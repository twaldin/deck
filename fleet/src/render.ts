import type { FleetModel, FleetTask, SmithersNode, SmithersRun, StatusState, TaskState } from "./types";
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
	/** Clock for age computation; defaults to the model's generation time. */
	now?: number;
}

/** A structured line: plain text + a whole-line color. Kept separate so
 * truncation operates on plain text and color is applied afterward. */
interface Line {
	text: string;
	color: keyof typeof SGR | null;
}

type DisplayState = StatusState | TaskState;

const STATUS_COLOR: Record<DisplayState, keyof typeof SGR> = {
	working: "cyan",
	in_flight: "cyan",
	"needs-decision": "yellow",
	blocked: "red",
	failed: "red",
	paused: "magenta",
	held: "yellow",
	queued: "gray",
	resolved: "green",
	done: "green",
	unknown: "gray",
};

const STATUS_GLYPH: Record<DisplayState, string> = {
	working: "●",
	in_flight: "●",
	"needs-decision": "◆",
	blocked: "✖",
	failed: "✖",
	paused: "❚",
	held: "❚",
	queued: "○",
	resolved: "✓",
	done: "✓",
	unknown: "·",
};

/** Map a smithers run/node state to a color + glyph. */
function runStyle(state: string): { color: keyof typeof SGR; glyph: string } {
	const s = state.toLowerCase();
	if (s.includes("fail") || s.includes("error")) return { color: "red", glyph: "✖" };
	if (s.includes("progress") || s.includes("running") || s === "active") return { color: "cyan", glyph: "◐" };
	if (s.includes("pending") || s.includes("queued") || s.includes("waiting")) return { color: "gray", glyph: "○" };
	if (s.includes("pause") || s.includes("block") || s.includes("approval")) return { color: "yellow", glyph: "❚" };
	if (
		s.includes("complete") ||
		s.includes("done") ||
		s.includes("finish") ||
		s.includes("success") ||
		s.includes("succeed")
	) {
		return { color: "green", glyph: "✓" };
	}
	return { color: "gray", glyph: "·" };
}

/** Render the full model to a flat array of terminal-ready (colored) lines. */
export function renderModel(model: FleetModel, options: RenderOptions): string[] {
	// `minWidth` is the threshold below which the same layout becomes compact
	// through truncation. It must never become a virtual terminal width: emitting
	// more cells than the real viewport wraps physical rows and invalidates the
	// differential painter's one-string-per-row model.
	const requestedWidth = Math.floor(options.width);
	const width = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : Math.max(1, options.minWidth);
	const compact = width < Math.max(1, options.minWidth);
	const now = options.now ?? model.generatedAtMs;
	const lines: Line[] = [];

	// Header.
	const runCount = model.tasks.reduce((n, t) => n + t.runs.length, 0) + model.orphanRuns.length;
	const activeCount = model.tasks.filter(
		(task) => task.status?.state === "working" || task.runs.some(isLiveRun),
	).length;
	lines.push({
		color: "bold",
		text: `Fleet · ${shorten(model.fmHome)} · ${model.tasks.length} tasks (${activeCount} active) · ${runCount} runs · ${clock(now)}`,
	});

	// Tasks.
	if (model.tasks.length === 0) {
		lines.push({ color: "gray", text: "  (no tasks — check FM_HOME diagnostics below)" });
	}
	model.tasks.forEach((task, i) => {
		const last = i === model.tasks.length - 1 && model.orphanRuns.length === 0;
		renderTask(task, last, now, compact, lines);
	});

	// Uncorrelated workflows section.
	if (model.orphanRuns.length > 0) {
		lines.push({ color: "gray", text: "" });
		lines.push({ color: "bold", text: `Workflows (uncorrelated · ${model.orphanRuns.length})` });
		model.orphanRuns.forEach((run, i) => {
			const last = i === model.orphanRuns.length - 1;
			renderRun(run, "", last, compact, lines);
		});
	}

	// Diagnostics footer.
	lines.push({ color: "gray", text: "" });
	lines.push({ color: "bold", text: "Sources" });
	const rankedDiagnostics = [...model.diagnostics].sort(
		(a, b) => diagnosticRank(a) - diagnosticRank(b),
	);
	for (const diag of rankedDiagnostics) {
		const level = diag.level ?? (diag.ok ? "ok" : "missing");
		const mark = level === "warning" ? "WARN" : level === "missing" ? "MISSING" : level;
		lines.push({
			color: level === "missing" || level === "warning" ? "yellow" : "gray",
			text: `  ${mark}  ${diag.source} — ${diag.detail}`,
		});
	}

	return lines.map((line) => finalizeLine(line, width, options.color));
}

