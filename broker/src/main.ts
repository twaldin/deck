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
	const gateway = startAuthGateway({
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
