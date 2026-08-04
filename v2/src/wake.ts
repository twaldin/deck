/**
 * Wake engine: severity-tiered, coalesced, edge-triggered.
 *
 * fm2's measured failure, re-measured live before this was written:
 *   2216-line triage log, 1844 `absorbed stale` records (was 933 at the day-1
 *   snapshot, so it accumulates rather than converging), and 80 of 163 status
 *   lines — 49% — were `working:`, each firing a wake that needed no action.
 *
 * Three causes, all addressed here:
 *   level-triggered  -> every condition carries a durable baseline; only CHANGE
 *                       wakes, so a standing condition stops re-firing.
 *   no baseline      -> the baseline is on disk, so a restart does not re-fire
 *                       everything it already reported.
 *   working: woke     -> T2 never wakes. It updates counters only.
 *
 * Reconcile is the source of truth; fs.watch is a latency hint. fs.watch on
 * macOS misses events, breaks across atomic replace, and coalesces bursts, so
 * treating it as truth would rebuild the silent-watcher class under a new name.
 * Because `.status` is append-only and the cursor is identity-aware, a missed
 * event is LATE, never LOST.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CursorStore,
	type StatusCursor,
	loadCursors,
	readFileSince,
	readStatus,
	readStatusSince,
	saveCursors,
} from "./events";
import { intakeFiles, stateDir, wakeFiles } from "./home";
import { readMeta } from "./meta";
import { type StatusEvent, type WakeTier, tierFor } from "./status";

/**
 * The shape a wake carries. `.status` lines produce StatusEvents; the intake
 * event log produces synthetic events with verb "intake". Consumers only read
 * verb + note for display, so the widening is safe.
 */
export type WakeEvent = {
	verb: string;
	key: string;
	note: string;
	raw: string;
};

export type WakeItem = {
	taskId: string;
	tier: WakeTier;
	event: WakeEvent;
};

export type ReconcileResult = {
	/** T0: deliver now, one message per event. */
	interrupt: WakeItem[];
	/** T1: deliver as ONE folded summary this cycle. */
	batched: WakeItem[];
	/** T2: recorded only. Never delivered. */
	silent: WakeItem[];
	/** Cursor invalidations, worth surfacing as source health. */
	rescanned: string[];
	/** Malformed status lines, surfaced rather than swallowed. */
	malformed: Array<{ taskId: string; raw: string; reason: string }>;
};

type Baseline = Record<string, { lastTier: WakeTier; lastRaw: string; count: number }>;

/** Durable, edge-triggered conditions that do not have a .status producer. */
export type WakeCondition = {
	key: "max-adversarial" | "reviewer-silent" | "main-red" | "migration-gate" | "broker-no-quota" | "needs-decision" | "ci-fail" | "actionable-comment" | "decision-ask";
	taskId: string;
	note: string;
	/** T0 is used for failures and gates; reviewer silence is batched. */
	tier?: WakeTier;
};

/** Record external workflow conditions in the same durable outbox as status events. */
export function enqueueWakeConditions(conditions: WakeCondition[]): void {
	const items: WakeItem[] = conditions.map((condition) => ({
		taskId: condition.taskId,
		tier: condition.tier ?? (condition.key === "reviewer-silent" ? "T1" : "T0"),
		event: { verb: condition.key, key: condition.key, note: condition.note, raw: `${condition.key}:${condition.note}` },
	}));
	if (items.length === 0) return;
	// Conditions use the same baseline, so a persistent gate creates one wake.
	const baseline = loadBaseline();
	const fresh = items.filter((item) => {
		const previous = baseline[`${item.taskId}:${item.event.key}`];
		if (previous?.lastRaw === item.event.raw) return false;
		baseline[`${item.taskId}:${item.event.key}`] = { lastTier: item.tier, lastRaw: item.event.raw, count: (previous?.count ?? 0) + 1 };
		return true;
	});
	saveBaseline(baseline);
	enqueue(fresh);
}

