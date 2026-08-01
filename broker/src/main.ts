/**
 * deck-broker daemon (SPEC §6): sole reader of broker/store.db; proxies LLM
 * calls over 127.0.0.1 (OpenAI-compat /v1/chat/completions + native
 * /v1/messages via pi-ai's auth gateway); control over run/broker.sock.
 * Raw provider tokens never leave this process.
 *
 * Composition over @oh-my-pi/pi-ai (MIT):
 * - SqliteAuthCredentialStore  → store.db (0600), refresh-lease CAS, identity dedup
 * - AuthStorage                → single-flight refresh, sticky-by-session, usage cache
 * - AuthBrokerRefresher        → proactive refresh sweep (5-min skew / 60s cadence)
 * - startAuthGateway           → wire formats, Claude-Code OAuth presentation, SSE
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerRefresher } from "@oh-my-pi/pi-ai/auth-broker";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { startFastGateway } from "./fast-gateway";
import { startControlSocket } from "./control";
import { buildModelIndex } from "./models";
import {
	BROKER_DIR,
	BROKER_SOCK,
	DEFAULT_GATEWAY_BIND,
	ensureDirs,
	ensureToken,
	GATEWAY_TOKEN_FILE,
	STORE_DB,
	USAGE_JSON,
	writeJsonAtomic,
} from "./paths";
import { refreshUsageRoster } from "./usage";
import { nativeReasoning } from "./reasoning";

function gatewayBind(bind: string): { hostname: string; port: number } {
	const separator = bind.lastIndexOf(":");
	if (separator < 1) throw new Error(`Invalid broker bind address: ${bind}`);
	return { hostname: bind.slice(0, separator), port: Number(bind.slice(separator + 1)) };
}

/** Add the broker's provider-specific reasoning checks to the live gateway path. */
function startValidatedGateway(options: Parameters<typeof startAuthGateway>[0]) {
	const upstream = startAuthGateway({ ...options, bind: "127.0.0.1:0" });
	const { hostname, port } = gatewayBind(DEFAULT_GATEWAY_BIND);
	const server = Bun.serve({
		hostname,
		port,
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && ["/v1/chat/completions", "/v1/messages", "/v1/responses"].includes(url.pathname)) {
				let body: { model?: string; reasoning_effort?: string; thinking?: { type?: string; budget_tokens?: number } };
				try {
					body = await request.json() as typeof body;
					if (body.reasoning_effort !== undefined) {
						const modelId = body.model?.split("/").pop() ?? "";
						const provider = modelId.startsWith("grok-") ? "xai" : "openai";
						nativeReasoning(provider, body.reasoning_effort);
					}
					if (body.thinking?.type === "enabled") {
						nativeReasoning("anthropic", `budget:${body.thinking.budget_tokens ?? ""}`);
					}
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

export const BROKER_VERSION = "deck-broker/0.1.0";
const CONTROL_TOKEN_FILE = path.join(BROKER_DIR, "control.token");
const USAGE_ROSTER_INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
	ensureDirs();

	const store = await SqliteAuthCredentialStore.open(STORE_DB);
	fs.chmodSync(STORE_DB, 0o600);
	const storage = new AuthStorage(store, { sourceLabel: `deck ${STORE_DB}` });
	await storage.reload();

	const gatewayToken = ensureToken(GATEWAY_TOKEN_FILE);
	const controlCapability = ensureToken(CONTROL_TOKEN_FILE);

	const models = buildModelIndex();
	const gateway = startValidatedGateway({
		storage,
		bind: DEFAULT_GATEWAY_BIND,
		bearerTokens: [gatewayToken],
		version: BROKER_VERSION,
		resolveModel: models.resolve,
		listModels: models.list,
	});

	const refresher = new AuthBrokerRefresher({ storage });
	refresher.start();

	const control = startControlSocket(BROKER_SOCK, {
		storage,
		listBlocks: ids => store.listCredentialBlocks(ids),
		invalidateUsageCache: () => storage.invalidateUsageCache(),
		capability: controlCapability,
		gatewayUrl: gateway.url,
		version: BROKER_VERSION,
		startedAt: Date.now(),
	});

	// Usage roster: initial snapshot + steady cadence (matches AuthStorage's
	// 5-min per-credential cache, so this never hammers provider usage APIs).
	const refreshRoster = () =>
		refreshUsageRoster(storage).catch(error => {
			console.error("usage roster refresh failed:", error instanceof Error ? error.message : error);
		});
	void refreshRoster();
	const rosterTimer = setInterval(refreshRoster, USAGE_ROSTER_INTERVAL_MS);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`${signal}: shutting down`);
		clearInterval(rosterTimer);
		refresher.stop();
		control.close();
		await gateway.close();
		storage.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	writeJsonAtomic(path.join(BROKER_DIR, "broker.meta.json"), {
		version: BROKER_VERSION,
		pid: process.pid,
		gateway: gateway.url,
		startedAt: new Date().toISOString(),
	});
	console.error(`${BROKER_VERSION} up — gateway ${gateway.url}, control ${BROKER_SOCK}, store ${STORE_DB}, roster ${USAGE_JSON}`);
}

main().catch(error => {
	console.error("broker boot failed:", error);
	process.exit(1);
});
