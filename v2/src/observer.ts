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
import type { StatusVerb } from "./status";
import { stateDir } from "./home";

/** A run as the read-only CLI reports it. */
export type ObservedRun = {
	id: string;
	workflow: string;
	status: string;
	step: string | null;
	rootDir: string | null;
};

export type ObservedNode = {
	nodeId: string;
	status: string;
	/** Attempt counter when the CLI reports one; a retry bumps it. */
	attempt?: number;
};

export type Observation = {
	run: ObservedRun;
	nodes: ObservedNode[];
};

export type EmittedEvent = {
	taskId: string;
	verb: StatusVerb;
	note: string;
	key: string;
};

/**
 * Which run states are worth a status line, and as what.
 *
 * Deliberately sparse: a node starting is not news. fm2's measured status volume
 * was 49% `working:` lines, each costing the orchestrator a supervision turn to
 * read and discard. Only transitions the orchestrator can act on are events.
 */
const RUN_TRANSITIONS: Record<string, { verb: StatusVerb; note: string } | undefined> = {
	completed: { verb: "done", note: "workflow finished" },
	failed: { verb: "failed", note: "workflow failed" },
	cancelled: { verb: "failed", note: "workflow cancelled" },
	// A run waiting on an approval gate is the one mid-run state that matters:
	// it is blocked on the captain and nothing advances until he answers.
	awaiting_approval: { verb: "needs-decision", note: "workflow is waiting for approval" },
	awaiting_human: { verb: "needs-decision", note: "workflow is waiting for an answer" },
	// Paused is deliberate waiting, not a fault. It is reported so the fleet view
	// can show it, and `paused` is explicitly never treated as stale.
	paused: { verb: "paused", note: "workflow paused" },
};

/** Terminal run states: after one of these the run emits nothing further. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

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
}): string {
	return `${input.scope}:${input.runId}:${input.nodeId}:${input.transition}:${input.seq}`;
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
	const events: EmittedEvent[] = [];
	const { run, nodes } = observation;

	// A failed node inside a still-running workflow is reported, because the
	// fix-now doctrine depends on the orchestrator hearing about a red result
	// without waiting for the whole run to finish.
	for (const node of nodes) {
		if (node.status !== "failed") continue;
		const key = transitionKey({
			scope: "node",
			runId: run.id,
			nodeId: node.nodeId,
			transition: "failed",
			seq: node.attempt ?? 0,
		});
		if (seen.has(key)) continue;
		events.push({
			taskId,
			verb: "working",
			note: `step ${node.nodeId} failed and is being retried`,
			key,
		});
	}

	const transition = RUN_TRANSITIONS[run.status];
	if (transition !== undefined) {
		const key = transitionKey({
			scope: "run",
			runId: run.id,
			nodeId: "",
			transition: run.status,
			seq: 0,
		});
		if (!seen.has(key)) {
			const step = run.step === null ? "" : ` at ${run.step}`;
			events.push({
				taskId,
				verb: transition.verb,
				note: `${transition.note}${TERMINAL.has(run.status) ? "" : step}`,
				key,
			});
		}
	}

	return events;
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
		appendStatus(taskId, event.verb, event.note);
		emitted.push(event.key);
		writeLedger(taskId, { emitted });
	}
}

/** Observe once and write whatever is new. Returns what it appended. */
export function observeOnce(taskId: string, observation: Observation): EmittedEvent[] {
	const ledger = readLedger(taskId);
	const events = planEvents(taskId, observation, ledger);
	commitEvents(taskId, events, ledger);
	return events;
}

/** True once the run can produce no further events, so polling can stop. */
export function isFinished(observation: Observation): boolean {
	return TERMINAL.has(observation.run.status);
}
