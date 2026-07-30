/**
 * Teardown guard. The one piece whose refusal must never be bypassed.
 *
 * Ported from fm2's bin/fm-teardown.sh (1239 lines) as rules, not shell. The
 * refusal is a stop-and-investigate result, never an obstacle to work around.
 *
 * Two hardenings over a naive implementation:
 *
 * 1. Landing is tested by searching main for the squash commit `(#N)`, NEVER by
 *    the GitHub `merged` flag. A Graphite queue-merged PR reads
 *    `state=closed, merged=false` — three confirmed repros (#24043, #25397,
 *    #25810). A naive merged-flag check would discard landed work.
 *
 * 2. Evidence-bearing worktrees are refused in CODE, not in a memory note.
 *    fm2's learnings protect treehouse slots holding frozen pre-force-push
 *    originals and uncommitted work; prose guarding irreplaceable evidence is
 *    exactly the decay class that loses it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readMeta } from "./meta";
import { taskFiles } from "./home";
import { openDecisions } from "./events";

export type TeardownRefusal = {
	code:
		| "E_DIRTY"
		| "E_UNPUSHED"
		| "E_NOT_LANDED"
		| "E_NO_REPORT"
		| "E_OPEN_DECISION"
		| "E_PROTECTED_SLOT"
		| "E_ACTIVE_RUN"
		| "E_NO_META"
		| "E_NO_WORKTREE";
	message: string;
	/** What the operator should inspect. Never "use --force". */
	inspect?: string;
};

export type TeardownVerdict =
	| { allowed: true; notes: string[] }
	| { allowed: false; refusals: TeardownRefusal[] };

/**
 * Worktree slots holding irreplaceable evidence. A path whose realpath sits
 * inside one of these is refused outright.
 *
 * Seeded from fm2 data/learnings.md: slots 21/24 hold frozen pre-force-push
 * originals, plus the recorded uncommitted-work list.
 */
