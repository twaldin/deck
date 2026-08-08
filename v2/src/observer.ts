/**
 * Smithers observer adapter: the SOLE `.status` writer for a workflow-backed task.
 *
 * A plain task's own run appends its status, epoch-fenced. A workflow-backed task
 * cannot work that way: it has many nodes, each retryable, each able to run more
 * than once. If nodes appended their own status lines, a retried node would
 * re-announce a transition the orchestrator already acted on, and two nodes
 * finishing together would interleave. So nodes never append. They return
 * validated output rows, and this adapter translates run state into status
 * events.
 *
 * Truth flows one way: Smithers owns the run, this adapter observes it, the
 * status file records what the orchestrator needs to react to. The adapter never
 * mutates a run — reads go through the public read-only CLI (`ps`, `inspect`),
 * never the private store, never a Gateway lifecycle command.
 *
 * Idempotency is the whole problem. `smithers ps` is a poll: the same transition
 * is visible on every cycle until it changes. Each emitted event therefore has a
 * key of {scope, run_id, node_id, transition, seq}, and the adapter keeps the set
 * of emitted keys on disk. A transition already in that set is never appended
 * twice, so an observer restart mid-run is safe, and so is a second observer.
 *
 * The `scope` field is load-bearing, not decoration. A run-level key first used a
 * "-" sentinel in the node position, which a node genuinely named "-" collides
 * with: two distinct events would share one key and the second poll would
 * suppress the survivor. Scoping run-level and node-level keys into separate
 * namespaces makes the collision unrepresentable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { appendStatus } from "./events";
import { stateDir } from "./home";
import { readMeta } from "./meta";
import { queueFile, retireRunQuestionsSafely } from "./questions-store";
import { findProfile } from "./projects";
import type { ProjectProfile } from "./projects";
import { SMITHERS_SPEC } from "./smithers";
import type { StatusVerb } from "./status";
import type { WakeItem } from "./wake";
import { releaseWorktree } from "./worktree-lock";

/** A run as the read-only CLI reports it. */
export type ObservedRun = {
	id: string;
	workflow: string;
	/** Outcome: runState.state when present, else run.status. See RUN_TRANSITIONS. */
	status: string;
	step: string | null;
	rootDir: string | null;
	workspace?: string;
};

export type ObservedNode = {
	nodeId: string;
	status: string;
	/** Attempt counter when the CLI reports one; a retry bumps it. */
	attempt?: number;
	/** Validated task output, when inspect exposes it. Used only for milestone context. */
	output?: unknown;
};

export type Observation = {
	run: ObservedRun;
	nodes: ObservedNode[];
};

export type PsSnapshotRow = {
	id?: unknown;
	workflow?: unknown;
	status?: unknown;
	state?: unknown;
	step?: unknown;
	rootDir?: unknown;
	/** Workspace that produced this row. */
	workspace?: string;
	blockedNode?: unknown;
	runState?: { blocked?: { nodeId?: unknown } };
	pendingApprovals?: Array<{ nodeId?: unknown; status?: unknown }>;
};

export type EmittedEvent = {
	taskId: string;
	verb: StatusVerb;
	note: string;
	key: string;
	/** Delivery classification written into the status grammar's key. */
	statusKey?: "terminal" | "milestone";
};

/**
 * Which run states are worth a status line, and as what.
 *
 * Deliberately sparse: a node starting is not news. fm2's measured status volume
 * was 49% `working:` lines, each costing the orchestrator a supervision turn to
 * read and discard. Only transitions the orchestrator can act on are events.
 */
/**
 * Real vocabulary, read off a live 0.30.0 workspace rather than guessed.
 *
 * Two traps confirmed against actual output:
 *
 *  - The field is `state`, not `status`, on steps. On the run there is BOTH:
 *    `run.status` and `runState.state`.
 *  - `run.status: "finished"` means STOPPED, not succeeded. Outcome lives in
 *    `runState.state` (`succeeded` / `failed`). Treating "finished" as success
 *    would report a failed workflow to the orchestrator as `done:`, and done is
 *    what it acts on.
 *
 * So the run verb is decided by runState.state, falling back to run.status.
 */
