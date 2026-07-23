/**
 * Canonical zod schemas for deck substrate state (SPEC §3 manifest v2,
 * §3.1 charter, §4.1 event envelope, §4.4 cards, §4.5.3 inbox commands).
 * These ARE the contract between store, router, lifecycle tools, and TUI —
 * every reader/writer parses through them at the file boundary.
 */
import { z } from "zod";
import { CAPS } from "./config";

// ── Identifiers ──────────────────────────────────────────────────────────────
export const stageSchema = z.enum(["intake", "active", "review", "landed", "watching", "done", "abandoned"]);
export type Stage = z.infer<typeof stageSchema>;

export const planeSchema = z.enum(["fact", "judgment", "tim", "lifecycle"]);
export type Plane = z.infer<typeof planeSchema>;

/** Machine-qualified session ref (I11). */
export const sessionRefSchema = z.object({
	machine: z.string().min(1),
	session_id: z.string().min(1),
	lease_epoch: z.number().int().nonnegative(),
	last_heartbeat: z.number().nullable(),
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

// ── Cards (SPEC §4.4, caps D-H enforced at the tool layer via assertCap;
//    schema-level max lengths are a second net) ──────────────────────────────
export const cardSchema = z.object({
	kind: z.enum(["decision", "cancellation", "flagged", "degraded"]),
	question: z.string().min(1).max(CAPS.askTimQuestion),
	recommendation: z.string().min(1).max(CAPS.askTimRecommendation),
	options: z.array(z.string().min(1).max(CAPS.askTimOptionLabel)).min(1).max(CAPS.askTimMaxOptions),
});
export type Card = z.infer<typeof cardSchema>;

export const cardEntrySchema = z.object({
	id: z.string().min(1),
	card: cardSchema,
	status: z.enum(["open", "answered"]),
	answer: z.string().nullable(),
	answered_ts: z.number().nullable(),
	cancel_in_flight: z.string().nullable(),
});
export type CardEntry = z.infer<typeof cardEntrySchema>;

// ── Manifest v2 (SPEC §3) ────────────────────────────────────────────────────
export const dispatchSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["workflow", "subagent"]),
	target: z.string().min(1),
	state: z.enum(["pending", "running", "done", "failed", "cancelled"]),
	started: z.number(),
	/** Session backing this dispatch, once liveness-verified (D-D). */
	session: sessionRefSchema.nullable(),
	result_ref: z.string().nullable(),
});
export type Dispatch = z.infer<typeof dispatchSchema>;

export const evidenceSchema = z.object({
	ts: z.number(),
	label: z.string().min(1),
	ref: z.string().min(1),
	by: z.enum(["watch", "agent", "tim"]),
	/** D-E: `done` requires at least one deploy-scoped evidence entry. */
	scope: z.enum(["ci", "review", "deploy", "fallout", "other"]),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const sideEffectSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["push", "merge", "deploy", "migration"]),
	ref: z.string().min(1),
	status: z.enum(["attempted", "confirmed", "rolledback"]),
	ts: z.number(),
	lease_epoch: z.number().int().nonnegative(),
});
export type SideEffect = z.infer<typeof sideEffectSchema>;

export const manifestSchema = z.object({
	v: z.literal(2),
	effort_id: z.string().min(1),
	project: z.string().min(1),
	title: z.string().min(1),
	created: z.string(),
	updated: z.string(),
	revision: z.number().int().nonnegative(),
	stage: stageSchema,
	overlays: z.object({
		blocked: z.string().nullable(),
		needs_tim: z.array(z.string()),
	}),
	session: sessionRefSchema.nullable(),
	watch: z.object({
		prs: z.array(z.string()),
		tickets: z.array(z.string()),
		slack_threads: z.array(z.string()),
	}),
	worktrees: z.array(z.string()),
	dispatches: z.array(dispatchSchema),
	evidence: z.array(evidenceSchema),
	side_effects: z.array(sideEffectSchema),
	cards: z.array(cardEntrySchema),
	decisions: z.array(z.object({ ts: z.number(), card_id: z.string(), answer: z.string() })),
	digest: z.string().max(CAPS.parkDigest).nullable(),
});
export type Manifest = z.infer<typeof manifestSchema>;

// ── Charter (SPEC §3.1) ──────────────────────────────────────────────────────
export const charterSchema = z.object({
	goal: z.string().min(1),
	acceptance_criteria: z.array(z.string().min(1)).min(1),
	constraints: z.array(z.string()),
	created: z.string(),
	charter_changes: z.array(
		z.object({ ts: z.number(), change: z.string().min(1), approved_by: z.literal("tim") }),
	),
});
export type Charter = z.infer<typeof charterSchema>;

// ── Event envelope (SPEC §4.1 — exact shape, no additions) ──────────────────
export const idemSchema = z.object({
	source: z.string().min(1), // e.g. "gh"
	external_id: z.string().min(1), // e.g. "pr:lindy-ai/lindy:25021:check:…"
	version: z.string().min(1), // updated_at or content hash
});
export type Idem = z.infer<typeof idemSchema>;

export const eventSchema = z.object({
	id: z.string().min(1), // ULID
	ts: z.string(),
	plane: planeSchema,
	type: z.string().min(1), // fact.pr.ci_state | judgment.assessment | tim.message | lifecycle.dispatch | …
	actor: z.string().min(1), // router:gh | owner | wf:pr-pipeline/01J… | tim
	data: z.record(z.string(), z.unknown()),
	/** Present on facts (dedup key, SPEC §4.3); judgments/decisions reference their subject inside `data`. */
	idem: idemSchema.optional(),
});
export type DeckEvent = z.infer<typeof eventSchema>;

// ── Command inbox (SPEC §4.5.3, D-A receipts) ────────────────────────────────
export const inboxCommandSchema = z.object({
	cmd_id: z.string().min(1),
	cmd: z.record(z.string(), z.unknown()),
	from: z.enum(["tim", "router"]),
	ts: z.number(),
	delivered: z.number().nullable(),
	acked: z.number().nullable(),
});
export type InboxCommand = z.infer<typeof inboxCommandSchema>;

// ── Lease file (SPEC §4.5) ───────────────────────────────────────────────────
export const leaseSchema = z.object({
	epoch: z.number().int().nonnegative(),
	token: z.string().min(1),
	holder: sessionRefSchema.nullable(),
	written: z.number(),
});
export type Lease = z.infer<typeof leaseSchema>;
