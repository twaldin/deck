import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export type DeckErrorCode = "E_TOO_LONG" | "E_CAS" | "E_LEASE" | "E_EVIDENCE" | "E_ADMISSION" | "E_CAP" | "E_ARG" | "E_STATE" | "E_LIVENESS" | "E_IO";

export class DeckError extends Error {
	readonly code: DeckErrorCode;
	readonly detail: Record<string, unknown>;
	constructor(code: DeckErrorCode, message: string, detail: Record<string, unknown> = {}) {
		super(`${code}: ${message}`);
		this.code = code;
		this.detail = detail;
	}
}

export const DECK_HOME = process.env.DECK_HOME ?? path.join(os.homedir(), ".deck");
export const WORKTREES_STATE = path.join(DECK_HOME, "worktrees.json");
export const EFFORTS_DIR = path.join(DECK_HOME, "efforts");
export function effortDir(effortId: string): string { return path.join(EFFORTS_DIR, effortId); }
export const EFFORT_FILES = { manifest: "manifest.json" } as const;

const sessionRefSchema = z.object({ machine: z.string().min(1), session_id: z.string().min(1), lease_epoch: z.number().int().nonnegative(), last_heartbeat: z.number().nullable() });
const dispatchSchema = z.object({ id: z.string().min(1), kind: z.enum(["workflow", "subagent"]), target: z.string().min(1), state: z.enum(["pending", "running", "done", "failed", "cancelled"]), started: z.number(), session: sessionRefSchema.nullable(), result_ref: z.string().nullable() });
const evidenceSchema = z.object({ ts: z.number(), label: z.string().min(1), ref: z.string().min(1), by: z.enum(["watch", "agent", "tim"]), scope: z.enum(["ci", "review", "deploy", "fallout", "other"]) });
const sideEffectSchema = z.object({ id: z.string().min(1), kind: z.enum(["push", "merge", "deploy", "migration"]), ref: z.string().min(1), status: z.enum(["attempted", "confirmed", "rolledback"]), ts: z.number(), lease_epoch: z.number().int().nonnegative() });
export const manifestSchema = z.object({
	v: z.literal(2), effort_id: z.string().min(1), project: z.string().min(1), title: z.string().min(1), created: z.string(), updated: z.string(), revision: z.number().int().nonnegative(),
	stage: z.enum(["intake", "active", "review", "landed", "watching", "done", "abandoned"]), overlays: z.object({ blocked: z.string().nullable(), needs_tim: z.array(z.string()) }), session: sessionRefSchema.nullable(),
	watch: z.object({ prs: z.array(z.string()), tickets: z.array(z.string()), slack_threads: z.array(z.string()) }), worktrees: z.array(z.string()), dispatches: z.array(dispatchSchema), evidence: z.array(evidenceSchema), side_effects: z.array(sideEffectSchema),
	cards: z.array(z.object({ id: z.string().min(1), card: z.object({ kind: z.enum(["decision", "cancellation", "flagged", "degraded"]), question: z.string().min(1), recommendation: z.string().min(1), options: z.array(z.string().min(1)).min(1) }), status: z.enum(["open", "answered"]), answer: z.string().nullable(), answered_ts: z.number().nullable(), cancel_in_flight: z.string().nullable() })),
	decisions: z.array(z.object({ ts: z.number(), card_id: z.string(), answer: z.string() })), digest: z.string().nullable(),
});

export function loadConfig(): { admission: { maxWorktreesGlobal: number } } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(DECK_HOME, "config.json"), "utf8")) as { admission?: { maxWorktreesGlobal?: unknown } };
		const value = raw.admission?.maxWorktreesGlobal;
		return { admission: { maxWorktreesGlobal: typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 24 } };
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { admission: { maxWorktreesGlobal: 24 } };
		throw error;
	}
}

export function ulid(): string { return `${Date.now().toString(36)}${randomBytes(8).toString("hex")}`; }
