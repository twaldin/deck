import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BacklogEntry, TaskState } from "../types";

/**
 * Injectable command runner so the collector is unit-testable without a live
 * `tasks-axi` on PATH. Returns null when the binary is missing or errors.
 */
export type CommandRunner = (
	command: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<{ stdout: string; exitCode: number } | null>;

const TASKS_AXI_FIELDS = "body,created,hold_reason";
export const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;

function normalizeState(value: string): TaskState {
	switch (value.trim()) {
		case "queued":
			return "queued";
		case "in_flight":
			return "in_flight";
		case "done":
			return "done";
		case "held":
			return "held";
		default:
			return "unknown";
	}
}

/**
 * Split one TOON/CSV-style row into fields, honoring double-quoted cells
 * (which may contain commas) and `""` escapes.
 */
export function splitToonRow(row: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (inQuotes) {
			if (ch === '"') {
				if (row[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			fields.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	fields.push(current);
	return fields;
}

/** Strip tasks-axi's body-truncation marker so detail text stays clean. */
function cleanDetail(value: string): string | null {
	const withoutMarker = value.replace(/\\n\.\.\. \(truncated,[^)]*\)/g, "").replace(/\\n/g, " ").trim();
	return withoutMarker === "" || withoutMarker === "-" ? null : withoutMarker;
}

function dashToNull(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed === "" || trimmed === "-" ? null : trimmed;
}

export interface TasksAxiParseResult {
	entries: BacklogEntry[];
	valid: boolean;
	detail: string;
}

/**
 * Parse and validate `tasks-axi list` output. The declared row count and the
 * expected schema are part of the contract: accepting a valid-looking prefix
 * would suppress the markdown fallback while silently dropping tasks.
 */
export function parseTasksAxiListResult(stdout: string): TasksAxiParseResult {
	const lines = stdout.split("\n");
	const headerIndex = lines.findIndex((line) => /^tasks\[\d+\]\{.*\}:\s*$/.test(line.trim()));
	if (headerIndex === -1) {
		const empty = lines.some((line) => /^tasks:\s*0 tasks\b/i.test(line.trim()));
		return empty
			? { entries: [], valid: true, detail: "0 rows" }
			: { entries: [], valid: false, detail: "missing tasks table header" };
	}
	const header = lines[headerIndex]?.trim() ?? "";
	const headerMatch = header.match(/^tasks\[(\d+)\]\{(.*)\}:\s*$/);
	if (!headerMatch || headerMatch[1] === undefined || headerMatch[2] === undefined) {
		return { entries: [], valid: false, detail: "malformed tasks table header" };
	}
	const declaredCount = Number(headerMatch[1]);
	const columns = headerMatch[2].split(",").map((c) => c.trim());
	const requiredColumns = ["id", "state", "repo", "title", "body", "created", "hold_reason"];
	if (new Set(columns).size !== columns.length || requiredColumns.some((column) => !columns.includes(column))) {
		return { entries: [], valid: false, detail: "unexpected tasks table schema" };
	}

	const entries: BacklogEntry[] = [];
	const ids = new Set<string>();
	let rowCount = 0;
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		if (!/^\s{2,}\S/.test(raw)) break; // rows are indented; first non-row ends the table
		rowCount++;
		const row = raw.trim();
		if (!hasBalancedQuotes(row)) {
			return { entries: [], valid: false, detail: `row ${rowCount} has unbalanced quotes` };
		}
		const cells = splitToonRow(row);
		if (cells.length !== columns.length) {
			return {
				entries: [],
				valid: false,
				detail: `row ${rowCount} has ${cells.length} cells; expected ${columns.length}`,
			};
		}
		const record: Record<string, string> = {};
		columns.forEach((col, idx) => {
			record[col] = cells[idx] ?? "";
		});
		const id = record.id?.trim();
		if (!id) return { entries: [], valid: false, detail: `row ${rowCount} has no id` };
		if (ids.has(id)) return { entries: [], valid: false, detail: `duplicate task id: ${id}` };
		ids.add(id);
		entries.push({
			id,
			title: cleanDetail(record.title ?? "") ?? id,
			state: normalizeState(record.state ?? ""),
			repo: dashToNull(record.repo),
			detail: cleanDetail(record.body ?? ""),
			since: dashToNull(record.created),
			hold: dashToNull(record.hold_reason),
		});
	}
	if (rowCount !== declaredCount) {
		return {
			entries: [],
			valid: false,
			detail: `declared ${declaredCount} rows but parsed ${rowCount}`,
		};
	}
	return { entries, valid: true, detail: `${entries.length} row${entries.length === 1 ? "" : "s"}` };
}

/** Backwards-compatible convenience parser; malformed and valid-empty both return []. */
export function parseTasksAxiList(stdout: string): BacklogEntry[] {
	return parseTasksAxiListResult(stdout).entries;
}

function hasBalancedQuotes(row: string): boolean {
	let inQuotes = false;
	for (let i = 0; i < row.length; i++) {
		if (row[i] !== '"') continue;
		if (inQuotes && row[i + 1] === '"') {
			i++;
			continue;
		}
		inQuotes = !inQuotes;
	}
	return !inQuotes;
}

const SECTION_STATE: Record<string, TaskState> = {
	"in flight": "in_flight",
	queued: "queued",
	done: "done",
	held: "held",
	"on hold": "held",
};

/**
 * Fallback parser for `data/backlog.md`. Understands `## Section` headers and
 * `- [ ] id - title (since ...)` items with an optional indented detail line.
 * Kept independent of tasks-axi so it works when the binary is absent.
 */
export function parseBacklogMarkdown(text: string): BacklogEntry[] {
	const entries: BacklogEntry[] = [];
	let sectionState: TaskState = "unknown";
	let current: BacklogEntry | null = null;

	const flush = () => {
		if (current) entries.push(current);
		current = null;
	};

	for (const line of text.split("\n")) {
		const header = line.match(/^##\s+(.*)$/);
		if (header && header[1] !== undefined) {
			flush();
			sectionState = SECTION_STATE[header[1].trim().toLowerCase()] ?? "unknown";
			continue;
		}
		const item = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
		if (item && item[2] !== undefined) {
			flush();
			const done = item[1]?.toLowerCase() === "x";
			const body = item[2].trim();
			const dashIdx = body.indexOf(" - ");
			const id = (dashIdx === -1 ? body : body.slice(0, dashIdx)).trim();
			const rest = dashIdx === -1 ? "" : body.slice(dashIdx + 3).trim();
			const hold = rest.match(/\(hold:\s*([^)]*)\)/i)?.[1]?.trim() ?? null;
			const since = rest.match(/\(since\s+([^)]*)\)/i)?.[1]?.trim() ?? null;
			const title = stripBacklogMetadata(rest);
			current = {
				id,
				title: title === "" ? id : title,
				state: done ? "done" : sectionState,
				repo: rest.match(/\(repo:\s*([^)]*)\)/i)?.[1]?.trim() ?? null,
				detail: null,
				since,
				hold,
			};
			continue;
		}
		// Indented continuation line = the item's detail.
		if (current && /^\s+\S/.test(line) && !line.trimStart().startsWith("-")) {
			const piece = line.trim();
			current.detail = current.detail ? `${current.detail} ${piece}` : piece;
		}
	}
	flush();
	return entries;
}

/** Remove only known backlog metadata, preserving meaningful title parentheses. */
function stripBacklogMetadata(value: string): string {
	return value
		.replace(/\s*\((?:repo|hold|hold-kind):\s*[^)]*\)/gi, "")
		.replace(/\s*\((?:since|done)\s+[^)]*\)/gi, "")
		.trim();
}

