/**
 * Deck-home integration: durable intake events + task correlation.
 *
 * The poller's diff engine is edge-triggered (a change is emitted once, then
 * the state file advances), so appending each change here yields a durable,
 * append-only event log that deck-v2's wake engine can consume with a byte
 * cursor — same discipline as `.status` files. Events are appended BEFORE the
 * state file advances: a crash in between re-detects the same diff next run,
 * so delivery is at-least-once, never lost.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePrUrl } from "./diff";
import type { DiffChange, IntakeState, PrItem } from "./schema";

/** Same home the deck-v2 fleet uses. DECK_V2_HOME keeps tests off the live home. */
export function deckHome(): string {
	return process.env.DECK_V2_HOME ?? path.join(os.homedir(), ".deck");
}

export function deckStateDir(): string {
	return path.join(deckHome(), "state");
}

/** Append-only intake event log, consumed by deck-v2 wake reconcile. */
export function intakeEventsFile(): string {
	return path.join(deckHome(), "intake", "events.jsonl");
}

/** One durable intake event, one JSON object per line. */
export type IntakeEvent = {
	v: 1;
	ts: string;
	kind: DiffChange["kind"];
	url: string;
	/** Correlated deck task id, or null when the PR maps to no known task. */
	taskId: string | null;
	/** High signal: the polled login was newly asked for review. */
	signal: boolean;
	/** One human-readable line (includes the URL). */
	note: string;
};

/** The correlation keys a deck task record can carry (from `<id>.meta`). */
export type TaskRef = {
	taskId: string;
	pr?: string;
	branch?: string;
	worktree?: string;
	/** "owner/name", resolved from the worktree's origin remote when possible. */
	repo?: string;
};

/**
 * "owner/name" from a GITHUB remote URL, else null. The host must be
 * github.com: a gitlab/mirror remote with the same owner/name is NOT the same
 * repo, and returning it would let a same-branch collision correlate wrongly.
 */
export function parseRepoFromRemote(url: string): string | null {
	const match =
		/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
			url.trim(),
		);
	return match?.[1] ?? null;
}

/** The worktree's origin repo, or null when the worktree is gone/unreadable. */
function repoFromWorktree(worktree: string): string | null {
	const run = spawnSync("git", ["-C", worktree, "remote", "get-url", "origin"], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (run.status !== 0 || typeof run.stdout !== "string") return null;
	return parseRepoFromRemote(run.stdout);
}

/**
 * Read every task's correlation keys from the deck state dir. The `.meta`
 * format is fm2's `key=value` lines; only the keys used for correlation are
 * kept. A missing dir means no fleet on this machine — no refs, not an error.
 */
export function readTaskRefs(stateDir: string = deckStateDir()): TaskRef[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(stateDir);
	} catch {
		return [];
	}
	const refs: TaskRef[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".meta") || entry.startsWith(".")) continue;
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(stateDir, entry), "utf8");
		} catch {
			continue;
		}
		const ref: TaskRef = { taskId: entry.slice(0, -".meta".length) };
		for (const line of raw.split("\n")) {
			const eq = line.indexOf("=");
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			const value = line.slice(eq + 1).trim();
			if (value.length === 0) continue;
			if (key === "pr") ref.pr = value;
			else if (key === "branch") ref.branch = value;
			else if (key === "worktree") ref.worktree = value;
		}
		// Branch names are only unique within a repo, so a branch match needs the
		// task's repo. Resolved from the live worktree's origin remote; a torn-down
		// worktree leaves it unknown and the ref is then excluded from branch
		// matching entirely (a finished task correlates by PR URL anyway).
		if (ref.branch !== undefined && ref.worktree !== undefined) {
			const repo = repoFromWorktree(ref.worktree);
			if (repo !== null) ref.repo = repo;
		}
		refs.push(ref);
	}
	return refs;
}

/**
 * Correlate one PR to a deck task. A PR-URL match wins over a branch match.
 * A branch match REQUIRES the task's repo to be known and equal to the PR's
 * repo (a branch name is only unique within a repo), and an ambiguous match
 * (two tasks, same branch, same repo) correlates to nothing rather than to
 * the wrong task.
 */