const RUN_TRANSITIONS: Record<string, { verb: StatusVerb; note: string } | undefined> = {
	succeeded: { verb: "done", note: "workflow finished" },
	failed: { verb: "failed", note: "workflow failed" },
	cancelled: { verb: "failed", note: "workflow cancelled" },
	"waiting-human": { verb: "needs-decision", note: "workflow is waiting for an answer" },
	"waiting-event": { verb: "blocked", note: "workflow is waiting for an event" },
	// Paused is deliberate waiting, not a fault, and is never treated as stale.
	paused: { verb: "paused", note: "workflow paused" },
};

/** Terminal states: after one of these the run emits nothing further. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Pipeline milestones are intentionally allow-listed recorded state. A healthy
 * node finishing is not news by itself, and the `terminal` marker identifies the
 * smaller subset that delivery policy may wake on. Everything else is stamped
 * `milestone` so informational churn stays silent structurally, not by note text.
 */
export const PIPELINE_MILESTONES: Record<string, {
	transition: string;
	entering?: boolean;
	terminal?: boolean;
	note: (node: ObservedNode) => string;
}> = {
	"push-pr": {
		transition: "pr-opened",
		note: (node) => `PR opened${formatMilestoneValue(node.output, ["prNumber", "pr", "number"])}`,
	},
	"enqueue-merge": {
		transition: "queued",
		note: () => "PR submitted to the merge queue",
	},
	"landing-poll": {
		transition: "landed",
		terminal: true,
		note: (node) => `PR landed${formatMilestoneValue(node.output, ["sha", "landedSha"])}`,
	},

	"fallout-wait": {
		transition: "fallout-wait",
		entering: true,
		note: () => "entered fallout wait",
	},
	"fallout-watch": {
		transition: "fallout-complete",
		note: () => "fallout checks complete",
	},
};

/**
 * Apply the owning project's terminal-delivery policy after wake classification.
 *
 * The owner map is resolved by the runner and keyed by task id. Keeping I/O out
 * of this function makes unknown ownership an explicit fail-quiet case rather
 * than an accidental config or filesystem dependency.
 */
export function applyProjectTierPolicy(
	items: WakeItem[],
	owners: ReadonlyMap<string, ProjectProfile | undefined>,
): WakeItem[] {
	return items.map((item) => {
		const { verb, key } = item.event;
		let tier = item.tier;
		if (verb === "failed" || verb === "blocked" || verb === "needs-decision") {
			tier = "T0";
		} else if (key === "milestone") {
			tier = "T2";
		} else if (key === "terminal") {
			tier = owners.get(item.taskId)?.wakeOnTerminal === true ? "T1" : "T2";
		}
		return tier === item.tier ? item : { ...item, tier };
	});
}

function formatMilestoneValue(output: unknown, fields: string[]): string {
	if (typeof output !== "object" || output === null) return "";
	for (const field of fields) {
		const value = (output as Record<string, unknown>)[field];
		if (typeof value === "string" || typeof value === "number") return ` (${field} ${value})`;
	}
	return "";
}

function milestoneFinished(status: string): boolean {
	return status === "finished" || status === "completed" || status === "succeeded";
}

export type ObserverLedger = {
	/** Emitted transition keys, so a poll never appends the same event twice. */
	emitted: string[];
};

function ledgerPath(taskId: string): string {
	return path.join(stateDir(), `${taskId}.observed`);
}

export function readLedger(taskId: string): ObserverLedger {
	try {
		const parsed = JSON.parse(fs.readFileSync(ledgerPath(taskId), "utf8")) as ObserverLedger;
		return { emitted: Array.isArray(parsed.emitted) ? parsed.emitted : [] };
	} catch {
		return { emitted: [] };
	}
}

