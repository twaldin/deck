/**
 * Fleet view model: what agents and workflows are ACTUALLY doing.
 *
 * Primary view is runs and workflows, with the task list demoted — the captain's
 * ask. This module is the model only; the extension renders it as a full-screen
 * overlay and the CLI prints it. Both consume the same shape, so the two faces
 * cannot drift.
 *
 * Sources degrade independently and report their own health, the pattern the
 * existing fleet/ dashboard already uses: a frame still renders when Smithers or
 * herdr is unavailable, because deck never reads either for truth. Herdr being
 * down removes decoration, not function.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { lastEvent, openDecisions } from "./events";
import { internalSummary } from "./backlog";
import { stateDir } from "./home";
import { readMeta } from "./meta";
import { pending } from "./queue";
import { unresolvedReceipts } from "./side-effects";
import { pidAlive } from "./spawn";
import { deckOwnedTasks } from "./wake";

const run = promisify(execFile);

export type SourceHealth = {
	name: string;
	state: "ok" | "missing" | "skipped";
	detail: string;
};

export type TaskRow = {
	taskId: string;
	kind: string;
	project: string | null;
	/** Live process, finished run, or never started. */
	runState: "running" | "finished" | "none";
	lastVerb: string | null;
	lastNote: string | null;
	openDecisions: number;
	queuedMessages: number;
	unresolvedSideEffects: number;
	pr: string | null;
	worktree: string | null;
	/** Smithers run id, when workflow-backed. */
	runId: string | null;
	/** Workflow stage, when known. */
	stage: string | null;
	/** herdr pane, when the run is visible. */
	pane: string | null;
};

export type FleetFrame = {
	generatedAt: string;
	tasks: TaskRow[];
	counters: {
		tasks: number;
		running: number;
		openDecisions: number;
		queuedMessages: number;
		internalOpen: number;
		internalCap: number;
	};
	sources: SourceHealth[];
};

type PsRun = { id: string; workflow?: string; status?: string; step?: string; rootDir?: string };

/** Public read-only CLI only. Never the private db, never Gateway lifecycle. */
async function collectRuns(cwd: string): Promise<{ runs: PsRun[]; health: SourceHealth }> {
	try {
		const { stdout } = await run(
			"bunx",
			["smithers-orchestrator@0.30.0", "ps", "--json"],
			{ cwd, timeout: 15_000, maxBuffer: 4_000_000 },
		);
		const parsed: unknown = JSON.parse(stdout);
		const runs = Array.isArray(parsed)
			? (parsed as PsRun[])
			: ((parsed as { runs?: PsRun[] }).runs ?? []);
		return {
			runs,
			health: { name: "smithers", state: "ok", detail: `${runs.length} run(s)` },
		};
	} catch (error) {
		return {
			runs: [],
			health: {
				name: "smithers",
				state: "missing",
				detail: error instanceof Error ? error.message.split("\n")[0] ?? "ps failed" : "ps failed",
			},
		};
	}
}

type HerdrAgent = { agent?: string; agent_status?: string; pane_id?: string; foreground_cwd?: string };

/**
 * herdr, view-only. Correlation is on `foreground_cwd` == the task's worktree,
 * a unique exact absolute path — the same key fleet/ uses for Smithers rootDir.
 */
async function collectPanes(): Promise<{ byWorktree: Map<string, string>; health: SourceHealth }> {
	const byWorktree = new Map<string, string>();
	try {
		const { stdout } = await run("herdr", ["agent", "list"], { timeout: 8_000 });
		const parsed: unknown = JSON.parse(stdout);
		const agents = ((parsed as { result?: { agents?: HerdrAgent[] } }).result?.agents ??
			[]) as HerdrAgent[];
		for (const agent of agents) {
			if (agent.foreground_cwd !== undefined && agent.pane_id !== undefined) {
				byWorktree.set(agent.foreground_cwd, agent.pane_id);
			}
		}
		return {
			byWorktree,
			health: { name: "herdr", state: "ok", detail: `${agents.length} agent(s)` },
		};
	} catch {
		// Headless is the default path, not a degraded one.
		return {
			byWorktree,
			health: { name: "herdr", state: "skipped", detail: "not running (headless is fine)" },
		};
	}
}

function realpath(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}