function loadBaseline(): Baseline {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(wakeFiles().baseline, "utf8"));
		if (parsed !== null && typeof parsed === "object") return parsed as Baseline;
		return {};
	} catch {
		return {};
	}
}

function saveBaseline(baseline: Baseline): void {
	const file = wakeFiles().baseline;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Clear resolved external conditions so a later recurrence is a new edge. */
export function clearWakeConditions(taskId: string, keys: WakeCondition["key"][]): void {
	const baseline = loadBaseline();
	for (const key of keys) delete baseline[`${taskId}:${key}`];
	saveBaseline(baseline);
}

/** Tasks deck owns. An fm2-owned task is skipped during the parallel run. */
export function deckOwnedTasks(): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(stateDir());
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.endsWith(".status")) continue;
		const id = entry.slice(0, -".status".length);
		if (id.startsWith(".")) continue;
		const meta = readMeta(id);
		// Absent marker means deck: fm2 sets its own explicitly during migration.
		if (meta === null || meta.owner_system === undefined || meta.owner_system === "deck") {
			ids.add(id);
		}
	}
	return [...ids].sort();
}

/**
 * One reconcile pass. This is the whole engine: it is safe to call on a timer,
 * on an fs.watch nudge, and at session start, and it produces the same result
 * from durable state either way.
 */
export function reconcile(taskIds?: string[]): ReconcileResult {
	const ids = taskIds ?? deckOwnedTasks();
	const cursors = loadCursors();
	const baseline = loadBaseline();
	const result: ReconcileResult = {
		interrupt: [],
		batched: [],
		silent: [],
		rescanned: [],
		malformed: [],
	};

	for (const taskId of ids) {
		const previous: StatusCursor | null = cursors[taskId] ?? null;
		const read = readStatusSince(taskId, previous);
		if (read.cursor !== null) cursors[taskId] = read.cursor;
		if (read.rescanned) result.rescanned.push(taskId);
		for (const bad of read.malformed) {
			result.malformed.push({ taskId, raw: bad.raw, reason: bad.reason });
		}

		for (const event of read.events) {
			const tier = tierFor(event.verb);
			const item: WakeItem = { taskId, tier, event };

			if (tier === "T2") {
				// The absorbed-noise class. Counted, never delivered.
				result.silent.push(item);
				baseline[taskId] = {
					lastTier: tier,
					lastRaw: event.raw,
					count: (baseline[taskId]?.count ?? 0) + 1,
				};
				continue;
			}

			// Edge-triggered: an identical repeat of the last reported line is a
			// standing condition, not a new event.
			const previousEntry = baseline[taskId];
			const unchanged =
				previousEntry !== undefined &&
				previousEntry.lastRaw.trim() === event.raw.trim() &&
				previousEntry.lastTier === tier;

			baseline[taskId] = {
				lastTier: tier,
				lastRaw: event.raw,
				count: (previousEntry?.count ?? 0) + 1,
			};
			if (unchanged) {
				result.silent.push(item);
				continue;
			}

			if (tier === "T0") result.interrupt.push(item);
			else result.batched.push(item);
		}
	}

	consumeIntake(cursors, baseline, result);

	saveCursors(cursors);
	saveBaseline(baseline);
	// The cursor has now advanced, so these events will never be re-read from the
	// status files. Persist them BEFORE returning: the caller may fail to inject,
	// or crash between reconcile and delivery, and a dropped `blocked:` is the
	// worst failure this system has. The outbox is what makes delivery
	// at-least-once instead of at-most-once.
	enqueue([...result.interrupt, ...result.batched]);
	return result;
}

/**
 * One line of the intake event log (written by deck-intake; see intake/src/deck.ts).
 * Only the fields reconcile acts on — unknown fields are ignored, so the two
 * packages can evolve without lockstep releases.
 */
