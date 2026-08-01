import { startFastGateway, type FastGatewayOptions } from "./fast-gateway";
import { DEFAULT_GATEWAY_BIND } from "./paths";
import { nativeReasoning } from "./reasoning";

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
	const { hostname, port } = gatewayBind(options.bind ?? DEFAULT_GATEWAY_BIND);
	const server = Bun.serve({
		hostname,
		port,
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && ["/v1/chat/completions", "/v1/messages", "/v1/responses"].includes(url.pathname)) {
				let body: { model?: string; reasoning_effort?: string; reasoning?: { effort?: string }; thinking?: { type?: string; budget_tokens?: number } };
				try {
					body = await request.json() as typeof body;
					const modelParts = body.model?.split("/") ?? [];
					const modelId = modelParts.at(-1) ?? "";
					const providerName = modelParts.at(-2);
					const provider = modelId.startsWith("claude-") || providerName === "anthropic" ? "anthropic" : providerName === "xai" || providerName === "xai-oauth" || modelId.startsWith("grok-") ? "xai" : "openai";
					const effort = body.reasoning_effort ?? body.reasoning?.effort;
					if (effort !== undefined) {
						const native = nativeReasoning(provider, effort);
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
			return fetch(target, new Request(request, { headers: request.headers }));
		},
	});
	return { url: `http://${hostname}:${server.port}`, close: async () => { server.stop(); await upstream.close(); }, port: server.port, hostname };
}
