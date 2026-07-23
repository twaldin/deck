/**
 * Router control-socket protocol (run/router.sock, NDJSON, capability-auth'd
 * like the broker socket). This is the contract between the lifecycle-tools
 * extension (client) and the wake router (server) — most importantly
 * `dispatch`, which per SPEC §4.4 (D-D) returns ONLY after verified liveness
 * (session exists + first heartbeat) or fails with E_LIVENESS.
 */
import { z } from "zod";
import { sessionRefSchema } from "./schemas";

export const routerRequestSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("status"),
		id: z.string(),
		cap: z.string(),
	}),
	z.object({
		op: z.literal("wake"),
		id: z.string(),
		cap: z.string(),
		effort_id: z.string().min(1),
		reason: z.string().min(1),
	}),
	z.object({
		/** Spawn a worker/workflow for an effort; returns after liveness (D-D). */
		op: z.literal("dispatch"),
		id: z.string(),
		cap: z.string(),
		effort_id: z.string().min(1),
		kind: z.enum(["workflow", "subagent"]),
		target: z.string().min(1), // workflow name@version or model/role for subagent
		brief: z.string().min(1),
		/** Lease token of the calling owner — router verifies before spawning. */
		lease_token: z.string().min(1),
	}),
	z.object({
		/** Fencing cancel of a dispatch (SPEC §4.5.3). */
		op: z.literal("cancel"),
		id: z.string(),
		cap: z.string(),
		effort_id: z.string().min(1),
		dispatch_id: z.string().min(1),
	}),
]);
export type RouterRequest = z.infer<typeof routerRequestSchema>;

export const routerResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		id: z.string(),
		data: z.record(z.string(), z.unknown()),
	}),
	z.object({
		ok: z.literal(false),
		id: z.string(),
		code: z.string(), // DeckErrorCode
		error: z.string(),
	}),
]);
export type RouterResponse = z.infer<typeof routerResponseSchema>;

/** dispatch success payload shape (inside data). */
export const dispatchResultSchema = z.object({
	dispatch_id: z.string(),
	session: sessionRefSchema,
});
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