type IntakeEventLine = {
	ts?: string;
	kind?: string;
	url?: string;
	taskId?: string | null;
	signal?: boolean;
	note?: string;
};

/** Reserved cursor key. A task id can never start with a dot. */
const INTAKE_CURSOR_KEY = ".intake";

/**
 * Consume new intake events. The intake poller's diff engine is already
 * edge-triggered (same PR review state never re-emits) and the durable
 * cursor never re-reads a consumed line.
 *
 * Tiering: a new review request is T0 (the captain owes a review NOW); an
 * event correlated to a deck task wakes that task as T1, as do removals and
 * review-decision changes on our own PRs (a human approved/blocked something).
 * Everything else — uncorrelated CI churn, new PRs we authored ourselves — is
 * recorded silently and listable via `deck-intake ls`.
 *
 * Edge triggering ALSO applies here, via the durable baseline keyed per URL:
 * the poller appends events BEFORE advancing its state file, so a crash in
 * between re-emits the same diff next run (at-least-once), and an identical
 * repeat must not wake twice. Only an ADJACENT repeat is a duplicate — the
 * baseline holds the URL's latest event, so a legitimate re-occurrence later
 * (new → removed → new again, same title) has an intervening event and wakes.
 * The note is deterministic (no timestamp): identical kind+note, back to
 * back, is the crash replay and nothing else.
 */
function consumeIntake(cursors: CursorStore, baseline: Baseline, result: ReconcileResult): void {
	// ponytail: readFileSince re-reads and re-hashes the whole log per cycle,
	// same as .status files. At a few hundred bytes per real PR state change the
	// log grows a few MB per quarter; if it ever hurts, rotate the log (move it
	// aside; the identity cursor detects the swap and rescans the fresh file).
	const read = readFileSince(intakeFiles().events, cursors[INTAKE_CURSOR_KEY] ?? null);
	if (read.cursor === null) return;
	cursors[INTAKE_CURSOR_KEY] = read.cursor;
	if (read.rescanned) result.rescanned.push(INTAKE_CURSOR_KEY);

	for (const line of read.text.split("\n")) {
		if (line.trim().length === 0) continue;
		let event: IntakeEventLine;
		try {
			event = JSON.parse(line) as IntakeEventLine;
		} catch {
			result.malformed.push({ taskId: INTAKE_CURSOR_KEY, raw: line, reason: "not valid JSON" });
			continue;
		}
		const note = event.note ?? `${event.kind ?? "?"} ${event.url ?? ""}`.trim();
		const taskId = typeof event.taskId === "string" ? event.taskId : "intake";
		const tier: WakeTier =
			event.signal === true
				? "T0"
				: typeof event.taskId === "string" ||
						event.kind === "removed" ||
						event.kind === "review-decision"
					? "T1"
					: "T2";
		const item: WakeItem = {
			taskId,
			tier,
			event: { verb: "intake", key: "default", note, raw: line },
		};

		const dedupKey = `${INTAKE_CURSOR_KEY}:${event.url ?? "?"}`;
		const fingerprint = `${event.kind ?? "?"}|${note}`;
		const previousEntry = baseline[dedupKey];
		const duplicate =
			tier !== "T2" && previousEntry !== undefined && previousEntry.lastRaw === fingerprint;
		baseline[dedupKey] = {
			lastTier: tier,
			lastRaw: fingerprint,
			count: (previousEntry?.count ?? 0) + 1,
		};

		if (tier === "T2" || duplicate) result.silent.push(item);
		else if (tier === "T0") result.interrupt.push(item);
		else result.batched.push(item);
	}
}

/**
 * Durable wake outbox.
 *
 * Reconcile is truth for READING status files; it cannot also be the
 * acknowledgement of delivery, because the read advances a durable cursor while
 * the delivery happens in a different process step that can fail. Splitting them
 * is the difference between "we saw it" and "the orchestrator was told".
 */
