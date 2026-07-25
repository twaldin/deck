import {
	closeSync,
	constants as FS_CONSTANTS,
	existsSync,
	fstatSync,
	openSync,
	readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface ShadowIssue {
	source: string;
	message: string;
}

const GitHubPrUrlSchema = z
	.string()
	.url()
	.superRefine((value, context) => {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			context.addIssue({ code: "custom", message: "not a parseable URL" });
			return;
		}
		if (
			url.protocol !== "https:" ||
			url.hostname !== "github.com" ||
			url.port !== "" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			value.includes("\\") ||
			value !== `https://github.com${url.pathname}` ||
			!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
		) {
			context.addIssue({ code: "custom", message: "not a canonical GitHub pull request URL" });
		}
	});

const WatchedEffortSchema = z.object({
	effortId: z.string().min(1),
	description: z.string().default(""),
	repo: z.string().default(""),
	kind: z.enum(["ship", "scout"]).optional(),
	prUrls: z.array(GitHubPrUrlSchema),
	linearIds: z.array(z.string().regex(/^(?:REL|ENG|ONC)-\d+$/)),
	since: z.string().min(1).optional(),
});

export type WatchedEffort = z.infer<typeof WatchedEffortSchema>;

const EffortActivitySchema = z.object({
	statusMtimeMs: z.number().finite().nonnegative().nullable(),
	statusTail: z.string().nullable(),
});

export type EffortActivity = z.infer<typeof EffortActivitySchema>;

const WatcherLivenessSchema = z.object({
	latestEndedAtMs: z.number().finite().nonnegative().nullable(),
	beaconAgeSec: z.number().finite().nonnegative().nullable(),
	ageSinceLatestMs: z.number().finite().nullable(),
});
export type WatcherLiveness = z.infer<typeof WatcherLivenessSchema>;

const MetaSchema = z
	.record(z.string(), z.string())
	.superRefine((meta, context) => {
		if (meta.pr !== undefined && !GitHubPrUrlSchema.safeParse(meta.pr).success) {
			context.addIssue({ code: "custom", message: "pr is not a canonical GitHub pull request URL" });
		}
		if (meta.pr_head !== undefined && !/^[0-9a-f]{7,64}$/i.test(meta.pr_head)) {
			context.addIssue({ code: "custom", message: "pr_head is not a Git commit SHA" });
		}
	});

const PrPollSchema = z
	.object({
		url: GitHubPrUrlSchema,
		owner: z.string().min(1),
		repo: z.string().min(1),
		number: z.string().regex(/^\d+$/),
	})
	.superRefine((poll, context) => {
		const expected = `https://github.com/${poll.owner}/${poll.repo}/pull/${poll.number}`;
		if (poll.url.replace(/\/$/, "") !== expected) {
			context.addIssue({ code: "custom", message: "url does not match owner/repo/number lines" });
		}
	});

const DecimalSecondsSchema = z
	.string()
	.regex(/^\d+(?:\.\d+)?$/)
	.transform(Number)
	.pipe(z.number().finite().nonnegative());

const WatchCycleSchema = z
	.object({
		ended_at: DecimalSecondsSchema.pipe(
			z.number().max(Number.MAX_SAFE_INTEGER / 1_000),
		),
		beacon_age: DecimalSecondsSchema,
	})
	.transform((cycle) => ({
		endedAt: cycle.ended_at,
		beaconAge: cycle.beacon_age,
	}));

const TailStatSchema = z.object({
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	mtimeMs: z.number().finite().nonnegative(),
});

interface TailSnapshot {
	text: string;
	mtimeMs: number;
}

const MAX_TAIL_READ_BYTES = 64 * 1024;
const MAX_INPUT_READ_BYTES = 8 * 1024 * 1024;
const READ_ONLY_OPEN_FLAGS =
	FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NONBLOCK | FS_CONSTANTS.O_NOFOLLOW;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// firstmate's backlog is human-edited prose: the effort id is the first token
// after the checkbox; repo/kind/since are optional parenthesised tokens that
// may appear in any order (and `since` is written WITHOUT a colon in practice).
// Never reject a bullet — extract what's there; PR URLs / Linear ids are also
// scraped from the bullet and its indented follow-up lines.
const BACKLOG_BULLET = /^- \[ \]\s+(\S+)(?:\s+-\s+(.*))?$/;
const REPO_TOKEN = /\(repo:\s*([^)]+)\)/;
const KIND_TOKEN = /\(kind:\s*(ship|scout)\)/;
const SINCE_TOKEN = /\(since:?\s*([^)]+)\)/;
export const PR_URL_TOKEN = /https:\/\/github\.com\/[^/\s)\]>]+\/[^/\s)\]>]+\/pull\/[^\s)\]>]+/g;
export const LINEAR_ID = /\b(?:REL|ENG|ONC)-\d+\b/g;