function writeLedger(taskId: string, ledger: ObserverLedger): void {
	const target = ledgerPath(taskId);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// Write-then-rename: a crash mid-write must not leave a truncated ledger,
	// because a lost ledger means every past transition looks new and gets
	// re-announced.
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target);
}

/**
 * The idempotency key. `seq` distinguishes genuine repeats of the same
 * transition — a node that fails, is retried, and fails again is two events, not
 * one — while a poll that re-observes an unchanged state produces an identical
 * key and is dropped.
 */
export function transitionKey(input: {
	scope: "run" | "node";
	runId: string;
	nodeId: string;
	transition: string;
	seq: number;
	/** Workspace that owns the run. */
	workspace?: string;
	/**
	 * Distinguishes repeats that share every other field.
	 *
	 * Needed because real payloads DO contain duplicate (nodeId, attempt) pairs —
	 * verified on a live debate run, where `backlog-opponent` appears twice at
	 * attempt 1, once per round. Without this, two failures of the same loop node in
	 * one poll collapse to one key and one of them is silently never reported.
	 *
	 * For run-level transitions it separates re-entries of the same state, so a
	 * workflow that stops at a second approval gate is not mistaken for the first.
	 */
	occurrence?: number | string;
}): string {
	const occurrence = input.occurrence === undefined ? "" : `:${input.occurrence}`;
	const workspace = input.workspace === undefined ? "" : `:${input.workspace}`;
	return `${input.scope}:${workspace}:${input.runId}:${input.nodeId}:${input.transition}:${input.seq}${occurrence}`;
}

/**
 * Translate one observation into the status events not yet emitted.
 *
 * Pure: it decides, it does not write. The caller commits. This is what makes
 * the double-emit case testable without a live Smithers run.
 */
export function planEvents(
	taskId: string,
	observation: Observation,
	ledger: ObserverLedger,
): EmittedEvent[] {
	const seen = new Set(ledger.emitted);
	// Cancelled runs can remain in `ps` output while old node rows are still
	// visible. Never wake from stale node rows after cancellation. The run-level
	// cancellation event below is still emitted once, so the task records closure.
	const events: EmittedEvent[] = [];
	const { run, nodes } = observation;

	// A failed node inside a still-running workflow is reported, because the
	// fix-now doctrine depends on the orchestrator hearing about a red result
	// without waiting for the whole run to finish.
	// Occurrence index per (nodeId, attempt), so duplicate loop-node rows in one
	// payload get distinct keys instead of collapsing to one event.
	const seenNode = new Map<string, number>();
	for (const node of nodes) {
		if (observation.run.status === "cancelled") continue;
		// Real step states seen live: finished, waiting-approval, failed.
		const milestone = run.workflow === "pr-pipeline" ? PIPELINE_MILESTONES[node.nodeId] : undefined;
		const landingConfirmed = node.nodeId !== "landing-poll" ||
			(typeof node.output === "object" && node.output !== null && (node.output as Record<string, unknown>).landed === true);
		const isMilestone = milestone !== undefined && landingConfirmed &&
			(milestone.entering ? node.status === "running" : milestoneFinished(node.status));
		if (node.status !== "failed" && !isMilestone) continue;
		const transition = node.status === "failed" ? "failed" : milestone!.transition;
		const dedupeKey = `${node.nodeId}:${node.attempt ?? 0}:${transition}`;
		const occurrence = seenNode.get(dedupeKey) ?? 0;
		seenNode.set(dedupeKey, occurrence + 1);
		const key = transitionKey({
			scope: "node",
			runId: run.id,
			nodeId: node.nodeId,
			transition,
			seq: node.attempt ?? 0,
			occurrence,
			workspace: run.workspace,
		});
		if (seen.has(key)) continue;
		events.push({
			taskId,
			verb: node.status === "failed" ? "failed" : "resolved",
			note: node.status === "failed"
				? `step ${node.nodeId} failed and is being retried`
				: milestone!.note(node),
			...(node.status === "failed"
				? {}
				: { statusKey: milestone!.terminal === true ? "terminal" as const : "milestone" as const }),
			key,
		});
	}

	const transition = run.status === "waiting-approval"
		? approvalTransition(run.step)
		: RUN_TRANSITIONS[run.status];
	if (transition !== undefined) {
		// The blocking step discriminates re-entries of a non-terminal state.
		const key = transitionKey({
			scope: "run",
			runId: run.id,
			nodeId: "",
			transition: run.status,
			seq: 0,
			...(TERMINAL.has(run.status) || run.step === null ? {} : { occurrence: run.step }),
			workspace: run.workspace,
		});
		if (!seen.has(key)) {
			const step = run.step === null ? "" : ` at ${run.step}`;
			const note = transition.note === "stamp ready"
				? transition.note
				: `${transition.note}${TERMINAL.has(run.status) ? "" : step}`;
			events.push({
				taskId,
				verb: transition.verb,
				note,
				key,
				...(TERMINAL.has(run.status) ? { statusKey: "terminal" as const } : {}),
			});
		}
	}

	return events;
}

