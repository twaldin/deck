import { startFastGateway, type FastGatewayOptions } from "./fast-gateway";
import { DEFAULT_GATEWAY_BIND } from "./paths";
import { nativeReasoning } from "./reasoning";
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
					requestBody = body;
					const modelParts = body.model?.split("/") ?? [];
					if (body.model !== undefined && quotaAccounts !== undefined) {
						const providerName = modelParts.at(-2);
						const provider = providerName ?? (modelParts.at(-1)?.startsWith("claude-") ? "anthropic" : modelParts.at(-1)?.startsWith("grok-") ? "xai" : "openai-codex");
						const requested: QuotaModel = { id: modelParts.at(-1) ?? body.model, provider };
						try {
							const routed = routeModel(requested, quotaAccounts(), options.quotaPreferences?.() ?? [], options.onQuotaEvent);
							if (routed.fallback !== undefined) body.model = body.model.replace(requested.id, routed.model.id);
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
					const modelId = modelParts.at(-1) ?? "";
					const providerName = modelParts.at(-2);
					const provider = providerName === "openai-codex" ? "openai" : (providerName ?? (modelId.startsWith("claude-") ? "anthropic" : modelId.startsWith("grok-") ? "xai" : "openai"));
					let effort = body.reasoning_effort ?? body.reasoning?.effort;
					if (provider === "anthropic" && effort !== undefined && !effort.startsWith("budget:")) {
						const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 65536, max: 65536 };
						const budget = budgets[effort];
						if (budget === undefined) throw new Error(`Unsupported anthropic reasoning effort: ${effort}`);
						effort = `budget:${budget}`;
					}
					if (effort !== undefined) {
						const native = nativeReasoning(provider as "anthropic" | "openai" | "xai", effort);
						if (native.provider === "anthropic" && body.thinking === undefined) body.thinking = native.thinking;
						if (native.provider === "openai" && body.reasoning === undefined) body.reasoning = { effort: native.reasoning };
					}
					if (body.thinking?.type === "enabled") nativeReasoning("anthropic", `budget:${body.thinking.budget_tokens ?? ""}`);
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