type OutboxEntry = { id: string; taskId: string; tier: WakeTier; raw: string; note: string; verb: string };

/**
 * Monotonic counter for outbox ids.
 *
 * The id used to be `${taskId}:${raw}`, which is identical for two identical
 * status lines — and a worker blocked twice for the same reason writes exactly
 * that. Reproduced: both events collapsed into one entry, and acking it discarded
 * the second wake. Coalescing is a DELIVERY policy (fold T1 into one message); it
 * must never be storage identity, or acking a delivered event silently drops an
 * undelivered one.
 */
let outboxSeq = 0;

function outboxPath(): string {
	return wakeFiles().queue;
}

function enqueue(items: WakeItem[]): void {
	if (items.length === 0) return;
	const lines = items.map((item) =>
		JSON.stringify({
			id: `${item.taskId}:${Date.now().toString(36)}:${(outboxSeq++).toString(36)}`,
			taskId: item.taskId,
			tier: item.tier,
			raw: item.event.raw,
			note: item.event.note,
			verb: item.event.verb,
		} satisfies OutboxEntry),
	);
	fs.mkdirSync(path.dirname(outboxPath()), { recursive: true });
	// Append-only, one JSON object per line: a torn final line loses at most the
	// newest entry and is skipped on read, rather than corrupting the file.
	fs.appendFileSync(outboxPath(), `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** Everything still owed to the orchestrator, oldest first. */
export function pendingWakes(): OutboxEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(outboxPath(), "utf8");
	} catch {
		return [];
	}
	const entries: OutboxEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line) as OutboxEntry);
		} catch {
			// A torn tail line from a crash mid-append. Skipping it is correct:
			// the event is still in the status file's history for a rescan.
		}
	}
	return entries;
}

/**
 * Acknowledge delivery. Only called after the send is known to have happened.
 * Anything not acknowledged stays owed and is redelivered next cycle.
 */
export function ackWakes(ids: string[]): void {
	if (ids.length === 0) return;
	const done = new Set(ids);
	const remaining = pendingWakes().filter((entry) => !done.has(entry.id));
	const target = outboxPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, remaining.map((entry) => JSON.stringify(entry)).join("\n") + (remaining.length > 0 ? "\n" : ""), { mode: 0o600 });
	fs.renameSync(tmp, target);
}

/**
 * Fold a cycle's T1 items into ONE message.
 *
 * This is the fix for the captain's screenshot: six queued follow-ups each
 * burning a turn after the first drain had already handled them. One injection
 * per cycle, regardless of how many events arrived.
 */
export function foldBatched(items: WakeItem[]): string | null {
	if (items.length === 0) return null;
	const byTask = new Map<string, WakeEvent[]>();
	for (const item of items) {
		const list = byTask.get(item.taskId) ?? [];
		list.push(item.event);
		byTask.set(item.taskId, list);
	}
	const parts: string[] = [];
	for (const [taskId, events] of byTask) {
		const last = events[events.length - 1];
		if (last === undefined) continue;
		const extra = events.length > 1 ? ` (+${events.length - 1} earlier)` : "";
		parts.push(`${taskId}: ${last.verb} — ${last.note}${extra}`);
	}
	return `${byTask.size} task(s) updated. ${parts.join(" · ")}`;
}

/** T0 messages are delivered one per event; latency is the point. */
export function formatInterrupt(item: WakeItem): string {
	return `${item.taskId}: ${item.event.verb} — ${item.event.note}`;
}

export type StaleVerdict = {
	taskId: string;
	reason: string;
};

/**
 * Staleness, redefined as a FACT rather than a heuristic.
 *
 * There is no pane to be idle, so the only real stale conditions are: a run was
 * recorded and its process is gone with no terminal status, or a workflow row is
 * running with no transition past a threshold. A `paused:` task is never stale —
 * that alone removes fm2's 1844 absorbed-stale records.
 */
export function detectStale(
	taskIds?: string[],
	options: { runAlive?: (pid: number) => boolean } = {},
): StaleVerdict[] {
	const alive = options.runAlive ?? defaultAlive;
	const ids = taskIds ?? deckOwnedTasks();
	const verdicts: StaleVerdict[] = [];
	for (const taskId of ids) {
		const meta = readMeta(taskId);
		if (meta === null) continue;
		// An empty `run_pid=` line parses to NaN; NaN and non-positive values mean
		// no live run is recorded, and a task with no recorded run cannot be stale.
		const pid =
			typeof meta.run_pid === "number" && Number.isInteger(meta.run_pid) && meta.run_pid > 0
				? meta.run_pid
				: undefined;
		if (pid === undefined) continue;

		const { lastEventVerb: currentVerb } = lastVerb(taskId);
		// A parked task already reported its state: paused and needs-decision wait on
		// purpose, blocked already fired its T0 wake, done/failed are finished.
		// Chasing any of them as stale is the absorbed-stale noise class.
		if (
			currentVerb === "done" ||
			currentVerb === "failed" ||
			currentVerb === "paused" ||
			currentVerb === "blocked" ||
			currentVerb === "needs-decision"
		) {
			continue;
		}

		if (alive(pid)) {
			// A LIVE worker past its deadline is stuck, not working. Liveness alone
			// cannot tell the difference: a looping worker writes no status and never
			// exits, so it is invisible forever without this. Observed live — a worker
			// finished its task, then retried a rate-limited search nine times.
			const deadline = typeof meta.run_deadline === "number" ? meta.run_deadline : undefined;
			if (deadline === undefined) continue;
			if (Date.now() < deadline) continue;
			const overdueMin = Math.max(1, Math.round((Date.now() - deadline) / 60000));
			verdicts.push({
				taskId,
				reason: `still running ${overdueMin} minute(s) past its budget with no result — likely stuck, not working`,
			});
			continue;
		}
		// Process gone. Stale only if the task never reached a terminal event.
		verdicts.push({
			taskId,
			reason: `run pid ${pid} is gone and the task never reported a terminal state (last: ${currentVerb ?? "no events"})`,
		});
	}
	return verdicts;
}

function defaultAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The task's last verb, read from the STATUS FILE.
 *
 * It used to read the wake baseline, which is only what reconcile has already
 * seen. That made a just-written `done:` invisible here, so a worker that had
 * finished but not yet exited was reported as stuck — and once a deadline exists,
 * that is a false alarm on every successful run whose process outlives its last
 * append. Staleness is a question about the task's real state, so it must read the
 * real record.
 */
function lastVerb(taskId: string): { lastEventVerb: string | null } {
	const { events } = readStatus(taskId);
	const last = events[events.length - 1];
	if (last !== undefined) return { lastEventVerb: last.verb };
	// No parseable event: fall back to the baseline, which may hold a malformed
	// line reconcile has seen.
	const baseline = loadBaseline()[taskId];
	if (baseline === undefined) return { lastEventVerb: null };
	const colon = baseline.lastRaw.indexOf(":");
	if (colon === -1) return { lastEventVerb: null };
	const head = baseline.lastRaw.slice(0, colon).trim().split(/\s+/)[0];
	return { lastEventVerb: head ?? null };
}

/**
 * Statusline counters. Rendered by the extension; costs no turn.
 */
export type FleetCounters = {
	activeRuns: number;
	pendingQuestions: number;
	t1Pending: number;
	tasks: number;
};

/** Watch `.status` files for a nudge. Never the source of truth. */
export function watchStatusDir(onNudge: () => void): () => void {
	let watcher: fs.FSWatcher | null = null;
	try {
		watcher = fs.watch(stateDir(), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename.endsWith(".status")) onNudge();
		});
	} catch {
		// No watcher is fine: reconcile on a timer is the contract.
		return () => {};
	}
	return () => {
		watcher?.close();
	};
}
