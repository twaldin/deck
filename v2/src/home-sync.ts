import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deckV2Home } from "./home";

export type HomeSyncProfile = "full" | "personal";

function runGit(home: string, args: string[], check = true): string {
	return execFileSync("git", ["-C", home, ...args], { encoding: "utf8", stdio: check ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] }).trim();
}

/** The home repository is identity only. Runtime state and secrets stay local. */
export function homeSyncStatus(home = deckV2Home()): string {
	if (!fs.existsSync(path.join(home, ".git"))) return "home repository: not configured";
	return runGit(home, ["status", "--short"]);
}

export function homeSyncPull(home = deckV2Home()): string {
	return runGit(home, ["pull", "--ff-only"]);
}

export function homeSyncPush(home = deckV2Home()): string {
	if (!fs.existsSync(path.join(home, ".git"))) throw new Error(`home repository is not configured at ${home}`);
	// The home repo must contain identity only. Runtime and secrets are excluded
	// structurally by its .gitignore and again here as a defense in depth.
	runGit(home, ["add", "-A"]);
	runGit(home, ["reset", "--", "state", "wt", "logs", "run", "questions", "broker", ".env"], false);
	const staged = runGit(home, ["diff", "--cached", "--name-only"]);
	if (staged.length > 0) runGit(home, ["commit", "-m", "sync home"]);
	return runGit(home, ["push"]);
}

/**
 * Install-time profile filtering is structural: callers clone only this tree.
 * A personal home must never be made by copying full and deleting files later.
 */
export function homeProfilePath(profile: HomeSyncProfile, repo = "twaldin/deck-home"): string {
	return `profile/${profile}`;
}
