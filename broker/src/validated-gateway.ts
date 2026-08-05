import { startFastGateway, type FastGatewayOptions } from "./fast-gateway";
import { DEFAULT_GATEWAY_BIND } from "./paths";
import { buildModelIndex } from "./models";
import { clampReasoning, nativeReasoning, supportedReasoning, type ReasoningEffort } from "./reasoning";
import { routeModel, NoQuotaError, routingProvider, type QuotaModel } from "./quota";

type GatewayUpstream = { url: string; close(): Promise<void> };
type StartUpstream = (options: FastGatewayOptions) => GatewayUpstream;
type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

function gatewayBind(bind: string): { hostname: string; port: number } {
	const separator = bind.lastIndexOf(":");
	if (separator < 1) throw new Error(`Invalid broker bind address: ${bind}`);
	return { hostname: bind.slice(0, separator), port: Number(bind.slice(separator + 1)) };
}

/** Attempt delays. Two retries is enough for a reset socket and cheap enough to always try. */
const UPSTREAM_RETRY_DELAYS_MS = [100, 300] as const;
/** Statuses that mean the upstream refused to serve: no generation was produced. */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
/** Errors raised BEFORE the request was handed to the upstream. */
const CONNECT_PHASE = /ECONNREFUSED|ConnectionRefused|ENOENT|EAI_AGAIN/i;

/**
 * Did this failure happen before anything was dispatched?
 *
 * This is the line between a safe replay and a possible double charge. A
 * refused connection proves the upstream never saw the request. A reset
 * mid-flight proves nothing: the provider may already have accepted the call
 * and started generating, and the broker exists to protect plan quota, so it
 * must not spend that quota twice to save one round trip.
 */
function isConnectPhase(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && CONNECT_PHASE.test(code)) return true;
	return error instanceof Error && CONNECT_PHASE.test(error.message);
}

function upstreamUnavailable(attempts: number, lastError: unknown, lastStatus?: number): Response {
	const reason = lastStatus === undefined
		? lastError instanceof Error ? lastError.message : String(lastError)
		: `upstream answered ${lastStatus}`;
	return Response.json(
		{
			error: {
				code: "UPSTREAM_UNAVAILABLE",
				type: "api_error",
				message: `broker upstream did not answer after ${attempts} attempt(s): ${reason}`,
				attempts,
				upstream_status: lastStatus ?? null,
			},
		},
		{ status: 502 },
	);
}

/**
 * Forward one request to the local upstream, ending every failure as JSON.
 *
 * A dropped socket makes `fetch` THROW. Unhandled, Bun answers with a non-JSON
 * 500 that no OpenAI or Anthropic client can parse, so the caller sees a
 * corrupt stream instead of an error it can act on.
 *
 * `replayable` is false when the body was streamed through untouched: a Request
 * body is a one-shot stream, so a second attempt would send an empty body.
 * `idempotent` is false for POST, which gates replay to connect-phase failures.
 */
async function forwardWithRetry(
	target: URL,
	init: RequestInit,
	options: { replayable: boolean; idempotent: boolean },
	upstreamFetch: FetchLike,
	sleep: (ms: number) => Promise<void>,
): Promise<Response> {
	let lastError: unknown;
	let lastStatus: number | undefined;
	for (let attempt = 0; ; attempt++) {
		const last = attempt >= UPSTREAM_RETRY_DELAYS_MS.length;
		let response: Response;
		try {
			response = await upstreamFetch(target, init);
		} catch (error) {
			lastError = error;
			lastStatus = undefined;
			if (last || !options.replayable || !(options.idempotent || isConnectPhase(error))) {
				return upstreamUnavailable(attempt + 1, error);
			}
			await sleep(UPSTREAM_RETRY_DELAYS_MS[attempt]!);
			continue;
		}
		if (!RETRYABLE_STATUS.has(response.status)) return response;
		lastStatus = response.status;
		// A POST can have reached and billed the provider before a proxy returns
		// 502/503/504. Only idempotent requests are safe to replay on status alone.
		if (last || !options.replayable || !options.idempotent) {
			// The upstream's own JSON error is more useful than ours; anything else
			// (an HTML or plain-text 503) becomes a structured error the client can read.
			if ((response.headers.get("content-type") ?? "").includes("json")) return response;
			await response.body?.cancel().catch(() => {});
			return upstreamUnavailable(attempt + 1, lastError, lastStatus);
		}
		await response.body?.cancel().catch(() => {});
		await sleep(UPSTREAM_RETRY_DELAYS_MS[attempt]!);
	}
}

