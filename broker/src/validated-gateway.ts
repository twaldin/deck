import { startFastGateway, type FastGatewayOptions } from "./fast-gateway";
import { DEFAULT_GATEWAY_BIND } from "./paths";
import { buildModelIndex } from "./models";
import { clampReasoning, nativeReasoning, supportedReasoning, type ReasoningEffort } from "./reasoning";
import { routeModel, NoQuotaError, routingProvider, type QuotaModel } from "./quota";

type GatewayUpstream = { url: string; close(): Promise<void> };
type StartUpstream = (options: FastGatewayOptions) => GatewayUpstream;

function gatewayBind(bind: string): { hostname: string; port: number } {
	const separator = bind.lastIndexOf(":");
	if (separator < 1) throw new Error(`Invalid broker bind address: ${bind}`);
	return { hostname: bind.slice(0, separator), port: Number(bind.slice(separator + 1)) };
}

export function startValidatedGateway(
	options: FastGatewayOptions,
	startUpstream: StartUpstream = startFastGateway,
) {
	const upstream = startUpstream({ ...options, bind: "127.0.0.1:0" });
	const quotaAccounts = options.quotaAccounts;
	const modelIndex = buildModelIndex();
	const { hostname, port } = gatewayBind(options.bind ?? DEFAULT_GATEWAY_BIND);
	const server = Bun.serve({
		hostname,
		port,
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			let requestBody: { model?: string } | undefined;
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
						const selector = provider === "anthropic" && effort.startsWith("budget:") ? effort : clampReasoning(effort, supportedReasoning(modelId, provider, capabilities));
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
				request = new Request(request, { body: JSON.stringify(body) });
			}
			const target = new URL(url.pathname + url.search, upstream.url);
			const response = await fetch(target, new Request(request, { headers: request.headers }));
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
			return response;
		},
	});
	return { url: `http://${hostname}:${server.port}`, close: async () => { server.stop(); await upstream.close(); }, port: server.port, hostname };
}