function recordIssue(issues: ShadowIssue[], source: string, error: unknown): void {
	issues.push({
		source,
		message: error instanceof Error ? error.message : String(error),
	});
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readText(path: string, issues: ShadowIssue[], optional = false): string | null {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(path, READ_ONLY_OPEN_FLAGS);
		const fileStat = fstatSync(descriptor);
		if (!fileStat.isFile()) {
			throw new Error("path is not a regular file");
		}
		const stat = TailStatSchema.parse({
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
		});
		if (stat.size > MAX_INPUT_READ_BYTES) {
			throw new Error(`file exceeds ${MAX_INPUT_READ_BYTES} bytes`);
		}
		const buffer = Buffer.allocUnsafe(stat.size);
		let bytesRead = 0;
		while (bytesRead < stat.size) {
			const count = readSync(
				descriptor,
				buffer,
				bytesRead,
				stat.size - bytesRead,
				bytesRead,
			);
			if (count === 0) {
				throw new Error(`file changed while reading at byte ${bytesRead}`);
			}
			bytesRead += count;
		}
		return z.string().parse(UTF8_DECODER.decode(buffer));
	} catch (error) {
		if (!(optional && isEnoent(error))) {
			recordIssue(issues, path, error);
		}
		return null;
	} finally {
		if (descriptor !== null) {
			try {
				closeSync(descriptor);
			} catch (error) {
				recordIssue(issues, path, error);
			}
		}
	}
}

function readTailSnapshot(path: string, issues: ShadowIssue[], optional = false): TailSnapshot | null {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(path, READ_ONLY_OPEN_FLAGS);
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) {
			throw new Error("path is not a regular file");
		}
		const parsedStat = TailStatSchema.safeParse({ size: stat.size, mtimeMs: stat.mtimeMs });
		if (!parsedStat.success) {
			recordIssue(issues, path, parsedStat.error);
			return null;
		}
		const length = Math.min(parsedStat.data.size, MAX_TAIL_READ_BYTES);
		const offset = parsedStat.data.size - length;
		const buffer = Buffer.allocUnsafe(length);
		let bytesRead = 0;
		while (bytesRead < length) {
			const count = readSync(
				descriptor,
				buffer,
				bytesRead,
				length - bytesRead,
				offset + bytesRead,
			);
			if (count === 0) {
				throw new Error(`file changed while tailing at byte ${offset + bytesRead}`);
			}
			bytesRead += count;
		}
		let content = buffer;
		if (offset > 0) {
			const boundary = Buffer.allocUnsafe(1);
			if (readSync(descriptor, boundary, 0, 1, offset - 1) !== 1) {
				throw new Error(`file changed while checking tail boundary at byte ${offset - 1}`);
			}
			if (boundary[0] !== 0x0a) {
				const firstNewline = content.indexOf(0x0a);
				if (firstNewline === -1 || firstNewline === content.length - 1) {
					recordIssue(issues, path, `last record exceeds ${MAX_TAIL_READ_BYTES} bytes`);
					return null;
				}
				content = content.subarray(firstNewline + 1);
			}
		}
		const text = z.string().parse(UTF8_DECODER.decode(content));
		return { text, mtimeMs: parsedStat.data.mtimeMs };
	} catch (error) {
		if (!(optional && isEnoent(error))) {
			recordIssue(issues, path, error);
		}
		return null;
	} finally {
		if (descriptor !== null) {
			try {
				closeSync(descriptor);
			} catch (error) {
				recordIssue(issues, path, error);
			}
		}
	}
}

function parsePrUrls(value: string, source: string, issues: ShadowIssue[]): string[] {
	const urls: string[] = [];
	for (const candidate of value.match(PR_URL_TOKEN) ?? []) {
		const normalized = candidate.replace(/[.,;:!?]+$/, "");
		const parsed = GitHubPrUrlSchema.safeParse(normalized);
		if (!parsed.success) {
			recordIssue(issues, source, `malformed GitHub pull request URL: ${candidate}`);
			continue;
		}
		urls.push(parsed.data.replace(/\/$/, ""));
	}
	return urls;
}


