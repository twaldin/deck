import type { FleetModel, FleetTask, PaneState, SmithersRun, SourceDiagnostic, StatusState, TaskState } from "./types";
import { isLiveRun } from "./run-state";

/** SGR color codes used for state coloring. */
const SGR = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	gray: "\x1b[90m",
} as const;

export interface RenderOptions {
	width: number;
	minWidth: number;
	color: boolean;
	verbose?: boolean;
	/** Clock for age computation; defaults to the model's generation time. */
	now?: number;
}

interface Line {
	text: string;
	color: keyof typeof SGR | null;
	/** Active status payload is wrapped before finalization, never ellipsized. */
	wrapped?: boolean;
}

type DisplayState = StatusState | TaskState;

// `null` means terminal default / white: queued work is intentionally not grey.
const STATUS_COLOR: Record<DisplayState, keyof typeof SGR | null> = {
	working: "cyan", in_flight: "cyan", "needs-decision": "yellow", blocked: "red", failed: "red",
	paused: "magenta", held: "gray", queued: null, resolved: "green", done: "green", unknown: "gray",
};
const STATUS_GLYPH: Record<DisplayState, string> = {
	working: "●", in_flight: "●", "needs-decision": "◆", blocked: "✖", failed: "✖",
	paused: "❚", held: "❚", queued: "○", resolved: "✓", done: "✓", unknown: "·",
};

/** Render the full model to a flat array of terminal-ready (colored) lines. */
export function renderModel(model: FleetModel, options: RenderOptions): string[] {
	const requestedWidth = Math.floor(options.width);
	const width = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : Math.max(1, options.minWidth);
	const now = options.now ?? model.generatedAtMs;
	const lines: Line[] = [];
	const runCount = model.tasks.reduce((n, task) => n + task.runs.length, 0) + model.orphanRuns.length;
	const active = model.tasks.filter(isActive);
	const queued = model.tasks.filter((task) => !isActive(task) && !isTerminal(taskState(task)));
	const done = model.tasks.filter((task) => !isActive(task) && isTerminal(taskState(task)));

	lines.push({
		color: "bold",
		text: `Fleet · ${shorten(model.fmHome)} · ${model.tasks.length} tasks (${active.length} active) · ${runCount} runs · ${clock(now)}`,
	});
	if (model.tasks.length === 0) lines.push({ color: "gray", text: "(no tasks — check sources below)" });

	for (const task of active) renderActiveTask(task, now, width, lines);
	for (const task of queued) renderQueuedTask(task, now, lines);
	if (done.length) renderDoneSummary(done, lines);
	for (const run of model.orphanRuns.filter(shouldShowRun)) renderRun(run, "⊘ ", lines);

	const source = sourceSummary(model.diagnostics);
	lines.push({ color: source.color, text: source.text });
	if (options.verbose) renderDiagnostics(model.diagnostics, lines);
	return lines.flatMap((line) => finalizeLine(line, width, options.color));
}

function taskState(task: FleetTask): DisplayState {
	return task.status?.state ?? task.backlog?.state ?? "unknown";
}

function isActive(task: FleetTask): boolean {
	const state = taskState(task);
	return state === "working" || state === "in_flight" || state === "needs-decision" || state === "blocked" || state === "failed" || state === "paused" || task.runs.some(shouldShowRun) || stalePaneState(task) !== null;
}

function isTerminal(state: DisplayState): boolean { return state === "done" || state === "resolved"; }
function shouldShowRun(run: SmithersRun): boolean { return isLiveRun(run) || /fail|error/i.test(run.status); }

/** Compare only states both surfaces can express; an unavailable pane is not stale. */
function stalePaneState(task: FleetTask): PaneState | null {
	const pane = task.paneState;
	const status = task.status?.state;
	if (!pane || pane === "unknown" || !status || status === "unknown") return null;
	const expected: PaneState[] = status === "working" ? ["working"]
		: status === "blocked" || status === "needs-decision" ? ["blocked"]
		: status === "done" || status === "resolved" ? ["idle", "done"]
		: ["idle", "done"];
	return expected.includes(pane) ? null : pane;
}

