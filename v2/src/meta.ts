/**
 * Per-task metadata, including run_epoch.
 *
 * Format is fm2's `key=value` lines on purpose: fm2 can read a deck-written
 * .meta during the parallel-run period (report §10.3 Class-A rollback).
 *
 * run_epoch exists because a killed process is not reliably a stopped process
 * (report §5.1). It fences LOCAL state writes and grants the right to START an
 * irreversible op. It does not, and cannot, un-land a push — that is what the
 * claim + receipt protocol in side-effects.ts is for.
 */
import * as fs from "node:fs";
import { assertTaskId, ensureHomeDirs, stateFiles } from "./home";

export type TaskKind = "ship" | "scout";
export type OwnerSystem = "deck" | "fm2";

export type TaskMeta = {
	id: string;
	project?: string;
	worktree?: string;
	branch?: string;
	kind?: TaskKind;
	model?: string;
	/** Bumped on every run start. Fences stale writers. */
	run_epoch?: number;
	/** pi session dir for this task's runs. */
	session_dir?: string;
	/** Smithers run id when the task is workflow-backed. */
	run_id?: string;
	/** pid of the live run, when one is running. */
	run_pid?: number;
	/**
	 * Epoch-ms wall-clock deadline for the live run.
	 *
	 * A worker that loops stays alive and writes nothing, so pid-liveness alone
	 * cannot detect it — observed live: a worker retried a rate-limited search nine
	 * times after finishing its actual work, and would have run forever.
	 */
	run_deadline?: number;
	/**
	 * Which system owns this task.
	 *
	 * Do NOT read this as parallel-run safety: the previous system has no notion of
	 * owner_system (verified — zero references in its 90 scripts), and its watcher
	 * globs `$STATE/*.status` unconditionally, so a marker cannot make it skip
	 * anything.
	 *
	 * The actual isolation is that the two systems keep separate state directories
	 * (`~/.deck/state` versus the old home's `state/`) and neither reads the
	 * other's. That is incidental, not enforced, so the one rule that matters is:
	 * never point DECK_V2_HOME at the old home. This marker is for a human reading
	 * a record and for the eventual migration, nothing more.
	 */
	owner_system?: OwnerSystem;
	pr?: string;
	pr_head?: string;
	created?: string;
	[key: string]: string | number | undefined;
};

/** Keys stored as integers. Everything else round-trips as a string. */
const NUMERIC_KEYS = new Set(["run_epoch", "run_pid", "run_deadline"]);

export function readMeta(id: string): TaskMeta | null {
	assertTaskId(id);
	const file = stateFiles(id).meta;
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const meta: TaskMeta = { id };
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (key.length === 0) continue;
		meta[key] = NUMERIC_KEYS.has(key) ? Number.parseInt(value, 10) : value;
	}
	return meta;
}

/** Atomic write: temp + rename, so a reader never sees a half-written file. */
export function writeMeta(meta: TaskMeta): void {
	assertTaskId(meta.id);
	ensureHomeDirs();
	const file = stateFiles(meta.id).meta;
	const lines: string[] = [];
	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined) continue;
		lines.push(`${key}=${String(value)}`);
	}
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function updateMeta(id: string, patch: Partial<TaskMeta>): TaskMeta {
	const current = readMeta(id) ?? { id };
	const next: TaskMeta = { ...current, ...patch, id };
	writeMeta(next);
	return next;
}

export function currentEpoch(id: string): number {
	return readMeta(id)?.run_epoch ?? 0;
}

/** Bump and return the new epoch. Called once per run start. */
export function bumpEpoch(id: string): number {
	const next = currentEpoch(id) + 1;
	updateMeta(id, { run_epoch: next });
	return next;
}

export class StaleEpochError extends Error {
	constructor(
		readonly taskId: string,
		readonly presented: number,
		readonly current: number,
	) {
		super(
			`stale epoch for ${taskId}: run presented ${presented}, current is ${current}; this run has been superseded`,
		);
		this.name = "StaleEpochError";
	}
}

/**
 * Fence a local write. Throws StaleEpochError when the caller's run has been
 * superseded, so the write is rejected and logged rather than applied.
 */
export function assertCurrentEpoch(id: string, presented: number): void {
	const current = currentEpoch(id);
	if (presented !== current) throw new StaleEpochError(id, presented, current);
}

export function isEpochCurrent(id: string, presented: number): boolean {
	return currentEpoch(id) === presented;
}
