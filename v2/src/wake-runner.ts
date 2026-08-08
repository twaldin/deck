import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { deckV2Home, stateDir } from "./home";
import { readMeta } from "./meta";
import { collectRuns, evictCollectRunsCache, type PsRun } from "./monitor";
import { queueFile, retireRunQuestionsSafely } from "./questions-store";
import { smithersWorkspaceCwd } from "./workspace";
import { applyProjectTierPolicy as projectTierPolicy } from "./observer";
import { loadProfiles, type ProjectProfile } from "./projects";
import { produceDueSelfWakes } from "./self-wake";
import {
	dueWakes as readDueWakes,
	foldBatched,
	formatInterrupt,
	ackWakes as retireDelivered,
	markInFlight as recordInFlight,
	reconcile,
	suppressWakes as recordSuppressed,
	type WakeCondition,
	type WakeItem,
} from "./wake";

export const WAKE_DRAIN_INTERVAL_MS = 30_000;
export const WAKE_DRAIN_LEASE_MS = WAKE_DRAIN_INTERVAL_MS * 3;
const PRIME_REQUEST_TIMEOUT_MS = 5_000;

type DueWake = ReturnType<typeof readDueWakes>[number];

type TierPolicy = (
	items: WakeItem[],
	owners: ReadonlyMap<string, ProjectProfile | undefined>,
) => WakeItem[];

export type WakeSend = (
	content: string,
	options: { triggerTurn: boolean },
) => Promise<{ ok: boolean }>;

export interface WakeDrainDependencies {
	now(): number;
	hasLiveSession(): boolean | Promise<boolean>;
	dueWakes(now: number): DueWake[];
	owners: ReadonlyMap<string, ProjectProfile | undefined>;
	applyProjectTierPolicy: TierPolicy;
	send: WakeSend;
	markInFlight(ids: string[], now: number): void | Promise<void>;
	/** Retire delivered ids permanently: receipt is the ack. See deliver(). */
	retire(ids: string[]): void | Promise<void>;
	suppressWakes(ids: string[], reason: string): void | Promise<void>;
}

export type DrainResult = {
	liveSession: boolean;
	deliveredIds: string[];
	failedIds: string[];
	silentIds: string[];
};

function asWakeItem(entry: DueWake): WakeItem {
	return {
		taskId: entry.taskId,
		tier: entry.tier,
		event: {
			verb: entry.verb,
			key: entry.key,
			note: entry.note,
			raw: entry.raw,
		},
	};
}

function withWakeMarker(content: string, ids: string[]): string {
	return `${content}\n\n[wake:${ids.join(",")}]`;
}

/**
 * Most T0 interrupts one cycle may deliver.
 *
 * Each becomes its own message, so this is a hard bound on how much of the
 * orchestrator's context a single sweep can consume. Overflow stays owed and
 * arrives on later cycles; nothing is discarded.
 */
const MAX_INTERRUPTS_PER_CYCLE = 5;

/**
 * Deliver the wakes owed at one instant.
 *
 * Storage, project policy, session presence, delivery, and time are injected:
 * the ordering below is the contract, not an accident of one Prime transport.
 */
