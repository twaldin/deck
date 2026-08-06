import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { startAuthGateway, type ModelResolver } from "@oh-my-pi/pi-ai/auth-gateway";
import { fastCreditMultiplier, type FastUsageMonitor } from "./fast-usage";

const FAST_SUFFIX = ":fast";

export function parseFastModel(modelId: string, resolveModel: ModelResolver): { modelId: string; serviceTier?: "priority" } {
	if (!modelId.endsWith(FAST_SUFFIX)) return { modelId };
	const baseId = modelId.slice(0, -FAST_SUFFIX.length);
	const resolverId = baseId.startsWith("deck/") ? baseId.slice("deck/".length) : baseId;
	const model = resolveModel(resolverId);
	if (!model || fastCreditMultiplier(model.provider, model.id) === undefined) {
		throw new Error(
			`:fast requires a ChatGPT OAuth model in the GPT-5.4, GPT-5.5, or GPT-5.6 family (received ${JSON.stringify(modelId)})`,
		);
	}
	return { modelId: resolverId, serviceTier: "priority" };
}



export const ARTIFACT_REQUEST_ID_HEADER = "x-deck-artifact-request-id";

type RequestCredentialPin = {
	provider: string;
	sessionId: string;
	credentialId: number;
};

export interface FastGateway {
	url: string;
	close(): Promise<void>;
	/**
	 * Bind one outer broker request to an OAuth credential. The inner auth
	 * gateway may refresh/retry that credential, but cannot fail over to a
	 * sibling while producing account-bound artifacts.
	 */
	pinRequestCredential(requestId: string, pin: RequestCredentialPin): void;
	unpinRequestCredential(requestId: string): void;
}

function pinKey(provider: string, sessionId: string): string {
	return `${provider}\u0000${sessionId}`;
}

function pinnedStorage(storage: AuthStorage, activePins: ReadonlyMap<string, number>): AuthStorage {
	const getApiKey: AuthStorage["getApiKey"] = async (provider, sessionId, options) => {
		const credentialId = sessionId === undefined ? undefined : activePins.get(pinKey(provider, sessionId));
		if (credentialId !== undefined && sessionId !== undefined) {
			if (!storage.pinSessionOAuthAccount(provider, sessionId, credentialId)) return undefined;
			const account = storage.listOAuthAccounts(provider, sessionId).find(entry => entry.credentialId === credentialId);
			if (account !== undefined) {
				const access = await storage.getOAuthAccessAt(provider, account.position, options);
				return access?.ok ? access.accessToken : undefined;
			}
		}
		return storage.getApiKey(provider, sessionId, options);
	};
	return new Proxy(storage, {
		get(target, property) {
			if (property === "getApiKey") return getApiKey;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function releaseWithBody(response: Response, release: () => void): Response {
	const body = response.body;
	if (body === null) {
		release();
		return response;
	}
	const reader = body.getReader();
	let released = false;
	const releaseOnce = (): void => {
		if (released) return;
		released = true;
		release();
	};
	const guarded = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					reader.releaseLock();
					releaseOnce();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				releaseOnce();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				releaseOnce();
			}
		},
	});
	return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function acquireSession(
	key: string,
	tails: Map<string, Promise<void>>,
): Promise<() => void> {
	const previous = tails.get(key) ?? Promise.resolve();
	let unlock = (): void => {};
	const current = new Promise<void>(resolve => {
		unlock = resolve;
	});
	tails.set(key, current);
	await previous;
	return () => {
		unlock();
		if (tails.get(key) === current) tails.delete(key);
	};
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
	fastUsageMonitor?: FastUsageMonitor;
	/** Optional upstream override for gateway-level tests. */
	upstream?: { url: string; close(): Promise<void> };
}

export function startFastGateway(opts: FastGatewayOptions): FastGateway {
	const activePins = new Map<string, number>();
	const requestPins = new Map<string, RequestCredentialPin>();
	const sessionTails = new Map<string, Promise<void>>();
	const upstream = opts.upstream ?? startAuthGateway({
		storage: pinnedStorage(opts.storage, activePins),
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
			const requestId = request.headers.get(ARTIFACT_REQUEST_ID_HEADER);
			const pin = requestId === null ? undefined : requestPins.get(requestId);
			const key = pin === undefined ? undefined : pinKey(pin.provider, pin.sessionId);
			const unlock = key === undefined ? undefined : await acquireSession(key, sessionTails);
			if (key !== undefined && pin !== undefined) activePins.set(key, pin.credentialId);
			const release = (finished: boolean): void => {
				if (key !== undefined && pin !== undefined && activePins.get(key) === pin.credentialId) activePins.delete(key);
				unlock?.();
				if (finished && requestId !== null && requestPins.get(requestId) === pin) requestPins.delete(requestId);
			};
			try {
				const url = new URL(request.url);
				const headers = new Headers(request.headers);
				headers.delete(ARTIFACT_REQUEST_ID_HEADER);
				const init: RequestInit = { method: request.method, headers };
				if (request.method === "POST") {
					const rawBody = await request.text();
					init.body = rawBody;
					if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/responses" && url.pathname !== "/v1/messages") {
						const response = await fetch(`${upstream.url}${url.pathname}${url.search}`, init);
						return unlock === undefined ? response : releaseWithBody(response, () => release(true));
					}
					const body = JSON.parse(rawBody) as Record<string, unknown>;
					if (typeof body.model === "string") {
						try {
							const fast = parseFastModel(body.model, opts.resolveModel);
							body.model = fast.modelId;
							if (fast.serviceTier !== undefined) body.service_tier = fast.serviceTier;
						} catch (error) {
							const response = Response.json({ error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error" } }, { status: 400 });
							return unlock === undefined ? response : releaseWithBody(response, () => release(true));
						}
					}
					init.body = JSON.stringify(body);
				}
				const response = await fetch(`${upstream.url}${url.pathname}${url.search}`, init);
				return unlock === undefined ? response : releaseWithBody(response, () => release(true));
			} catch (error) {
				release(false);
				throw error;
			}
		},
	});
	return {
		url: `http://${server.hostname}:${server.port}`,
		pinRequestCredential(requestId, pin) {
			requestPins.delete(requestId);
			requestPins.set(requestId, pin);
		},
		unpinRequestCredential(requestId) {
			requestPins.delete(requestId);
		},
		async close() {
			server.stop(true);
			await upstream.close();
		},
	};
}
