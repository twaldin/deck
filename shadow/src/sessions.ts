/**
 * Read-only mate-session evidence for the shadow.
 *
 * Streams the three session-log roots on this machine - Claude Code project
 * transcripts, Codex rollout logs, and omp agent sessions - and extracts
 * effort tokens (canonical PR URLs + Linear IDs) from *work records only*.
 *
 * Coverage model (complete, not sampled):
 *  - First pass is a full streaming backfill of every candidate file, line by
 *    line - no head/tail sampling.
 *  - A persisted store keeps per-file {inode, offset} cursors plus the
 *    accumulated token->latest-work-timestamp index, so each subsequent tick
 *    reads ONLY appended complete JSONL records. Rotation/truncation
 *    (inode change, size shrink) resets that file's cursor.
 *
 * Actor partition (evidence is meaningless without provenance of WHO):
 *  - "worker" sessions are mates doing repo work (treehouse worktrees, lindy
 *    checkouts, deck, ...). Their work records drive fm_behind_sessions /
 *    untracked_pr / stalled_effort freshness.
 *  - "firstmate" sessions are firstmate's OWN cognition (~/firstmate cwd:
 *    omp slug "-firstmate", claude slug "-Users-<user>-firstmate"). Firstmate
 *    discussing an effort is NOT mate work and never drives fm_behind - it is
 *    awareness evidence only (e.g. it upgrades an untracked_pr to "signal"
 *    when firstmate demonstrably knows about the PR but has not tracked it).
 *
 * Provenance rules (the load-bearing part):
 *  - Each token is stamped with ITS OWN record timestamp - never file mtime.
 *  - Only "active" records - ones that demonstrate work being performed -
 *    feed the index:
 *      claude: type=assistant turns, and type=user records carrying a
 *              toolUseResult (tool execution results).
 *      codex:  response_item payloads of function_call / function_call_output,
 *              and assistant messages.
 *      omp:    message records with role assistant / toolResult.
 *    Passive records (user prompts, hook/context injections such as Claude's
 *    startup repo-wide GitHub summaries, reasoning blobs, session meta) are
 *    IGNORED: a mention is not work.
 *  - Bootstrap/status-inventory guard: firstmate's fm-session-start.sh (and
 *    kin) dump fleet-wide digests as tool results; those records are excluded
 *    by marker, and ANY single record touching more than
 *    INVENTORY_TOKEN_LIMIT distinct tokens is treated as a digest, not work.
 *
 * Never writes anywhere near the scanned roots; the store lives under
 * deck's own output directory.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { z } from "zod";
import { LINEAR_ID, PR_URL_TOKEN, type ShadowIssue, type WatchedEffort } from "./firstmate.ts";
import type { PrFact } from "./poll.ts";

export type SessionSource = "claude" | "codex" | "omp";
export type SessionActor = "worker" | "firstmate";

export const SessionFindingSchema = z.object({
	kind: z.enum(["fm_behind_sessions", "untracked_pr", "stalled_effort"]),
	/** "signal" = strong, actionable; "observation" = honest but join-limited. */
	severity: z.enum(["signal", "observation"]),
	effortId: z.string().nullable(),
	detail: z.string().min(1),
	evidencePaths: z.array(z.string()),
	latestSessionMtimeMs: z.number().finite().nonnegative().nullable(),
});

export type SessionFinding = z.infer<typeof SessionFindingSchema>;

export interface SessionRoots {
	claudeProjects: string;
	codexSessions: string;
	ompSessions: string;
}

export function defaultSessionRoots(home = homedir()): SessionRoots {
	return {
		claudeProjects: join(home, ".claude", "projects"),
		codexSessions: join(home, ".codex", "sessions"),
		ompSessions: join(home, ".omp", "agent", "sessions"),
	};
}

const ActorActivitySchema = z.object({
	tsMs: z.number().finite().nonnegative(),
	paths: z.array(z.string()).max(5),
});

const TokenEntrySchema = z.object({
	worker: ActorActivitySchema.optional(),
	firstmate: ActorActivitySchema.optional(),
});