export async function buildFrame(options: { workflowCwd?: string } = {}): Promise<FleetFrame> {
	const ids = deckOwnedTasks();
	const [{ runs, health: runHealth }, { byWorktree, health: paneHealth }] = await Promise.all([
		options.workflowCwd === undefined
			? Promise.resolve({
					runs: [] as PsRun[],
					health: { name: "smithers", state: "skipped", detail: "no workflow dir configured" } as SourceHealth,
				})
			: collectRuns(options.workflowCwd),
		collectPanes(),
	]);

	const runsByRoot = new Map<string, PsRun>();
	for (const psRun of runs) {
		if (psRun.rootDir !== undefined && psRun.rootDir.length > 0) {
			runsByRoot.set(realpath(psRun.rootDir), psRun);
		}
	}

	const tasks: TaskRow[] = [];
	for (const taskId of ids) {
		const meta = readMeta(taskId);
		const event = lastEvent(taskId);
		const worktree = meta?.worktree ?? null;
		const resolved = worktree === null ? null : realpath(worktree);
		const psRun = resolved === null ? undefined : runsByRoot.get(resolved);
		const pid = meta?.run_pid;

		tasks.push({
			taskId,
			kind: meta?.kind ?? "ship",
			project: meta?.project ?? null,
			runState:
				pid === undefined ? "none" : pidAlive(pid) ? "running" : "finished",
			lastVerb: event?.verb ?? null,
			lastNote: event?.note ?? null,
			openDecisions: openDecisions(taskId).size,
			queuedMessages: pending(taskId).length,
			unresolvedSideEffects: unresolvedReceipts(taskId).length,
			pr: meta?.pr ?? null,
			worktree,
			runId: psRun?.id ?? meta?.run_id ?? null,
			stage: psRun?.step ?? null,
			pane: resolved === null ? null : byWorktree.get(resolved) ?? null,
		});
	}

	const internal = internalSummary();
	return {
		generatedAt: new Date().toISOString(),
		tasks,
		counters: {
			tasks: tasks.length,
			running: tasks.filter((task) => task.runState === "running").length,
			openDecisions: tasks.reduce((sum, task) => sum + task.openDecisions, 0),
			queuedMessages: tasks.reduce((sum, task) => sum + task.queuedMessages, 0),
			internalOpen: internal.open,
			internalCap: internal.cap,
		},
		sources: [
			runHealth,
			paneHealth,
			{ name: "home", state: "ok", detail: `${stateDir()} (${ids.length} task(s))` },
		],
	};
}

/** Plain-text frame. Used by the CLI and as the extension's non-TUI fallback. */
export function renderFrame(frame: FleetFrame): string {
	const lines: string[] = [];
	const c = frame.counters;
	lines.push(
		`Fleet · ${c.tasks} task(s), ${c.running} running · ${c.openDecisions} decision(s) · ${c.queuedMessages} queued · internal ${c.internalOpen}/${c.internalCap}`,
	);
	if (frame.tasks.length === 0) {
		lines.push("  (no tasks)");
	}
	for (const task of frame.tasks) {
		const mark = task.runState === "running" ? "●" : task.runState === "finished" ? "✓" : "○";
		const bits: string[] = [task.kind];
		if (task.project !== null) bits.push(task.project);
		if (task.stage !== null) bits.push(`@${task.stage}`);
		if (task.pr !== null) bits.push(`PR ${task.pr}`);
		if (task.pane !== null) bits.push(task.pane);
		lines.push(`${mark} ${task.taskId}  ${bits.join(" · ")}`);
		if (task.lastVerb !== null) {
			lines.push(`    ${task.lastVerb}: ${(task.lastNote ?? "").slice(0, 90)}`);
		}
		const flags: string[] = [];
		if (task.openDecisions > 0) flags.push(`${task.openDecisions} decision(s) open`);
		if (task.queuedMessages > 0) flags.push(`${task.queuedMessages} message(s) queued`);
		if (task.unresolvedSideEffects > 0) {
			flags.push(`${task.unresolvedSideEffects} UNRESOLVED side effect(s)`);
		}
		if (flags.length > 0) lines.push(`    ! ${flags.join(" · ")}`);
	}
	lines.push("");
	lines.push(
		`Sources  ${frame.sources
			.map((source) => `${source.name}=${source.state}`)
			.join("  ")}`,
	);
	return lines.join("\n");
}

/** Compact statusline. Costs no turn; the captain glances instead of being told. */
export function renderStatusline(frame: FleetFrame): string {
	const c = frame.counters;
	const parts = [`${c.running}▶`, `${c.tasks} task`];
	if (c.openDecisions > 0) parts.push(`${c.openDecisions}?`);
	if (c.queuedMessages > 0) parts.push(`${c.queuedMessages}✉`);
	return parts.join(" · ");
}