export async function drainOnce(deps: WakeDrainDependencies): Promise<DrainResult> {
	const now = deps.now();
	if (!(await deps.hasLiveSession())) {
		return { liveSession: false, deliveredIds: [], failedIds: [], silentIds: [] };
	}

	const due = deps.dueWakes(now);
	const classified = deps.applyProjectTierPolicy(due.map(asWakeItem), deps.owners);
	if (
		classified.length !== due.length ||
		classified.some((item, index) => {
			const entry = due[index];
			return entry === undefined || item.taskId !== entry.taskId || item.event.raw !== entry.raw;
		})
	) {
		throw new Error("wake tier policy must preserve outbox entry identity and order");
	}
	const owed = due.map((entry, index) => ({ entry, item: classified[index] as WakeItem }));
	const interrupts = owed.filter(({ item }) => item.tier === "T0");
	const batched = owed.filter(({ item }) => item.tier === "T1");
	const silentIds = owed.filter(({ item }) => item.tier === "T2").map(({ entry }) => entry.id);
	const deliveredIds: string[] = [];
	const failedIds: string[] = [];
	if (silentIds.length > 0) {
		// T2 is a durable policy decision, not consumer acknowledgement. Record
		// why these entries were withheld so they do not remain due forever.
		await deps.suppressWakes(silentIds, "classified T2; wake policy forbids delivery");
	}

	const deliver = async (content: string, ids: string[]): Promise<void> => {
		let result: { ok: boolean };
		try {
			result = await deps.send(withWakeMarker(content, ids), { triggerTurn: true });
		} catch {
			failedIds.push(...ids);
			return;
		}
		if (!result.ok) {
			failedIds.push(...ids);
			return;
		}
		// Landing in the session IS the acknowledgement. The send resolves only
		// after Prime accepts the follow-up, and a wake is only ever sent to a
		// session with an attached client, so a resolved send means a live
		// orchestrator holds the event.
		//
		// The wake used to stay owed until the agent called wake_ack. That put a
		// per-wake tool call between the orchestrator and its work, and when the
		// ack silently did nothing the same event was redelivered on a timer -
		// observed live as one effort interrupting the orchestrator every two
		// minutes. A notification that must be dismissed is a task; this is not
		// meant to be one.
		//
		// A failed send retains the entry, so nothing is dropped in the case the
		// old design actually protected against.
		await deps.retire(ids);
		deliveredIds.push(...ids);
	};

	// Cap interrupts per cycle. Measured on deckbox at first activation: 90 T0
	// entries were owed at once, and delivering one message each would have
	// buried the orchestrator's context under stale history the moment it
	// started — the exact "wakes nuked the context" failure that caused an
	// earlier wake attempt to be abandoned.
	//
	// The overflow is NOT dropped and NOT suppressed: it stays owed, is not
	// marked in flight, and is delivered on later cycles. Oldest first, so a
	// backlog drains in order instead of starving.
	// T0s owed at the same instant that carry the SAME fact about several
	// tasks (same condition key, same note - a broker outage seen by every
	// watching run) deliver as ONE message, so a shared condition costs one
	// interruption instead of one per task. Distinct facts stay separate
	// messages: each is owed its own turn.
	const groups = new Map<string, { entries: string[]; items: WakeItem[] }>();
	// Collision safety: the identity includes the event kind (verb), so
	// "blocked" and "failed" with an identical note never share a fold. A fold
	// only merges the SAME fact about DIFFERENT tasks: repeated events from one
	// task each keep their own group (occurrence counter per task within the
	// fact) because two failures of one task are two facts, not one.
	const seenPerTask = new Map<string, number>();
	for (const { entry, item } of interrupts) {
		const semantic = `${item.event.verb}\u0000${item.event.key}\u0000${item.event.note}`;
		const taskKey = `${semantic}\u0000${item.taskId}`;
		const occurrence = seenPerTask.get(taskKey) ?? 0;
		seenPerTask.set(taskKey, occurrence + 1);
		const fact = `${semantic}\u0000${occurrence}`;
		const group = groups.get(fact) ?? { entries: [], items: [] };
		group.entries.push(entry.id);
		group.items.push(item);
		groups.set(fact, group);
	}
	const admitted = [...groups.values()].slice(0, MAX_INTERRUPTS_PER_CYCLE);
	const deferred = groups.size - admitted.length;
	for (const group of admitted) {
		const content = group.items.length === 1
			? formatInterrupt(group.items[0] as WakeItem)
			: group.items.map((item) => formatInterrupt(item)).join("\n");
		await deliver(content, group.entries);
	}
	// The overflow notice is a rendering concern, never a stored wake: it must
	// not enter the id list, or markInFlight would stamp an id that has no file.
	const foldedItems = batched.map(({ item }) => item);
	if (deferred > 0) {
		foldedItems.push({
			taskId: "wake",
			tier: "T1",
			event: {
				verb: "resolved",
				key: "wake-overflow",
				note: `${deferred} more urgent wake group(s) still owed; delivered next cycle`,
				raw: `wake-overflow:${deferred}`,
			},
		});
	}
	const folded = foldBatched(foldedItems);
	if (folded !== null) await deliver(folded, batched.map(({ entry }) => entry.id));

	return { liveSession: true, deliveredIds, failedIds, silentIds };
}

function sweepFile(): string {
	return path.join(stateDir(), ".wake-runner-heartbeat.json");
}

