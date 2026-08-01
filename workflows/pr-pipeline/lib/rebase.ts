import { execOrThrow, type ExecFn } from "./gh.ts";

export async function runRebaseTests(exec: ExecFn, worktree: string, command?: string): Promise<string> {
	if (!command) throw new Error("A project test command is required for rebase validation.");
	return execOrThrow(exec, ["sh", "-lc", command], { cwd: worktree });
}

/** Rebase a non-mergeable PR branch and publish it without changing its PR. */
export async function rebaseAndPush(
	exec: ExecFn,
	args: { git: string; worktree: string; branch: string; baseBranch: string; testCommand?: string },
): Promise<string[]> {
	const run = (command: string[]) => execOrThrow(exec, command, { cwd: args.worktree });
	const actions: string[] = [];
	await run([args.git, "fetch", "origin", args.baseBranch]);
	actions.push(`fetched origin/${args.baseBranch}`);
	await run([args.git, "rebase", `origin/${args.baseBranch}`]);
	actions.push(`rebased ${args.branch}`);
	await runRebaseTests(exec, args.worktree, args.testCommand);
	actions.push("tests passed after rebase");
	await run([args.git, "push", "--force-with-lease", "origin", `${args.branch}:${args.branch}`]);
	actions.push(`force-with-lease pushed ${args.branch}`);
	return actions;
}