export const SessionStoreSchema = z.object({
	v: z.literal(1),
	files: z.record(
		z.string(),
		z.object({
			inode: z.number().finite().nonnegative(),
			offset: z.number().int().nonnegative(),
			source: z.enum(["claude", "codex", "omp"]),
			actor: z.enum(["worker", "firstmate"]),
			/** Working directory sniffed from the file's own records (session meta). Authoritative over path slugs. */
			cwd: z.string().nullable(),
			/** Deck's own sessions: cursor kept (offset=size) but no tokens ever ingested. */
			excluded: z.boolean(),
		}),
	),
	prTs: z.record(z.string(), TokenEntrySchema),
	linearTs: z.record(z.string(), TokenEntrySchema),
	/** PR URL -> Linear IDs co-mentioned in the SAME work record (effort linkage). */
	prLinks: z.record(z.string(), z.array(z.string()).max(8)),
	/** Untracked-PR candidates already resolved to a terminal state (closed/landed) - never re-polled, never findings. */
	terminalPrUrls: z.array(z.string()),
});

export type SessionStore = z.infer<typeof SessionStoreSchema>;
type TokenEntry = z.infer<typeof TokenEntrySchema>;

export function emptySessionStore(): SessionStore {
	return { v: 1, files: {}, prTs: {}, linearTs: {}, prLinks: {}, terminalPrUrls: [] };
}

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** A single JSONL line larger than this is consumed without parsing. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_WALK_DEPTH = 5;
const NEWLINE = 0x0a;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });
const CANONICAL_PR = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
/** Known bootstrap/status-inventory tool invocations whose output is a fleet-wide digest, not work. */
const BOOTSTRAP_MARKER = /fm-session-start|fm-bootstrap|fm-brief|fm-backlog-pull|fm-backlog-handoff|fm-bearings-snapshot/;
/** More distinct tokens than this in ONE record = inventory/digest, not focused work. */
const INVENTORY_TOKEN_LIMIT = 8;

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
/**
 * Deck's OWN session logs (this project's agents) quote fixture PR URLs and
 * discuss the watch-set constantly; treating them as worker evidence is
 * self-contamination. Excluded wholesale.
 */
const EXCLUDED_PATH = /-dev-deck(\/|$)|-Users-[^/]+-dev-deck(\/|$)/;

/** Rebuild a canonical PR URL from a raw token; drop tokens without a numeric PR id. */
function canonicalizePrUrl(raw: string): string | null {
	const match = CANONICAL_PR.exec(raw);
	if (match === null) {
		return null;
	}
	return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
}

