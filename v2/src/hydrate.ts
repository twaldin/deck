/**
 * The hydration contract.
 *
 * Every run is fresh, so "what a run is guaranteed to know" has to be a written
 * contract; otherwise hydration quality is folklore that decays. Session
 * continuity across processes is proven, but sufficiency is a design obligation.
 *
 * Elements 1-3 are ALWAYS included and never truncated. 4-8 are budget-filled,
 * newest first. Explicitly rejected: full boot dumps (fm2's session-start digest
 * was 578 lines / 143KB / 16s) and whole-transcript replay.
 *
 * Element 6 is why ephemeral runs are BETTER than long-lived ones rather than
 * merely equal: external state is re-fetched, never remembered, so a run cannot
 * hold a stale belief about CI that it never formed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { openDecisions, readStatus } from "./events";
import { taskFiles } from "./home";
import { readMeta } from "./meta";
import { drain } from "./queue";
import { unresolvedReceipts } from "./side-effects";

export type HydrationOptions = {
	/** Bounded status tail. Newest events matter; ancient ones do not. */
	statusTail?: number;
	/** Character budget for the whole seed. Tight by posture. */
	budget?: number;
};

const DEFAULT_STATUS_TAIL = 15;
const DEFAULT_BUDGET = 12_000;

/**
 * Build the hydration seed for a run.
 *
 * `drain` marks queued messages acked, so this has a side effect on purpose: a
 * message is delivered exactly once, and the ack is durable.
 */
export function buildHydration(taskId: string, epoch: number, options: HydrationOptions = {}): string {
	const statusTail = options.statusTail ?? DEFAULT_STATUS_TAIL;
	const budget = options.budget ?? DEFAULT_BUDGET;
	const meta = readMeta(taskId);
	const sections: string[] = [];

	// --- Element 2: queued messages (never truncated) ------------------------
	// Drained first so a steer can never be lost to a budget decision.
	const messages = drain(taskId, epoch);
	if (messages.length > 0) {
		sections.push(
			`## Messages for you\n\n${messages
				.map((m) => `- (${m.from}) ${m.text}`)
				.join("\n")}\n\nAct on these before continuing.`,
		);
	}

	// --- Element 3: open decisions (never truncated) -------------------------
	const open = openDecisions(taskId);
	if (open.size > 0) {
		sections.push(
			`## Open decisions — do NOT act against these\n\n${[...open.entries()]
				.map(([key, event]) => `- [${key}] ${event.note}`)
				.join(
					"\n",
				)}\n\nThese are with the captain. Do not re-ask, and do not pick an answer yourself.`,
		);
	}

	// --- Element 7: worktree delta (mandatory after a cancel) ----------------
	const delta = worktreeDelta(meta?.worktree);
	if (delta !== null) {
		sections.push(
			`## Uncommitted state in your worktree\n\n\`\`\`\n${delta}\n\`\`\`\n\nA previous run may have been interrupted mid-edit. Check this against your last commit before you act.`,
		);
	}

	// --- Unresolved side effects: may have changed the world -----------------
	const pending = unresolvedReceipts(taskId);
	if (pending.length > 0) {
		sections.push(
			`## Unresolved irreversible operations\n\n${pending
				.map((r) => `- ${r.op} on ${r.target} started ${r.started_at} (receipt ${r.receipt_id})`)
				.join(
					"\n",
				)}\n\nEach may have taken effect. Ask the provider what actually happened before retrying anything. Never retry blind.`,
		);
	}

	// --- Element 4: bounded status tail --------------------------------------
	const { events, malformed } = readStatus(taskId);
	if (events.length > 0) {
		const tail = events.slice(-statusTail);
		sections.push(
			`## Your recent events\n\n${tail.map((e) => `- ${e.raw.trim()}`).join("\n")}`,
		);
	}
	if (malformed.length > 0) {
		sections.push(
			`## Malformed status lines detected\n\n${malformed
				.slice(-3)
				.map((m) => `- ${m.raw.trim()} (${m.reason})`)
				.join("\n")}\n\nStart every line with the verb.`,
		);
	}

	// --- Element 8: run identity --------------------------------------------
	sections.push(
		`## Run\n\n- task: ${taskId}\n- epoch: ${epoch}${
			meta?.worktree === undefined ? "" : `\n- worktree: ${meta.worktree}`
		}${meta?.branch === undefined ? "" : `\n- branch: ${meta.branch}`}${
			meta?.pr === undefined ? "" : `\n- PR: ${meta.pr}`
		}`,
	);

	const seed = sections.join("\n\n");
	return seed.length <= budget ? seed : `${seed.slice(0, budget)}\n\n[seed truncated at budget]`;
}

/** `git status --porcelain`, or null when clean/unavailable. */
export function worktreeDelta(worktree: string | undefined): string | null {
	if (worktree === undefined || !fs.existsSync(worktree)) return null;
	try {
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd: worktree,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length === 0 ? null : out;
	} catch {
		return null;
	}
}

/** Element 1: the charter. Read from the brief, which is immutable once written. */
export function charter(taskId: string): string | null {
	try {
		return fs.readFileSync(taskFiles(taskId).brief, "utf8");
	} catch {
		return null;
	}
}
