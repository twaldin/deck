/**
 * Single-use merge authorizations (SPEC §10). Append-only JSONL at
 * ~/.deck/gateway/authorizations.jsonl: mint records + consume follow-ups,
 * folded like inbox receipts — no rewrites, crash-safe by construction.
 * Consume is serialized by a lockfile; a consumed or head-moved authorization
 * can never authorize a merge.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DECK_HOME, DeckError, ulid } from "@deck/core";
import { z } from "zod";

export const authorizationSchema = z.object({
	id: z.string().min(1),
	repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be owner/name"),
	pr: z.number().int().positive(),
	head_sha: z.string().min(7),
	base: z.string().min(1),
	required_checks: z.array(z.string().min(1)).min(1),
	workflow_run_id: z.string().nullable(),
	minted_ts: z.number(),
});
export type MergeAuthorization = z.infer<typeof authorizationSchema>;

const consumeRecordSchema = z.object({
	id: z.string().min(1),
	consumed_ts: z.number(),
	result: z.enum(["merged", "rejected"]),
	detail: z.string(),
});
const recordSchema = z.union([authorizationSchema, consumeRecordSchema]);

export interface AuthorizationState extends MergeAuthorization {
	consumed_ts: number | null;
	result: string | null;
}

const GATEWAY_DIR = path.join(DECK_HOME, "gateway");
const AUTH_FILE = path.join(GATEWAY_DIR, "authorizations.jsonl");
const LOCK_FILE = path.join(GATEWAY_DIR, "authorizations.lock");

function ensureDir(): void {
	fs.mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
}

function appendRecord(record: unknown): void {
	ensureDir();
	const line = `${JSON.stringify(recordSchema.parse(record))}\n`;
	const fd = fs.openSync(AUTH_FILE, "a", 0o600);
	try {
		fs.writeSync(fd, line);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function listAuthorizations(): AuthorizationState[] {
	let text: string;
	try {
		text = fs.readFileSync(AUTH_FILE, "utf8");
	} catch {
		return [];
	}
	const states = new Map<string, AuthorizationState>();
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const record = recordSchema.parse(JSON.parse(line));
		if ("minted_ts" in record) {
			if (!states.has(record.id)) states.set(record.id, { ...record, consumed_ts: null, result: null });
			continue;
		}
		const existing = states.get(record.id);
		if (existing === undefined) throw new DeckError("E_IO", "consume record precedes its authorization", { id: record.id });
		existing.consumed_ts = record.consumed_ts;
		existing.result = record.result;
	}
	return [...states.values()];
}

export function mintAuthorization(input: Omit<MergeAuthorization, "id" | "minted_ts">): MergeAuthorization {
	const record = authorizationSchema.parse({ ...input, id: ulid(), minted_ts: Date.now() });
	appendRecord(record);
	return record;
}

/** Serialize consumes: O_CREAT|O_EXCL lockfile with stale takeover after 30s. */
function withConsumeLock<T>(fn: () => T): T {
	ensureDir();
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
			try {
				return fn();
			} finally {
				fs.closeSync(fd);
				fs.rmSync(LOCK_FILE, { force: true });
			}
		} catch (error) {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") throw error;
			const age = Date.now() - (fs.statSync(LOCK_FILE, { throwIfNoEntry: false })?.mtimeMs ?? 0);
			if (age > 30_000) {
				fs.rmSync(LOCK_FILE, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new DeckError("E_IO", "authorization lock held too long");
			Bun.sleepSync(50);
		}
	}
}

/**
 * Atomic consume: validates single-use + head binding under the lock and
 * appends the consume record before returning. `expectedHeadSha` is the sha
 * ABOUT to be merged — if the PR head moved after minting, this rejects
 * (SPEC §10: a head Tim never approved cannot be merged).
 */
export function consumeAuthorization(id: string, expectedHeadSha: string, result: "merged" | "rejected", detail: string): MergeAuthorization {
	return withConsumeLock(() => {
		const state = listAuthorizations().find(candidate => candidate.id === id);
		if (state === undefined) throw new DeckError("E_STATE", "no such authorization", { id });
		if (state.consumed_ts !== null) throw new DeckError("E_STATE", "authorization already consumed", { id });
		if (state.head_sha !== expectedHeadSha) {
			appendRecord({ id, consumed_ts: Date.now(), result: "rejected", detail: `head moved: authorized ${state.head_sha}, saw ${expectedHeadSha}` });
			throw new DeckError("E_STATE", "authorization bound to a different head sha", {
				authorized: state.head_sha,
				actual: expectedHeadSha,
			});
		}
		appendRecord({ id, consumed_ts: Date.now(), result, detail });
		return authorizationSchema.parse({ ...state, consumed_ts: undefined, result: undefined });
	});
}
