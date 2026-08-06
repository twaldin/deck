/**
 * Read-only compatibility helpers for historical worker sessions and model
 * policy. Fire-and-forget process creation was retired in v4: bounded
 * decomposition uses Prime's native `rlm()` and long-running work uses `ship`.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stateFiles } from "./home";
import type { TaskKind } from "./meta";
import { findProfile, loadProfiles, type ModelSeat, type ProjectProfile } from "./projects";
import { assertDeckModel } from "../../workflows/pr-pipeline/lib/models";

/** Captain policy 2026-07-31: one-shot/spawn bread-and-butter is luna (high TPS). */
export const DEFAULT_WORKER_MODEL = "deck/gpt-5.6-luna";


export type SpawnRequest = {
	taskId: string;
	task: string;
	acceptance: string[];
	/** Absolute path to an existing disposable worktree (escape hatch). */
	worktree?: string;
	/** Repo to allocate a fresh worktree from: absolute path or alias. */
	repo?: string;
	/** Base branch/commit for allocation. Default: origin/main. */
	base?: string;
	/** Short label recorded on the allocated worktree entry. */
	desc?: string;
	kind: TaskKind;
	project?: string;
	/** Wall-clock budget for the run. Default DEFAULT_DEADLINE_MS. */
	deadlineMs?: number;
	/**
	 * Escape hatch: this ship spawn deliberately bypasses the project's PR
	 * pipeline (a worker inside a pipeline stage, or captain-authorized bare
	 * work). Default false: profiled ship work goes through `deck-v2 ship`.
	 */
	noPipeline?: boolean;
	branch?: string;
	model?: string;
	context?: string;
	/**
	 * Native reasoning selector passed to Pi. Use a named effort (`minimal`,
	 * `low`, `medium`, `high`, `xhigh`, or `max`) or an Anthropic budget as
	 * `budget:<tokens>`; Pi sends the provider-native value without remapping.
	 */
	reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
	thinking?: string;
};


/**
 * Resolve a repo alias to its primary checkout via the project profiles
 * (config/projects.json). An absolute path always works too.
 */
export function resolveRepo(repo: string): string {
	if (path.isAbsolute(repo)) return repo;
	const profile = findProfile(repo);
	if (profile === null) {
		const known = loadProfiles().map((p) => p.id);
		throw new Error(
			`unknown repo alias "${repo}"; use an absolute path or one of: ${known.join(", ")}`,
		);
	}
	return profile.primary;
}

/** Realpath when the path exists; the input otherwise. */
function realpathIfExists(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function profileByPrimary(candidate: string): ProjectProfile | null {
	const resolved = realpathIfExists(candidate);
	for (const profile of loadProfiles()) {
		if (realpathIfExists(profile.primary) === resolved) return profile;
	}
	return null;
}

/**
 * The primary checkout a worktree belongs to. A linked worktree's
 * --git-common-dir is <primary>/.git, so its parent is the primary. Null when
 * the path is not a git worktree (isolation checks refuse that later anyway).
 */
function worktreePrimary(worktree: string): string | null {
	const run = spawnSync(
		"git",
		["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf8", env: { ...process.env } },
	);
	if (run.status !== 0) return null;
	const commonDir = run.stdout.trim();
	if (commonDir.length === 0) return null;
	return path.dirname(commonDir);
}

/**
 * The profile a ship spawn would belong to, if any: match by project name,
 * repo alias, the repo's primary checkout path, or — for the worktree escape
 * hatch — the primary checkout the worktree was created from. The worktree
 * path matters: without it, `spawn --kind ship --worktree <wt>` on a profiled
 * project would bypass the pipeline the other two paths enforce.
 */
function seatModel(seat: ModelSeat | undefined): { model: string; reasoning?: string } {
	if (seat === undefined) return { model: DEFAULT_WORKER_MODEL };
	return typeof seat === "string" ? { model: seat } : seat;
}

export function workerModelFor(request: SpawnRequest): string {
	const model = request.model ?? seatModel(shipProfileFor(request)?.models?.implementer).model;
	assertDeckModel(model);
	return model;
}

export function workerReasoningFor(request: SpawnRequest): string | undefined {
	const profile = shipProfileFor(request);
	const implementer = profile?.models?.implementer;
	const embeddedReasoning = typeof implementer === "object" ? implementer.reasoning : undefined;
	return request.reasoning
		?? request.thinking
		?? embeddedReasoning
		?? profile?.models?.reasoningImplementer
		?? profile?.models?.reasoning
		?? seatModel(implementer).reasoning;
}

export function shipProfileFor(request: SpawnRequest): ProjectProfile | null {
	if (request.project !== undefined) {
		const byProject = findProfile(request.project);
		if (byProject !== null) return byProject;
	}
	if (request.repo !== undefined) {
		if (!path.isAbsolute(request.repo)) return findProfile(request.repo);
		return profileByPrimary(request.repo);
	}
	if (request.worktree !== undefined) {
		const primary = worktreePrimary(request.worktree);
		if (primary !== null) return profileByPrimary(primary);
	}
	return null;
}

/**
 * Machine enforcement of the default ship path (doctrine PR #26865: a bare
 * spawn shipped a PR with no adversarial review). A ship spawn on a profiled
 * project is refused unless noPipeline is explicit: the effort ships through
 * the pr-pipeline (`deck-v2 ship`), where the PR open is a compute node hard-
 * gated behind the adversarial review. Raw spawn stays available for workers
 * inside a pipeline stage, scouts, and captain-authorized escapes.
 */
export function assertShipGoesThroughPipeline(request: SpawnRequest): void {
	if (request.kind !== "ship" || request.noPipeline === true) return;
	const profile = shipProfileFor(request);
	if (profile === null) return;
	throw new Error(
		`refusing a bare ship spawn on profiled project "${profile.id}" (pipeline: ${profile.pipeline}).\n` +
			`Ship the effort through its pipeline instead: deck-v2 ship <ticket> --profile ${profile.id} ... \n` +
			`(adversarial review is a hard gate before the PR opens there).\n` +
			`spawn is for workers inside a pipeline stage and for scouts; pass --no-pipeline only with the captain's word.`,
	);
}


/** Newest session file, which is the task's current agent identity. */
export function latestSession(taskId: string): string | null {
	const dir = stateFiles(taskId).sessions;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return null;
	}
	if (entries.length === 0) return null;
	const sorted = entries
		.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	const newest = sorted[0];
	return newest === undefined ? null : path.join(dir, newest.f);
}

export type PeekEntry = {
	role: string;
	text: string;
	ts?: string;
};

/**
 * Peek: the last N meaningful entries of a task's session.
 *
 * This replaces pane-scraping with the actual transcript, so there is no
 * rendering ambiguity to misread — the failure mode behind four dated fm2
 * incidents.
 */
export function peekSession(taskId: string, limit = 12): PeekEntry[] {
	const file = latestSession(taskId);
	if (file === null) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries: PeekEntry[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const record = parsed as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
		if (record.type !== "message" || record.message === undefined) continue;
		const role = record.message.role ?? "unknown";
		const text = flattenContent(record.message.content);
		if (text.trim().length === 0) continue;
		entries.push({ role, text, ...(record.timestamp === undefined ? {} : { ts: record.timestamp }) });
	}
	return entries.slice(-limit);
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string; name?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "toolCall") parts.push(`[tool: ${typed.name ?? "?"}]`);
		else if (typed.type === "thinking") parts.push("[thinking]");
	}
	return parts.join(" ");
}

/** Is a pid still alive? Used to tell "run finished" from "run vanished". */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}