function diagnosticRank(diag: FleetModel["diagnostics"][number]): number {
	const level = diag.level ?? (diag.ok ? "ok" : "missing");
	if (level === "missing" || level === "warning") return 0;
	if (level === "ok") return 1;
	return 2;
}

function renderTask(task: FleetTask, last: boolean, now: number, compact: boolean, out: Line[]): void {
	const branch = last ? "└─" : "├─";
	const pipe = last ? "  " : "│ ";
	const status = task.status;
	const state: DisplayState = status?.state ?? task.backlog?.state ?? "unknown";
	const glyph = STATUS_GLYPH[state];
	const color = STATUS_COLOR[state];

	const meta = task.meta;
	const bits: string[] = [state];
	if (!compact) {
		if (meta?.model) bits.push(meta.effort ? `${trimModel(meta.model)}/${meta.effort}` : trimModel(meta.model));
		else if (meta?.effort) bits.push(meta.effort);
		if (meta?.kind) bits.push(meta.kind);
		if (meta?.harness) bits.push(meta.harness);
	}
	if (status?.mtimeMs !== null && status?.mtimeMs !== undefined) bits.push(age(now - status.mtimeMs));
	else if (task.backlog?.since) bits.push(`since ${task.backlog.since}`);

	out.push({ color, text: `${branch} ${glyph} ${task.id}  ${SGR_META(bits)}` });

	// Detail line: last status message, else backlog title/detail.
	const detail = status?.message || task.backlog?.title || task.backlog?.detail;
	if (!compact && detail) out.push({ color: state === "unknown" ? "gray" : null, text: `${pipe}   ${detail}` });
	if (!compact && task.backlog?.hold) out.push({ color: "magenta", text: `${pipe}   hold: ${task.backlog.hold}` });

	// Correlated runs.
	task.runs.forEach((run, i) => {
		const runLast = i === task.runs.length - 1;
		renderRun(run, pipe, runLast, compact, out);
	});
}

function renderRun(run: SmithersRun, indent: string, last: boolean, compact: boolean, out: Line[]): void {
	const branch = last ? "└─" : "├─";
	const childPipe = indent + (last ? "  " : "│ ");
	const style = runStyle(run.status);
	const meta = [run.status];
	if (run.step) meta.push(`@${run.step}`);
	if (run.started) meta.push(run.started);
	out.push({
		color: style.color,
		text: compact
			? `${indent}${branch} ${style.glyph} ${run.workflow}  ${meta.slice(0, 2).join(" · ")}`
			: `${indent}${branch} ${style.glyph} ${run.workflow} ${dim(run.id)}  ${meta.join(" · ")}`,
	});

	if (compact) return;
	run.nodes.forEach((node, i) => {
		const nodeLast = i === run.nodes.length - 1;
		renderNode(node, childPipe, nodeLast, out);
	});
}

function renderNode(node: SmithersNode, indent: string, last: boolean, out: Line[]): void {
	const branch = last ? "└─" : "├─";
	const style = runStyle(node.state);
	const attempt = node.attempt > 1 ? ` (attempt ${node.attempt})` : "";
	out.push({ color: style.color, text: `${indent}${branch} ${style.glyph} ${node.label} — ${node.state}${attempt}` });
}

/** Apply width truncation and (optional) color to a structured line. */
function finalizeLine(line: Line, width: number, color: boolean): string {
	const plain = truncate(sanitize(line.text), width);
	if (!color || line.color === null) return plain;
	return `${SGR[line.color]}${plain}${SGR.reset}`;
}

/** Strip control bytes so nothing corrupts the terminal. */
function sanitize(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate to terminal display cells without splitting a grapheme cluster. */
export function truncate(text: string, width: number): string {
	const cellBudget = Math.max(0, Math.floor(width));
	if (Bun.stringWidth(text) <= cellBudget) return text;
	if (cellBudget === 0) return "";

	const ellipsis = "…";
	const contentBudget = cellBudget - Bun.stringWidth(ellipsis);
	if (contentBudget <= 0) return ellipsis;

	let out = "";
	let used = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const segmentWidth = Bun.stringWidth(segment);
		if (used + segmentWidth > contentBudget) break;
		out += segment;
		used += segmentWidth;
	}
	return `${out}${ellipsis}`;
}

function SGR_META(bits: string[]): string {
	return bits.filter(Boolean).join("  ");
}

function dim(text: string): string {
	return `(${text})`;
}

function trimModel(model: string): string {
	// deck/gpt-5.6-sol -> gpt-5.6-sol
	const slash = model.lastIndexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

export function age(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function clock(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shorten(p: string): string {
	const home = process.env.HOME;
	return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}
