import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SourceDiagnostic, StatusEvent, StatusState, TaskMeta } from "../types";

const KNOWN_STATUS_STATES = new Set<StatusState>([
	"working",
	"needs-decision",
	"blocked",
	"paused",
	"resolved",
	"done",
	"failed",
]);
const MAX_META_BYTES = 64 * 1024;
const MAX_STATUS_TAIL_BYTES = 64 * 1024;

/** Parse a `state/<id>.meta` key=value block. Tolerant of blank/comment lines. */
export function parseMeta(text: string): TaskMeta {
	const raw: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key !== "") raw[key] = value;
	}
	const get = (key: string): string | null => (key in raw ? (raw[key] ?? null) : null);
	return {
		window: get("window"),
		worktree: get("worktree"),
		project: get("project"),
		harness: get("harness"),
		kind: get("kind"),
		mode: get("mode"),
		model: get("model"),
		effort: get("effort"),
		backend: get("backend"),
		raw,
	};
}

/**
 * Parse the FINAL non-blank event of a status tail. Firstmate appends one
 * `state: message` line per event; the last one is the current status. A line
 * that does not lead with a known state token is reported verbatim as
 * `unknown` rather than dropped, so nothing is silently lost.
 */
export function parseStatusTail(text: string, mtimeMs: number | null = null): StatusEvent | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim() ?? "";
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon > 0) {
			const token = line.slice(0, colon).trim();
			if (KNOWN_STATUS_STATES.has(token as StatusState)) {
				return { state: token as StatusState, message: line.slice(colon + 1).trim(), mtimeMs };
			}
		}
		return { state: "unknown", message: line, mtimeMs };
	}
	return null;
}

/** Raw per-task pieces the fleet collector produces (pre-enrichment). */
export interface FleetStatePieces {
	metas: Map<string, TaskMeta>;
	statuses: Map<string, StatusEvent>;
	/** Sorted union of every task id seen via a `.meta` or `.status` file. */
	ids: string[];
	/** Per-file failures that did not prevent the rest of the scan. */
	diagnostics: SourceDiagnostic[];
	ok: boolean;
	detail: string;
}

/**
 * Collect firstmate `state/*.meta` and the tail of every `state/*.status`.
 * Read-only: opens files, never writes. Missing FM_HOME/state degrades to an
 * empty, `ok:false` result with a human-readable diagnostic.
 */
export async function collectFleetState(
	fmHome: string,
	signal?: AbortSignal,
): Promise<FleetStatePieces> {
	const stateDir = path.join(fmHome, "state");
	const metas = new Map<string, TaskMeta>();
	const statuses = new Map<string, StatusEvent>();
	const diagnostics: SourceDiagnostic[] = [];
	if (signal?.aborted) {
		return { metas, statuses, ids: [], diagnostics, ok: false, detail: "state scan aborted" };
	}

	let entries: string[];
	try {
		entries = await fs.readdir(stateDir);
	} catch (error) {
		return {
			metas,
			statuses,
			ids: [],
			diagnostics,
			ok: false,
			detail: `state dir unreadable: ${describe(error)} (${stateDir})`,
		};
	}

	const ids = new Set<string>();
	for (const entry of entries) {
		if (signal?.aborted) {
			diagnostics.push({
				source: "FM_HOME",
				ok: false,
				level: "warning",
				detail: "state scan aborted; partial results retained",
			});
			break;
		}
		if (entry.startsWith(".")) continue; // firstmate internal bookkeeping files
		const full = path.join(stateDir, entry);
		if (entry.endsWith(".meta")) {
			const id = entry.slice(0, -".meta".length);
			ids.add(id);
			try {
				const bounded = await readBounded(full, MAX_META_BYTES, false);
				metas.set(id, parseMeta(bounded.text));
				if (bounded.truncated) {
					diagnostics.push({
						source: `FM_HOME:${entry}`,
						ok: false,
						level: "warning",
						detail: `meta exceeds ${MAX_META_BYTES} bytes; parsed bounded prefix`,
					});
				}
			} catch (error) {
				diagnostics.push({
					source: `FM_HOME:${entry}`,
					ok: false,
					level: "warning",
					detail: `unreadable: ${describe(error)}`,
				});
			}
		} else if (entry.endsWith(".status")) {
			const id = entry.slice(0, -".status".length);
			ids.add(id);
			try {
				const bounded = await readBounded(full, MAX_STATUS_TAIL_BYTES, true);
				const event = parseStatusTail(bounded.text, bounded.mtimeMs);
				if (event) statuses.set(id, event);
				if (bounded.truncated && (!event || !bounded.text.includes("\n"))) {
					diagnostics.push({
						source: `FM_HOME:${entry}`,
						ok: false,
						level: "warning",
						detail: `final event exceeds ${MAX_STATUS_TAIL_BYTES} bytes or follows an oversized blank tail`,
					});
				}
			} catch (error) {
				diagnostics.push({
					source: `FM_HOME:${entry}`,
					ok: false,
					level: "warning",
					detail: `unreadable: ${describe(error)}`,
				});
			}
		}
	}

	const sortedIds = [...ids].sort();
	return {
		metas,
		statuses,
		ids: sortedIds,
		diagnostics,
		ok: true,
		detail: `${sortedIds.length} task${sortedIds.length === 1 ? "" : "s"} (${metas.size} meta, ${statuses.size} status${diagnostics.length ? `, ${diagnostics.length} unreadable` : ""})`,
	};
}

async function readBounded(
	file: string,
	maxBytes: number,
	fromEnd: boolean,
): Promise<{ text: string; truncated: boolean; mtimeMs: number }> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		const bytesToRead = Math.min(stat.size, maxBytes);
		const offset = fromEnd ? Math.max(0, stat.size - bytesToRead) : 0;
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: stat.size > maxBytes,
			mtimeMs: stat.mtimeMs,
		};
	} finally {
		await handle.close();
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${code}` : error.message;
	}
	return String(error);
}