/** Persist one completed watcher sweep using the wake store's atomic-file discipline. */
export function recordSweep(now: number): void {
	if (!Number.isFinite(now)) throw new Error("wake sweep time must be finite");
	const file = sweepFile();
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(tmp, `${JSON.stringify({ lastSweptAt: now })}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// rename consumed it, or the write never created it.
		}
	}
}

function lastSweptAt(): number | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(sweepFile(), "utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		const value = (parsed as { lastSweptAt?: unknown }).lastSweptAt;
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** A missing heartbeat is stale too: silence cannot be evidence that the watcher is healthy. */
export function staleWatcherCondition(now: number, maxAgeMs: number): WakeCondition | null {
	if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
		throw new Error("watcher staleness needs a finite time and non-negative maximum age");
	}
	const sweptAt = lastSweptAt();
	if (sweptAt !== null && now - sweptAt <= maxAgeMs) return null;
	return {
		key: "watcher-stale" as WakeCondition["key"],
		taskId: "wake-runner",
		tier: "T0",
		note: sweptAt === null
			? "wake drain has never recorded a completed sweep"
			: `wake drain last completed a sweep at ${new Date(sweptAt).toISOString()}`,
	};
}

type DaemonResponse = {
	type?: string;
	id?: string;
	success?: boolean;
	data?: unknown;
	error?: unknown;
};

type PrimeSessionSummary = {
	id?: unknown;
	activeSessionId?: unknown;
	cwd?: unknown;
	runtimeKind?: unknown;
	attachedClients?: unknown;
	lastActivityAt?: unknown;
};

function daemonSocketPath(): string {
	return process.env.DECK_PRIME_DAEMON_SOCKET ?? path.join(deckV2Home(), ".prime", "run", "conversation.sock");
}

function daemonError(response: DaemonResponse): string {
	if (typeof response.error === "string") return response.error;
	if (response.error !== null && typeof response.error === "object") {
		const message = (response.error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return "Prime daemon rejected the request";
}

/**
 * One bounded daemon request, through Prime's own client.
 *
 * A hand-rolled JSONL socket was tried first and every command came back
 * `Daemon commands require protocol 7 or newer`, so no session was ever found
 * and no wake could ever be delivered — while the drainer looked perfectly
 * healthy, sweeping on schedule and reporting nothing owed. Measured on
 * deckbox against a live orchestrator.
 *
 * The daemon negotiates a protocol and schema in its hello, so the only safe
 * client is the one shipped with the runtime it is talking to. It moves in
 * lockstep with the daemon; a copy here would silently rot at the next bump.
 */
async function requestDaemon(command: Record<string, unknown>): Promise<DaemonResponse> {
	const socketPath = daemonSocketPath();
	if (!fs.existsSync(socketPath)) {
		throw new Error(`Prime daemon socket is not live: ${socketPath}`);
	}
	const clientModule = path.join(
		deckV2Home(),
		".prime/runtime/lib/node_modules/prime-agent/dist/modes/daemon/daemon-client.js",
	);
	if (!fs.existsSync(clientModule)) {
		throw new Error(`managed Prime runtime has no daemon client: ${clientModule}`);
	}
	const { DaemonClient } = (await import(pathToFileURL(clientModule).href)) as {
		DaemonClient: new (socket: string) => {
			connect(): Promise<unknown>;
			waitForHello(): Promise<unknown>;
			request(command: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse>;
			close(): void;
		};
	};
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
		await client.waitForHello();
		return await client.request(command, PRIME_REQUEST_TIMEOUT_MS);
	} finally {
		// Always close: a launchd- or systemd-owned sweep that leaks a client
		// accumulates daemon connections every 30 seconds, forever.
		client.close();
	}
}

function activityTime(summary: PrimeSessionSummary): number {
	return typeof summary.lastActivityAt === "string" ? Date.parse(summary.lastActivityAt) || 0 : 0;
}

/**
 * Choose the session a wake should go to, or null when none can receive it.
 *
 * Pure so the selection rules are testable without a daemon.
 */
export function selectLiveSession(sessions: PrimeSessionSummary[], home: string): string | null {
	const root = path.resolve(home);
	const candidates = sessions
		.filter((session) =>
			session.runtimeKind === "top-level" &&
			typeof session.cwd === "string" &&
			path.resolve(session.cwd) === root &&
			(typeof session.activeSessionId === "string" || typeof session.id === "string") &&
			// A daemon-resident session with no attached client accepts the
			// message and drops it: measured on deckbox, the daemon answered
			// success, the drainer marked the wake in flight, and the text
			// appeared in no transcript. Delivery to nobody is worse than no
			// delivery, because it consumes the obligation. Requiring a client
			// leaves the wake pending until a real orchestrator is listening.
			Number(session.attachedClients ?? 0) > 0)
		.sort((left, right) => {
			const attached = Number(right.attachedClients ?? 0) - Number(left.attachedClients ?? 0);
			return attached === 0 ? activityTime(right) - activityTime(left) : attached;
		});
	const selected = candidates[0];
	if (selected === undefined) return null;
	return typeof selected.activeSessionId === "string" ? selected.activeSessionId : (selected.id as string);
}

async function findPrimeSession(): Promise<string | null> {
	try {
		const response = await requestDaemon({ type: "list" });
		const sessions = (response.data as { sessions?: unknown } | undefined)?.sessions;
		if (!Array.isArray(sessions)) return null;
		return selectLiveSession(sessions as PrimeSessionSummary[], deckV2Home());
	} catch {
		return null;
	}
}

function readInputProfile(runId: string): string | undefined {
	const shipDir = path.resolve(stateDir(), "ship");
	const inputFile = path.resolve(shipDir, `${runId}.input.json`);
	if (path.dirname(inputFile) !== shipDir) return undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(inputFile, "utf8"));
		if (parsed === null || typeof parsed !== "object") return undefined;
		const profile = (parsed as { profile?: unknown }).profile;
		return typeof profile === "string" ? profile : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve task ownership through the durable task -> run -> ship-input join. */
function projectOwners(): ReadonlyMap<string, ProjectProfile | undefined> {
	let profiles: ProjectProfile[];
	try {
		profiles = loadProfiles();
	} catch {
		profiles = [];
	}
	const byId = new Map(profiles.map((profile) => [profile.id, profile]));
	const owners = new Map<string, ProjectProfile | undefined>();
	let names: string[];
	try {
		names = fs.readdirSync(stateDir());
	} catch {
		return owners;
	}
	for (const name of names) {
		if (!name.endsWith(".meta")) continue;
		const taskId = name.slice(0, -".meta".length);
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId)) continue;
		const runId = readMeta(taskId)?.run_id;
		const profileId = typeof runId === "string" ? readInputProfile(runId) : undefined;
		owners.set(taskId, profileId === undefined ? undefined : byId.get(profileId));
	}
	return owners;
}

function productionDependencies(now: number): WakeDrainDependencies {
	let activeSessionId: string | null = null;
	return {
		now: () => now,
		hasLiveSession: async () => {
			activeSessionId = await findPrimeSession();
			return activeSessionId !== null;
		},
		dueWakes: readDueWakes,
		owners: projectOwners(),
		applyProjectTierPolicy: projectTierPolicy,
		markInFlight: recordInFlight,
		retire: (ids) => {
			retireDelivered(ids);
		},
		suppressWakes: recordSuppressed,
		send: async (content, options) => {
			if (activeSessionId === null) return { ok: false };
			// A resolved request is not a delivered message: the daemon answers
			// `{success:false, error}` for a rejected prompt. Treating that as
			// delivery would retire the wake and lose the event silently, so the
			// response has to be inspected rather than merely awaited.
			const accepted = (response: DaemonResponse): { ok: boolean } => ({
				ok: response.success !== false,
			});
			try {
				if (!options.triggerTurn) {
					return accepted(await requestDaemon({
						type: "append_custom_message",
						activeSessionId,
						message: { customType: "deck.wake.v1", content, display: true },
					}));
				}
				// This is the daemon form of sendMessage(..., { deliverAs:
				// "followUp", triggerTurn: true }) used by questions.ts.
				return accepted(await requestDaemon({
					type: "prompt",
					activeSessionId,
					message: content,
					streamingBehavior: "followUp",
					queueIfBusy: true,
					expandPromptTemplates: false,
					customMessage: { customType: "deck.wake.v1", content, display: true },
				}));
			} catch {
				return { ok: false };
			}
		},
	};
}

/**
 * Terminal outcomes as the durable Smithers run state reports them. `status:
 * "finished"` means STOPPED, not succeeded; the outcome lives in `state`
 * (see observer.ts RUN_TRANSITIONS), so both fields are checked.
 */
const RUN_TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled"]);

function terminalOutcome(run: Pick<PsRun, "status" | "state">): string | undefined {
	if (typeof run.state === "string" && RUN_TERMINAL_OUTCOMES.has(run.state)) return run.state;
	if (typeof run.status === "string" && RUN_TERMINAL_OUTCOMES.has(run.status)) return run.status;
	return undefined;
}

/**
 * A terminal run can never consume an answer, so its still-open workflow
 * questions are queue noise (observed live: dry-run artifacts outliving their
 * cancelled runs). This runs in the wake drainer because that is the production
 * loop that durably sees terminal runs; retirement is idempotent per run and a
 * failure is a warning, never a broken sweep.
 */
export function retireQuestionsForTerminalRuns(
	runs: readonly Pick<PsRun, "id" | "status" | "state">[],
	warn?: (message: string) => void,
	deadlineAtMs?: number,
): string[] {
	const retired: string[] = [];
	let processed = 0;
	for (const run of runs) {
		// Each retirement scans the queue and can wait on its lock, so the whole
		// pass shares the sweep's time budget instead of running unbounded.
		if (deadlineAtMs !== undefined && Date.now() > deadlineAtMs) {
			warn?.(
				`question GC budget exhausted after ${processed} run(s); resuming next sweep`,
			);
			break;
		}
		processed += 1;
		const outcome = terminalOutcome(run);
		if (outcome === undefined) continue;
		retired.push(...retireRunQuestionsSafely(
			queueFile(),
			run.id,
			`run ${run.id} reached terminal state ${outcome}; question retired automatically`,
			warn,
		));
	}
	return retired;
}

async function drainSweep(): Promise<DrainResult> {
	const now = Date.now();
	// Status and declarative self-wakes must reach the outbox before this cycle
	// snapshots due entries. Reversing these calls adds a full interval of latency.
	reconcile();
	produceDueSelfWakes(now);
	// Wakes drain FIRST: delivery must never wait on the run snapshot, which is
	// a gateway fetch that can hang. Question GC rides behind, bounded — a slow
	// or unavailable snapshot skips retirement this cycle and the next sweep
	// retries.
	const result = await drainOnce(productionDependencies(now));
	// One budget covers the whole GC pass: snapshot AND retirement. collectRuns
	// reports failure as degraded health instead of rejecting, so health is the
	// real skip signal; the deadline guards a genuinely hung fetch.
	const gcDeadlineAt = Date.now() + runSnapshotDeadlineMs();
	const gcWarn = (message: string) =>
		process.stderr.write(`deck: ${message}\n`);
	try {
		const { runs, health } = await withDeadline(
			collectRuns(smithersWorkspaceCwd()),
			runSnapshotDeadlineMs(),
			"run snapshot",
		);
		if (health.state !== "ok") {
			gcWarn(
				`skipping question GC this sweep: gateway snapshot ${health.state} (${health.detail})`,
			);
		} else {
			retireQuestionsForTerminalRuns(runs, gcWarn, gcDeadlineAt);
		}
	} catch (error) {
		// The deadline fired while the gateway request still hangs; evict the
		// cached in-flight promise so the next sweep issues a fresh request
		// instead of re-awaiting the hung one forever.
		evictCollectRunsCache(smithersWorkspaceCwd());
		gcWarn(
			`skipping question GC this sweep: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	recordSweep(now);
	return result;
}

function runSnapshotDeadlineMs(): number {
	const raw = Number(process.env.DECK_RUN_SNAPSHOT_DEADLINE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

/** Bounds a promise that has no deadline of its own; the loser keeps running detached. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} did not respond within ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

type DrainSignal = "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM";
const DRAIN_SIGNAL_EXIT_CODE: Record<DrainSignal, number> = {
	SIGHUP: 129,
	SIGINT: 130,
	SIGQUIT: 131,
	SIGTERM: 143,
};

type WakeDrainLockRecord = {
	owner: string;
	pid: number;
	renewedAt: number;
	released?: boolean;
};

export type WakeDrainClaim = {
	renew(now?: number): boolean;
	release(now?: number): void;
};

function wakeDrainLockDir(): string {
	return path.join(stateDir(), ".wake-drain.lock");
}

function wakeDrainOwnerFile(): string {
	return path.join(wakeDrainLockDir(), "owner");
}

function readWakeDrainLock(): WakeDrainLockRecord | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(wakeDrainOwnerFile(), "utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		const row = parsed as Record<string, unknown>;
		if (
			typeof row.owner !== "string" ||
			typeof row.pid !== "number" ||
			!Number.isInteger(row.pid) ||
			typeof row.renewedAt !== "number" ||
			!Number.isFinite(row.renewedAt)
		) {
			return null;
		}
		return {
			owner: row.owner,
			pid: row.pid,
			renewedAt: row.renewedAt,
			...(row.released === true ? { released: true } : {}),
		};
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Replace only the record owned by this claimant. The owner-specific temp file
 * moves with the old directory if a lease reclaimer wins, so an evicted holder
 * cannot overwrite the next claimant's record through the stable lock path.
 */
function replaceOwnedWakeDrainLock(owner: string, next: WakeDrainLockRecord): boolean {
	const current = readWakeDrainLock();
	if (current?.owner !== owner) return false;
	const tmp = path.join(wakeDrainLockDir(), `.owner.${owner}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
		if (readWakeDrainLock()?.owner !== owner) return false;
		fs.renameSync(tmp, wakeDrainOwnerFile());
		return true;
	} catch {
		return false;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// rename consumed it, or lease reclamation moved the directory.
		}
	}
}

function buildWakeDrainClaim(record: WakeDrainLockRecord): WakeDrainClaim {
	let active = true;
	return {
		renew: (now = Date.now()) => {
			if (!active) return false;
			const renewed = replaceOwnedWakeDrainLock(record.owner, { ...record, renewedAt: now });
			if (renewed) record.renewedAt = now;
			else active = false;
			return renewed;
		},
		release: (now = Date.now()) => {
			if (!active) return;
			// Marking released avoids a check-then-rename race where an expired
			// old holder could accidentally remove a replacement claimant.
			replaceOwnedWakeDrainLock(record.owner, { ...record, renewedAt: now, released: true });
			active = false;
		},
	};
}

/**
 * Claim the one drainer for this Deck home.
 *
 * mkdir+rename is the established worktree-lock claim pattern. The added lease
 * makes proof of recent work authoritative: an expired record is reclaimable
 * even when its pid was recycled into an unrelated live process.
 */
export function claimWakeDrain(now = Date.now(), pid = process.pid): WakeDrainClaim | null {
	const file = wakeDrainLockDir();
	const owner = `wake-drain-${pid}-${randomUUID()}`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const tmp = `${file}.tmp-${owner}-${attempt}`;
		const record: WakeDrainLockRecord = { owner, pid, renewedAt: now };
		try {
			fs.mkdirSync(tmp, { mode: 0o700 });
			fs.writeFileSync(path.join(tmp, "owner"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
			fs.renameSync(tmp, file);
			return buildWakeDrainClaim(record);
		} catch (error) {
			try {
				fs.rmSync(tmp, { recursive: true, force: true });
			} catch {
				// The claim rename consumed it.
			}
			const current = readWakeDrainLock();
			const leaseFresh =
				current !== null &&
				current.released !== true &&
				now - current.renewedAt <= WAKE_DRAIN_LEASE_MS;
			if (leaseFresh && pidAlive(current.pid)) return null;
			const stale = `${file}.stale-${pid}-${randomUUID()}`;
			try {
				fs.renameSync(file, stale);
				fs.rmSync(stale, { recursive: true, force: true });
			} catch {
				if (attempt === 7) throw error;
			}
		}
	}
	throw new Error(`could not acquire wake drain lock ${wakeDrainOwnerFile()}`);
}

/** Run one launchd/systemd sweep, or remain resident for an explicit local watcher. */
export async function runWakeDrain(options: { once?: boolean; intervalMs?: number } = {}): Promise<void> {
	const intervalMs = options.intervalMs ?? WAKE_DRAIN_INTERVAL_MS;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("wake drain interval must be positive");
	const claim = claimWakeDrain();
	if (claim === null) {
		process.stdout.write(`wake-drain: another live drainer owns ${deckV2Home()}; skipping this sweep\n`);
		return;
	}

	let released = false;
	let renewTimer: ReturnType<typeof setInterval> | undefined;
	const releaseOnce = (): void => {
		if (released) return;
		released = true;
		clearInterval(renewTimer);
		claim.release();
	};
	renewTimer = setInterval(() => {
		if (claim.renew()) return;
		process.stderr.write("wake-drain: exclusive lease was lost; stopping\n");
		releaseOnce();
		process.exit(1);
	}, WAKE_DRAIN_INTERVAL_MS);
	const signalHandlers = (Object.keys(DRAIN_SIGNAL_EXIT_CODE) as DrainSignal[]).map((signal) => {
		const handler = (): void => {
			releaseOnce();
			process.exit(DRAIN_SIGNAL_EXIT_CODE[signal]);
		};
		process.once(signal, handler);
		return { signal, handler };
	});

	try {
		for (;;) {
			if (!claim.renew()) throw new Error("wake-drain lost its exclusive lease before sweeping");
			await drainSweep();
			if (!claim.renew()) throw new Error("wake-drain lost its exclusive lease after sweeping");
			if (options.once === true) return;
			await Bun.sleep(intervalMs);
		}
	} finally {
		for (const { signal, handler } of signalHandlers) process.off(signal, handler);
		releaseOnce();
	}
}
