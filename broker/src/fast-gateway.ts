import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { startAuthGateway, type ModelResolver } from "@oh-my-pi/pi-ai/auth-gateway";

const FAST_SUFFIX = ":fast";

export function parseFastModel(modelId: string, resolveModel: ModelResolver): { modelId: string; serviceTier?: "priority" } {
	if (!modelId.endsWith(FAST_SUFFIX)) return { modelId };
	const baseId = modelId.slice(0, -FAST_SUFFIX.length);
	const resolverId = baseId.startsWith("deck/") ? baseId.slice("deck/".length) : baseId;
	const model = resolveModel(resolverId);
	if (!model || !isOpenAIModel(model)) {
		throw new Error(`:fast is supported only for OpenAI models (received ${JSON.stringify(modelId)})`);
	}
	return { modelId: resolverId, serviceTier: "priority" };
}

function isOpenAIModel(model: Model<Api>): boolean {
	return model.provider === "openai" || model.provider === "openai-codex";
}

export interface FastGatewayOptions {
	bind: string;
	/** Optional broker quota snapshot and fallback policy. */
	quotaAccounts?: () => import("./quota").AccountQuota[];
	quotaPreferences?: () => import("./quota").QuotaModel[];
	onQuotaEvent?: (event: import("./quota").QuotaEvent) => void;
	bearerTokens: string[];
	version: string;
	resolveModel: ModelResolver;
	listModels: () => Iterable<Model<Api>>;
	storage: AuthStorage;
	/** Optional upstream override for gateway-level tests. */
	upstream?: { url: string; close(): Promise<void> };
}

export function startFastGateway(opts: FastGatewayOptions): { url: string; close(): Promise<void> } {
	const upstream = opts.upstream ?? startAuthGateway({
		storage: opts.storage,
		bind: "127.0.0.1:0",
		bearerTokens: opts.bearerTokens,
		version: opts.version,
		resolveModel: id => opts.resolveModel(id),
		listModels: opts.listModels,
	});
	const [hostname, portText] = opts.bind.includes(":") ? opts.bind.split(":") : ["127.0.0.1", opts.bind];
	const server = Bun.serve({
		port: Number(portText),
		hostname,
		// Long reasoning pauses exceed Bun's 10s default idle timeout and killed
		// in-flight worker streams with ECONNRESET. 255s is Bun's maximum.
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			const init: RequestInit = { method: request.method, headers: request.headers };
			if (request.method === "POST") {
				const rawBody = await request.text();
				init.body = rawBody;
				if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/responses" && url.pathname !== "/v1/messages") return fetch(`${upstream.url}${url.pathname}${url.search}`, init);
				const body = JSON.parse(rawBody) as Record<string, unknown>;
				if (typeof body.model === "string") {
					try {
						const fast = parseFastModel(body.model, opts.resolveModel);
						body.model = fast.modelId;
						if (fast.serviceTier !== undefined) body.service_tier = fast.serviceTier;
					} catch (error) {
						return Response.json({ error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error" } }, { status: 400 });
					}
				}
				init.body = JSON.stringify(body);
			}
			return fetch(`${upstream.url}${url.pathname}${url.search}`, init);
		},
	});
	return {
		url: `http://${server.hostname}:${server.port}`,
		async close() {
			server.stop(true);
			await upstream.close();
		},
	};
}
