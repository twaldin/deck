/**
 * Deck runtime layout (SPEC §0): code in ~/dev/deck, state in ~/.deck (0700).
 * The broker owns broker/store.db (0600, sole reader — SPEC §6.4) and
 * broker/usage.json; its control socket lives at run/broker.sock.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export const DECK_HOME = process.env.DECK_HOME ?? path.join(os.homedir(), ".deck");
export const BROKER_DIR = path.join(DECK_HOME, "broker");
export const RUN_DIR = path.join(DECK_HOME, "run");

export const STORE_DB = path.join(BROKER_DIR, "store.db");
export const USAGE_JSON = path.join(BROKER_DIR, "usage.json");
export const GATEWAY_TOKEN_FILE = path.join(BROKER_DIR, "gateway.token");
export const BROKER_SOCK = path.join(RUN_DIR, "broker.sock");

export const DEFAULT_GATEWAY_BIND = process.env.DECK_BROKER_BIND ?? "127.0.0.1:8377";

export function ensureDirs(): void {
	for (const dir of [DECK_HOME, BROKER_DIR, RUN_DIR]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700); // mkdirSync mode is masked by umask; enforce
	}
}

/** Read-or-mint a bearer token file (0600), mirroring omp's token-file pattern. */
export function ensureToken(file: string): string {
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (existing.length > 0) return existing;
	} catch {
		// missing — mint below
	}
	const token = randomBytes(32).toString("base64url");
	fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return token;
}

/**
 * Atomic 0600 JSON write: unique same-dir temp + rename. Temp name carries
 * pid+random so concurrent writers (roster timer vs control `usage`) never
 * rename each other's file out from under them; rename picks a winner.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}
