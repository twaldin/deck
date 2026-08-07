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
import { randomUUID } from "node:crypto";
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
	key:
		| "max-adversarial"
		| "reviewer-silent"
		| "main-red"
		| "migration-gate"
		| "broker-no-quota"
		| "needs-decision"
		| "ci-fail"
		| "actionable-comment"
		| "decision-ask"
		| "agent-requested"
		| "watcher-stale"
		| "run-terminal";
	taskId: string;
	note: string;
	/** T0 is used for failures and gates; reviewer silence and terminal runs are batched. */
	tier?: WakeTier;
};

type BaselineLockOwner = { owner: string; pid: number };

const BASELINE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const BASELINE_LOCK_TIMEOUT_MS = 30_000;

function readBaselineLock(file: string): BaselineLockOwner | null {
	try {
		const row = JSON.parse(fs.readFileSync(path.join(file, "owner"), "utf8")) as { owner?: unknown; pid?: unknown };
		return typeof row.owner === "string" && typeof row.pid === "number" ? { owner: row.owner, pid: row.pid } : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The per-wake store removed the queue's shared read-modify-write, but the
 * baseline is still one shared mutable file. Its lock is claimed by atomically
 * renaming a prepared directory, and a dead owner's pid makes a crash stale
 * rather than turning edge detection into a permanent fleet-wide wedge.
 */
function withBaselineLock<T>(operation: () => T): T {
	const file = `${wakeFiles().baseline}.lock`;
	const owner = `wake-baseline:${process.pid}:${randomUUID()}`;
	const deadline = performance.now() + BASELINE_LOCK_TIMEOUT_MS;
	for (;;) {
		const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.mkdirSync(tmp, { mode: 0o700 });
			fs.writeFileSync(path.join(tmp, "owner"), `${JSON.stringify({ owner, pid: process.pid })}\n`, { mode: 0o600 });
			fs.renameSync(tmp, file);
			break;
		} catch (error) {
			try {
				fs.rmSync(tmp, { recursive: true, force: true });
			} catch {
				// The atomic rename consumed it.
			}
			const current = readBaselineLock(file);
			if (current === null) {
				if (!fs.existsSync(file)) continue;
				if (performance.now() >= deadline) throw new Error(`cannot inspect wake baseline lock ${file}: ${String(error)}`);
				Atomics.wait(BASELINE_LOCK_WAIT, 0, 0, 1);
				continue;
			}
			if (performance.now() >= deadline) throw new Error(`timed out waiting for wake baseline lock held by ${current.owner}`);
			if (!pidAlive(current.pid)) {
				const stale = `${file}.stale-${process.pid}-${randomUUID()}`;
				try {
					if (readBaselineLock(file)?.owner === current.owner) {
						fs.renameSync(file, stale);
						fs.rmSync(stale, { recursive: true, force: true });
					}
				} catch {
					// Another waiter reclaimed it first.
				}
				continue;
			}
			Atomics.wait(BASELINE_LOCK_WAIT, 0, 0, 5);
		}
	}

	try {
		return operation();
	} finally {
		if (readBaselineLock(file)?.owner === owner) {
			const released = `${file}.release-${process.pid}-${randomUUID()}`;
			try {
				fs.renameSync(file, released);
				fs.rmSync(released, { recursive: true, force: true });
			} catch {
				// The lock was already reclaimed after an owner crash.
			}
		}
	}
}

/** Record external workflow conditions in the same durable outbox as status events. */
export function enqueueWakeConditions(conditions: WakeCondition[]): void {
	const items: WakeItem[] = conditions.map((condition) => ({
		taskId: condition.taskId,
		tier: condition.tier ?? (condition.key === "reviewer-silent" || condition.key === "run-terminal" ? "T1" : "T0"),
		event: { verb: condition.key, key: condition.key, note: condition.note, raw: `${condition.key}:${condition.note}` },
	}));
	if (items.length === 0) return;
	// Conditions use the same baseline, so a persistent gate creates one wake.
	// The lock spans the whole read-modify-write; locking only the write lets
	// concurrent clear/enqueue cycles restore each other's stale snapshots.
	mutateBaseline((baseline) => {
		const fresh = items.filter((item) => {
			const previous = baseline[`${item.taskId}:${item.event.key}`];
			if (previous?.lastRaw === item.event.raw) return false;
			baseline[`${item.taskId}:${item.event.key}`] = {
				lastTier: item.tier,
				lastRaw: item.event.raw,
				count: (previous?.count ?? 0) + 1,
			};
			return true;
		});
		// Queue first: a crash may duplicate the edge, but can never record an
		// edge baseline for a wake that was not durably stored.
		enqueue(fresh);
	});
}

/**
 * Promote a durable one-shot registration without consulting the edge baseline.
 * The caller's stable registration id makes retry overwrite-free and idempotent;
 * a conflicting payload under the same id is a data-integrity error, not a wake
 * to silently coalesce.
 */
export function enqueueWakeOnce(id: string, condition: WakeCondition): void {
	const entry: OutboxEntry = {
		id: `wake-once-${id}`,
		taskId: condition.taskId,
		key: condition.key,
		tier: condition.tier ?? (condition.key === "reviewer-silent" || condition.key === "run-terminal" ? "T1" : "T0"),
		raw: `${condition.key}:${condition.note}`,
		note: condition.note,
		verb: condition.key,
	};
	withOutboxMutationLock(() => {
		const target = outboxEntryPath(entry.id);
		if (target === null) throw new Error(`unsafe one-shot wake id ${JSON.stringify(id)}`);
		const existing = readOutboxEntry(target);
		if (existing !== null) {
			if (sameStoredWake(existing, entry)) return;
			throw new Error(`one-shot wake id ${JSON.stringify(id)} already names a different wake`);
		}
		writeOutboxEntry(entry);
	});
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

function saveBaselineUnlocked(baseline: Baseline): void {
	const file = wakeFiles().baseline;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(tmp, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function mutateBaseline<T>(operation: (baseline: Baseline) => T): T {
	return withBaselineLock(() => {
		const baseline = loadBaseline();
		const result = operation(baseline);
		saveBaselineUnlocked(baseline);
		return result;
	});
}

/** Clear resolved external conditions so a later recurrence is a new edge. */
export function clearWakeConditions(taskId: string, keys: WakeCondition["key"][]): void {
	mutateBaseline((baseline) => {
		for (const key of keys) delete baseline[`${taskId}:${key}`];
	});
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
	const settled = mutateBaseline((baseline) => reconcileLocked(taskIds, baseline));
	saveCursors(settled.cursors);
	return settled.result;
}

function reconcileLocked(taskIds: string[] | undefined, baseline: Baseline): { result: ReconcileResult; cursors: CursorStore } {
	const ids = taskIds ?? deckOwnedTasks();
	const cursors = loadCursors();
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

	// Persist the wake before either edge-detection record. A crash after enqueue
	// but before the cursor advances deliberately favors one duplicate over one
	// lost wake; mutateBaseline saves the baseline before this result reaches
	// saveCursors, so a rescan absorbs that duplicate without erasing the durable
	// obligation.
	enqueue([...result.interrupt, ...result.batched]);
	return { result, cursors };
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
export type OutboxEntry = {
	id: string;
	taskId: string;
	key: string;
	tier: WakeTier;
	raw: string;
	note: string;
	verb: string;
	deliveredAt?: number;
	/** How many times this wake has been sent. Drives redelivery backoff. */
	deliveries?: number;
};

/**
 * A sequence is useful for ordering entries minted in one process, but it is
 * not identity on its own. Every process starts at zero, so the pid and random
 * component are what make concurrent producers globally unique.
 *
 * The id used to be `${taskId}:${raw}`, which is identical for two identical
 * status lines — and a worker blocked twice for the same reason writes exactly
 * that. Reproduced: both events collapsed into one entry, and acking it discarded
 * the second wake. Coalescing is a DELIVERY policy (fold T1 into one message); it
 * must never be storage identity, or acking a delivered event silently drops an
 * undelivered one.
 */
let outboxSeq = 0;

function outboxDir(): string {
	return `${wakeFiles().queue}.d`;
}

const OUTBOX_ID_RE = /^[A-Za-z0-9:._-]+$/;

function outboxEntryPath(id: string): string | null {
	if (!OUTBOX_ID_RE.test(id)) return null;
	return path.join(outboxDir(), `${id}.json`);
}

function nextOutboxId(): string {
	return `wake-${Date.now().toString(36)}-${process.pid.toString(36)}-${(outboxSeq++).toString(36)}-${randomUUID()}`;
}

function parseOutboxEntry(value: unknown): OutboxEntry | null {
	if (value === null || typeof value !== "object") return null;
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.id !== "string" ||
		!OUTBOX_ID_RE.test(entry.id) ||
		typeof entry.taskId !== "string" ||
		(entry.tier !== "T0" && entry.tier !== "T1" && entry.tier !== "T2") ||
		typeof entry.raw !== "string" ||
		typeof entry.note !== "string" ||
		typeof entry.verb !== "string" ||
		(entry.key !== undefined && typeof entry.key !== "string") ||
		(entry.deliveredAt !== undefined && (typeof entry.deliveredAt !== "number" || !Number.isFinite(entry.deliveredAt))) ||
		(entry.deliveries !== undefined && (typeof entry.deliveries !== "number" || !Number.isFinite(entry.deliveries)))
	) {
		return null;
	}
	return {
		id: entry.id,
		taskId: entry.taskId,
		tier: entry.tier,
		raw: entry.raw,
		note: entry.note,
		verb: entry.verb,
		key: entry.key ?? "default",
		...(entry.deliveredAt === undefined ? {} : { deliveredAt: entry.deliveredAt }),
		...(entry.deliveries === undefined ? {} : { deliveries: entry.deliveries }),
	};
}

function readOutboxEntry(file: string): OutboxEntry | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parseOutboxEntry(parsed);
	} catch {
		// Atomic writers never expose a torn target, but a crash, manual edit, or
		// older writer can still leave one. One bad wake must not poison the queue.
		return null;
	}
}

function writeOutboxEntry(entry: OutboxEntry): void {
	const target = outboxEntryPath(entry.id);
	if (target === null) throw new Error(`unsafe wake id ${JSON.stringify(entry.id)}`);
	fs.mkdirSync(outboxDir(), { recursive: true, mode: 0o700 });
	const tmp = path.join(outboxDir(), `.${entry.id}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, target);
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// rename consumed it, or the write never created it.
		}
	}
}
const OUTBOX_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const OUTBOX_LOCK_TIMEOUT_MS = 30_000;

/**
 * In-flight marking replaces an entry while acknowledgement removes it. They
 * must serialize per store, or a marker that read just before an ack can rename
 * its temporary file afterward and resurrect a durably consumed wake.
 */
function withOutboxMutationLock<T>(operation: () => T): T {
	fs.mkdirSync(outboxDir(), { recursive: true, mode: 0o700 });
	const lock = path.join(outboxDir(), ".mutation.lock");
	const token = `${process.pid}:${randomUUID()}`;
	const deadline = performance.now() + OUTBOX_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (performance.now() >= deadline) throw new Error(`timed out waiting for wake outbox mutation lock ${lock}`);

			let owner: string;
			let stale = false;
			try {
				owner = fs.readFileSync(lock, "utf8");
				const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
				if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
					stale = !pidAlive(ownerPid);
				} else {
					stale = Date.now() - fs.statSync(lock).mtimeMs >= OUTBOX_LOCK_TIMEOUT_MS;
				}
			} catch (readError) {
				const readCode = (readError as NodeJS.ErrnoException).code;
				if (readCode === "ENOENT") continue;
				throw new Error(`cannot inspect wake outbox mutation lock ${lock}: ${String(readError)}`);
			}
			if (stale) {
				try {
					// Another waiter may have recovered the stale owner and a live
					// process may already hold the pathname. Never unlink a token
					// other than the dead one this waiter actually observed.
					if (fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock);
				} catch (recoveryError) {
					const recoveryCode = (recoveryError as NodeJS.ErrnoException).code;
					if (recoveryCode !== "ENOENT") throw recoveryError;
				}
				continue;
			}
			Atomics.wait(OUTBOX_LOCK_WAIT, 0, 0, 5);
		}
	}

	try {
		return operation();
	} finally {
		try {
			if (fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw error;
		}
	}
}

function sameStoredWake(left: OutboxEntry, right: OutboxEntry): boolean {
	return (
		left.id === right.id &&
		left.taskId === right.taskId &&
		left.tier === right.tier &&
		left.raw === right.raw &&
		left.note === right.note &&
		left.key === right.key &&
		left.verb === right.verb
	);
}

/**
 * The legacy pathname is atomically claimed before it is read. An old producer
 * that opens the append log during cutover therefore creates a new legacy file
 * for the next read instead of landing between this read and unlink.
 *
 * Writes are idempotent, and the claimed source is removed only after every
 * valid line has an atomic target. Malformed remnants are quarantined rather
 * than reprocessed: otherwise acking a valid migrated sibling would only make
 * the next read resurrect it from the retained legacy file.
 *
 * Duplicate legacy ids are reminted deterministically. Collisions were possible
 * across producer processes, and treating them as one would repeat the exact
 * loss this migration exists to eliminate.
 */
function migrateLegacyOutboxUnlocked(): void {
	const legacy = wakeFiles().queue;
	const claimed = `${legacy}.migrating`;
	let raw: string;
	try {
		if (!fs.existsSync(claimed)) fs.renameSync(legacy, claimed);
		if (!fs.statSync(claimed).isFile()) return;
		raw = fs.readFileSync(claimed, "utf8");
	} catch {
		return;
	}

	const corrupt: string[] = [];
	const seen = new Map<string, number>();
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		let entry: OutboxEntry;
		try {
			const parsed: unknown = JSON.parse(line);
			const normalized = parseOutboxEntry(parsed);
			if (normalized === null) {
				corrupt.push(line);
				continue;
			}
			entry = normalized;
		} catch {
			// Preserve a torn line for diagnosis without letting it replay valid
			// siblings forever.
			corrupt.push(line);
			continue;
		}

		const occurrence = seen.get(entry.id) ?? 0;
		seen.set(entry.id, occurrence + 1);
		let candidate = occurrence === 0 ? entry.id : `${entry.id}:legacy-${index.toString(36)}`;
		for (let collision = 0; ; collision += 1) {
			const migrated = candidate === entry.id ? entry : { ...entry, id: candidate };
			const target = outboxEntryPath(candidate);
			if (target === null) {
				corrupt.push(line);
				break;
			}
			const existing = readOutboxEntry(target);
			if (existing === null) {
				writeOutboxEntry(migrated);
				break;
			}
			if (sameStoredWake(existing, migrated)) break;
			candidate = `${entry.id}:legacy-${index.toString(36)}-${collision.toString(36)}`;
		}
	}

	if (corrupt.length > 0) fs.appendFileSync(`${legacy}.corrupt`, `${corrupt.join("\n")}\n`, { mode: 0o600 });
	try {
		fs.unlinkSync(claimed);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
	}
}

function migrateLegacyOutbox(): void {
	const legacy = wakeFiles().queue;
	if (!fs.existsSync(legacy) && !fs.existsSync(`${legacy}.migrating`)) return;
	withOutboxMutationLock(migrateLegacyOutboxUnlocked);
}

function enqueue(items: WakeItem[]): void {
	for (const item of items) {
		writeOutboxEntry({
			id: nextOutboxId(),
			taskId: item.taskId,
			tier: item.tier,
			raw: item.event.raw,
			note: item.event.note,
			key: item.event.key,
			verb: item.event.verb,
		});
	}
}

function outboxTimestamp(entry: OutboxEntry, fallback: number): number {
	const current = /^wake-(?!once-)([0-9a-z]+)-/.exec(entry.id);
	if (current !== null) {
		const timestamp = Number.parseInt(current[1]!, 36);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	const legacy = /^[a-z0-9-]+:([0-9a-z]+):/.exec(entry.id);
	if (legacy !== null) {
		const timestamp = Number.parseInt(legacy[1]!, 36);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	return fallback;
}

/** Everything still owed to the orchestrator, oldest first. */
export function pendingWakes(): OutboxEntry[] {
	migrateLegacyOutbox();
	const entries: Array<{ entry: OutboxEntry; queuedAt: number }> = [];
	let files: fs.Dirent[];
	try {
		files = fs.readdirSync(outboxDir(), { withFileTypes: true });
	} catch {
		return [];
	}
	for (const file of files) {
		if (!file.isFile() || !file.name.endsWith(".json")) continue;
		const target = path.join(outboxDir(), file.name);
		const entry = readOutboxEntry(target);
		if (entry === null || file.name !== `${entry.id}.json`) continue;
		let fallback = 0;
		try {
			fallback = fs.statSync(target).mtimeMs;
		} catch {
			continue;
		}
		entries.push({ entry, queuedAt: outboxTimestamp(entry, fallback) });
	}
	entries.sort((left, right) => left.queuedAt - right.queuedAt || left.entry.id.localeCompare(right.entry.id));
	return entries.map(({ entry }) => entry);
}

/**
 * Wakes owed right now: never delivered, or in flight past their backoff.
 *
 * A wake is NEVER retired for going unacknowledged. Dropping one after N tries
 * would turn durable at-least-once into best effort, and the work it names
 * would vanish silently — the precise failure this subsystem exists to
 * prevent. Everything unacked stays owed and stays injectable at session start.
 *
 * Noise is bounded by BACKOFF instead. Measured against a live orchestrator:
 * 13 unacked wakes re-arrived every two minutes forever, because a session
 * started before the ack contract existed could not acknowledge anything. With
 * backoff the same wake is still owed, but its retries space out rather than
 * pinning the orchestrator's attention.
 */
export function dueWakes(
	now = Date.now(),
	redeliverAfterMs = 120_000,
	maxBackoffMs = 3_600_000,
): OutboxEntry[] {
	return pendingWakes().filter((entry) => {
		if (entry.deliveredAt === undefined) return true;
		const attempts = entry.deliveries ?? 1;
		// Doubling, capped: 2m, 4m, 8m ... then hourly for as long as it is owed.
		const wait = Math.min(redeliverAfterMs * 2 ** (attempts - 1), maxBackoffMs);
		return now - entry.deliveredAt >= wait;
	});
}

/** Mark sent entries in-flight without acknowledging the durable obligation. */
export function markInFlight(ids: string[], now = Date.now()): void {
	migrateLegacyOutbox();
	withOutboxMutationLock(() => {
		for (const id of new Set(ids)) {
			const target = outboxEntryPath(id);
			if (target === null) continue;
			const entry = readOutboxEntry(target);
			if (entry === null || entry.id !== id) continue;
			// Count deliveries so redelivery can be bounded. Unbounded retry was
			// measured against a live orchestrator: 13 wakes were delivered and
			// never acknowledged, so every one of them re-arrived every two
			// minutes indefinitely. At-least-once must not mean forever.
			writeOutboxEntry({ ...entry, deliveredAt: now, deliveries: (entry.deliveries ?? 0) + 1 });
		}
	});
}

/**
 * Acknowledge only after the CONSUMER durably records the wake. Acking when the
 * send happens is at-most-once delivery: if the session dies mid-delivery, the
 * wake and its work are both lost.
 */
export function ackWakes(ids: string[]): void {
	migrateLegacyOutbox();
	withOutboxMutationLock(() => {
		for (const id of new Set(ids)) {
			const target = outboxEntryPath(id);
			if (target === null) continue;
			try {
				fs.unlinkSync(target);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw error;
			}
		}
	});
}

/**
 * Remove wakes that policy says must never be delivered. This is not an ack:
 * the suppression ledger keeps "consumer saw it" distinguishable from "policy
 * withheld it", so a missing wake remains explainable after the fact.
 */
export function suppressWakes(ids: string[], reason: string): void {
	migrateLegacyOutbox();
	withOutboxMutationLock(() => {
		for (const id of new Set(ids)) {
			const target = outboxEntryPath(id);
			if (target === null) continue;
			const entry = readOutboxEntry(target);
			if (entry === null || entry.id !== id) continue;
			const log = path.join(path.dirname(wakeFiles().queue), ".wake-suppressed.jsonl");
			// Evidence first, removal second. A crash between them leaves a
			// recoverable duplicate and a reason; the opposite order silently
			// destroys both the obligation and the explanation.
			fs.appendFileSync(
				log,
				`${JSON.stringify({ id: entry.id, taskId: entry.taskId, verb: entry.verb, reason, timestamp: Date.now() })}\n`,
				{ mode: 0o600 },
			);
			try {
				fs.unlinkSync(target);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw error;
			}
		}
	});
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
				// own, and a child agent doing anything appends to its transcript — so
				// staying quiet here would hide a real wedge in every worktree big enough
				// to exhaust the walk budget, forever. The reason says the worktree
				// evidence is partial.
				const partial = truncated ? "; worktree scan was incomplete" : "";
				verdicts.push({
					taskId,
					reason:
						child === undefined
							? `alive as pid ${pid} but has written nothing for ${silentMin} minute(s)${partial} — likely stuck, not working`
							: `alive as pid ${pid} but has written nothing for ${silentMin} minute(s); child pid ${child.pid} (${childLabel(child.command)})${childCpuDelta === undefined ? "" : ` has CPU delta ${(childCpuDelta / 1000).toFixed(2)}s`} and is still running${partial} — likely a stuck child agent`,
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