export function correlate(
	item: Pick<PrItem, "url" | "headRef" | "repo">,
	refs: TaskRef[],
): string | null {
	const url = normalizePrUrl(item.url);
	for (const ref of refs) {
		if (ref.pr !== undefined && normalizePrUrl(ref.pr) === url) return ref.taskId;
	}
	const byBranch = new Set<string>();
	for (const ref of refs) {
		if (ref.branch === undefined || ref.branch !== item.headRef) continue;
		if (ref.repo === undefined || ref.repo !== item.repo) continue;
		byBranch.add(ref.taskId);
	}
	if (byBranch.size === 1) return [...byBranch][0] ?? null;
	return null;
}

/**
 * Note text stays within enums, GitHub logins ([a-zA-Z0-9-]), "owner/name#N"
 * and API-provided URLs. PR TITLES ARE DELIBERATELY EXCLUDED: the note is
 * injected into the orchestrator's context as an operational message, and a
 * title is attacker-writable free text (anyone who can open or retitle a PR
 * in a polled repo). Titles live on human-facing surfaces only — the markdown
 * report and `deck-intake ls`.
 */
function describe(change: DiffChange, ref: string): { note: string; signal: boolean } {
	switch (change.kind) {
		case "new":
			return {
				note: `new PR (${change.buckets.join(",")}): ${ref} ${change.url}`,
				signal: change.reviewRequested,
			};
		case "removed":
			return { note: `PR ${change.resolution}: ${ref} ${change.url}`, signal: false };
		case "ci":
			return { note: `ci ${change.from}->${change.to}: ${ref} ${change.url}`, signal: false };
		case "review-decision":
			return {
				note: `review ${change.from}->${change.to}: ${ref} ${change.url}`,
				signal: false,
			};
		case "reviewers": {
			const parts = [
				...change.added.map((login) => `+${login}`),
				...change.removed.map((login) => `-${login}`),
			];
			return {
				note: `reviewers ${parts.join(",")}: ${ref} ${change.url}`,
				signal: change.selfRequested,
			};
		}
		case "buckets":
			return {
				note: `buckets ${change.from.join(",")}->${change.to.join(",")}: ${ref} ${change.url}`,
				signal: change.reviewRequested,
			};
		case "untracked":
			return { note: `untracked: ${ref} ${change.url}`, signal: false };
	}
}

/**
 * Map a poll's changes to durable events. Pure. `untracked` is excluded: it is
 * a standing condition recomputed every run (it would spam the log), and it is
 * listable via `deck-intake ls` instead. Correlation uses the current item,
 * falling back to the previous snapshot for removed PRs.
 */
export function buildIntakeEvents(
	changes: DiffChange[],
	current: IntakeState,
	previous: IntakeState,
	refs: TaskRef[],
	now: () => Date = () => new Date(),
): IntakeEvent[] {
	const events: IntakeEvent[] = [];
	for (const change of changes) {
		if (change.kind === "untracked") continue;
		const item = current.items[change.url] ?? previous.items[change.url];
		const ref = item === undefined ? "" : `${item.repo}#${item.number}`;
		const { note, signal } = describe(change, ref);
		events.push({
			v: 1,
			ts: now().toISOString(),
			kind: change.kind,
			url: change.url,
			taskId: item === undefined ? null : correlate(item, refs),
			signal,
			note,
		});
	}
	return events;
}

/**
 * Append events, one JSON object per line. A torn tail line (crash mid-append)
 * is reported and skipped by the consumer — but only if the NEXT append does
 * not glue onto it, so a file that does not end in a newline gets one first.
 */
export function appendIntakeEvents(filePath: string, events: IntakeEvent[]): void {
	if (events.length === 0) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	let prefix = "";
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > 0) {
			const fd = fs.openSync(filePath, "r");
			try {
				const tail = Buffer.alloc(1);
				fs.readSync(fd, tail, 0, 1, stat.size - 1);
				if (tail[0] !== 0x0a) prefix = "\n";
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		// No file yet: nothing to repair.
	}
	const lines = events.map((event) => JSON.stringify(event)).join("\n");
	fs.appendFileSync(filePath, `${prefix}${lines}\n`, { mode: 0o600 });
}