function approvalTransition(step: string | null): { verb: StatusVerb; note: string } {
	const gate = (step ?? "").toLowerCase();
	if (gate.includes("review-escalation")) {
		return { verb: "failed", note: "review-escalation — orch heal; do not wait on captain" };
	}
	if (gate.includes("r0-stamp") || gate === "stamp" || gate.endsWith("-stamp")) {
		return { verb: "needs-decision", note: "stamp ready" };
	}
	return {
		verb: "needs-decision",
		note: "workflow is waiting for approval",
	};
}

export function wakeOnTerminalForRun(runId: string): boolean {
	const shipDir = path.resolve(stateDir(), "ship");
	const inputPath = path.resolve(shipDir, `${runId}.input.json`);
	if (inputPath === shipDir || !inputPath.startsWith(`${shipDir}${path.sep}`)) return false;
	let input: { profile?: unknown };
	try {
		input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as { profile?: unknown };
	} catch {
		// A run without deck's durable ship input cannot be tied to a project
		// safely. Guessing from a worktree path risks waking the wrong fleet.
		return false;
	}
	return typeof input.profile === "string" && findProfile(input.profile)?.wakeOnTerminal === true;
}

/**
 * Commit planned events: append each status line, then record its key.
 *
 * Order matters and is the deliberate choice of the safer failure. Appending
 * before recording means a crash between the two re-announces one event on
 * restart; recording first would mean a crash loses it forever. A duplicate
 * `done:` costs the orchestrator one wasted look. A lost `failed:` means nobody
 * ever hears that the work broke.
 */
export function commitEvents(taskId: string, events: EmittedEvent[], ledger: ObserverLedger): void {
	if (events.length === 0) return;
	const emitted = [...ledger.emitted];
	for (const event of events) {
		appendStatus(taskId, event.verb, event.note, event.statusKey === undefined ? {} : { key: event.statusKey });
		emitted.push(event.key);
		writeLedger(taskId, { emitted });
	}
}

/** Observe once and write whatever is new. Returns what it appended. */
export function observeOnce(taskId: string, observation: Observation): EmittedEvent[] {
	const ledger = readLedger(taskId);
	const events = planEvents(taskId, observation, ledger);
	commitEvents(taskId, events, ledger);
	if (isFinished(observation)) {
		const metaWorktree = readMeta(taskId)?.worktree;
		const shipInput = path.join(stateDir(), "ship", `${observation.run.id}.input.json`);
		let inputWorktree: string | undefined;
		try {
			const input = JSON.parse(fs.readFileSync(shipInput, "utf8")) as { worktree?: unknown };
			if (typeof input.worktree === "string") inputWorktree = input.worktree;
		} catch { /* non-ship tasks have no ship input */ }
		const worktree = metaWorktree ?? inputWorktree;
		if (worktree !== undefined) releaseWorktree(worktree, observation.run.id);
		// A terminal run can never consume an answer; its open questions are
		// queue noise. Dismissal is idempotent and scoped to this run id, and a
		// retirement failure must never break the observation that noticed the
		// terminal run — it is reported as a warning instead.
		retireRunQuestionsSafely(
			queueFile(),
			observation.run.id,
			`run ${observation.run.id} reached terminal state ${observation.run.status}; question retired automatically`,
		);
	}
	return events;
}