function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function stateFile(stateDir: string, effortId: string, suffix: string, issues: ShadowIssue[]): string | null {
	if (effortId === "." || effortId === ".." || /[/\\]/.test(effortId)) {
		recordIssue(issues, effortId, "effort id is not a safe state filename");
		return null;
	}
	return join(stateDir, `${effortId}${suffix}`);
}

function parseMeta(path: string, issues: ShadowIssue[]): z.infer<typeof MetaSchema> | null {
	const text = readText(path, issues, true);
	if (text === null) {
		return null;
	}
	const meta: Record<string, string> = {};
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line.trim() === "") {
			continue;
		}
		const separator = line.indexOf("=");
		if (separator <= 0) {
			recordIssue(issues, path, `line ${index + 1} is not key=value`);
			return null;
		}
		const key = line.slice(0, separator).trim();
		if (key === "") {
			recordIssue(issues, path, `line ${index + 1} has an empty key`);
			return null;
		}
		if (Object.prototype.hasOwnProperty.call(meta, key)) {
			recordIssue(issues, path, `line ${index + 1} duplicates key ${key}`);
			return null;
		}
		meta[key] = line.slice(separator + 1).trim();
	}
	const parsed = MetaSchema.safeParse(meta);
	if (!parsed.success) {
		recordIssue(issues, path, parsed.error);
		return null;
	}
	return parsed.data;
}

function parsePrPoll(path: string, issues: ShadowIssue[]): z.infer<typeof PrPollSchema> | null {
	const text = readText(path, issues, true);
	if (text === null) {
		return null;
	}
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	if (lines.length !== 4) {
		recordIssue(issues, path, `expected 4 lines, received ${lines.length}`);
		return null;
	}
	const parsed = PrPollSchema.safeParse({
		url: lines[0],
		owner: lines[1],
		repo: lines[2],
		number: lines[3],
	});
	if (!parsed.success) {
		recordIssue(issues, path, parsed.error);
		return null;
	}
	return parsed.data;
}

export function parseWatchSet(
	fmHome = join(homedir(), "firstmate"),
	issues: ShadowIssue[] = [],
): WatchedEffort[] {
	const backlogPath = join(fmHome, "data", "backlog.md");
	const backlog = readText(backlogPath, issues);
	if (backlog === null) {
		return [];
	}

	const efforts: WatchedEffort[] = [];
	const seenEffortIds = new Set<string>();
	let inFlight = false;
	let current: WatchedEffort | null = null;
	for (const [index, line] of backlog.split(/\r?\n/).entries()) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading !== null) {
			if (inFlight && heading[1]?.trim().toLowerCase() !== "in flight") {
				break;
			}
			inFlight = heading[1]?.trim().toLowerCase() === "in flight";
			current = null;
			continue;
		}
		if (!inFlight) {
			continue;
		}
		if (line.startsWith("- [ ]")) {
			const match = BACKLOG_BULLET.exec(line);
			const effortId = match?.[1]?.trim();
			if (effortId === undefined || effortId.length === 0) {
				// Genuinely shapeless (no effort-id token) — record and skip only this line.
				recordIssue(issues, backlogPath, `In flight bullet without an effort id on line ${index + 1}`);
				current = null;
				continue;
			}
			if (seenEffortIds.has(effortId)) {
				recordIssue(issues, backlogPath, `duplicate In flight effort id on line ${index + 1}: ${effortId}`);
				current = null;
				continue;
			}
			const rest = match?.[2] ?? "";
			const kindMatch = KIND_TOKEN.exec(rest);
			const kind = kindMatch?.[1] === "ship" || kindMatch?.[1] === "scout" ? kindMatch[1] : undefined;
			const effort = WatchedEffortSchema.safeParse({
				effortId,
				description: rest.replace(REPO_TOKEN, "").replace(KIND_TOKEN, "").replace(SINCE_TOKEN, "").replace(/\s+/g, " ").trim(),
				repo: REPO_TOKEN.exec(rest)?.[1]?.trim() ?? "",
				kind,
				since: SINCE_TOKEN.exec(rest)?.[1]?.trim() || undefined,
				prUrls: unique(parsePrUrls(line, backlogPath, issues)),
				linearIds: unique(line.match(LINEAR_ID) ?? []),
			});
			if (!effort.success) {
				recordIssue(issues, backlogPath, effort.error);
				current = null;
				continue;
			}
			current = effort.data;
			seenEffortIds.add(current.effortId);
			efforts.push(current);
			continue;
		}
		if (current !== null && (line.startsWith(" ") || line.startsWith("\t"))) {
			current.prUrls = unique([
				...current.prUrls,
				...parsePrUrls(line, backlogPath, issues),
			]);
			current.linearIds = unique([...current.linearIds, ...(line.match(LINEAR_ID) ?? [])]);
		} else if (line.trim() !== "") {
			current = null;
		}
	}

	const stateDir = join(fmHome, "state");
	for (const effort of efforts) {
		const metaPath = stateFile(stateDir, effort.effortId, ".meta", issues);
		if (metaPath !== null) {
			const meta = parseMeta(metaPath, issues);
			if (meta?.pr !== undefined) {
				effort.prUrls = unique([...effort.prUrls, meta.pr.replace(/\/$/, "")]);
			}
		}
	}

	for (const effort of efforts) {
		const pollPath = stateFile(stateDir, effort.effortId, ".pr-poll", issues);
		if (pollPath === null || !existsSync(pollPath)) {
			continue;
		}
		const poll = parsePrPoll(pollPath, issues);
		if (poll !== null) {
			effort.prUrls = unique([...effort.prUrls, poll.url.replace(/\/$/, "")]);
		}
	}

	return efforts;
}

