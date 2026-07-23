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
	result: z.enum(["claimed", "merged", "rejected"]),
	detail: z.string(),
});
const recordSchema = z.union([authorizationSchema, consumeRecordSchema]);

export interface AuthorizationState extends MergeAuthorization {
	consumed_ts: number | null;
	result: string | null;
}

/** Terminal (single-use spent) states; `claimed` also spends the authorization. */
export type AuthorizationResult = "claimed" | "merged" | "rejected";

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
 * Atomic single-use CLAIM (SPEC §10): under the lock, verify unconsumed + head
 * binding, then append a `claimed` record that spends the authorization. This
 * is the single-use gate and MUST run before the irreversible merge PUT — two
 * concurrent merges serialize here and the loser sees `already consumed`
 * (adversarial-review: a post-PUT consume let both callers reach the merge).
 * A crash after claim leaves the authorization spent → reauthorization needed,
 * the deliberate safe failure.
 */
export function claimAuthorization(id: string, expectedHeadSha: string): MergeAuthorization {
	return withConsumeLock(() => {
		const state = listAuthorizations().find(candidate => candidate.id === id);
		if (state === undefined) throw new DeckError("E_STATE", "no such authorization", { id });
		if (state.consumed_ts !== null) throw new DeckError("E_STATE", "authorization already consumed", { id });
		if (state.head_sha !== expectedHeadSha) {
			throw new DeckError("E_STATE", "claim head sha does not match authorization (verify live head first)", {
				authorized: state.head_sha,
				actual: expectedHeadSha,
			});
		}
		appendRecord({ id, consumed_ts: Date.now(), result: "claimed", detail: expectedHeadSha });
		return authorizationSchema.parse({ ...state, consumed_ts: undefined, result: undefined });
	});
}

/**
 * Finalize a CLAIMED authorization after the merge PUT resolves. Appends the
 * terminal result; does NOT re-check `consumed_ts` (the claim already spent it
 * and this is the same caller closing its own claim). Idempotent-safe: a
 * missing claim throws (finalize without claim is a bug).
 */
export function finalizeAuthorization(id: string, result: "merged" | "rejected", detail: string): void {
	withConsumeLock(() => {
		const state = listAuthorizations().find(candidate => candidate.id === id);
		if (state === undefined) throw new DeckError("E_STATE", "no such authorization", { id });
		if (state.result !== "claimed") throw new DeckError("E_STATE", "finalize requires a claimed authorization", { id, result: state.result });
		appendRecord({ id, consumed_ts: state.consumed_ts ?? Date.now(), result, detail });
	});
}

/**
 * Burn an authorization on a REJECTED merge attempt (head moved, red check,
 * upstream refusal). Unconditional single-use burn — no head-binding fight
 * (adversarial-review: passing the moved sha to the consume guard was wrong).
 * Idempotent: a already-consumed authorization is left as-is.
 */
export function rejectAuthorization(id: string, detail: string): void {
	withConsumeLock(() => {
		const state = listAuthorizations().find(candidate => candidate.id === id);
		if (state === undefined) throw new DeckError("E_STATE", "no such authorization", { id });
		if (state.consumed_ts !== null) return;
		appendRecord({ id, consumed_ts: Date.now(), result: "rejected", detail });
	});
}
