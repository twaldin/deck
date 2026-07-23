import * as fs from "node:fs";
import * as path from "node:path";
import {
	BROKER_DIR,
	EFFORT_FILES,
	EFFORTS_DIR,
	charterSchema,
	eventSchema,
	inboxCommandSchema,
	manifestSchema,
	type Charter,
	type DeckEvent,
	type InboxCommand,
	type Manifest,
} from "@deck/core";
import { z, type ZodType } from "zod";
import { usageRosterSchema, type AccountsViewData, type BoardViewData, type EffortViewData, type LoadIssue, type UsageRoster } from "./types";

const effortIdSchema = z.string().min(1).regex(/^[^/\\]+$/);

type ReadResult<T> = { ok: true; value: T } | { ok: false; issue: LoadIssue };

interface CachedRead<T> {
	statKey: string;
	result: ReadResult<T>;
}

interface StatePaths {
	effortsDir: string;
	brokerDir: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Lock-free reader for the atomic projections in SPEC §3-§4. Atomic rename
 * makes an unchanged (mtime,size) pair safe to reuse while writers swap files.
 */
export class DeckStateReader {
	private readonly paths: StatePaths;
	private readonly manifestCache = new Map<string, CachedRead<Manifest>>();
	private readonly charterCache = new Map<string, CachedRead<Charter>>();
	private readonly tailCache = new Map<string, CachedRead<DeckEvent[]>>();
	private readonly inboxCache = new Map<string, CachedRead<InboxCommand[]>>();
	private readonly usageCache = new Map<string, CachedRead<UsageRoster>>();

	constructor(paths: Partial<StatePaths> = {}) {
		this.paths = {
			effortsDir: paths.effortsDir ?? EFFORTS_DIR,
			brokerDir: paths.brokerDir ?? BROKER_DIR,
		};
	}

	private readCached<T>(
		cache: Map<string, CachedRead<T>>,
		file: string,
		parse: (text: string) => T,
		missingValue?: T,
	): ReadResult<T> {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch (error) {
			if (isMissing(error) && missingValue !== undefined) return { ok: true, value: missingValue };
			return { ok: false, issue: { source: file, message: errorMessage(error) } };
		}
		const statKey = `${stat.mtimeMs}:${stat.size}`;
		const cached = cache.get(file);
		if (cached?.statKey === statKey) return cached.result;

		let result: ReadResult<T>;
		try {
			result = { ok: true, value: parse(fs.readFileSync(file, "utf8")) };
		} catch (error) {
			result = { ok: false, issue: { source: file, message: errorMessage(error) } };
		}
		cache.set(file, { statKey, result });
		return result;
	}

	private readJson<T>(cache: Map<string, CachedRead<T>>, file: string, schema: ZodType<T>): ReadResult<T> {
		return this.readCached(cache, file, text => schema.parse(JSON.parse(text)));
	}

	private readJsonLines<T>(
		cache: Map<string, CachedRead<T[]>>,
		file: string,
		schema: ZodType<T>,
	): ReadResult<T[]> {
		return this.readCached(
			cache,
			file,
			text => {
				const values: T[] = [];
				const lines = text.split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index]?.trim() ?? "";
					if (line.length === 0) continue;
					try {
						values.push(schema.parse(JSON.parse(line)));
					} catch (error) {
						throw new Error(`${file}:${index + 1}: ${errorMessage(error)}`);
					}
				}
				return values;
			},
			[],
		);
	}

	loadBoard(): BoardViewData {
		const efforts: Manifest[] = [];
		const issues: LoadIssue[] = [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.paths.effortsDir, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return { efforts, issues };
			return { efforts, issues: [{ source: this.paths.effortsDir, message: errorMessage(error) }] };
		}

		const currentManifestFiles = new Set<string>();
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const file = path.join(this.paths.effortsDir, entry.name, EFFORT_FILES.manifest);
			currentManifestFiles.add(file);
			const result = this.readJson(this.manifestCache, file, manifestSchema);
			if (!result.ok) {
				issues.push(result.issue);
				continue;
			}
			if (result.value.effort_id !== entry.name) {
				issues.push({ source: file, message: `effort_id ${result.value.effort_id} does not match directory ${entry.name}` });
				continue;
			}
			efforts.push(result.value);
		}
		for (const file of this.manifestCache.keys()) {
			if (!currentManifestFiles.has(file)) this.manifestCache.delete(file);
		}
		return { efforts, issues };
	}

	loadEffort(effortId: string): EffortViewData {
		const parsedId = effortIdSchema.safeParse(effortId);
		if (!parsedId.success) {
			return {
				effortId,
				manifest: null,
				charter: null,
				events: [],
				inbox: [],
				issues: [{ source: "effort_id", message: parsedId.error.message }],
			};
		}
		const directory = path.join(this.paths.effortsDir, parsedId.data);
		const manifestResult = this.readJson(this.manifestCache, path.join(directory, EFFORT_FILES.manifest), manifestSchema);
		const charterResult = this.readJson(this.charterCache, path.join(directory, EFFORT_FILES.charter), charterSchema);
		const tailResult = this.readJsonLines(this.tailCache, path.join(directory, EFFORT_FILES.tail), eventSchema);
		const inboxResult = this.readJsonLines(this.inboxCache, path.join(directory, EFFORT_FILES.inbox), inboxCommandSchema);
		const issues: LoadIssue[] = [];
		if (!manifestResult.ok) issues.push(manifestResult.issue);
		if (!charterResult.ok) issues.push(charterResult.issue);
		if (!tailResult.ok) issues.push(tailResult.issue);
		if (!inboxResult.ok) issues.push(inboxResult.issue);
		return {
			effortId: parsedId.data,
			manifest: manifestResult.ok ? manifestResult.value : null,
			charter: charterResult.ok ? charterResult.value : null,
			events: tailResult.ok ? tailResult.value.slice(-20) : [],
			inbox: inboxResult.ok ? inboxResult.value : [],
			issues,
		};
	}

	loadAccounts(): AccountsViewData {
		const usageFile = path.join(this.paths.brokerDir, "usage.json");
		const usageResult = this.readJson(this.usageCache, usageFile, usageRosterSchema);
		return {
			usage: usageResult.ok ? usageResult.value : null,
			broker: null,
			issues: usageResult.ok ? [] : [usageResult.issue],
		};
	}
}