/** True once the run can produce no further events, so polling can stop. */
export function isFinished(observation: Observation): boolean {
	return TERMINAL.has(observation.run.status);
}

/** Observe one `smithers ps --json` snapshot. This is the production poll wire. */
function taskIdForRow(row: PsSnapshotRow): string | null {
	if (typeof row.id !== "string") return null;
	const shipDir = path.resolve(stateDir(), "ship");
	const inputPath = path.resolve(shipDir, `${row.id}.input.json`);
	if (inputPath === shipDir || !inputPath.startsWith(`${shipDir}${path.sep}`)) return null;
	try {
		const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as { ticket?: unknown };
		return typeof input.ticket === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.ticket) ? input.ticket : null;
	} catch {
		return null;
	}
}

function observationFromPsRow(row: PsSnapshotRow): Observation | null {
	if (typeof row.id !== "string") return null;
	const taskId = taskIdForRow(row);
	if (taskId === null) return null;
	const status = typeof row.status === "string" ? row.status : typeof row.state === "string" ? row.state : "";
	const outcome = typeof row.state === "string" && (TERMINAL.has(row.state) || status === "") ? row.state : status;
	const pending = row.pendingApprovals?.find((approval) => approval.status === "requested")?.nodeId
		?? row.pendingApprovals?.[0]?.nodeId
		?? row.blockedNode
		?? row.runState?.blocked?.nodeId;
	const step = typeof pending === "string" ? pending : typeof row.step === "string" && row.step !== "—" ? row.step : null;
	return {
		run: { id: row.id, workflow: typeof row.workflow === "string" ? row.workflow : "", status: outcome, step, rootDir: typeof row.rootDir === "string" ? row.rootDir : null, workspace: row.workspace },
		nodes: [],
	};
}

export function observePsSnapshot(rows: readonly PsSnapshotRow[]): EmittedEvent[] {
	const emitted: EmittedEvent[] = [];
	for (const row of rows) {
		const observation = observationFromPsRow(row);
		const taskId = taskIdForRow(row);
		if (observation !== null && taskId !== null) emitted.push(...observeOnce(taskId, observation));
	}
	return emitted;
}

/** Inspect each live Smithers row so production polling includes node transitions. */
const psSnapshotInFlight = new Map<string, Promise<EmittedEvent[]>>();

async function observePsSnapshotWithInspectOnce(options: {
	rows: readonly PsSnapshotRow[];
	workspace: string;
	run: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number } | null>;
}): Promise<EmittedEvent[]> {
	const emitted: EmittedEvent[] = [];
	for (const row of options.rows) {
		const base = observationFromPsRow(row);
		const taskId = taskIdForRow(row);
		if (base === null || taskId === null || typeof row.id !== "string") continue;
		const result = await options.run("bunx", [SMITHERS_SPEC, "inspect", row.id, "--format", "json"], row.workspace ?? options.workspace).catch(() => null);
		const inspected = result !== null && result.exitCode === 0 ? parseInspect(result.stdout) : null;
		if (inspected !== null) inspected.run.workspace = base.run.workspace;
		emitted.push(...observeOnce(taskId, inspected ?? base));
	}
	return emitted;
}

export function observePsSnapshotWithInspect(options: {
	rows: readonly PsSnapshotRow[];
	workspace: string;
	run: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number } | null>;
}): Promise<EmittedEvent[]> {
	const current = psSnapshotInFlight.get(options.workspace);
	if (current !== undefined) return current;
	const result = observePsSnapshotWithInspectOnce(options);
	psSnapshotInFlight.set(options.workspace, result);
	void result.then(
		() => { if (psSnapshotInFlight.get(options.workspace) === result) psSnapshotInFlight.delete(options.workspace); },
		() => { if (psSnapshotInFlight.get(options.workspace) === result) psSnapshotInFlight.delete(options.workspace); },
	);
	return result;
}

