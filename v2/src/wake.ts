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
import { spawnSync } from "node:child_process";
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
import { intakeFiles, stateDir, stateFiles, wakeFiles } from "./home";
import { readMeta } from "./meta";
import { STATUS_VERBS, TERMINAL_VERBS, type StatusEvent, type StatusVerb, type WakeTier, tierFor } from "./status";

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

// These non-live states never need a stale verdict. All values exist in the
// status grammar; terminal verbs stay sourced from status.ts.
const STALE_SKIP_VERBS = new Set<StatusVerb>([
	...TERMINAL_VERBS,
	"paused",
	"blocked",
	"needs-decision",
	"resolved",
]);

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

/** Silence before a live worker is called stuck. Overridable per call and by env. */
export const DEFAULT_SILENCE_MS = 10 * 60 * 1000;
/** Suppression ceiling: a standing silent verdict repeats at most this often. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Bound on the worktree walk, so one huge tree cannot stall a reconcile cycle. */
const MAX_WALK_ENTRIES = 20_000;

function configuredSilenceMs(override?: number): number {
	if (typeof override === "number" && override > 0) return override;
	const fromEnv = Number.parseInt(process.env.DECK_STALE_SILENCE_MS ?? "", 10);
	return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SILENCE_MS;
}

/**
 * Newest mtime under `root`, ignoring node_modules/.git and never leaving the
 * tree (dirents are typed, so a symlink is never descended into).
 *
 * Returns as soon as something newer than `cutoff` is seen: the question is
 * "has this worker written anything lately", and the first yes answers it.
 *
 * Mtimes after `limit` (now) are IGNORED, not clamped. A file dated in the
 * future (clock skew, a restored archive, a generator that writes ahead) would
 * otherwise read as fresh on every cycle and hide a real wedge forever, and
 * clamping it to now has exactly the same effect.
 *
 * `truncated` means the walk hit its entry budget without finding anything
 * fresh, so the tree was not fully searched. The caller still judges — the
 * transcript signal is complete on its own — but says so in the reason,
 * because the worktree half of the evidence is partial.
 */
function newestMtimeMs(
	root: string,
	cutoff: number,
	limit: number,
): { newest: number; truncated: boolean } {
	let newest = 0;
	let visited = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (visited++ > MAX_WALK_ENTRIES) return { newest, truncated: true };
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			// Only regular files. A symlink is neither followed nor stat'd, which is
			// what keeps the scan inside the worktree.
			if (!entry.isFile()) continue;
			let mtime: number;
			try {
				mtime = fs.statSync(full).mtimeMs;
			} catch {
				continue;
			}
			if (mtime > newest && mtime <= limit) newest = mtime;
			if (newest > cutoff) return { newest, truncated: false };
		}
	}
	return { newest, truncated: false };
}

/** Transcript signal: newest session mtime and total bytes written so far. */
function sessionSignal(dir: string): { mtimeMs: number; bytes: number } {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { mtimeMs: 0, bytes: 0 };
	}
	let mtimeMs = 0;
	let bytes = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		try {
			const stat = fs.statSync(path.join(dir, entry.name));
			bytes += stat.size;
			if (stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
		} catch {
			continue;
		}
	}
	return { mtimeMs, bytes };
}

/**
 * Per-task activity watermark and verdict suppression.
 *
 * `bytes` makes transcript GROWTH a signal in its own right: an appended
 * session whose mtime a coarse filesystem has not moved still proves the worker
 * is alive. CPU samples provide a third signal for model/API work that writes no
 * files. `emitted`/`nextEmitAt` are why the same silent verdict is not re-sent
 * every cycle.
 */
type ActivityRecord = {
	bytes: number;
	lastSignalMs: number;
	/** Latest accumulated CPU sample, keyed by process identity. */
	cpuSampleAt?: number;
	parentCpuMs?: number;
	childCpuMs?: Record<string, number>;
	/**
	 * The run this watermark belongs to. A respawn bumps run_epoch, and without
	 * this the replacement run inherits the dead run's silence and is reported
	 * as stuck the moment it starts.
	 */
	epoch?: number;
	emitted?: string;
	nextEmitAt?: number;
	backoffMs?: number;
	/**
	 * Earliest cycle that re-runs the worktree walk for this task. While a silent
	 * verdict is suppressed the walk cannot change what is reported, so it runs at
	 * most once per silence window instead of on every cycle.
	 */
	nextScanAt?: number;
};

