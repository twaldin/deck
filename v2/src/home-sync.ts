import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deckV2Home } from "./home";
import { ARCHIVE_ONCE_NAMES, DURABLE_LINK_NAMES } from "./bootstrap";

export type HomeSyncProfile = "full" | "personal";

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remote(): string {
	const value = process.env.DECK_HOME_GIT_REMOTE?.trim();
	if (!value) throw new Error("home sync refused: DECK_HOME_GIT_REMOTE is unset");
	return value;
}

export function profileMarkerPath(home = deckV2Home()): string {
	return path.join(home, ".deck-profile");
}

export function resolveHomeSyncProfile(home = deckV2Home()): HomeSyncProfile {
	const value = process.env.DECK_HOME_PROFILE?.trim() || (fs.existsSync(profileMarkerPath(home))
		? fs.readFileSync(profileMarkerPath(home), "utf8").trim()
		: "");
	if (value === "full" || value === "personal") return value;
	throw new Error(`home sync refused: DECK_HOME_PROFILE is unset and ${profileMarkerPath(home)} does not identify a profile`);
}

function gitRemote(value: string): string {
	if (/^(?:https?|ssh|git|file):\/\//.test(value) || /^[^/]+@[^:]+:.+/.test(value) || value.startsWith("/") || value.startsWith("~")) return value;
	return `https://github.com/${value}.git`;
}

function assertPersonalProfile(home: string, selectedProfile: HomeSyncProfile): void {
	if (selectedProfile !== "personal") return;
	const found = execFileSync("find", [home, "-type", "f", "(", "-name", "restricted-*", "-o", "-path", "*/secrets-map.md", ")", "-print", "-quit"], { encoding: "utf8" }).trim();
	if (found) throw new Error("restricted project material in personal home");
} 

function cloneHome(selectedProfile: HomeSyncProfile): { root: string; repo: string } {
	const root = mkdtempSync(path.join(tmpdir(), "deck-home-sync-"));
	const repo = path.join(root, "repo");
	const branch = `profile/${selectedProfile}`;
	try {
		execFileSync("gh", ["repo", "clone", remote(), repo, "--", "--branch", branch], { stdio: "ignore" });
	} catch {
		execFileSync("git", ["clone", "--branch", branch, gitRemote(remote()), repo], { stdio: "ignore" });
	}
	return { root, repo };
}

const NEVER_SYNC_HOME_ENTRIES: Record<string, true> = {
	".git": true,
	".prime": true,
	"AGENTS.md": true,
	"logs": true,
	"run": true,
	...Object.fromEntries(ARCHIVE_ONCE_NAMES.map((name) => [name, true as const])),
	...Object.fromEntries(DURABLE_LINK_NAMES.map((name) => [name, true as const])),
};

/** Host-private durable state and retired profiles never enter the home git repository. */
export function homeSyncMayCopyEntry(name: string): boolean {
	return NEVER_SYNC_HOME_ENTRIES[name] !== true;
}

function identityEntries(home: string): string[] {
	return fs.readdirSync(home).filter(homeSyncMayCopyEntry);
}

function copyIdentity(from: string, to: string): void {
	for (const name of identityEntries(from)) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, force: true });
}

/** Home sync uses a temporary clone. The operator home never becomes a checkout. */
export function homeSyncStatus(home = deckV2Home()): string {
	let clone: { root: string; repo: string } | undefined;
	try {
		const selectedProfile = resolveHomeSyncProfile(home);
		clone = cloneHome(selectedProfile);
		assertPersonalProfile(home, selectedProfile);
		copyIdentity(home, clone.repo);
		const result = runGit(clone.repo, ["status", "--short"]);
		return result || "home repository: clean";
	} finally { if (clone) rmSync(clone.root, { recursive: true, force: true }); }
}

export function homeSyncPull(home = deckV2Home()): string {
	const selectedProfile = resolveHomeSyncProfile(home);
	const clone = cloneHome(selectedProfile);
	try {
		fs.mkdirSync(home, { recursive: true });
		// Pull is additive. A profile branch may be incomplete, and deleting local
		// entries would turn a sync into silent data loss.
		assertPersonalProfile(clone.repo, selectedProfile);
		copyIdentity(clone.repo, home);
		return "home repository: pulled";
	}
	finally { rmSync(clone.root, { recursive: true, force: true }); }
}

export function homeSyncPush(home = deckV2Home()): string {
	const selectedProfile = resolveHomeSyncProfile(home);
	const clone = cloneHome(selectedProfile);
	try {
		assertPersonalProfile(home, selectedProfile);
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
export function homeProfilePath(profile: HomeSyncProfile): string {
	return `profile/${profile}`;
}