function taskMeta(task: FleetTask, now: number): string {
	const bits: string[] = [];
	if (task.meta?.model) bits.push(task.meta.effort ? `${trimModel(task.meta.model)}/${task.meta.effort}` : trimModel(task.meta.model));
	else if (task.meta?.effort) bits.push(task.meta.effort);
	if (task.status?.mtimeMs != null) bits.push(age(now - task.status.mtimeMs));
	else if (task.backlog?.since) bits.push(`since ${task.backlog.since}`);
	return bits.join(" · ");
}

function taskTitle(task: FleetTask): string {
	return task.backlog?.title || task.backlog?.detail || "";
}

function renderActiveTask(task: FleetTask, now: number, width: number, out: Line[]): void {
	const state = taskState(task);
	const meta = taskMeta(task, now);
	const stale = stalePaneState(task);
	out.push({ color: STATUS_COLOR[state], text: `${STATUS_GLYPH[state]} ${task.id}${meta ? `  ${meta}` : ""}${stale ? `  status stale (pane: ${stale})` : ""}` });
	// Status is the payload: wrap it; never replace its tail with an ellipsis.
	const detail = task.status?.message || taskTitle(task);
	const indent = width >= 4 ? "  " : "";
	if (detail) for (const text of wrap(detail, Math.max(1, width - Bun.stringWidth(indent))).slice(0, 4)) out.push({ color: STATUS_COLOR[state], text: `${indent}${text}`, wrapped: true });
	for (const run of task.runs.filter(shouldShowRun)) renderRun(run, "  ", out);
}

function renderRun(run: SmithersRun, indent: string, out: Line[]): void {
	const style = runStyle(run.status);
	const step = run.step ? ` @${run.step}` : "";
	out.push({ color: style.color, text: `${indent}${style.glyph} ${run.workflow}${step} · ${run.status}` });
}

function runStyle(state: string): { color: keyof typeof SGR; glyph: string } {
	const value = state.toLowerCase();
	if (value.includes("fail") || value.includes("error")) return { color: "red", glyph: "✖" };
	if (value.includes("progress") || value.includes("running") || value === "active") return { color: "cyan", glyph: "◐" };
	if (value.includes("pause") || value.includes("block") || value.includes("approval")) return { color: "yellow", glyph: "❚" };
	if (value.includes("complete") || value.includes("done") || value.includes("finish") || value.includes("success")) return { color: "green", glyph: "✓" };
	return { color: "gray", glyph: "○" };
}

function renderQueuedTask(task: FleetTask, now: number, out: Line[]): void {
	const state = taskState(task);
	const meta = taskMeta(task, now);
	const hold = task.backlog?.hold ? ` — hold: ${task.backlog.hold}` : "";
	const title = taskTitle(task);
	const stale = stalePaneState(task);
	out.push({ color: STATUS_COLOR[state], text: `${STATUS_GLYPH[state]} ${task.id}${meta ? `  ${meta}` : ""}${title ? `  ${title}` : ""}${hold}${stale ? `  status stale (pane: ${stale})` : ""}` });
}

function renderDoneSummary(tasks: readonly FleetTask[], out: Line[]): void {
	const mostRecent = [...tasks].sort((a, b) => (b.status?.mtimeMs ?? 0) - (a.status?.mtimeMs ?? 0))[0];
	const detail = mostRecent ? taskTitle(mostRecent) || mostRecent.status?.message || mostRecent.id : "";
	out.push({ color: "green", text: `✓ ${tasks.length} done${detail ? ` — most recent: ${detail}` : ""}` });
}

