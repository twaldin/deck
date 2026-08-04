import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { WorktreeEntry } from "./schema";

export type ReapDecision = "reap" | "keep-dirty" | "keep-active";
export function classifyIdleWorktree(dirty: boolean, terminal: boolean): ReapDecision {
	if (!terminal) return "keep-active";
	if (dirty) return "keep-dirty";
	return "reap";
}
export function worktreeDirty(worktree: string): boolean {
	try { return execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim().length > 0; }
	catch { return true; }
}
export function excludeWorktreePool(pool: string): void {
	if (process.platform !== "darwin") return;
	try { execFileSync("mdutil", ["-i", "off", pool], { stdio: "ignore" }); } catch { /* Spotlight is optional. */ }
}
