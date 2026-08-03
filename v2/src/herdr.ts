/**
 * Herdr projection: every running worker surfaces as a named herdr agent.
 *
 * PROJECTION, not authority — the status file and session file remain the only
 * truth (the fm2 presentation-spaces lesson). Workers stay headless `pi -p`;
 * this module mirrors their state into herdr so the captain can `herdr agent
 * list` and see the same facts as /fleet. herdr missing is not an error: every
 * call degrades to "skipped" and the fleet keeps working.
 *
 * Shape (the smallest that works, probed live):
 *   - one dedicated "deck fleet" workspace, created --no-focus, id persisted in
 *     state/.herdr-projection.json and re-verified each pass
 *   - one tab per running task, --cwd = the task's worktree (which is what
 *     fleet.ts correlates on), root pane running `tail -F <status file>`
 *   - `herdr pane report-agent --source deck --agent <taskId>` carries
 *     working | blocked | idle mapped from run liveness + last status verb
 *   - teardown is identity-exact: a pane is closed only after `pane get`
 *     proves it still carries OUR agent label and the recorded pane id
 *   - smithers runs are fleet-only (/fleet, deck-fleet): no herdr pane. A pane
 *     recorded by an older version is released on the next pass.
 *
 * Pane and agent ids are recorded in the task's meta (herdr_pane, herdr_tab)
 * for recovery, per the brief.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FleetFrame, SourceHealth, TaskRow } from "./fleet";
import { stateDir, stateFiles } from "./home";
import { readMeta, updateMeta } from "./meta";
import { reapOrphanedBunTests } from "./orphan-reaper";

const run = promisify(execFile);

export type HerdrAgentState = "working" | "idle" | "blocked";

/**
 * Map a task row to the herdr agent state. Severity mirrors chipFor: a
 * decision or block outranks the process being alive.
 */
export function desiredState(task: TaskRow): HerdrAgentState {
	if (
		task.openDecisions > 0 ||
		task.lastVerb === "needs-decision" ||
		task.lastVerb === "blocked" ||
		task.lastVerb === "failed"
	) {
		return "blocked";
	}
	return task.runState === "running" ? "working" : "idle";
}

/**
 * Whether the task's pane should be closed. Terminal verbs (done, failed)
 * always release; a parked task (paused/blocked with no live run) or a gone
 * worktree releases too. Only a task that is running — or briefly between
 * events without a terminal/parked verb — keeps a pane. Pure; exported for
 * tests.
 */
export function shouldReleasePane(input: {
	runState: TaskRow["runState"];
	lastVerb: string | null;
	worktreeExists: boolean;
}): boolean {
	if (input.lastVerb === "done" || input.lastVerb === "failed") return true;
	if (input.runState === "running") return false;
	if (!input.worktreeExists) return true;
	return input.lastVerb === "paused" || input.lastVerb === "blocked";
}

/** One-line message for the agent row. herdr truncates long labels badly. */
export function projectionMessage(task: TaskRow): string {
	const body =
		task.lastVerb === null ? "no status yet" : `${task.lastVerb}: ${task.lastNote ?? ""}`;
	return body.length > 120 ? `${body.slice(0, 119)}…` : body;
}

// ---- herdr CLI plumbing -----------------------------------------------------

