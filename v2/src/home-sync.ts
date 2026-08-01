import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deckV2Home } from "./home";

export type HomeSyncProfile = "full" | "personal";

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remote(): string {
	return process.env.DECK_HOME_GIT_REMOTE ?? "twaldin/deck-home";
}

function profile(): string {
	return process.env.DECK_HOME_PROFILE ?? "personal";
}

function cloneHome(): { root: string; repo: string } {
	const root = mkdtempSync(path.join(tmpdir(), "deck-home-sync-"));
	const repo = path.join(root, "repo");
	const branch = `profile/${profile()}`;
	try {
		execFileSync("gh", ["repo", "clone", remote(), repo, "--", "--branch", branch], { stdio: "ignore" });
	} catch {
		execFileSync("git", ["clone", "--branch", branch, remote(), repo], { stdio: "ignore" });
	}
	return { root, repo };
}

function identityEntries(home: string): string[] {
	return fs.readdirSync(home).filter((name) => ![".git", ".pi", ".env", "AGENTS.md", "data", "state", "wt", "logs", "run", "questions", "broker"].includes(name));
}

function copyIdentity(from: string, to: string): void {
	for (const name of identityEntries(from)) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, force: true });
}

/** Home sync uses a temporary clone. The operator home never becomes a checkout. */
export function homeSyncStatus(home = deckV2Home()): string {
	let clone: { root: string; repo: string } | undefined;
	try {
		clone = cloneHome();
		copyIdentity(home, clone.repo);
		const result = runGit(clone.repo, ["status", "--short"]);
		return result || "home repository: clean";
	} finally { if (clone) rmSync(clone.root, { recursive: true, force: true }); }
}

export function homeSyncPull(home = deckV2Home()): string {
	const clone = cloneHome();
	try {
		fs.mkdirSync(home, { recursive: true });
		const incoming = new Set(identityEntries(clone.repo));
		for (const name of identityEntries(home)) if (!incoming.has(name)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
		copyIdentity(clone.repo, home);
		return "home repository: pulled";
	}
	finally { rmSync(clone.root, { recursive: true, force: true }); }
}

export function homeSyncPush(home = deckV2Home()): string {
	const clone = cloneHome();
	try {
		copyIdentity(home, clone.repo);
		runGit(clone.repo, ["add", "-A"]);
		const staged = runGit(clone.repo, ["diff", "--cached", "--name-only"]);
		if (staged.length > 0) { runGit(clone.repo, ["commit", "-m", "sync home"]); return runGit(clone.repo, ["push"]); }
		return "home repository: clean";
	} finally { rmSync(clone.root, { recursive: true, force: true }); }
}

/**
 * Install-time profile filtering is structural: callers clone only this tree.
 * A personal home must never be made by copying full and deleting files later.
 */
export function homeProfilePath(profile: HomeSyncProfile, repo = "twaldin/deck-home"): string {
	return `profile/${profile}`;
}