type ActivityStore = Record<string, ActivityRecord>;

function loadActivity(): ActivityStore {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(wakeFiles().activity, "utf8"));
		if (parsed !== null && typeof parsed === "object") return parsed as ActivityStore;
		return {};
	} catch {
		return {};
	}
}

function saveActivity(store: ActivityStore): void {
	const file = wakeFiles().activity;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export type ChildProcessRow = { pid: number; command: string };

/** CPU-time sample for a worker and its direct children. */
export type ProcessCpuSample = {
	parentMs?: number;
	children: Array<{ pid: number; cpuMs: number }>;
};

/** CPU samples must be separated enough to distinguish scheduler noise. */
const MIN_CPU_SAMPLE_INTERVAL_MS = 15_000;

export function parseCpuTimeMs(raw: string): number | undefined {
	const value = raw.trim();
	if (value.length === 0) return undefined;
	const [dayPart, clock] = value.includes("-") ? value.split(/-(.*)/s) : [undefined, value];
	const segments = (clock ?? "").split(":");
	if ((segments.length !== 2 && segments.length !== 3) || segments.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return undefined;
	const parts = segments.map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return undefined;
	const seconds = parts[parts.length - 1];
	const minutes = parts[parts.length - 2];
	const hours = parts.length === 3 ? (parts[0] ?? 0) : 0;
	const days = dayPart === undefined ? 0 : Number(dayPart);
	if (!Number.isFinite(days) || seconds === undefined || minutes === undefined) return undefined;
	return (days * 86_400 + hours * 3_600 + minutes * 60 + seconds) * 1000;
}

type ProcessRow = { pid: number; ppid: number; cpuMs?: number };

type ProcessSnapshot = {
	rows: ProcessRow[];
};

/** One process-table pass serves CPU sampling and direct-child discovery. */
function defaultProcessSnapshot(): ProcessSnapshot {
	try {
		// Keep worker-controlled command text out of the process table used for
		// activity decisions. It is fetched separately only for an emitted label.
		const out = spawnSync("ps", ["-axo", "pid=,ppid=,time="], { encoding: "utf8" });
		if (out.status !== 0 || typeof out.stdout !== "string") return { rows: [] };
		const rows: ProcessRow[] = [];
		for (const line of out.stdout.split("\n")) {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			if (match === null) continue;
			const rawCpu = parseCpuTimeMs(match[3] ?? "");
			rows.push({
				pid: Number(match[1]),
				ppid: Number(match[2]),
				...(rawCpu === undefined ? {} : { cpuMs: rawCpu }),
			});
		}
		return { rows };
	} catch {
		return { rows: [] };
	}
}

function cpuFromSnapshot(pid: number, snapshot: ProcessSnapshot): ProcessCpuSample {
	const parent = snapshot.rows.find((row) => row.pid === pid);
	return {
		parentMs: parent?.cpuMs,
		children: snapshot.rows
			.filter((row) => row.ppid === pid && row.cpuMs !== undefined)
			.map((row) => ({ pid: row.pid, cpuMs: row.cpuMs as number })),
	};
}

function childCommand(pid: number): string {
	try {
		const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
		return typeof out.stdout === "string" ? out.stdout.trim() : "";
	} catch {
		return "";
	}
}

function childrenFromSnapshot(pid: number, snapshot: ProcessSnapshot): ChildProcessRow[] {
	return snapshot.rows
		.filter((row) => row.ppid === pid)
		.map((row) => ({ pid: row.pid, command: childCommand(row.pid) }));
}

/**
 * A short, safe label for a child process.
 *
 * The raw `ps` command line is attacker-influenced text (a worker chooses what it
 * runs) that ends up in an orchestrator message: it can be kilobytes long and can
 * carry control characters, including newlines that forge extra report lines.
 * The executable's basename answers "what is it waiting on" without any of that.
 */
function childLabel(command: string): string {
	const executable = command.trim().split(/\s+/)[0] ?? "";
	const safe = path
		.basename(executable)
		// Printable ASCII only, so no newline, tab, or escape survives into a message.
		.replace(/[^\x20-\x7e]/g, "")
		.slice(0, 40);
	return safe.length > 0 ? safe : "unknown";
}

/**
 * Staleness, redefined as a FACT rather than a heuristic.
 *
 * A recorded run whose process is gone with no terminal or resolved status is stale. A LIVE
 * run is judged on ACTIVITY, not on its deadline: a deadline says the budget is
 * spent, which is a planning fact, while writing files and appending to its
 * transcript is proof the worker is still doing the work. Alerting on the
 * deadline alone reported every long-but-productive run as stuck; alerting on
 * silence reports only the class that motivated the deadline — a worker looping
 * on a retry, alive, writing nothing.
 *
 * A `paused:` task is never stale — that alone removes fm2's 1844 absorbed-stale
 * records.
 */
export function detectStale(
	taskIds?: string[],
	options: {
		runAlive?: (pid: number) => boolean;
		/** Silence before a live worker is called stuck. Default 10 minutes. */
		silenceMs?: number;
		/** Injected for tests; defaults to a `ps` scan for direct children. */
		listChildren?: (pid: number) => ChildProcessRow[];
		/** Injected for tests; defaults to one `ps` process-table sample. */
		sampleCpu?: (pid: number) => ProcessCpuSample;
		now?: number;
		/**
		 * Persist the activity watermark and mark verdicts emitted. Default true.
		 *
		 * A read-only caller (the CLI's `stale`, a human looking) must pass false:
		 * otherwise looking at the fleet marks the verdict as delivered and the
		 * orchestrator's own cycle never reports it. false is read-only in BOTH
		 * directions — it neither writes suppression nor obeys it, so an inspection
		 * always answers with the current verdict.
		 */
		record?: boolean;
	} = {},
): StaleVerdict[] {
	const alive = options.runAlive ?? defaultAlive;
	let processSnapshot: ProcessSnapshot | undefined;
	const getProcessSnapshot = (): ProcessSnapshot => {
		processSnapshot ??= defaultProcessSnapshot();
		return processSnapshot;
	};
	const listChildren = options.listChildren ?? ((pid: number) => childrenFromSnapshot(pid, getProcessSnapshot()));
	const sampleCpu = options.sampleCpu ?? ((pid: number) => cpuFromSnapshot(pid, getProcessSnapshot()));
	const silenceMs = configuredSilenceMs(options.silenceMs);
	const now = options.now ?? Date.now();
	const persist = options.record ?? true;
	const ids = taskIds ?? deckOwnedTasks();
	const activity = loadActivity();
	let activityDirty = false;
	/** A task with no live run has no watermark to keep. */
	const forget = (taskId: string): void => {
		if (activity[taskId] === undefined) return;
		delete activity[taskId];
		activityDirty = true;
	};
	const verdicts: StaleVerdict[] = [];
	for (const taskId of ids) {
		const meta = readMeta(taskId);
		if (meta === null) {
			forget(taskId);
			continue;
		}
		// An empty `run_pid=` line parses to NaN; NaN and non-positive values mean
		// no live run is recorded, and a task with no recorded run cannot be stale.
		const pid =
			typeof meta.run_pid === "number" && Number.isInteger(meta.run_pid) && meta.run_pid > 0
				? meta.run_pid
				: undefined;
		if (pid === undefined) {
			forget(taskId);
			continue;
		}

		const { lastEventVerb: currentVerb } = lastVerb(taskId);
		// A task that has reported any of these states must not receive a stale
		// verdict.
		if (currentVerb !== null && STALE_SKIP_VERBS.has(currentVerb)) {
			forget(taskId);
			continue;
		}

		if (alive(pid)) {
			// A LIVE worker that is WRITING is working, however overdue. A live worker
			// writing nothing is the class that motivated this: observed live, a worker
			// finished its task then retried a rate-limited search nine times, alive and
			// silent, invisible to a liveness probe.
			const cutoff = now - silenceMs;
			// A new run starts with a clean watermark: the previous run's silence and
			// suppression say nothing about this one.
			const epoch = typeof meta.run_epoch === "number" ? meta.run_epoch : 0;
			const stored = activity[taskId];
			const respawned = stored !== undefined && (stored.epoch ?? 0) !== epoch;
			const previous = respawned ? undefined : stored;
			// Suppression key excludes the minute count AND the child pid: a standing
			// silence would otherwise look like a new verdict on every cycle, and a
			// parent respawning short-lived children would bypass backoff entirely.
			const fingerprint = `silent:${pid}`;
			// A suppressed verdict is muted until nextEmitAt, so re-walking the worktree
			// before then cannot change the outcome — scan once per silence window and
			// skip the rest. A read-only caller is never throttled, because it does not
			// apply suppression either and must see the current verdict.
			const cpuPrevious = previous;
			const cpuIntervalElapsed =
				cpuPrevious !== undefined && now - (cpuPrevious.cpuSampleAt ?? 0) >= MIN_CPU_SAMPLE_INTERVAL_MS;
			let currentCpu: ProcessCpuSample = {
				parentMs: cpuPrevious?.parentCpuMs,
				children: Object.entries(cpuPrevious?.childCpuMs ?? {}).map(([childPid, cpuMs]) => ({ pid: Number(childPid), cpuMs })),
			};
			if (cpuPrevious === undefined || cpuIntervalElapsed) {
				try {
					currentCpu = sampleCpu(pid);
				} catch {
					currentCpu = { children: [] };
				}
			}
			const previousParentCpuMs = cpuPrevious?.parentCpuMs;
			const parentCpuDelta =
				cpuIntervalElapsed && previousParentCpuMs !== undefined && currentCpu.parentMs !== undefined
					? Math.max(0, currentCpu.parentMs - previousParentCpuMs)
					: 0;
			const previousChildren = cpuPrevious?.childCpuMs ?? {};
			const childCpuDeltas = new Map<number, number>();
			for (const child of currentCpu.children) {
				const old = previousChildren[String(child.pid)];
				if (cpuIntervalElapsed && old !== undefined) {
					childCpuDeltas.set(child.pid, Math.max(0, child.cpuMs - old));
				}
			}
			const cpuActive = parentCpuDelta > 0 || [...childCpuDeltas.values()].some((delta) => delta > 0);
			const cpuFields = {
				cpuSampleAt: cpuIntervalElapsed || cpuPrevious === undefined ? now : cpuPrevious.cpuSampleAt,
				parentCpuMs: cpuIntervalElapsed || cpuPrevious === undefined ? currentCpu.parentMs : cpuPrevious.parentCpuMs,
				childCpuMs: cpuIntervalElapsed || cpuPrevious === undefined
					? Object.fromEntries(currentCpu.children.map((child) => [String(child.pid), child.cpuMs]))
					: cpuPrevious.childCpuMs,
			};
			const suppressedScan =
				persist &&
				previous?.emitted === fingerprint &&
				now < (previous.nextEmitAt ?? 0) &&
				now < (previous.nextScanAt ?? 0);
			if (cpuActive) {
				if (persist) {
					const session = sessionSignal(
						typeof meta.session_dir === "string" ? meta.session_dir : stateFiles(taskId).sessions,
					);
					const activeRecord: ActivityRecord = {
						...previous,
						epoch,
						bytes: session.bytes,
						lastSignalMs: now,
						...cpuFields,
					};
					delete activeRecord.emitted;
					delete activeRecord.nextEmitAt;
					delete activeRecord.backoffMs;
					delete activeRecord.nextScanAt;
					activity[taskId] = activeRecord;
					activityDirty = true;
				}
				continue;
			}
			if (suppressedScan) continue;
			const session = sessionSignal(
				typeof meta.session_dir === "string" ? meta.session_dir : stateFiles(taskId).sessions,
			);
			// Worktree writes and transcript growth count alongside CPU time. A status
			// line is a report ABOUT the work, not the work: a worker looping on a retry
			// can keep appending `working:` while writing nothing, and counting that
			// mtime as activity is exactly what hides the wedge this check exists to find.
			let newest = session.mtimeMs <= now ? session.mtimeMs : 0;
			let truncated = false;
			// Skip the walk when a cheap signal already proves recent activity: the
			// verdict cannot change, and this is the common case for a healthy run.
			if (newest <= cutoff && (previous?.lastSignalMs ?? 0) <= cutoff && typeof meta.worktree === "string" && meta.worktree.length > 0) {
				const walk = newestMtimeMs(meta.worktree, cutoff, now);
				newest = Math.max(newest, walk.newest);
				truncated = walk.truncated;
			}
			// Transcript growth is activity even when the mtime looks old, which is what
			// a coarse filesystem timestamp or a restored mtime can make it look like.
			const grew = previous !== undefined && session.bytes > previous.bytes;
			const observed = grew ? now : newest;
			// A run cannot have been silent for longer than it has existed. The worktree
			// and transcript of a REPLACEMENT run still hold the dead run's files, so
			// without this anchor the new run is judged by the old run's mtimes and is
			// called stuck the moment it starts — including on the very first sight,
			// where there is no stored record to notice the respawn from.
			const runStarted =
				typeof meta.run_started === "number" &&
				Number.isFinite(meta.run_started) &&
				meta.run_started > 0 &&
				meta.run_started <= now
					? meta.run_started
					: 0;
			const lastSignalMs = Math.max(
				runStarted,
				previous !== undefined
					? Math.max(observed, previous.lastSignalMs)
					: respawned
						// A replacement run's clock starts when we first see it. Its worktree
						// still holds the dead run's files, and judging the new run by those
						// mtimes reports it as stuck before it has had a chance to write.
						? now
						// First sight ever: an existing old mtime IS this run's last signal,
						// so an already-wedged worker is caught on the first pass rather than
						// granted a fresh silence window.
						: (observed === 0 ? now : observed),
			);
			const record: ActivityRecord = {
				...previous,
				epoch,
				bytes: session.bytes,
				lastSignalMs,
				...cpuFields,
			};

			if (lastSignalMs > cutoff) {
				// Active. Clear suppression so the next real silence alerts at once.
				delete record.emitted;
				delete record.nextEmitAt;
				delete record.backoffMs;
				delete record.nextScanAt;
				activity[taskId] = record;
				activityDirty = true;
				continue;
			}

			// Persisted suppression is a DELIVERY policy for the recording cycle. A
			// read-only caller (record:false) must not apply it: a human inspecting the
			// fleet has to see the current verdict even when the recording caller
			// already muted it.
			const suppressed =
				persist && record.emitted === fingerprint && now < (record.nextEmitAt ?? 0);
			if (!suppressed) {
				const silentMin = Math.max(1, Math.round((now - lastSignalMs) / 60000));
				// Named only on a verdict that is actually emitted: `ps` on every cycle of a
				// standing silence buys nothing.
				const child = listChildren(pid)[0];
				const childCpuDelta = child === undefined ? undefined : childCpuDeltas.get(child.pid);
				// A truncated walk still alerts. The transcript signal is complete on its
				// own, and a pi worker doing anything appends to its transcript — so
				// staying quiet here would hide a real wedge in every worktree big enough
				// to exhaust the walk budget, forever. The reason says the worktree
				// evidence is partial.
				const partial = truncated ? "; worktree scan was incomplete" : "";
				verdicts.push({
					taskId,
					reason:
						child === undefined
							? `alive as pid ${pid} but has written nothing for ${silentMin} minute(s)${partial} — likely stuck, not working`
							: `alive as pid ${pid} but has written nothing for ${silentMin} minute(s); child pid ${child.pid} (${childLabel(child.command)})${childCpuDelta === undefined ? "" : ` has CPU delta ${(childCpuDelta / 1000).toFixed(2)}s`} and is still running${partial} — likely a stuck subagent`,
				});
				const backoffMs =
					record.emitted === fingerprint
						? Math.min((record.backoffMs ?? silenceMs) * 2, MAX_BACKOFF_MS)
						: silenceMs;
				record.emitted = fingerprint;
				record.backoffMs = backoffMs;
				record.nextEmitAt = now + backoffMs;
			}
			record.nextScanAt = now + silenceMs;
			activity[taskId] = record;
			activityDirty = true;
			continue;
		}
		// Process gone. Stale only if the task never reached a skipped state.
		forget(taskId);
		verdicts.push({
			taskId,
			reason: `run pid ${pid} is gone and the task never reported a terminal state (last: ${currentVerb ?? "no events"})`,
		});
	}
	if (activityDirty && persist) saveActivity(activity);
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
function lastVerb(taskId: string): { lastEventVerb: StatusVerb | null } {
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
	return { lastEventVerb: STATUS_VERBS.find((verb) => verb === head) ?? null };
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
