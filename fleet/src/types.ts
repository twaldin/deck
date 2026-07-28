/**
 * Typed model for the read-only fleet dashboard.
 *
 * The three layers are deliberately separable so a herdr plugin (or any other
 * surface) could reuse the collectors without the TUI renderer:
 *   collectors/*  ->  produce the raw typed pieces below
 *   model.ts      ->  assembles a {@link FleetModel}
 *   render.ts     ->  turns a {@link FleetModel} into terminal lines
 * Nothing here imports a renderer, and nothing here mutates external state.
 */

/** Backlog lifecycle state, normalized across the tasks-axi and markdown paths. */
export type TaskState = "queued" | "in_flight" | "done" | "held" | "unknown";

/**
 * The leading token of the final `state: message` line in a `state/*.status`
 * file. `unknown` covers any non-conforming trailing line so the collector
 * never throws on unexpected input.
 */
export type StatusState =
	| "working"
	| "needs-decision"
	| "blocked"
	| "paused"
	| "resolved"
	| "done"
	| "failed"
	| "unknown";

/** Parsed `state/<id>.meta` key=value block. Every key is optional. */
export interface TaskMeta {
	window: string | null;
	worktree: string | null;
	project: string | null;
	harness: string | null;
	kind: string | null;
	mode: string | null;
	model: string | null;
	effort: string | null;
	backend: string | null;
	/** Every parsed key=value pair, including keys not surfaced above. */
	raw: Record<string, string>;
}

/** The final non-blank event from a `state/<id>.status` tail. */
export interface StatusEvent {
	state: StatusState;
	message: string;
	/** mtime of the status file in epoch ms, used for "age of last event". */
	mtimeMs: number | null;
}

/** A single backlog task, from tasks-axi if available else markdown parsing. */
export interface BacklogEntry {
	id: string;
	title: string;
	state: TaskState;
	repo: string | null;
	detail: string | null;
	since: string | null;
	/** Non-null when the task is held/blocked with a stated reason. */
	hold: string | null;
}

/** One node/step inside a Smithers run (from `smithers inspect --json`). */
export interface SmithersNode {
	id: string;
	state: string;
	attempt: number;
	label: string;
}

/** A Smithers run observed through the read-only CLI. */
export interface SmithersRun {
	id: string;
	workflow: string;
	status: string;
	/** Current step id when the run advertises one, else null. */
	step: string | null;
	/** Human-relative ("1m ago") or ISO start marker, verbatim from the CLI. */
	started: string | null;
	/**
	 * `config.rootDir` from `inspect` — the durable path a run executes in.
	 * This is the ONLY identifier used for correlation (see correlate.ts).
	 */
	rootDir: string | null;
	/** The workspace directory the run was discovered in. */
	workspace: string;
	nodes: SmithersNode[];
}

/**
 * A fleet task = one firstmate state slug (a `.meta` and/or `.status` file),
 * enriched with its backlog entry and any Smithers runs correlated to it.
 */
export interface FleetTask {
	id: string;
	meta: TaskMeta | null;
	status: StatusEvent | null;
	backlog: BacklogEntry | null;
	runs: SmithersRun[];
}

/** Per-source health, so missing sources degrade loudly rather than silently. */
export interface SourceDiagnostic {
	source: string;
	ok: boolean;
	/** Optional richer presentation; `ok` remains for simple programmatic checks. */
	level?: "ok" | "warning" | "missing" | "skipped";
	detail: string;
}

/** The complete assembled view the renderer consumes. */
export interface FleetModel {
	fmHome: string;
	generatedAtMs: number;
	tasks: FleetTask[];
	/** Runs whose rootDir matched no task worktree — shown as a separate section. */
	orphanRuns: SmithersRun[];
	diagnostics: SourceDiagnostic[];
}