export interface BacklogResult {
	entries: BacklogEntry[];
	source: "tasks-axi" | "markdown" | "none";
	ok: boolean;
	detail: string;
}

/**
 * Collect backlog tasks: prefer `tasks-axi list` (authoritative, normalized
 * state), and safely fall back to parsing `data/backlog.md` directly whenever
 * the binary is missing, errors, or emits an unparseable shape.
 */
export async function collectBacklog(
	fmHome: string,
	run: CommandRunner,
	signal?: AbortSignal,
): Promise<BacklogResult> {
	const backlogPath = path.join(fmHome, "data", "backlog.md");
	if (signal?.aborted) return abortedBacklog();

	const result = await run("tasks-axi", ["list", "--fields", TASKS_AXI_FIELDS], fmHome, signal).catch(() => null);
	if (signal?.aborted) return abortedBacklog();
	let fallbackReason = "tasks-axi unavailable";
	if (result && result.exitCode === 0) {
		const parsed = parseTasksAxiListResult(result.stdout);
		if (parsed.valid) {
			return {
				entries: parsed.entries,
				source: "tasks-axi",
				ok: true,
				detail: `${parsed.entries.length} via tasks-axi`,
			};
		}
		fallbackReason = `tasks-axi malformed: ${parsed.detail}`;
	} else if (result) {
		fallbackReason = `tasks-axi failed (exit ${result.exitCode})`;
	}

	// Fallback: read the markdown backlog directly.
	try {
		const stat = await fs.stat(backlogPath);
		if (stat.size > MAX_BACKLOG_BYTES) {
			return {
				entries: [],
				source: "none",
				ok: false,
				detail: `backlog.md exceeds ${MAX_BACKLOG_BYTES} byte safety limit`,
			};
		}
		if (signal?.aborted) return abortedBacklog();
		const text = await fs.readFile(backlogPath, { encoding: "utf8", signal });
		const entries = parseBacklogMarkdown(text);
		return {
			entries,
			source: "markdown",
			ok: true,
			detail: `${entries.length} via backlog.md (${fallbackReason})`,
		};
	} catch (error) {
		return {
			entries: [],
			source: "none",
			ok: false,
			detail: `no backlog: ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : String(error)}`,
		};
	}
}

function abortedBacklog(): BacklogResult {
	return {
		entries: [],
		source: "none",
		ok: false,
		detail: "backlog collection aborted",
	};
}
