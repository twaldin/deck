/**
 * The `.status` append path and the identity-aware cursor reader.
 *
 * Writer rules (report §5.1, resolved in review round 2):
 *   plain task          -> the crew run appends, epoch-fenced
 *   Smithers-backed task -> the observer adapter is the SOLE writer
 * One writer per task, always. N writers on one append-only log is the
 * ambiguity the log exists to prevent.
 *
 * Reader rules (report §6.2, corrected in review round 2): `.status` is
 * O_APPEND-only and a byte offset is a durable cursor — but a bare path+offset
 * cursor silently skips events if a file is ever replaced or truncated, so the
 * cursor also carries identity (dev/inode/size/tail hash) and rescans from zero
 * on any mismatch. The invariant is enforced AND the cursor tolerates its
 * violation, because a merely-documented invariant is the class of rule that
 * decays.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { assertTaskId, ensureHomeDirs, stateFiles, wakeFiles } from "./home";
import { assertCurrentEpoch } from "./meta";
import {
	type MalformedStatusLine,
	type StatusEvent,
	type StatusVerb,
	formatStatusLine,
	isMalformed,
	parseStatusLine,
} from "./status";

/**
 * Append one status event. O_APPEND keeps the write atomic for a single line,
 * which is what makes the byte cursor sound.
 *
 * `epoch` fences the write: pass the epoch the run was started with. Omit it
 * only for the observer adapter, which is the task's sole writer by contract and
 * has no run of its own.
 */
export function appendStatus(
	id: string,
	verb: StatusVerb,
	note: string,
	options: { epoch?: number; key?: string } = {},
): string {
	assertTaskId(id);
	ensureHomeDirs();
	if (options.epoch !== undefined) assertCurrentEpoch(id, options.epoch);
	const line = formatStatusLine(verb, note, options.key);
	fs.appendFileSync(stateFiles(id).status, `${line}\n`, { mode: 0o600 });
	return line;
}

export type ReadStatusResult = {
	events: StatusEvent[];
	malformed: MalformedStatusLine[];
};

export function readStatus(id: string): ReadStatusResult {
	assertTaskId(id);
	let raw: string;
	try {
		raw = fs.readFileSync(stateFiles(id).status, "utf8");
	} catch {
		return { events: [], malformed: [] };
	}
	return splitLines(raw);
}

function splitLines(raw: string): ReadStatusResult {
	const events: StatusEvent[] = [];
	const malformed: MalformedStatusLine[] = [];
	for (const line of raw.split("\n")) {
		const parsed = parseStatusLine(line);
		if (parsed === null) continue;
		if (isMalformed(parsed)) malformed.push(parsed);
		else events.push(parsed);
	}
	return { events, malformed };
}

/**
 * Identity-aware cursor. `offset` alone is only valid while the file identity
 * holds; dev/inode/size/tailHash detect replacement, truncation and rewrite.
 */
export type StatusCursor = {
	dev: number;
	ino: number;
	size: number;
	offset: number;
	tailHash: string;
};

export type CursorStore = Record<string, StatusCursor>;

function hash(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function loadCursors(): CursorStore {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(wakeFiles().cursors, "utf8"));
		if (parsed !== null && typeof parsed === "object") return parsed as CursorStore;
		return {};
	} catch {
		return {};
	}
}

export function saveCursors(store: CursorStore): void {
	ensureHomeDirs();
	const tmp = `${wakeFiles().cursors}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, wakeFiles().cursors);
}

export type CursorRead = {
	events: StatusEvent[];
	malformed: MalformedStatusLine[];
	cursor: StatusCursor | null;
	/** True when the cursor was invalidated and the file was rescanned. */
	rescanned: boolean;
};

/**
 * Read only what is new since `previous`, tolerating file-identity changes.
 *
 * A missed fs.watch event is therefore LATE, never LOST: reconcile reads from
 * the recorded offset forward and catches up.
 */
export function readStatusSince(id: string, previous: StatusCursor | null): CursorRead {
	assertTaskId(id);
	const file = stateFiles(id).status;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return { events: [], malformed: [], cursor: null, rescanned: false };
	}

	const full = fs.readFileSync(file, "utf8");
	const identityHolds =
		previous !== null &&
		previous.dev === stat.dev &&
		previous.ino === stat.ino &&
		stat.size >= previous.size &&
		previous.offset <= full.length &&
		hash(full.slice(0, previous.offset)) === previous.tailHash;

	const slice = identityHolds && previous !== null ? full.slice(previous.offset) : full;
	const parsed = splitLines(slice);
	const cursor: StatusCursor = {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		offset: full.length,
		tailHash: hash(full),
	};
	return {
		...parsed,
		cursor,
		rescanned: previous !== null && !identityHolds,
	};
}

/** Latest event per decision key, for reconciling open decisions. */
export function openDecisions(id: string): Map<string, StatusEvent> {
	const { events } = readStatus(id);
	const open = new Map<string, StatusEvent>();
	for (const event of events) {
		if (event.verb === "needs-decision") open.set(event.key, event);
		else if (event.verb === "resolved") open.delete(event.key);
	}
	return open;
}

/** Last event overall, or null. A wake event, not current state. */
export function lastEvent(id: string): StatusEvent | null {
	const { events } = readStatus(id);
	return events.length === 0 ? null : (events[events.length - 1] ?? null);
}