/**
 * Frame a mid-stream failure as an SSE event.
 *
 * Anthropic clients dispatch on the event NAME, OpenAI clients read the JSON
 * payload, so one frame has to carry both. `[DONE]` is deliberately absent: it
 * is the success sentinel, and appending it would hide the failure again.
 */
function sseErrorFrame(error: unknown): Uint8Array {
	const code = (error as { code?: unknown } | null)?.code;
	const detail = error instanceof Error
		? `${typeof code === "string" ? code : error.name}: ${error.message}`
		: String(error);
	const payload = {
		type: "error",
		error: {
			code: "UPSTREAM_STREAM_FAILED",
			type: "api_error",
			message: `broker upstream stream failed mid-response: ${detail}`,
		},
	};
	return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** End of the last complete SSE frame in `buffer`, or -1. Frames end on a blank line. */
function lastFrameEnd(buffer: Uint8Array): number {
	for (let i = buffer.length - 1; i >= 1; i--) {
		if (buffer[i] !== 0x0a) continue; // \n
		if (buffer[i - 1] === 0x0a) return i + 1; // \n\n
		if (i >= 3 && buffer[i - 1] === 0x0d && buffer[i - 2] === 0x0a && buffer[i - 3] === 0x0d) return i + 1; // \r\n\r\n
	}
	return -1;
}

/**
 * Cap on bytes held back while waiting for a frame boundary.
 *
 * Only the trailing PARTIAL frame is ever buffered, so this is a safety valve
 * against an upstream that never emits a boundary, not a normal-path cost. Past
 * the cap the guard stops holding bytes back and forwards them as they arrive:
 * degrading to the old splice risk beats growing without bound.
 */
const MAX_PENDING_FRAME_BYTES = 1 << 20;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/**
 * Make an SSE body that dies mid-stream say so.
 *
 * Once the upstream has sent headers the status code is spent: a later reset
 * cannot become a 502, and nothing may be replayed because those tokens were
 * already billed and delivered. Forwarded raw, that reset reaches the client as
 * a CLEAN EOF — every frame it received was individually well formed, so a
 * truncated answer is indistinguishable from a finished one and the agent
 * silently acts on half a response. The failure has to travel in-band.
 *
 * Only SSE is wrapped. Truncation of any other body is already self-detecting
 * (half a JSON document does not parse), and Bun.serve cannot signal a
 * mid-stream failure on those anyway: it strips content-length, always chunks,
 * and ends the chunked body cleanly even when the source stream errors.
 */
function guardStreamedBody(response: Response): Response {
	const body = response.body;
	if (body === null) return response;
	if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
	const reader = body.getReader();
	// Bytes read past the last frame boundary. A reset lands INSIDE a frame far
	// more often than on the blank line between two, and a half-frame already
	// forwarded cannot be recalled: the error frame then splices into its
	// `data:` line and the client hits a JSON parse failure before it ever reads
	// the explanation. So the incomplete tail waits here, and is dropped whole
	// if the stream dies.
	let pending = new Uint8Array(0);
	let overflowed = false;
	// `pull`, not a `start` loop: the guard must not buffer the stream it exists to keep live.
	const guarded = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					// A clean EOF means the upstream meant to stop. Whatever it last sent
					// is its own final word, complete or not, and is forwarded as-is.
					if (pending.length > 0) controller.enqueue(pending);
					pending = new Uint8Array(0);
					reader.releaseLock();
					controller.close();
					return;
				}
				if (overflowed) {
					controller.enqueue(value);
					return;
				}
				const buffer = pending.length === 0 ? value : concat(pending, value);
				const boundary = lastFrameEnd(buffer);
				if (boundary === -1) {
					if (buffer.length > MAX_PENDING_FRAME_BYTES) {
						overflowed = true;
						pending = new Uint8Array(0);
						controller.enqueue(buffer);
						return;
					}
					pending = buffer;
					return; // Nothing complete yet; pull again.
				}
				pending = buffer.subarray(boundary);
				controller.enqueue(buffer.subarray(0, boundary));
			} catch (error) {
				// Drop `pending`: it is a frame the upstream never finished.
				pending = new Uint8Array(0);
				controller.enqueue(sseErrorFrame(error));
				reader.releaseLock();
				controller.close();
			}
		},
		cancel: reason => reader.cancel(reason),
	});
	return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function startValidatedGateway(
	options: FastGatewayOptions,
	startUpstream: StartUpstream = startFastGateway,
	upstreamFetch: FetchLike = fetch,
) {
	const upstream = startUpstream({ ...options, bind: "127.0.0.1:0" });
	const quotaAccounts = options.quotaAccounts;
	const modelIndex = buildModelIndex();
	const warnedReasoningClamps = new Set<string>();
	const { hostname, port } = gatewayBind(options.bind ?? DEFAULT_GATEWAY_BIND);
	const server = Bun.serve({
		hostname,
		port,
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			let requestBody: { model?: string } | undefined;
			let forwardBody: string | undefined;
			if (request.method === "POST" && ["/v1/chat/completions", "/v1/messages", "/v1/responses"].includes(url.pathname)) {
				let body: { model?: string; reasoning_effort?: string; reasoning?: { effort?: string }; thinking?: { type?: string; budget_tokens?: number }; prompt_cache_key?: string };
				try {
					body = await request.json() as typeof body;
					const modelParts = body.model?.split("/") ?? [];
					requestBody = body;
					if (body.model !== undefined && quotaAccounts !== undefined) {
						const providerName = modelParts.at(-2);
						const provider = providerName ?? (modelParts.at(-1)?.startsWith("claude-") ? "anthropic" : modelParts.at(-1)?.startsWith("grok-") ? "xai" : "openai-codex");
						const requested: QuotaModel = { id: modelParts.at(-1) ?? body.model, provider };
						try {
							const routed = routeModel(requested, quotaAccounts(), options.quotaPreferences?.() ?? [], options.onQuotaEvent);
							if (routed.fallback !== undefined) body.model = `${routed.model.provider}/${routed.model.id}`;
							// AuthStorage uses the request session key for sticky OAuth routing.
							// Pin the selected account before the upstream parses the request.
							const sessionId = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : `deck-route:${routed.model.provider}:${routed.model.id}`;
							body.prompt_cache_key = sessionId;
							if (typeof (options.storage as unknown as { pinSessionOAuthAccount?: unknown })?.pinSessionOAuthAccount === "function") {
								(options.storage as unknown as { pinSessionOAuthAccount: (provider: string, sessionId: string, credentialId: number) => boolean }).pinSessionOAuthAccount(routed.account.authProvider ?? routed.model.provider, sessionId, routed.account.credentialId);
							}
						} catch (error) {
							if (error instanceof NoQuotaError) return Response.json({ error: { code: error.code, type: "quota_exhausted", message: error.message, provider: error.provider, retry_after_ms: error.retryAfterMs ?? null } }, { status: 503 });
							throw error;
						}
					}
					const reasoningParts = body.model?.split("/") ?? [];
					const modelId = reasoningParts.at(-1) ?? "";
					const providerName = reasoningParts.at(-2);
					const provider = providerName === "anthropic"
						? "anthropic"
						: providerName === "xai" || providerName === "xai-oauth" || modelId.startsWith("grok-")
							? "xai"
							: "openai";
					const effort = body.reasoning_effort ?? body.reasoning?.effort;
					if (effort !== undefined) {
						const resolved = modelIndex.resolve(body.model ?? modelId) ?? modelIndex.resolve(modelId);
						const capabilities = resolved?.thinking?.efforts as readonly ReasoningEffort[] | undefined;
						const supported = supportedReasoning(modelId, provider, capabilities);
						const selector = provider === "anthropic" && effort.startsWith("budget:") ? effort : clampReasoning(effort, supported);
						if (selector !== effort) {
							const sessionId = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "default";
							const warningKey = `${sessionId}:${modelId}:${effort}`;
							if (!warnedReasoningClamps.has(warningKey)) {
								warnedReasoningClamps.add(warningKey);
								console.warn(`[reasoning] model=${modelId} requested=${effort} effective=${selector} session=${sessionId}`);
							}
						}
						const native = nativeReasoning(provider, selector);
						delete body.reasoning;
						delete body.reasoning_effort;
						if ("reasoning_effort" in native) {
							body.reasoning_effort = native.reasoning_effort;
							if (provider === "openai" && providerName !== "deck") body.reasoning = { effort: native.reasoning_effort };
						} else if ("thinking" in native) body.thinking = native.thinking;
					}
					if (body.thinking?.type === "enabled") {
						const nativeThinking = nativeReasoning("anthropic", `budget:${body.thinking.budget_tokens ?? ""}`);
						if ("thinking" in nativeThinking) body.thinking = nativeThinking.thinking;
					}
				} catch (error) {
					return Response.json({ error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) } }, { status: 400 });
				}
				forwardBody = JSON.stringify(body);
			}
			const target = new URL(url.pathname + url.search, upstream.url);
			// Only the rewritten JSON body is buffered, and only it may be replayed.
			// Every other route streams through byte-for-byte: decoding an arbitrary
			// body as text would corrupt a binary or multipart upload.
			const idempotent = request.method === "GET" || request.method === "HEAD";
			const headers = new Headers(request.headers);
			let init: RequestInit;
			if (forwardBody === undefined) {
				init = new Request(request, { headers }) as RequestInit;
			} else {
				// The rewritten body has its own length and is no longer compressed.
				headers.delete("content-length");
				headers.delete("content-encoding");
				init = { method: request.method, headers, body: forwardBody };
			}
			const response = await forwardWithRetry(
				target,
				init,
				{ replayable: forwardBody !== undefined || idempotent, idempotent },
				upstreamFetch,
				ms => Bun.sleep(ms),
			);
			if (response.status === 429 && quotaAccounts !== undefined && requestBody?.model !== undefined) {
				const parts = requestBody.model.split("/");
				const provider = routingProvider(parts.at(-2) ?? (parts.at(-1)?.startsWith("claude-") ? "anthropic" : parts.at(-1)?.startsWith("grok-") ? "xai" : "openai-codex"));
				const requested: QuotaModel = { id: parts.at(-1) ?? requestBody.model, provider };
				const retryAfter = response.headers.get("retry-after");
				const retryAfterMs = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
				try {
					routeModel(requested, quotaAccounts(), [], options.onQuotaEvent);
				} catch (error) {
					if (!(error instanceof NoQuotaError)) throw error;
				}
				// A provider 429 is a quota signal. Do not expose it as a retryable
				// gateway response while AuthStorage records the cooling block.
				return Response.json({ error: { code: "NO_QUOTA", type: "quota_exhausted", message: `no quota is available for provider ${requested.provider}`, provider: requested.provider, retry_after_ms: retryAfterMs ?? null } }, { status: 503 });
			}
			return guardStreamedBody(response);
		},
	});
	return { url: `http://${hostname}:${server.port}`, close: async () => { server.stop(); await upstream.close(); }, port: server.port, hostname };
}