/**
 * Poll a Smithers run and write whatever is new, until it is finished.
 *
 * Reads go through the public read-only CLI (`inspect --json`), pinned to the
 * workspace version because bun can silently resolve a newer global build from a
 * directory without a package.json. Never a mutating command, never the private
 * store, never a Gateway lifecycle call.
 *
 * The poll is what makes the adapter the sole writer: nodes return validated
 * output rows and stay silent, so a retried node cannot re-announce a transition
 * the orchestrator already acted on.
 */
export async function observeRun(options: {
	taskId: string;
	runId: string;
	workspace: string;
	run: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number } | null>;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	maxCycles?: number;
}): Promise<EmittedEvent[]> {
	const interval = options.intervalMs ?? 10_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const emitted: EmittedEvent[] = [];

	for (let cycle = 0; cycle < (options.maxCycles ?? Number.POSITIVE_INFINITY); cycle++) {
		const result = await options
			.run("bunx", [SMITHERS_SPEC, "inspect", options.runId, "--format", "json"], options.workspace)
			.catch(() => null);

		// A failed read is not a failed run. Reporting it as one would append a
		// terminal status for a workflow that is still working, and terminal status
		// is what the orchestrator acts on. Silence and retry is correct.
		if (result === null || result.exitCode !== 0) {
			await sleep(interval);
			continue;
		}

		const observation = parseInspect(result.stdout);
		if (observation === null) {
			await sleep(interval);
			continue;
		}

		emitted.push(...observeOnce(options.taskId, observation));
		if (isFinished(observation)) break;
		await sleep(interval);
	}
	return emitted;
}


/**
 * Parse `inspect --format json`. Returns null for anything unusable rather than
 * guessing: a wrong guess here writes a wrong terminal status.
 */
export function parseInspect(stdout: string): Observation | null {
	let payload: any;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return null;
	}
	const run = payload?.run ?? payload;
	if (typeof run?.id !== "string" || typeof run?.status !== "string") return null;

	// Canonical shape is nodes[].nodeId; steps[].id is the legacy alias kept for
	// compatibility, so both are accepted.
	const rawNodes: any[] = Array.isArray(payload?.nodes) && payload.nodes.length > 0
		? payload.nodes
		: Array.isArray(payload?.steps)
			? payload.steps
			: [];
	// Steps carry `state`; `status` is accepted too so a shape change does not read
	// as every node being healthy.
	const nodes: ObservedNode[] = rawNodes
		.map((node) => ({
			nodeId: typeof node?.nodeId === "string" ? node.nodeId : String(node?.id ?? ""),
				status: String(node?.state ?? node?.status ?? ""),
			...(typeof node?.attempt === "number" ? { attempt: node.attempt } : {}),
			...(node?.output !== undefined ? { output: node.output } : {}),
		}))
		.filter((node) => node.nodeId.length > 0);

	// runState.state is the outcome; run.status only says it stopped.
	const outcome =
		typeof payload?.runState?.state === "string" ? payload.runState.state : run.status;

	return {
		run: {
			id: run.id,
			workflow: String(run.workflow ?? ""),
			status: outcome,
			step: outcome === "waiting-event"
				? typeof run.blockedNode === "string"
					? run.blockedNode
					: typeof payload?.runState?.blocked?.nodeId === "string"
						? payload.runState.blocked.nodeId
						: typeof run.step === "string" && run.step !== "—" ? run.step : null
				: typeof run.step === "string" && run.step !== "—" ? run.step : null,
			rootDir: typeof payload?.config?.rootDir === "string" ? payload.config.rootDir : null,
		},
		nodes,
	};
}
