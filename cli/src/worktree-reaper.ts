import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { WorktreeEntry } from "./schema";

export type ReapDecision = "reap" | "keep-dirty" | "keep-active" | "keep-young";
export function classifyIdleWorktree(entry: WorktreeEntry, now: number, ttlMs: number, dirty: boolean, terminal: boolean): ReapDecision {
	if (dirty) return "keep-dirty";
	if (!terminal) return "keep-active";
	const age = now - Date.parse(entry.created);
	return age >= ttlMs ? "reap" : "keep-young";
}
export function worktreeDirty(worktree: string): boolean {
	try { return execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim().length > 0; }
	catch { return true; }
}
export function worktreeTtlMs(): number {
	const seconds = Number(process.env.DECK_WORKTREE_TTL_SECONDS ?? 7 * 24 * 60 * 60);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 7 * 24 * 60 * 60 * 1000;
}
export function excludeWorktreePool(pool: string): void {
	if (process.platform !== "darwin") return;
	try { execFileSync("mdutil", ["-i", "off", pool], { stdio: "ignore" }); } catch { /* Spotlight is optional. */ }
}
