/**
 * Reclaim worktrees whose work has landed.
 *
 * The wt system allocated worktrees and never reclaimed one - a laptop reached
 * 192GB across 39 worktrees, the oldest from a retired era. `releaseWorktree`
 * frees only the lock, and `evaluateTeardown` deliberately never acts on its own
 * verdict.
 *
 * That verdict is also not sufficient authority to delete. It cannot see
 * Smithers, so it only tests for an active run when the caller proves one; it
 * allows a clean pushed branch whose PR is still OPEN; and effort records can
 * name adopted or hand-made checkouts. Every one of those gaps is closed here,
 * and the deletion itself happens under the worktree's own lock so a run cannot
 * claim the slot between the check and the removal.
 *
 * Dependencies are injected so the destructive path is testable without a live
 * GitHub, a live Smithers, or the operator's real home.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateTeardown } from "./teardown";
import type { TaskMeta } from "./meta";

/** Lock owner the reaper holds while it deletes, so no run can claim the slot. */
export const REAPER_OWNER = "deck-reap";

export type ReapDeps = {
	/** Every effort with a durable record. */
	efforts(): TaskMeta[];
	/** Deck-owned worktree root; anything outside it is refused. */
	wtRoot(): string;
	/** MERGED | CLOSED | OPEN | UNKNOWN. */
	prState(reference: string): string;
	/** Smithers runs plus whether the enumeration can be trusted. */
	runs(): Promise<{ liveEffortIds: Set<string>; healthy: boolean }>;
	/** Throws when a living or durable owner holds the slot. */
	claim(worktree: string, owner: string): () => void;
	/** Cheap preflight; the claim is the real authority. */
	lockIsLive(worktree: string): boolean;
	/** Returns an error string on failure, or null on success. */
	remove(worktree: string): string | null;
};

export type ReapResult = { apply: boolean; cleared: string[]; refused: string[] };

export async function reapWorktrees(deps: ReapDeps, apply: boolean): Promise<ReapResult> {
	const { liveEffortIds, healthy } = await deps.runs();
	if (!healthy) {
		// A failed read is not evidence of idleness.
		throw new Error("cannot enumerate Smithers runs, so no worktree can be proven idle; refusing to reap");
	}
	const root = deps.wtRoot();
	const cleared: string[] = [];
	const refused: string[] = [];

	for (const effort of deps.efforts()) {
		const worktree = effort.worktree;
		if (worktree === undefined || !fs.existsSync(worktree)) continue;
		const resolved = fs.realpathSync(worktree);

		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
			refused.push(`${effort.id}\tE_NOT_DECK_OWNED`);
			continue;
		}
		if (deps.lockIsLive(resolved)) {
			refused.push(`${effort.id}\tE_LOCK_LIVE`);
			continue;
		}
		if (effort.pr === undefined) {
			refused.push(`${effort.id}\tE_NO_PR`);
			continue;
		}
		const state = deps.prState(effort.pr);
		if (state !== "MERGED" && state !== "CLOSED") {
			refused.push(`${effort.id}\tE_PR_${state}`);
			continue;
		}
		const activeRun = liveEffortIds.has(effort.id);
		const verdict = evaluateTeardown(effort.id, { activeRun });
		if (!verdict.allowed) {
			refused.push(`${effort.id}\t${verdict.refusals.map((r) => r.code).join(",")}`);
			continue;
		}
		if (!apply) {
			cleared.push(`${effort.id}\t${resolved}`);
			continue;
		}

		let release: (() => void) | undefined;
		try {
			release = deps.claim(resolved, REAPER_OWNER);
		} catch {
			refused.push(`${effort.id}\tE_LOCK_LIVE`);
			continue;
		}
		try {
			// Re-verified while holding the lock: everything above was read before
			// this process owned the slot.
			const held = evaluateTeardown(effort.id, { activeRun: false });
			if (!held.allowed) {
				refused.push(`${effort.id}\t${held.refusals.map((r) => r.code).join(",")}`);
				continue;
			}
			const failure = deps.remove(resolved);
			if (failure !== null) {
				refused.push(`${effort.id}\tE_REMOVE_FAILED ${failure.slice(0, 160)}`);
				continue;
			}
			cleared.push(`${effort.id}\t${resolved}`);
		} finally {
			release?.();
		}
	}
	return { apply, cleared, refused };
}