function sourceSummary(diagnostics: readonly SourceDiagnostic[]): { text: string; color: keyof typeof SGR } {
	const groups: [string, string][] = [["fm", "FM_HOME"], ["backlog", "backlog:"], ["smithers", "smithers:"]];
	if (diagnostics.some((d) => d.source === "pane")) groups.push(["pane", "pane"]);
	groups.push(["broker", "broker"]);
	const grouped = groups.flatMap(([, prefix]) => diagnostics.filter((d) => d.source.startsWith(prefix)));
	const other = diagnostics.filter((d) => !grouped.includes(d));
	const health = groups.map(([name, prefix]) => `${name} ${sourceHealth(diagnostics.filter((d) => d.source.startsWith(prefix)))}`);
	if (other.length) health.push(`other ${sourceHealth(other)}`);
	const text = `sources: ${health.join(" · ")}`;
	return { text, color: /failed|warn/.test(text) ? "yellow" : "gray" };
}

function sourceHealth(diagnostics: readonly SourceDiagnostic[]): string {
	if (!diagnostics.length) return "absent";
	if (diagnostics.some((d) => !d.ok && (d.level ?? "missing") !== "skipped")) return "failed";
	if (diagnostics.some((d) => (d.level ?? (d.ok ? "ok" : "missing")) === "warning")) return "warn";
	if (diagnostics.some((d) => (d.level ?? (d.ok ? "ok" : "missing")) === "skipped")) return "skipped";
	return "ok";
}

function renderDiagnostics(diagnostics: readonly SourceDiagnostic[], out: Line[]): void {
	for (const diag of [...diagnostics].sort((a, b) => Number(a.ok) - Number(b.ok))) {
		const level = diag.level ?? (diag.ok ? "ok" : "missing");
		out.push({ color: level === "ok" ? "gray" : "yellow", text: `  ${level.toUpperCase()} ${diag.source} — ${diag.detail}` });
	}
}

/** Apply width truncation and (optional) color to a structured line. */
function finalizeLine(line: Line, width: number, color: boolean): string[] {
	const text = line.wrapped ? sanitize(line.text) : truncate(sanitize(line.text), width);
	return [line.color === null || !color ? text : `${SGR[line.color]}${text}${SGR.reset}`];
}

/** Wrap text at terminal cell boundaries, preserving every grapheme. */
export function wrap(text: string, width: number): string[] {
	const budget = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	let line = "";
	for (const word of sanitize(text).split(/\s+/)) {
		if (!word) continue;
		const candidate = line ? `${line} ${word}` : word;
		if (Bun.stringWidth(candidate) <= budget) { line = candidate; continue; }
		if (line) lines.push(line);
		line = "";
		for (const { segment } of graphemeSegmenter.segment(word)) {
			const segmentWidth = Bun.stringWidth(segment);
			// A double-width grapheme cannot fit a one-cell narrow pane. Keep the
			// painter invariant with a visible replacement rather than overflowing.
			const safeSegment = segmentWidth > budget ? "?" : segment;
			if (Bun.stringWidth(line) + Bun.stringWidth(safeSegment) > budget && line) { lines.push(line); line = ""; }
			line += safeSegment;
		}
	}
	if (line || lines.length === 0) lines.push(line);
	return lines;
}

/** Strip control bytes so nothing corrupts the terminal. */
function sanitize(text: string): string { return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "); }
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate to terminal display cells without splitting a grapheme cluster. */
export function truncate(text: string, width: number): string {
	const cellBudget = Math.max(0, Math.floor(width));
	if (Bun.stringWidth(text) <= cellBudget) return text;
	if (cellBudget === 0) return "";
	const contentBudget = cellBudget - Bun.stringWidth("…");
	if (contentBudget <= 0) return "…";
	let out = "";
	for (const { segment } of graphemeSegmenter.segment(text)) {
		if (Bun.stringWidth(out) + Bun.stringWidth(segment) > contentBudget) break;
		out += segment;
	}
	return `${out}…`;
}

function trimModel(model: string): string { return model.slice(model.lastIndexOf("/") + 1); }
export function age(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
function clock(ms: number): string { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function shorten(p: string): string { const home = process.env.HOME; return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p; }