function parseTs(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Classify a session file's actor from its path. Firstmate's own cognition
 * lives under cwd ~/firstmate: omp slugs it "-firstmate", claude slugs it
 * "-Users-<user>-firstmate". Treehouse firstmate WORKTREES (code work on the
 * firstmate repo) contain "treehouse" and stay "worker".
 */
export function classifyActor(path: string): SessionActor {
	// Walk EVERY ancestor segment: omp nests per-session subdirectories
	// (e.g. .../-firstmate/<session>/__advisor.jsonl), so a parent-only check
	// would misclassify nested firstmate logs as workers.
	for (const segment of dirname(path).split("/")) {
		if (segment === "-firstmate" || /^-Users-[^-]+-firstmate$/.test(segment)) {
			return "firstmate";
		}
	}
	return "worker";
}

export type ActorResolution = SessionActor | "excluded";

/**
 * Resolve actor from a sniffed cwd - authoritative over path slugs, which is
 * essential for Codex whose log paths are date-only and carry no project.
 *  - cwd under deckHome => excluded (deck's own sessions: self-contamination).
 *  - cwd at/under fmHome => firstmate cognition (awareness only).
 *  - anything else => worker.
 */
export function resolveActorFromCwd(cwd: string, fmHome: string, deckHome: string): ActorResolution {
	if (cwd === deckHome || cwd.startsWith(`${deckHome}/`)) {
		return "excluded";
	}
	if (cwd === fmHome || cwd.startsWith(`${fmHome}/`)) {
		return "firstmate";
	}
	return "worker";
}

/** Pull a cwd out of any record shape that carries one (claude top-level, codex session_meta/turn_context payload, omp session record). */
export function sniffCwd(record: Record<string, unknown>): string | null {
	if (typeof record["cwd"] === "string") {
		return record["cwd"] as string;
	}
	const payload = record["payload"];
	if (typeof payload === "object" && payload !== null) {
		const payloadCwd = (payload as Record<string, unknown>)["cwd"];
		if (typeof payloadCwd === "string") {
			return payloadCwd;
		}
	}
	return null;
}

interface RecordClass {
	active: boolean;
	tsMs: number | null;
}

/**
 * Classify one parsed JSONL record. Active = the record demonstrates work
 * being performed (assistant action or tool execution result), not a prompt,
 * injected context, or bookkeeping.
 */
export function classifyRecord(source: SessionSource, record: Record<string, unknown>): RecordClass {
	const tsMs = parseTs(record["timestamp"]);
	if (source === "claude") {
		const type = record["type"];
		if (type === "assistant") {
			return { active: true, tsMs };
		}
		if (type === "user" && "toolUseResult" in record) {
			return { active: true, tsMs };
		}
		return { active: false, tsMs };
	}
	if (source === "codex") {
		const payload = record["payload"];
		if (record["type"] === "response_item" && typeof payload === "object" && payload !== null) {
			const payloadType = (payload as Record<string, unknown>)["type"];
			const role = (payload as Record<string, unknown>)["role"];
			if (payloadType === "function_call" || payloadType === "function_call_output") {
				return { active: true, tsMs };
			}
			if (payloadType === "message" && role === "assistant") {
				return { active: true, tsMs };
			}
		}
		return { active: false, tsMs };
	}
	// omp
	if (record["type"] === "message") {
		const message = record["message"];
		if (typeof message === "object" && message !== null) {
			const role = (message as Record<string, unknown>)["role"];
			if (role === "assistant" || role === "toolResult") {
				return { active: true, tsMs };
			}
		}
	}
	return { active: false, tsMs };
}

function recordToken(map: Record<string, TokenEntry>, key: string, actor: SessionActor, tsMs: number, path: string): void {
	const entry = (map[key] ??= {});
	const existing = entry[actor];
	if (existing === undefined) {
		entry[actor] = { tsMs, paths: [path] };
		return;
	}
	existing.tsMs = Math.max(existing.tsMs, tsMs);
	if (existing.paths.length < 5 && !existing.paths.includes(path)) {
		existing.paths.push(path);
	}
}

/** Feed one complete JSONL line into the store. Exported for tests. */
export function ingestLine(store: SessionStore, source: SessionSource, actor: SessionActor, path: string, line: string): void {
	if (line.length === 0) {
		return;
	}
	let record: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) {
			return;
		}
		record = parsed as Record<string, unknown>;
	} catch {
		return; // junk or foreign format
	}
	const classified = classifyRecord(source, record);
	if (!classified.active || classified.tsMs === null) {
		return; // passive mention or undateable record: never drives activity
	}
	// Bootstrap/status-inventory guard: fleet digests mention every token
	// without working any of them.
	if (BOOTSTRAP_MARKER.test(line)) {
		return;
	}
	const prMatches = unique(
		(line.match(PR_URL_TOKEN) ?? [])
			.map(canonicalizePrUrl)
			.filter((url): url is string => url !== null),
	);
	const linearMatches = unique(line.match(LINEAR_ID) ?? []);
	if (prMatches.length > INVENTORY_TOKEN_LIMIT || linearMatches.length > INVENTORY_TOKEN_LIMIT) {
		return; // digest/listing, not focused work
	}
	for (const url of prMatches) {
		recordToken(store.prTs, url, actor, classified.tsMs, path);
		// Co-occurrence in one work record links the PR to its effort's Linear
		// IDs - the join firstmate itself uses (backlog tracks efforts by
		// Linear ID, often without PR URLs).
		if (linearMatches.length > 0) {
			const links = (store.prLinks[url] ??= []);
			for (const id of linearMatches) {
				if (links.length < 8 && !links.includes(id)) {
					links.push(id);
				}
			}
		}
	}
	for (const id of linearMatches) {
		recordToken(store.linearTs, id, actor, classified.tsMs, path);
	}
}

