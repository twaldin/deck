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
import { stateDir, stateFiles } from "./home";
import { readMeta } from "./meta";
import { openQuestions, queueFile } from "./questions-store";
import { pending } from "./queue";
import { unresolvedReceipts } from "./side-effects";
import { SMITHERS_SPEC } from "./smithers";
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
	/** ms since the last status append, from the file's mtime. */
	statusAgeMs: number | null;
};

export type WorkflowRow = {
	runId: string;
	workflow: string | null;
	status: string | null;
	step: string | null;
	/** Task correlated by rootDir == worktree, when one matches. */
	taskId: string | null;
};

export type FleetFrame = {
	generatedAt: string;
	tasks: TaskRow[];
	workflows: WorkflowRow[];
	counters: {
		tasks: number;
		running: number;
		openDecisions: number;
		queuedMessages: number;
		/** Captain questions waiting in the /questions queue. */
		openQuestions: number;
		internalOpen: number;
		internalCap: number;
	};
	sources: SourceHealth[];
};

type PsRun = { id: string; workflow?: string; status?: string; step?: string; rootDir?: string };

/** Public read-only CLI only. Never the private db, never Gateway lifecycle. */
async function collectRuns(cwd: string): Promise<{ runs: PsRun[]; health: SourceHealth }> {
	// A home whose workflows link is not installed yet has no runs to miss:
	// that is "skipped" (run v2/install.sh), not "missing" (smithers broke).
	if (!fs.existsSync(cwd)) {
		return {
			runs: [],
			health: { name: "smithers", state: "skipped", detail: `no workspace at ${cwd} (run v2/install.sh)` },
		};
	}
	try {
		const { stdout } = await run(
			"bunx",
			[SMITHERS_SPEC, "ps", "--json"],
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

	const taskByRoot = new Map<string, string>();
	const tasks: TaskRow[] = [];
	for (const taskId of ids) {
		const meta = readMeta(taskId);
		const event = lastEvent(taskId);
		const worktree = meta?.worktree ?? null;
		const resolved = worktree === null ? null : realpath(worktree);
		const psRun = resolved === null ? undefined : runsByRoot.get(resolved);
		if (resolved !== null) taskByRoot.set(resolved, taskId);
		const pid = meta?.run_pid;
		let statusAgeMs: number | null = null;
		try {
			statusAgeMs = Date.now() - fs.statSync(stateFiles(taskId).status).mtimeMs;
		} catch {
			// no status file yet
		}

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
			statusAgeMs,
		});
	}

	const workflows: WorkflowRow[] = runs.map((psRun) => ({
		runId: psRun.id,
		workflow: psRun.workflow ?? null,
		status: psRun.status ?? null,
		step: psRun.step ?? null,
		taskId:
			psRun.rootDir !== undefined && psRun.rootDir.length > 0
				? taskByRoot.get(realpath(psRun.rootDir)) ?? null
				: null,
	}));

	const internal = internalSummary();
	let questionsOpen = 0;
	try {
		questionsOpen = openQuestions(queueFile()).length;
	} catch {
		// an unreadable queue must not take the fleet view down with it
	}
	return {
		generatedAt: new Date().toISOString(),
		tasks,
		workflows,
		counters: {
			tasks: tasks.length,
			running: tasks.filter((task) => task.runState === "running").length,
			openDecisions: tasks.reduce((sum, task) => sum + task.openDecisions, 0),
			queuedMessages: tasks.reduce((sum, task) => sum + task.queuedMessages, 0),
			openQuestions: questionsOpen,
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
		`Fleet · ${c.tasks} task(s), ${c.running} running · ${c.openDecisions} decision(s) · ${c.openQuestions} question(s) · ${c.queuedMessages} queued · internal ${c.internalOpen}/${c.internalCap}`,
	);
	if (frame.tasks.length === 0) {
		lines.push("  (no tasks)");
	}
	for (const wf of frame.workflows) {
		lines.push(
			`▸ wf:${wf.runId}  ${[wf.workflow, wf.status, wf.step === null ? null : `@${wf.step}`, wf.taskId]
				.filter((bit): bit is string => bit !== null)
				.join(" · ")}`,
		);
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

// ---- themed overlay renderer ----------------------------------------------
//
// Pure text: the theme is injected as two functions, so these helpers run under
// bun tests with PLAIN_FLEET_THEME and inside pi with the real theme. The
// extension wraps this text in a pi-tui Box; nothing here imports pi-tui.

export interface FleetTheme {
	fg: (key: string, text: string) => string;
	bold: (text: string) => string;
}

export const PLAIN_FLEET_THEME: FleetTheme = {
	fg: (_key, text) => text,
	bold: (text) => text,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Printable width. ANSI-aware; fleet text carries no wide glyph classes. */
export function textWidth(line: string): number {
	return line.replace(ANSI_RE, "").length;
}

export type Chip = { label: string; color: string };

/**
 * One status chip per task. Severity order: a captain decision outranks a
 * blocked run, which outranks the fact that a process happens to be alive.
 */
export function chipFor(task: TaskRow): Chip {
	if (task.openDecisions > 0 || task.lastVerb === "needs-decision") {
		return { label: "decision", color: "warning" };
	}
	if (task.lastVerb === "blocked" || task.lastVerb === "failed") {
		return { label: task.lastVerb, color: "error" };
	}
	if (task.runState === "running") return { label: "running", color: "success" };
	if (task.lastVerb === "done") return { label: "done", color: "dim" };
	if (task.queuedMessages > 0) return { label: "queued", color: "accent" };
	return { label: "idle", color: "dim" };
}

/** "3h7m" / "12m" / "41s" — compact age, matching the usage overlay. */
export function humanAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 24) return `${hours}h${rest}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function truncate(body: string, max: number): string {
	return body.length > max ? `${body.slice(0, Math.max(0, max - 1))}…` : body;
}

/**
 * Attention rank: lower renders first. Terminal rows (done/failed with nothing
 * pending) rank last and are hidden by the default view.
 */
export function attentionRank(task: TaskRow): number {
	if (task.openDecisions > 0 || task.lastVerb === "needs-decision") return 0;
	if (task.lastVerb === "blocked") return 1;
	if (task.unresolvedSideEffects > 0) return 2;
	if (task.runState === "running") return 3;
	if (task.lastVerb === "paused") return 4;
	if (task.queuedMessages > 0) return 5;
	if (task.lastVerb === "done" || task.lastVerb === "failed") return 7;
	return 6;
}

/** Attention-first order; terminal done/failed rows drop unless showAll. */
export function visibleTasks(tasks: TaskRow[], showAll: boolean): { shown: TaskRow[]; hidden: number } {
	const sorted = [...tasks].sort((a, b) => attentionRank(a) - attentionRank(b));
	if (showAll) return { shown: sorted, hidden: 0 };
	const shown = sorted.filter((task) => attentionRank(task) < 7);
	return { shown, hidden: sorted.length - shown.length };
}

/**
 * Wrap the body in a titled border so the overlay reads as a panel — the same
 * frame the usage overlay draws (deck-usage.ts framed()).
 */
export function framed(title: string, body: string, footer: string, theme: FleetTheme): string {
	const lines = body.split("\n");
	const inner = Math.max(textWidth(title) + 4, ...lines.map(textWidth), textWidth(footer)) + 2;
	const top =
		theme.fg("border", "╭─ ") +
		theme.bold(theme.fg("accent", title)) +
		theme.fg("border", ` ${"─".repeat(Math.max(0, inner - textWidth(title) - 3))}╮`);
	const bottom = theme.fg("border", `╰${"─".repeat(inner)}╯`);
	const padded = lines.map((line) => {
		const pad = " ".repeat(Math.max(0, inner - textWidth(line) - 1));
		return `${theme.fg("border", "│")} ${line}${pad}${theme.fg("border", "│")}`;
	});
	return [top, ...padded, bottom, "", footer].join("\n");
}

/**
 * The overlay's whole text: counters header, chip-per-task rows, workflow rows,
 * source health, key footer. Pure, so tests assert on it directly.
 */
export function buildFleetText(
	frame: FleetFrame,
	theme: FleetTheme = PLAIN_FLEET_THEME,
	options: { showAll?: boolean; maxBodyLines?: number } = {},
): string {
	const showAll = options.showAll ?? false;
	const c = frame.counters;
	const lines: string[] = [];
	const header = [
		`${theme.bold(String(c.running))} running`,
		`${c.tasks} task(s)`,
		c.openDecisions > 0 ? theme.fg("warning", `${c.openDecisions} decision(s)`) : null,
		c.openQuestions > 0 ? theme.fg("warning", `${c.openQuestions} question(s) — /questions`) : null,
		c.queuedMessages > 0 ? theme.fg("accent", `${c.queuedMessages} queued`) : null,
		`internal ${c.internalOpen}/${c.internalCap}`,
	].filter((bit): bit is string => bit !== null);
	lines.push(header.join(theme.fg("dim", "  ·  ")));
	lines.push("");

	const { shown, hidden } = visibleTasks(frame.tasks, showAll);
	if (frame.tasks.length === 0) lines.push(theme.fg("dim", "  (no tasks)"));
	for (const task of shown) {
		const chip = chipFor(task);
		const age = task.statusAgeMs === null ? "" : theme.fg("dim", ` ${humanAge(task.statusAgeMs)}`);
		// Every dynamic field is clamped: the Text component word-wraps rather
		// than corrupting the TUI, but an unclamped URL or task id would still
		// wrap across the frame border and break the panel visually.
		const bits: string[] = [theme.fg("dim", task.kind)];
		if (task.project !== null) bits.push(theme.fg("text", truncate(task.project, 20)));
		if (task.stage !== null) bits.push(theme.fg("accent", `@${truncate(task.stage, 20)}`));
		if (task.pane !== null) bits.push(theme.fg("dim", truncate(task.pane, 12)));
		lines.push(
			`${theme.fg(chip.color, `[${chip.label.padEnd(8)}]`)} ${theme.bold(truncate(task.taskId, 24).padEnd(24))}${bits.join(theme.fg("dim", " · "))}${age}`,
		);
		if (task.lastVerb !== null) {
			lines.push(
				`           ${theme.fg("dim", `${task.lastVerb}:`)} ${theme.fg("text", truncate(task.lastNote ?? "", 64))}`,
			);
		}
		if (task.pr !== null) lines.push(`           ${theme.fg("accent", truncate(task.pr, 72))}`);
		const flags: string[] = [];
		if (task.openDecisions > 0) flags.push(`${task.openDecisions} decision(s) open`);
		if (task.queuedMessages > 0) flags.push(`${task.queuedMessages} message(s) queued`);
		if (task.unresolvedSideEffects > 0) flags.push(`${task.unresolvedSideEffects} UNRESOLVED side effect(s)`);
		if (flags.length > 0) lines.push(`           ${theme.fg("warning", `! ${flags.join(" · ")}`)}`);
	}
	if (hidden > 0) {
		lines.push(theme.fg("dim", `  ${hidden} done/failed hidden — [a] shows all`));
	}

	if (frame.workflows.length > 0) {
		lines.push("");
		lines.push(theme.bold(theme.fg("toolTitle", "workflows")));
		for (const wf of frame.workflows) {
			const bits = [wf.workflow, wf.status, wf.step === null ? null : `@${wf.step}`, wf.taskId]
				.filter((bit): bit is string => bit !== null)
				.join(" · ");
			lines.push(
				`  ${theme.fg("accent", `wf:${truncate(wf.runId, 16)}`)}  ${theme.fg("text", truncate(bits, 64))}`,
			);
		}
	}

	lines.push("");
	lines.push(
		frame.sources
			.map((source) =>
				theme.fg(source.state === "ok" ? "success" : source.state === "missing" ? "error" : "dim", `${source.name}=${source.state}`),
			)
			.join("  "),
	);

	// Clamp the body so the framed panel never draws taller than the viewport:
	// the border must close on screen, not below it.
	let body = lines;
	if (options.maxBodyLines !== undefined && body.length > options.maxBodyLines) {
		const kept = Math.max(1, options.maxBodyLines - 1);
		body = [...body.slice(0, kept), theme.fg("dim", `  … +${lines.length - kept} more line(s)`)];
	}

	const footer = `${theme.fg("accent", "[q/Esc]")} ${theme.fg("dim", "close")}   ${theme.fg("accent", "[r]")} ${theme.fg("dim", "refresh")}   ${theme.fg("accent", "[a]")} ${theme.fg("dim", showAll ? "attention only" : "show all")}   ${theme.fg("dim", "live · refreshes every 5s")}`;
	return framed("deck fleet", body.join("\n"), footer, theme);
}

/** Compact statusline. Costs no turn; the captain glances instead of being told. */
export function renderStatusline(frame: FleetFrame): string {
	const c = frame.counters;
	const parts = [`${c.running}▶`, `${c.tasks} task`];
	if (c.openQuestions > 0) parts.push(`${c.openQuestions}q`);
	if (c.openDecisions > 0) parts.push(`${c.openDecisions}?`);
	if (c.queuedMessages > 0) parts.push(`${c.queuedMessages}✉`);
	return parts.join(" · ");
}
