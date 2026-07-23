import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { DeckError } from "../errors";
import { CURSORS_FILE, SEEN_DIR, ensureStateDirs } from "../layout";
import { idemSchema, type Idem } from "../schemas";
import {
	appendJsonLine,
	atomicWriteJson,
	atomicWriteJsonLines,
	readJsonLines,
	repairTrailingJsonLine,
	withExclusiveLock,
} from "./io";
import {
	cursorsSchema,
	cursorValueSchema,
	seenRecordSchema,
	type Cursors,
	type CursorValue,
	type SeenRecord,
} from "./schemas";

const sourceSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "source must be one path-safe segment");
const DEFAULT_CAPACITY = 10_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_FSYNC_BATCH_SIZE = 32;

export interface SeenRingOptions {
	capacity?: number;
	maxAgeMs?: number;
	fsyncBatchSize?: number;
	now?: () => number;
}

/**
 * Single-router-writer idempotency ring (SPEC §4.3). Adds append JSONL records,
 * fsyncs in bounded batches, and atomically compacts on age/cap eviction.
 */
export class SeenRing {
	readonly source: string;
	readonly file: string;
	private readonly capacity: number;
	private readonly maxAgeMs: number;
	private readonly fsyncBatchSize: number;
	private readonly now: () => number;
	private entries: SeenRecord[];
	private keys: Set<string>;
	private pendingSync = 0;

	constructor(source: string, options: SeenRingOptions = {}) {
		this.source = sourceSchema.parse(source);
		this.capacity = positiveInteger(options.capacity ?? DEFAULT_CAPACITY, "capacity");
		this.maxAgeMs = positiveInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "maxAgeMs");
		this.fsyncBatchSize = positiveInteger(options.fsyncBatchSize ?? DEFAULT_FSYNC_BATCH_SIZE, "fsyncBatchSize");
		this.now = options.now ?? Date.now;
		ensureStateDirs();
		this.file = path.join(SEEN_DIR, `${this.source}.ring`);
		withExclusiveLock(`${this.file}.lock`, () => {
			repairTrailingJsonLine(this.file, `${this.file}.bad`, seenRecordSchema);
		});
		this.entries = readJsonLines(this.file, seenRecordSchema);
		this.keys = new Set<string>();
		this.normalizeLoadedEntries();
	}

	has(input: Idem): boolean {
		const idem = this.assertSource(input);
		this.evictExpired();
		return this.keys.has(idemKey(idem));
	}

	add(input: Idem): void {
		const idem = this.assertSource(input);
		this.evictExpired();
		const key = idemKey(idem);
		if (this.keys.has(key)) {
			return;
		}
		const record = seenRecordSchema.parse({ ...idem, seen_at: this.now() });
		const nextEntries = [...this.entries, record];
		if (nextEntries.length > this.capacity) {
			this.rewriteCompacted(nextEntries.slice(-this.capacity));
			return;
		}

		const nextPendingSync = this.pendingSync + 1;
		const sync = nextPendingSync >= this.fsyncBatchSize;
		appendJsonLine(this.file, record, seenRecordSchema, sync);
		this.entries.push(record);
		this.keys.add(key);
		this.pendingSync = sync ? 0 : nextPendingSync;
	}

	/** Force durability of a partial fsync batch before orderly shutdown. */
	flush(): void {
		if (this.pendingSync === 0) {
			return;
		}
		let descriptor: number | null = null;
		try {
			descriptor = fs.openSync(this.file, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
			fs.fsyncSync(descriptor);
			this.pendingSync = 0;
		} catch (error) {
			throw new DeckError("E_IO", "cannot fsync seen ring", {
				source: this.source,
				cause: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (descriptor !== null) {
				fs.closeSync(descriptor);
			}
		}
	}

	private assertSource(input: Idem): Idem {
		const idem = idemSchema.parse(input);
		if (idem.source !== this.source) {
			throw new DeckError("E_ARG", "idempotency source does not match ring", {
				ring_source: this.source,
				key_source: idem.source,
			});
		}
		return idem;
	}

	private normalizeLoadedEntries(): void {
		const cutoff = this.now() - this.maxAgeMs;
		const seenNewest = new Set<string>();
		const normalizedReversed: SeenRecord[] = [];
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const record = this.entries[index];
			if (record === undefined) {
				continue;
			}
			if (record.source !== this.source) {
				throw new DeckError("E_IO", "seen ring contains a foreign source", {
					ring_source: this.source,
				key_source: record.source,
				});
			}
			const key = idemKey(record);
			if (record.seen_at >= cutoff && !seenNewest.has(key)) {
				seenNewest.add(key);
				normalizedReversed.push(record);
			}
		}
		const normalized = normalizedReversed.reverse().slice(-this.capacity);
		const changed = normalized.length !== this.entries.length;
		if (changed) {
			this.rewriteCompacted(normalized);
			return;
		}
		this.entries = normalized;
		this.keys = new Set(this.entries.map((entry) => idemKey(entry)));
	}

	private evictExpired(): void {
		const cutoff = this.now() - this.maxAgeMs;
		const current = this.entries.filter((entry) => entry.seen_at >= cutoff);
		if (current.length !== this.entries.length) {
			this.rewriteCompacted(current);
		}
	}

	private rewriteCompacted(entries: SeenRecord[]): void {
		const persisted = atomicWriteJsonLines(this.file, entries, seenRecordSchema);
		this.entries = persisted;
		this.keys = new Set(persisted.map((entry) => idemKey(entry)));
		this.pendingSync = 0;
	}
}

export function readCursors(): Cursors {
	ensureStateDirs();
	if (!fs.existsSync(CURSORS_FILE)) {
		return cursorsSchema.parse({});
	}
	let raw: string;
	try {
		raw = fs.readFileSync(CURSORS_FILE, "utf8");
		const decoded: unknown = JSON.parse(raw);
		return cursorsSchema.parse(decoded);
	} catch (error) {
		throw new DeckError("E_IO", "invalid intake cursor state", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Persist only after the corresponding tail append has fsynced. The store does
 * not reorder caller operations; this explicit caller ordering is SPEC §4.2.
 */
export function writeCursor(source: string, cursor: CursorValue): Cursors {
	const parsedSource = z.string().min(1).parse(source);
	const parsedCursor = cursorValueSchema.parse(cursor);
	ensureStateDirs();
	return withExclusiveLock(`${CURSORS_FILE}.lock`, () => {
		const cursors = readCursors();
		const next = cursorsSchema.parse({ ...cursors, [parsedSource]: parsedCursor });
		return atomicWriteJson(CURSORS_FILE, next, cursorsSchema);
	});
}

function idemKey(idem: Idem): string {
	return JSON.stringify([idem.source, idem.external_id, idem.version]);
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new DeckError("E_ARG", `${field} must be a positive integer`, { field, value });
	}
	return value;
}