export function protectedWorktrees(): readonly string[] {
	return (process.env.DECK_PROTECTED_WORKTREES ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
}

/** Uncommitted tracked changes OR untracked files. Both block teardown. */
export function isDirty(worktree: string): { dirty: boolean; detail: string } {
	const status = tryGit(worktree, ["status", "--porcelain"]);
	if (status === null) return { dirty: true, detail: "git status failed; cannot prove clean" };
	if (status.length === 0) return { dirty: false, detail: "" };
	return { dirty: true, detail: status.split("\n").slice(0, 10).join("; ") };
}

/**
 * Commits on this branch not reachable from any remote ref.
 *
 * This is the "unlanded work" test in its strongest form: reachability from a
 * remote, not a merge flag and not an ancestor check against a possibly-stale
 * local main.
 */
export function unpushedCommits(worktree: string): string[] {
	// Argument order is load-bearing: `--not --remotes HEAD` applies the negation
	// to HEAD as well and always yields nothing, silently reporting all work as
	// pushed. `HEAD --not --remotes` is "reachable from HEAD, not from any remote".
	const unreachable = tryGit(worktree, ["log", "--format=%h %s", "HEAD", "--not", "--remotes"]);
	if (unreachable === null || unreachable.length === 0) return [];
	return unreachable.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Landed test, lands-and-closes safe: is there a squash commit referencing
 * `(#N)` on the given base ref?
 */
export function findLandingCommit(
	worktree: string,
	prNumber: number,
	baseRef = "origin/main",
): string | null {
	const found = tryGit(worktree, [
		"log",
		baseRef,
		"--format=%H %s",
		`--grep=(#${prNumber})`,
		"--fixed-strings",
		"-n",
		"5",
	]);
	if (found === null || found.length === 0) return null;
	const first = found.split("\n")[0];
	return first === undefined || first.trim().length === 0 ? null : first;
}

function realpath(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

export function isProtectedWorktree(worktree: string): string | null {
	const resolved = realpath(worktree);
	for (const guarded of protectedWorktrees()) {
		const guardedResolved = realpath(guarded);
		if (resolved === guardedResolved || resolved.startsWith(`${guardedResolved}${path.sep}`)) {
			return guardedResolved;
		}
	}
	return null;
}

export type TeardownOptions = {
	/** A scout task must have left its report before its scratch is discarded. */
	kind?: "ship" | "scout";
	/** PR number, when the task shipped one. Enables the landed test. */
	prNumber?: number;
	baseRef?: string;
	/** True when a workflow run for this task is still non-terminal. */
	activeRun?: boolean;
};

/**
 * Decide whether a task may be torn down. Pure inspection: never mutates, never
 * deletes. The caller acts on the verdict.
 */
export function evaluateTeardown(taskId: string, options: TeardownOptions = {}): TeardownVerdict {
	const refusals: TeardownRefusal[] = [];
	const notes: string[] = [];

	const meta = readMeta(taskId);
	if (meta === null) {
		return {
			allowed: false,
			refusals: [
				{
					code: "E_NO_META",
					message: `no metadata for ${taskId}: refusing to tear down a task whose record is missing`,
					inspect: "state/<id>.meta",
				},
			],
		};
	}

	const kind = options.kind ?? meta.kind ?? "ship";
	const worktree = meta.worktree;

	if (options.activeRun === true) {
		refusals.push({
			code: "E_ACTIVE_RUN",
			message: `a run for ${taskId} is still non-terminal; teardown would orphan it`,
			inspect: "smithers ps --json / the task's run_id",
		});
	}

	// Scout completion gate: the report is the only thing that survives.
	if (kind === "scout") {
		const report = taskFiles(taskId).report;
		if (!fs.existsSync(report)) {
			refusals.push({
				code: "E_NO_REPORT",
				message: `scout ${taskId} has no report; its scratch worktree is the only copy of the findings`,
				inspect: report,
			});
		}
	}

	// Unresolved captain decisions block completion (decision-hold lifecycle).
	const open = openDecisions(taskId);
	if (open.size > 0) {
		refusals.push({
			code: "E_OPEN_DECISION",
			message: `${taskId} has ${open.size} unresolved decision(s): ${[...open.keys()].join(", ")}`,
			inspect: "state/<id>.status needs-decision lines without a matching resolved",
		});
	}

	if (worktree === undefined || worktree.length === 0) {
		refusals.push({
			code: "E_NO_WORKTREE",
			message: `${taskId} records no worktree; nothing to tear down and nothing proven safe`,
			inspect: "state/<id>.meta worktree=",
		});
		return refusals.length === 0 ? { allowed: true, notes } : { allowed: false, refusals };
	}

	const guarded = isProtectedWorktree(worktree);
	if (guarded !== null) {
		refusals.push({
			code: "E_PROTECTED_SLOT",
			message: `${worktree} is inside protected path ${guarded}: it holds evidence that is not recoverable from a remote`,
			inspect: "DECK_PROTECTED_WORKTREES / data/learnings.md evidence list",
		});
	}

	if (!fs.existsSync(worktree)) {
		notes.push(`worktree ${worktree} is already gone`);
		return refusals.length === 0 ? { allowed: true, notes } : { allowed: false, refusals };
	}

	const dirty = isDirty(worktree);
	if (dirty.dirty) {
		refusals.push({
			code: "E_DIRTY",
			message: `${worktree} has uncommitted or untracked changes: ${dirty.detail}`,
			inspect: `git -C ${worktree} status`,
		});
	}

	const unpushed = unpushedCommits(worktree);
	if (unpushed.length > 0) {
		// Landed work is safe even when unreachable from a remote branch, because
		// a squash-merge rewrites the commit. This is the lands-and-closes case.
		const landing =
			options.prNumber === undefined
				? null
				: findLandingCommit(worktree, options.prNumber, options.baseRef);
		if (landing === null) {
			refusals.push({
				code: options.prNumber === undefined ? "E_UNPUSHED" : "E_NOT_LANDED",
				message:
					options.prNumber === undefined
						? `${worktree} has ${unpushed.length} commit(s) not reachable from any remote: ${unpushed[0] ?? ""}`
						: `PR #${options.prNumber} has no squash commit on ${options.baseRef ?? "origin/main"} and ${unpushed.length} local commit(s) are unreachable from a remote`,
				inspect: `git -C ${worktree} log --not --remotes HEAD`,
			});
		} else {
			notes.push(
				`landed as ${landing} (found by searching for (#${options.prNumber}); the merged flag is never the test)`,
			);
		}
	}

	return refusals.length === 0 ? { allowed: true, notes } : { allowed: false, refusals };
}

export function formatVerdict(taskId: string, verdict: TeardownVerdict): string {
	if (verdict.allowed) {
		const notes = verdict.notes.length > 0 ? `\n${verdict.notes.map((n) => `  note: ${n}`).join("\n")}` : "";
		return `teardown allowed: ${taskId}${notes}`;
	}
	const lines = verdict.refusals.map(
		(refusal) =>
			`  ${refusal.code}: ${refusal.message}${refusal.inspect === undefined ? "" : `\n    inspect: ${refusal.inspect}`}`,
	);
	return [
		`teardown REFUSED: ${taskId}`,
		...lines,
		"",
		"This is a stop-and-investigate result. Do not bypass it.",
		"Discarding this work needs explicit captain authorization for THIS task.",
	].join("\n");
}