/**
 * Stream every complete appended line of `path` from `offset`, feeding the
 * store. Returns the new byte offset (position after the last consumed
 * newline). Line-safe across chunk boundaries; splits on raw 0x0A so UTF-8
 * multi-byte sequences are never cut mid-character.
 */
interface StreamContext {
	actor: SessionActor;
	cwd: string | null;
	excluded: boolean;
	fmHome: string;
	deckHome: string;
}

/** Apply a newly-sniffed cwd to the context; returns false when the file turns out to be excluded. */
function applyCwd(context: StreamContext, cwd: string): boolean {
	context.cwd = cwd;
	const resolution = resolveActorFromCwd(cwd, context.fmHome, context.deckHome);
	if (resolution === "excluded") {
		context.excluded = true;
		return false;
	}
	context.actor = resolution;
	return true;
}

function streamFile(
	store: SessionStore,
	source: SessionSource,
	path: string,
	startOffset: number,
	size: number,
	context: StreamContext,
): number {
	const descriptor = openSync(path, "r");
	try {
		let consumed = startOffset;
		let remainder: Buffer = Buffer.alloc(0);
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		while (consumed + remainder.length < size) {
			const bytesRead = readSync(descriptor, chunk, 0, READ_CHUNK_BYTES, consumed + remainder.length);
			if (bytesRead <= 0) {
				break;
			}
			const data = remainder.length > 0 ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
			const lastNewline = data.lastIndexOf(NEWLINE);
			if (lastNewline === -1) {
				if (data.length > MAX_LINE_BYTES) {
					// Monster line: consume without parsing rather than ballooning memory.
					consumed += data.length;
					remainder = Buffer.alloc(0);
				} else {
					remainder = Buffer.from(data); // copy - chunk buffer is reused
				}
				continue;
			}
			const complete = UTF8_DECODER.decode(data.subarray(0, lastNewline));
			for (const line of complete.split("\n")) {
				const trimmed = line.trimEnd();
				// cwd is authoritative over path slugs (Codex paths are date-only).
				// Session meta arrives in the first records, before any work
				// records, so tokens are never ingested under a wrong actor in
				// practice; once excluded, the file is skipped wholesale.
				if (context.cwd === null && trimmed.length > 0) {
					try {
						const parsed: unknown = JSON.parse(trimmed);
						if (typeof parsed === "object" && parsed !== null) {
							const cwd = sniffCwd(parsed as Record<string, unknown>);
							if (cwd !== null && !applyCwd(context, cwd)) {
								return size; // deck's own session: consume cursor, ingest nothing
							}
						}
					} catch {
						// unparseable line: no cwd to sniff
					}
				}
				ingestLine(store, source, context.actor, path, trimmed);
			}
			consumed += lastNewline + 1;
			remainder = Buffer.from(data.subarray(lastNewline + 1));
		}
		return consumed;
	} finally {
		closeSync(descriptor);
	}
}

interface CandidateFile {
	source: SessionSource;
	path: string;
	mtimeMs: number;
	size: number;
	inode: number;
}