export function readEffortActivity(
	fmHome: string,
	effortId: string,
	issues: ShadowIssue[] = [],
): EffortActivity {
	const path = stateFile(join(fmHome, "state"), effortId, ".status", issues);
	if (path === null) {
		return EffortActivitySchema.parse({ statusMtimeMs: null, statusTail: null });
	}

	const snapshot = readTailSnapshot(path, issues, true);
	if (snapshot === null) {
		return EffortActivitySchema.parse({ statusMtimeMs: null, statusTail: null });
	}
	const lines = snapshot.text.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const statusTail = lines.length === 0 ? "" : lines.slice(-5).join("\n");
	return EffortActivitySchema.parse({
		statusMtimeMs: snapshot.mtimeMs,
		statusTail,
	});
}

export function readWatcherLiveness(
	fmHome: string,
	issues: ShadowIssue[] = [],
	nowMs = Date.now(),
): WatcherLiveness {
	const path = join(fmHome, "state", ".watch-cycle-exits.log");
	const snapshot = readTailSnapshot(path, issues);
	if (snapshot === null) {
		return WatcherLivenessSchema.parse({
			latestEndedAtMs: null,
			beaconAgeSec: null,
			ageSinceLatestMs: null,
		});
	}
	const lines = snapshot.text.split(/\r?\n/).filter((line) => line.trim() !== "");
	const lastLine = lines.at(-1);
	if (lastLine === undefined) {
		recordIssue(issues, path, "watch-cycle log is empty");
		return WatcherLivenessSchema.parse({
			latestEndedAtMs: null,
			beaconAgeSec: null,
			ageSinceLatestMs: null,
		});
	}
	const fields: Record<string, string> = {};
	for (const field of lastLine.split("\t")) {
		const separator = field.indexOf("=");
		if (separator <= 0) {
			recordIssue(issues, path, `watch-cycle field is not key=value: ${field}`);
			return WatcherLivenessSchema.parse({
				latestEndedAtMs: null,
				beaconAgeSec: null,
				ageSinceLatestMs: null,
			});
		}
		const key = field.slice(0, separator);
		if (Object.prototype.hasOwnProperty.call(fields, key)) {
			recordIssue(issues, path, `watch-cycle field is duplicated: ${key}`);
			return WatcherLivenessSchema.parse({
				latestEndedAtMs: null,
				beaconAgeSec: null,
				ageSinceLatestMs: null,
			});
		}
		fields[key] = field.slice(separator + 1);
	}
	const parsed = WatchCycleSchema.safeParse(fields);
	if (!parsed.success) {
		recordIssue(issues, path, parsed.error);
		return WatcherLivenessSchema.parse({
			latestEndedAtMs: null,
			beaconAgeSec: null,
			ageSinceLatestMs: null,
		});
	}
	const latestEndedAtMs = parsed.data.endedAt * 1_000;
	return WatcherLivenessSchema.parse({
		latestEndedAtMs,
		beaconAgeSec: parsed.data.beaconAge,
		ageSinceLatestMs: nowMs - latestEndedAtMs,
	});
}
