import * as fs from "node:fs";
import * as path from "node:path";
import { DeckError, type DeckErrorCode } from "@deck/core";
import { z } from "zod";

const gitOutputSchema = z.string();

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function describeCommand(args: readonly string[]): string {
	return `git ${args.join(" ")}`;
}

export async function runGitResult(repo: string, args: readonly string[]): Promise<GitResult> {
	let processHandle: ReturnType<typeof Bun.spawn>;
	try {
		processHandle = Bun.spawn(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DeckError("E_IO", `cannot start ${describeCommand(args)}: ${message}`);
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return {
		exitCode,
		stdout: gitOutputSchema.parse(stdout),
		stderr: gitOutputSchema.parse(stderr),
	};
}

export async function runGit(
	repo: string,
	args: readonly string[],
	failureCode: DeckErrorCode = "E_IO",
): Promise<string> {
	const result = await runGitResult(repo, args);
	if (result.exitCode !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new DeckError(failureCode, `${describeCommand(args)} failed: ${reason}`, {
			exitCode: result.exitCode,
		});
	}
	return result.stdout.trim();
}

export async function resolveRepository(input: string): Promise<string> {
	const candidate = path.resolve(input);
	const topLevel = await runGit(candidate, ["rev-parse", "--show-toplevel"], "E_ARG");
	if (topLevel.length === 0) {
		throw new DeckError("E_ARG", `${input} is not a non-bare git worktree`);
	}
	return path.resolve(topLevel);
}

export async function prepareBase(repo: string, requestedBase?: string): Promise<string> {
	if (requestedBase === undefined) {
		await runGit(repo, ["fetch", "origin", "main"]);
		await runGit(repo, ["rev-parse", "--verify", "origin/main^{commit}"]);
		return "origin/main";
	}

	await runGit(repo, ["rev-parse", "--verify", `${requestedBase}^{commit}`], "E_ARG");
	return requestedBase;
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
	await runGit(repo, ["worktree", "add", worktreePath, "-b", branch, base]);
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