function collectJsonlFiles(
	source: SessionSource,
	root: string,
	minMtimeMs: number,
	issues: ShadowIssue[],
	depth = 0,
): CandidateFile[] {
	if (depth > MAX_WALK_DEPTH) {
		return [];
	}
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		// A missing root is normal (harness not installed); anything else is an issue.
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		issues.push({ source: `sessions:${root}`, message: error instanceof Error ? error.message : String(error) });
		return [];
	}
	const collected: CandidateFile[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (EXCLUDED_PATH.test(path)) {
			continue; // deck's own sessions: self-contamination
		}
		if (entry.isDirectory()) {
			collected.push(...collectJsonlFiles(source, path, minMtimeMs, issues, depth + 1));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
			continue;
		}
		try {
			const stat = statSync(path);
			if (stat.mtimeMs >= minMtimeMs && stat.size > 0) {
				collected.push({ source, path, mtimeMs: stat.mtimeMs, size: stat.size, inode: stat.ino });
			}
		} catch (error) {
			issues.push({ source: `sessions:${path}`, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return collected;
}

export function loadSessionStore(path: string, issues: ShadowIssue[]): SessionStore {
	try {
		const parsed = SessionStoreSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		if (parsed.success) {
			return parsed.data;
		}
		issues.push({ source: `sessions:${path}`, message: "session store failed validation; rebuilding from scratch" });
		return emptySessionStore();
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptySessionStore();
		}
		issues.push({ source: `sessions:${path}`, message: error instanceof Error ? error.message : String(error) });
		return emptySessionStore();
	}
}

export function saveSessionStore(path: string, store: SessionStore, issues: ShadowIssue[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		issues.push({ source: `sessions:${path}`, message: error instanceof Error ? error.message : String(error) });
	}
}

export interface UpdateOptions {
	roots?: SessionRoots;
	/** Only files with mtime inside this window are (newly) tracked. Already-tracked files are always followed. */
	windowMs?: number;
	nowMs?: number;
	/** Firstmate's home checkout - sessions with this cwd are firstmate cognition. */
	fmHome?: string;
	/** Deck's own checkout - sessions with this cwd are excluded wholesale. */
	deckHome?: string;
}

/**
 * Incrementally consume all candidate session files into the store.
 * Returns the number of files that yielded new bytes this pass.
 */
export function updateSessionStore(store: SessionStore, issues: ShadowIssue[], options: UpdateOptions = {}): number {
	const roots = options.roots ?? defaultSessionRoots();
	const windowMs = options.windowMs ?? 30 * 24 * 60 * 60 * 1000;
	const nowMs = options.nowMs ?? Date.now();
	const fmHome = options.fmHome ?? join(homedir(), "firstmate");
	const deckHome = options.deckHome ?? join(homedir(), "dev", "deck");
	const minMtimeMs = nowMs - windowMs;
	const candidates = [
		...collectJsonlFiles("claude", roots.claudeProjects, minMtimeMs, issues),
		...collectJsonlFiles("codex", roots.codexSessions, minMtimeMs, issues),
		...collectJsonlFiles("omp", roots.ompSessions, minMtimeMs, issues),
	];
	let advanced = 0;
	for (const candidate of candidates) {
		const tracked = store.files[candidate.path];
		let offset = tracked?.offset ?? 0;
		if (tracked !== undefined && (tracked.inode !== candidate.inode || candidate.size < offset)) {
			offset = 0; // rotated or truncated: re-consume
		}
		if (candidate.size <= offset) {
			continue;
		}
		// Known-excluded file grew: keep the cursor current, never ingest.
		if (tracked?.excluded === true && tracked.inode === candidate.inode) {
			store.files[candidate.path] = { ...tracked, offset: candidate.size };
			continue;
		}
		const context: StreamContext = {
			// Persisted cwd (from the file's own session meta) is authoritative;
			// path slugs are the fallback for the first encounter.
			actor: tracked?.cwd != null && tracked.excluded === false ? tracked.actor : classifyActor(candidate.path),
			cwd: tracked?.cwd ?? null,
			excluded: false,
			fmHome,
			deckHome,
		};
		if (context.cwd !== null && !applyCwd(context, context.cwd)) {
			store.files[candidate.path] = { inode: candidate.inode, offset: candidate.size, source: candidate.source, actor: context.actor, cwd: context.cwd, excluded: true };
			continue;
		}
		try {
			const newOffset = streamFile(store, candidate.source, candidate.path, offset, candidate.size, context);
			store.files[candidate.path] = {
				inode: candidate.inode,
				offset: context.excluded ? candidate.size : newOffset,
				source: candidate.source,
				actor: context.actor,
				cwd: context.cwd,
				excluded: context.excluded,
			};
			advanced += 1;
		} catch (error) {
			issues.push({
				source: `sessions:${candidate.path}`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return advanced;
}

export interface SessionActivity {
	latestTsMs: number;
	paths: string[];
}

export interface SessionIndex {
	/** Worker (mate) work records only - drives freshness-based findings. */
	workerByLinearId: Map<string, SessionActivity>;
	workerByPrUrl: Map<string, SessionActivity>;
	/** Firstmate's own records - awareness evidence only, never "work". */
	firstmateByLinearId: Map<string, SessionActivity>;
	firstmateByPrUrl: Map<string, SessionActivity>;
	/** PR URL -> Linear IDs co-mentioned in the same work record. */
	prLinks: Map<string, readonly string[]>;
	scannedFiles: number;
}

function intoMap(target: Map<string, SessionActivity>, key: string, activity: { tsMs: number; paths: string[] } | undefined): void {
	if (activity !== undefined) {
		target.set(key, { latestTsMs: activity.tsMs, paths: activity.paths });
	}
}

export function indexFromStore(store: SessionStore): SessionIndex {
	const workerByLinearId = new Map<string, SessionActivity>();
	const workerByPrUrl = new Map<string, SessionActivity>();
	const firstmateByLinearId = new Map<string, SessionActivity>();
	const firstmateByPrUrl = new Map<string, SessionActivity>();
	for (const [id, entry] of Object.entries(store.linearTs)) {
		intoMap(workerByLinearId, id, entry.worker);
		intoMap(firstmateByLinearId, id, entry.firstmate);
	}
	for (const [url, entry] of Object.entries(store.prTs)) {
		intoMap(workerByPrUrl, url, entry.worker);
		intoMap(firstmateByPrUrl, url, entry.firstmate);
	}
	const prLinks = new Map<string, readonly string[]>(Object.entries(store.prLinks));
	return { workerByLinearId, workerByPrUrl, firstmateByLinearId, firstmateByPrUrl, prLinks, scannedFiles: Object.keys(store.files).length };
}

export interface FindingOptions {
	nowMs?: number;
	/** Worker activity newer than status by more than this => fm_behind_sessions. */
	behindThresholdMs?: number;
	/** No worker activity within this window on an open PR => stalled_effort. */
	stalledThresholdMs?: number;
	/** Only PRs under this prefix count as "watched repo" for untracked_pr. */
	watchedRepoPrefix?: string;
	/** Only worker activity fresher than this window yields untracked_pr (historic PRs are done work, not divergence). */
	untrackedFreshMs?: number;
}

export function deriveSessionFindings(
	watchSet: readonly WatchedEffort[],
	statusMtimeByEffort: ReadonlyMap<string, number | null>,
	factsByUrl: ReadonlyMap<string, PrFact | null>,
	index: SessionIndex,
	options: FindingOptions = {},
): SessionFinding[] {
	const nowMs = options.nowMs ?? Date.now();
	const behindThresholdMs = options.behindThresholdMs ?? 30 * 60 * 1000;
	const stalledThresholdMs = options.stalledThresholdMs ?? 48 * 60 * 60 * 1000;
	const watchedRepoPrefix = options.watchedRepoPrefix ?? "https://github.com/lindy-ai/lindy/pull/";
	const untrackedFreshMs = options.untrackedFreshMs ?? 72 * 60 * 60 * 1000;
	const findings: SessionFinding[] = [];
	const watchedPrUrls = new Set(watchSet.flatMap((effort) => effort.prUrls));

	for (const effort of watchSet) {
		// WORKER activity only: firstmate discussing an effort is not mate work.
		const activities = [
			...effort.linearIds.map((id) => index.workerByLinearId.get(id)),
			...effort.prUrls.map((url) => index.workerByPrUrl.get(url)),
		].filter((activity): activity is SessionActivity => activity !== undefined);
		const latest =
			activities.length === 0 ? null : Math.max(...activities.map((activity) => activity.latestTsMs));
		const paths = unique(activities.flatMap((activity) => activity.paths)).slice(0, 5);
		const statusMtimeMs = statusMtimeByEffort.get(effort.effortId) ?? null;

		if (latest !== null && statusMtimeMs !== null && latest - statusMtimeMs > behindThresholdMs) {
			findings.push(
				SessionFindingSchema.parse({
					kind: "fm_behind_sessions",
					severity: "signal",
					effortId: effort.effortId,
					detail: `worker sessions touched this effort ${Math.round((latest - statusMtimeMs) / 60000)}min after firstmate's last status write`,
					evidencePaths: paths,
					latestSessionMtimeMs: latest,
				}),
			);
		} else if (latest !== null && statusMtimeMs === null) {
			findings.push(
				SessionFindingSchema.parse({
					kind: "fm_behind_sessions",
					severity: "observation",
					effortId: effort.effortId,
					detail:
						"worker sessions show recent activity but no readable firstmate status file (status keyed by window, not slug - join limitation)",
					evidencePaths: paths,
					latestSessionMtimeMs: latest,
				}),
			);
		}

		// stalled: an open, un-landed PR with zero WORKER activity and a stale/absent status.
		const hasOpenUnlanded = effort.prUrls.some((url) => {
			const fact = factsByUrl.get(url);
			return fact != null && !fact.landed && fact.state.toUpperCase() === "OPEN";
		});
		const sessionFresh = latest !== null && nowMs - latest <= stalledThresholdMs;
		const statusFresh = statusMtimeMs !== null && nowMs - statusMtimeMs <= stalledThresholdMs;
		if (hasOpenUnlanded && !sessionFresh && !statusFresh) {
			const fmAware = [
				...effort.linearIds.map((id) => index.firstmateByLinearId.get(id)),
				...effort.prUrls.map((url) => index.firstmateByPrUrl.get(url)),
			].filter((activity): activity is SessionActivity => activity !== undefined);
			const fmNote =
				fmAware.length > 0
					? `; firstmate last discussed it ${new Date(Math.max(...fmAware.map((activity) => activity.latestTsMs))).toISOString()}`
					: "";
			findings.push(
				SessionFindingSchema.parse({
					kind: "stalled_effort",
					severity: "signal",
					effortId: effort.effortId,
					detail: `open un-landed PR with no worker session activity and no status update in ${Math.round(stalledThresholdMs / 3600000)}h - possibly dropped${fmNote}`,
					evidencePaths: paths,
					latestSessionMtimeMs: latest,
				}),
			);
		}
	}

	const watchedLinearIds = new Set(watchSet.flatMap((effort) => effort.linearIds));
	for (const [url, activity] of index.workerByPrUrl) {
		if (!url.startsWith(watchedRepoPrefix) || watchedPrUrls.has(url)) {
			continue;
		}
		if (nowMs - activity.latestTsMs > untrackedFreshMs) {
			continue; // historic work, long done - not "work happening off the books"
		}
		// A PR co-mentioned with a WATCHED Linear ID is tracked via its effort -
		// firstmate's backlog keys efforts by Linear ID, usually without PR URLs.
		const links = index.prLinks.get(url) ?? [];
		if (links.some((id) => watchedLinearIds.has(id))) {
			continue;
		}
		// Firstmate awareness upgrades this to a signal: it KNOWS about the PR
		// (its own transcripts mention it) yet the backlog does not track it.
		const fmSaw = index.firstmateByPrUrl.get(url);
		findings.push(
			SessionFindingSchema.parse({
				kind: "untracked_pr",
				severity: fmSaw !== undefined ? "signal" : "observation",
				effortId: null,
				detail:
					fmSaw !== undefined
						? `${url} shows worker sessions AND firstmate's own transcripts mention it, but it is not in firstmate's backlog watch-set - known yet untracked`
						: `${url} shows worker sessions but is not in firstmate's backlog watch-set`,
				evidencePaths: activity.paths.slice(0, 5),
				latestSessionMtimeMs: activity.latestTsMs,
			}),
		);
	}

	return findings;
}
