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
};

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
		refs.push(ref);
	}
	return refs;
}

/**
 * Correlate one PR to a deck task. A PR-URL match wins over a branch match;
 * an ambiguous branch match (two tasks, same branch name across repos)
 * correlates to nothing rather than to the wrong task.
 */
export function correlate(
	item: Pick<PrItem, "url" | "headRef">,
	refs: TaskRef[],
): string | null {
	const url = normalizePrUrl(item.url);
	for (const ref of refs) {
		if (ref.pr !== undefined && normalizePrUrl(ref.pr) === url) return ref.taskId;
	}
	const byBranch = new Set<string>();
	for (const ref of refs) {
		if (ref.branch !== undefined && ref.branch === item.headRef) byBranch.add(ref.taskId);
	}
	if (byBranch.size === 1) return [...byBranch][0] ?? null;
	return null;
}

function describe(change: DiffChange, title: string): { note: string; signal: boolean } {
	switch (change.kind) {
		case "new":
			return {
				note: `new PR (${change.buckets.join(",")}): ${title} ${change.url}`,
				signal: change.reviewRequested,
			};
		case "removed":
			return { note: `PR ${change.resolution}: ${title} ${change.url}`, signal: false };
		case "ci":
			return { note: `ci ${change.from}->${change.to}: ${title} ${change.url}`, signal: false };
		case "review-decision":
			return {
				note: `review ${change.from}->${change.to}: ${title} ${change.url}`,
				signal: false,
			};
		case "reviewers": {
			const parts = [
				...change.added.map((login) => `+${login}`),
				...change.removed.map((login) => `-${login}`),
			];
			return {
				note: `reviewers ${parts.join(",")}: ${title} ${change.url}`,
				signal: change.selfRequested,
			};
		}
		case "buckets":
			return {
				note: `buckets ${change.from.join(",")}->${change.to.join(",")}: ${title} ${change.url}`,
				signal: change.reviewRequested,
			};
		case "untracked":
			return { note: `untracked: ${title} ${change.url}`, signal: false };
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
		const title = item?.title ?? ("title" in change ? change.title : change.url);
		const { note, signal } = describe(change, title);
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

/** Append events, one JSON object per line. A torn tail line is skipped on read. */
export function appendIntakeEvents(filePath: string, events: IntakeEvent[]): void {
	if (events.length === 0) return;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const lines = events.map((event) => JSON.stringify(event)).join("\n");
	fs.appendFileSync(filePath, `${lines}\n`, { mode: 0o600 });
}
