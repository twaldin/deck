import * as fs from "node:fs";
import * as path from "node:path";
import { DeckError, type DeckErrorCode } from "./core";
import { z } from "zod";

const gitOutputSchema = z.string();
const GIT_TIMEOUT_MS = 300_000;

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function describeCommand(args: readonly string[]): string {
	return `git ${args.join(" ")}`;
}

export async function runGitResult(repo: string, args: readonly string[], umask?: number): Promise<GitResult> {
	let processHandle: Bun.ReadableSubprocess;
	let previousUmask: number | undefined;
	try {
		if (umask !== undefined) {
			previousUmask = process.umask(umask);
		}
		processHandle = Bun.spawn(["git", "-C", repo, ...args], {
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DeckError("E_IO", `cannot start ${describeCommand(args)}: ${message}`);
	} finally {
		if (previousUmask !== undefined) {
			process.umask(previousUmask);
		}
	}

	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		processHandle.kill("SIGTERM");
	}, GIT_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(processHandle.stdout).text(),
			new Response(processHandle.stderr).text(),
			processHandle.exited,
		]);
		if (timedOut) {
			throw new DeckError("E_IO", `${describeCommand(args)} timed out after ${GIT_TIMEOUT_MS}ms`);
		}
		return {
			exitCode,
			stdout: gitOutputSchema.parse(stdout),
			stderr: gitOutputSchema.parse(stderr),
		};
	} finally {
		clearTimeout(timeout);
	}

}

export async function runGit(
	repo: string,
	args: readonly string[],
	failureCode: DeckErrorCode = "E_IO",
	umask?: number,
): Promise<string> {
	const result = await runGitResult(repo, args, umask);
	if (result.exitCode !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new DeckError(failureCode, `${describeCommand(args)} failed: ${reason}`, {
			exitCode: result.exitCode,
		});
	}
	return result.stdout.trim();
}

export interface ResolvedRepository {
	identity: string;
	context: string;
}

export async function resolveRepository(input: string): Promise<ResolvedRepository> {
	const candidate = path.resolve(input);
	const topLevel = await runGit(candidate, ["rev-parse", "--show-toplevel"], "E_ARG");
	if (topLevel.length === 0) {
		throw new DeckError("E_ARG", `${input} is not a non-bare git worktree`);
	}

	const commonDirectory = await runGit(topLevel, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	], "E_ARG");
	const commandRoot = path.basename(commonDirectory) === ".git"
		? path.dirname(commonDirectory)
		: commonDirectory;
	try {
		return {
			identity: fs.realpathSync(commandRoot),
			context: fs.realpathSync(topLevel),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DeckError("E_ARG", `cannot resolve repository identity for ${input}: ${message}`);
	}
}

export async function validateBranchName(repo: string, branch: string): Promise<void> {
	await runGit(repo, ["check-ref-format", "--branch", branch], "E_ARG");
}

export async function prepareBase(repo: string, requestedBase?: string): Promise<string> {
	if (requestedBase === undefined) {
		await runGit(repo, ["fetch", "origin", "main"]);
		return runGit(repo, ["rev-parse", "--verify", "origin/main^{commit}"]);
	}

	return runGit(repo, ["rev-parse", "--verify", `${requestedBase}^{commit}`], "E_ARG");
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
	await runGit(repo, ["worktree", "add", worktreePath, "-b", branch, base], "E_IO", 0o077);
}

export async function removeWorktree(
	repo: string,
	worktreePath: string,
	branch: string,
	deleteBranch: boolean,
): Promise<void> {
	const removal = await runGitResult(repo, ["worktree", "remove", "--force", worktreePath]);
	if (removal.exitCode !== 0 && fs.existsSync(worktreePath)) {
		const reason = removal.stderr.trim() || removal.stdout.trim() || `exit ${removal.exitCode}`;
		throw new DeckError("E_IO", `git worktree remove --force failed: ${reason}`, {
			exitCode: removal.exitCode,
		});
	}

	// A missing directory can still leave administrative files; prune before
	// the slot becomes reusable (PLAN §5.8: dead trees must not hold branches).
	await runGit(repo, ["worktree", "prune"]);
	if (!deleteBranch) {
		return;
	}

	const branchRef = `refs/heads/${branch}`;
	const exists = await runGitResult(repo, ["show-ref", "--verify", "--quiet", branchRef]);
	if (exists.exitCode === 0) {
		await runGit(repo, ["branch", "-D", branch]);
	} else if (exists.exitCode !== 1) {
		const reason = exists.stderr.trim() || exists.stdout.trim() || `exit ${exists.exitCode}`;
		throw new DeckError("E_IO", `git show-ref --verify failed: ${reason}`, {
			exitCode: exists.exitCode,
		});
	}
}
