import { execOrThrow, type ExecFn } from "./gh.ts";

/** Rebase a non-mergeable PR branch and publish it without changing its PR. */
export async function rebaseAndPush(
	exec: ExecFn,
	args: { git: string; worktree: string; branch: string; baseBranch: string },
): Promise<string[]> {
	const run = (command: string[]) => execOrThrow(exec, command, { cwd: args.worktree });
	const actions: string[] = [];
	await run([args.git, "fetch", "origin", args.baseBranch]);
	actions.push(`fetched origin/${args.baseBranch}`);
	await run([args.git, "rebase", `origin/${args.baseBranch}`]);
	actions.push(`rebased ${args.branch}`);
	await run([args.git, "push", "--force-with-lease", "origin", `${args.branch}:${args.branch}`]);
	actions.push(`force-with-lease pushed ${args.branch}`);
	return actions;
}
