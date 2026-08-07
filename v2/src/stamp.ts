import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A durable merge authorization. Revocation wins until the merge fires. */
export type Stamp = {
	patchIds: string[];
	base: string;
	head: string;
	at: number;
	revoked?: number;
};

const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function controlledGitEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// Ambient Git variables can retarget repositories, alter diff context, inject
	// config and attributes, run hooks, or write traces. Start from no Git state
	// and add back only the replay variables this module owns.
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	Object.assign(env, overrides);
	env.GIT_ATTR_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = os.devNull;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function git(repoDir: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
	const result = spawnSync(
		"git",
		["-C", repoDir, "--no-replace-objects", "-c", "color.ui=false", "-c", "core.quotePath=true", "--no-pager", ...args],
		{
			encoding: "utf8",
			env: controlledGitEnv(env),
			input,
			maxBuffer: MAX_GIT_OUTPUT,
		},
	);
	if (result.error !== undefined) throw new Error(`cannot run git ${args[0] ?? "command"}`, { cause: result.error });
	if (result.status !== 0) {
		const reason = result.stderr.trim() || `exit ${result.status ?? "unknown"}`;
		throw new Error(`git ${args[0] ?? "command"} failed: ${reason}`);
	}
	return result.stdout;
}

function lines(output: string): string[] {
	const trimmed = output.trim();
	return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}

/** Ordered content fingerprints for every commit in base..head. */
export function patchSeries(repoDir: string, base: string, head: string): string[] {
	const range = `${base}..${head}`;
	const commits = lines(git(repoDir, ["rev-list", "--reverse", "--topo-order", "--end-of-options", range]));
	if (commits.length === 0) return [];

	const patches = git(repoDir, [
		"log",
		"--reverse",
		"--topo-order",
		"--format=commit %H",
		"--no-show-signature",
		"--patch",
		// Unchanged context is not feature content: hashing it would revoke a
		// stamp when main changes a nearby line and Git rebases cleanly.
		"--unified=0",
		"--inter-hunk-context=0",
		"--default-prefix",
		"--diff-algorithm=myers",
		"--no-indent-heuristic",
		"--no-renames",
		"-O/dev/null",
		"--no-relative",
		"--submodule=short",
		"--ignore-submodules=none",
		"--full-index",
		"--binary",
		"--no-ext-diff",
		"--no-textconv",
		"--diff-merges=first-parent",
		"--end-of-options",
		range,
	]);
	// `--stable` is a security bug here: it strips whitespace before hashing. On
	// git 2.50.1, moving `return 1` from inside a Python `if` to just after it
	// produces the same stable id, which would merge code the captain never saw.
	const records = lines(git(repoDir, ["patch-id", "--verbatim"], patches));
	if (records.length !== commits.length) {
		// Empty or otherwise un-fingerprintable commits cannot inherit a stamp.
		throw new Error(`git patch-id fingerprinted ${records.length} of ${commits.length} commits`);
	}

	return records.map((record, index) => {
		const fields = record.trim().split(/\s+/);
		const expectedCommit = commits[index];
		if (fields.length !== 2 || fields[1] !== expectedCommit || !OBJECT_ID.test(fields[0] ?? "")) {
			throw new Error(`invalid git patch-id output at commit ${index + 1}`);
		}
		return fields[0]!;
	});
}
function resolveCommit(repoDir: string, revision: string): string {
	const resolved = git(repoDir, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
	if (!OBJECT_ID.test(resolved)) throw new Error(`cannot resolve commit ${revision}`);
	return resolved;
}

function resolveTree(repoDir: string, commit: string): string {
	const resolved = git(repoDir, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]).trim();
	if (!OBJECT_ID.test(resolved)) throw new Error(`cannot resolve tree for ${commit}`);
	return resolved;
}

/**
 * Re-run Git's merge rebase in an isolated clone. Patch ids deliberately omit
 * hunk line numbers, so equal ids alone can miss an identical edit relocated
 * between repeated contexts. The replay proves the candidate is the exact tree
 * produced by applying the reviewed history cleanly to its new base.
 */
function replayedTree(repoDir: string, stampedBase: string, stampedHead: string, currentBase: string): string {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deck-stamp-replay-"));
	try {
		const replay = path.join(scratch, "repo");
		const template = path.join(scratch, "template");
		const hooks = path.join(scratch, "hooks");
		fs.mkdirSync(template);
		fs.mkdirSync(hooks);
		const env = {
			GIT_COMMITTER_EMAIL: "deck-stamp@localhost",
			GIT_COMMITTER_NAME: "deck-stamp",
			GIT_EDITOR: "true",
			GIT_SEQUENCE_EDITOR: "true",
		};

		// --shared reads the original object store without copying or writing it;
		// every checkout, ref, rebase state file, and new commit stays in scratch.
		git(scratch, ["clone", "--shared", "--no-checkout", "--quiet", `--template=${template}`, fs.realpathSync(repoDir), replay], undefined, env);
		git(replay, ["config", "core.hooksPath", hooks], undefined, env);
		git(replay, ["config", "commit.gpgSign", "false"], undefined, env);
		git(replay, ["checkout", "--quiet", "--detach", stampedHead], undefined, env);
		git(
			replay,
			["rebase", "--merge", "--strategy=ort", "--no-autosquash", "--no-update-refs", "--onto", currentBase, stampedBase],
			undefined,
			env,
		);
		return resolveTree(replay, "HEAD");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/** Fast exact-series pre-filter. stampSurvivesAt is the authority. */
export function stampSurvives(stamped: Stamp, current: readonly string[]): boolean {
	if (stamped.revoked !== undefined || stamped.patchIds.length === 0 || current.length === 0) return false;
	if (stamped.patchIds.length !== current.length) return false;
	return stamped.patchIds.every((patchId, index) => patchId === current[index]);
}

/**
 * Authoritative check: fast patch-id rejection followed by a clean-rebase tree
 * proof. Any missing object, conflict, relocation, drift, or Git error denies.
 */
export function stampSurvivesAt(stamped: Stamp, repoDir: string, base: string, head: string): boolean {
	try {
		if (stamped.revoked !== undefined) return false;
		// Durable stamps must pin objects. Accepting mutable refs here would let a
		// force-push replace both the evidence and the candidate being checked.
		if (!OBJECT_ID.test(stamped.base) || !OBJECT_ID.test(stamped.head)) return false;
		const stampedBase = resolveCommit(repoDir, stamped.base);
		const stampedHead = resolveCommit(repoDir, stamped.head);
		const currentBase = resolveCommit(repoDir, base);
		const currentHead = resolveCommit(repoDir, head);

		// Recompute the stored history as well as the candidate. This refuses a
		// malformed token whose endpoints do not actually produce its patch ids.
		if (!stampSurvives(stamped, patchSeries(repoDir, stampedBase, stampedHead))) return false;
		if (!stampSurvives(stamped, patchSeries(repoDir, currentBase, currentHead))) return false;
		return replayedTree(repoDir, stampedBase, stampedHead, currentBase) === resolveTree(repoDir, currentHead);
	} catch {
		// A false negative costs one re-stamp; a false positive merges unreviewed code.
		return false;
	}
}