async function herdr(args: string[]): Promise<Record<string, unknown> | null> {
	try {
		const { stdout } = await run("herdr", args, { timeout: 8_000, maxBuffer: 1_000_000 });
		// Mutating commands (report-agent, release-agent) succeed with EMPTY
		// stdout; only a non-zero exit is failure for those.
		if (stdout.trim().length === 0) return {};
		const parsed: unknown = JSON.parse(stdout);
		if (parsed !== null && typeof parsed === "object") {
			return ((parsed as { result?: unknown }).result ?? {}) as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

type Projection = {
	workspaceId?: string;
	/** Legacy: older versions projected a smithers pane; kept only to release it. */
	smithersPane?: string;
	smithersTab?: string;
};

function projectionFile(): string {
	return path.join(stateDir(), ".herdr-projection.json");
}

function loadProjection(): Projection {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(projectionFile(), "utf8"));
		return parsed !== null && typeof parsed === "object" ? (parsed as Projection) : {};
	} catch {
		return {};
	}
}

function saveProjection(projection: Projection): void {
	const file = projectionFile();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** The dedicated workspace, created --no-focus once and re-verified each pass. */
async function ensureWorkspace(projection: Projection): Promise<string | null> {
	if (projection.workspaceId !== undefined) {
		const found = await herdr(["workspace", "get", projection.workspaceId]);
		if (found !== null) return projection.workspaceId;
	}
	const created = await herdr([
		"workspace",
		"create",
		"--label",
		"deck fleet",
		"--no-focus",
		"--cwd",
		stateDir(),
	]);
	const workspace = (created?.workspace ?? null) as { workspace_id?: string } | null;
	if (workspace?.workspace_id === undefined) return null;
	projection.workspaceId = workspace.workspace_id;
	saveProjection(projection);
	return workspace.workspace_id;
}

/**
 * Create the task's projection pane: a tab in the fleet workspace whose root
 * pane tails the status file. --cwd is the worktree so fleet.ts correlates it.
 */
async function createPane(
	workspaceId: string,
	task: TaskRow,
): Promise<{ pane: string; tab: string } | null> {
	const cwd = task.worktree !== null && fs.existsSync(task.worktree) ? task.worktree : stateDir();
	const created = await herdr([
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--label",
		task.taskId,
		"--no-focus",
		"--cwd",
		cwd,
	]);
	const pane = (created?.root_pane ?? null) as { pane_id?: string } | null;
	const tab = (created?.tab ?? null) as { tab_id?: string } | null;
	if (pane?.pane_id === undefined || tab?.tab_id === undefined) return null;
	await herdr(["pane", "run", pane.pane_id, `tail -n 40 -F ${shellQuote(stateFiles(task.taskId).status)}`]);
	return { pane: pane.pane_id, tab: tab.tab_id };
}

async function report(pane: string, agent: string, state: HerdrAgentState, message: string): Promise<boolean> {
	const result = await herdr([
		"pane",
		"report-agent",
		pane,
		"--source",
		"deck",
		"--agent",
		agent,
		"--state",
		state,
		"--message",
		message,
	]);
	return result !== null;
}

/**
 * Identity proof for a close. Exact-match ONLY: the pane id must be the
 * recorded one AND the pane must still carry our agent label. A missing agent
 * field is NOT authorization \u2014 a herdr schema change or a reused pane id
 * would otherwise close somebody else's pane. Pure; exported for tests.
 */
export function mayClosePane(
	info: { pane_id?: string; agent?: string } | null,
	pane: string,
	agent: string,
): boolean {
	return info !== null && info.pane_id === pane && info.agent === agent;
}

/** POSIX single-quote. The pane command runs in a shell; paths are data. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Identity-exact teardown: close the pane ONLY when `pane get` proves the
 * recorded pane still carries our agent label. Anything less \u2014 pane gone,
 * relabeled, or agent field absent \u2014 clears our record and touches nothing.
 */
async function releasePane(pane: string, tab: string | undefined, agent: string): Promise<void> {
	const found = await herdr(["pane", "get", pane]);
	const info = (found?.pane ?? null) as { pane_id?: string; agent?: string } | null;
	if (!mayClosePane(info, pane, agent)) return;
	await herdr(["pane", "release-agent", pane, "--source", "deck", "--agent", agent]);
	if (tab !== undefined) await herdr(["tab", "close", tab]);
	else await herdr(["pane", "close", pane]);
}

// ---- the projection pass ------------------------------------------------

let inFlight = false;

/**
 * One projection pass over a built frame. Idempotent; safe on a timer. Never
 * throws — herdr being down turns the pass into a no-op with "skipped" health.
 */
export async function projectFleet(frame: FleetFrame): Promise<SourceHealth> {
	if (inFlight) return { name: "herdr-projection", state: "skipped", detail: "pass already running" };
	inFlight = true;
	try {
		return await pass(frame);
	} catch (error) {
		return {
			name: "herdr-projection",
			state: "missing",
			detail: error instanceof Error ? error.message.split("\n")[0] ?? "failed" : "failed",
		};
	} finally {
		inFlight = false;
	}
}

async function pass(frame: FleetFrame): Promise<SourceHealth> {
	// Reap crashed test shards before projection. This runs on every herdr tick,
	// even when herdr itself is unavailable.
	await reapOrphanedBunTests();
	// Liveness probe first: no herdr means no projection, not an error.
	if ((await herdr(["workspace", "list"])) === null) {
		return { name: "herdr-projection", state: "skipped", detail: "herdr not running" };
	}
	const projection = loadProjection();
	let projected = 0;

	for (const task of frame.tasks) {
		const meta = readMeta(task.taskId);
		const recordedPane = typeof meta?.herdr_pane === "string" ? meta.herdr_pane : undefined;
		const recordedTab = typeof meta?.herdr_tab === "string" ? meta.herdr_tab : undefined;
		const worktreeExists = task.worktree !== null && fs.existsSync(task.worktree);
		// Spawned tasks open a pane immediately. Terminal status always wins over
		// process liveness, so a late status event cannot leave a ghost pane.
		const active = task.runState === "running" && !shouldReleasePane({ runState: task.runState, lastVerb: task.lastVerb, worktreeExists });

		// Terminal or parked: close the pane (identity-exact) instead of leaving
		// an idle ghost. A worktree still on disk is not a reason to keep one.
		if (shouldReleasePane({ runState: task.runState, lastVerb: task.lastVerb, worktreeExists })) {
			if (recordedPane !== undefined) {
				await releasePane(recordedPane, recordedTab, task.taskId);
				updateMeta(task.taskId, { herdr_pane: undefined, herdr_tab: undefined });
			}
			continue;
		}

		if (active) {
			let pane = recordedPane;
			if (pane === undefined) {
				const workspaceId = await ensureWorkspace(projection);
				if (workspaceId === null) continue;
				const created = await createPane(workspaceId, task);
				if (created === null) continue;
				pane = created.pane;
				updateMeta(task.taskId, { herdr_pane: created.pane, herdr_tab: created.tab });
			}
			const ok = await report(pane, task.taskId, desiredState(task), projectionMessage(task));
			if (!ok) {
				// Pane vanished (session restart, manual close). Recreate next pass.
				updateMeta(task.taskId, { herdr_pane: undefined, herdr_tab: undefined });
				continue;
			}
			projected += 1;
			continue;
		}

		if (recordedPane === undefined) continue;

		// Not running, not terminal/parked: the next event resumes the same
		// session, so the pane parks as idle until then.
		await report(recordedPane, task.taskId, desiredState(task), projectionMessage(task));
		projected += 1;
	}

	// Smithers runs are fleet-only (/fleet, deck-fleet). Release any pane a
	// previous version created so no ghost survives the upgrade.
	if (projection.smithersPane !== undefined) {
		await releasePane(projection.smithersPane, projection.smithersTab, "deck-smithers");
		delete projection.smithersPane;
		delete projection.smithersTab;
		saveProjection(projection);
	}

	return {
		name: "herdr-projection",
		state: "ok",
		detail: `${projected} agent(s) projected`,
	};
}
