import { execOrThrow, type ExecFn } from "./gh.ts";
import { testLaneCommand } from "./test-lane.ts";

export async function runRebaseTests(exec: ExecFn, worktree: string, command?: string): Promise<string> {
	if (!command) throw new Error("A project test command is required for rebase validation.");
	return execOrThrow(exec, ["bash", "-lc", testLaneCommand(command)], { cwd: worktree });
}

export interface BoundedRebaseArgs {
	git: string;
	worktree: string;
	branch: string;
	baseBranch: string;
	expectedRemoteHead: string;
	/**
	 * Commits created by this durable workflow run but not yet present on the
	 * remote PR branch. Callers must source these SHAs from persisted task
	 * output; arbitrary local commits are intentionally not trusted.
	 */
	runCommitShas?: string[];
}

async function commitIds(exec: ExecFn, args: BoundedRebaseArgs, range: string): Promise<string[]> {
	const output = await execOrThrow(exec, [args.git, "rev-list", "--reverse", range], {
		cwd: args.worktree,
	});
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function patchFingerprint(exec: ExecFn, args: BoundedRebaseArgs, commit: string): Promise<string> {
	const patch = await execOrThrow(
		exec,
		[args.git, "show", "--format=", "--binary", "--no-ext-diff", commit],
		{ cwd: args.worktree },
	);
	const patchId = (
		await execOrThrow(exec, [args.git, "patch-id", "--stable"], {
			cwd: args.worktree,
			stdin: patch,
		})
	)
		.trim()
		.split(/\s+/, 1)[0];
	// An empty commit has no patch-id. It is safe only when its exact object id
	// was allowlisted (an empty commit rewritten by rebase therefore fails
	// closed instead of becoming an untraceable extra commit).
	return patchId ? `patch:${patchId}` : `commit:${commit}`;
}

async function fingerprints(
	exec: ExecFn,
	args: BoundedRebaseArgs,
	commits: string[],
): Promise<Array<{ commit: string; fingerprint: string }>> {
	return Promise.all(
		commits.map(async (commit) => ({
			commit,
			fingerprint: await patchFingerprint(exec, args, commit),
		})),
	);
}

/**
 * Fail closed unless every commit about to be force-pushed is either already
 * on the remote PR branch or explicitly attributed to this workflow run.
 *
 * Stable patch ids survive a rebase's SHA rewrites. A multiset (rather than a
 * Set) also prevents one allowlisted patch from authorizing duplicate commits.
 */
export async function assertBoundedRebase(exec: ExecFn, args: BoundedRebaseArgs): Promise<void> {
	const currentBranch = (
		await execOrThrow(exec, [args.git, "branch", "--show-current"], {
			cwd: args.worktree,
		})
	).trim();
	if (currentBranch !== args.branch) {
		throw new Error(
			`[escalate] bounded rebase: worktree HEAD is on "${currentBranch || "detached"}", ` +
				`not "${args.branch}" — refusing to push foreign commits.`,
		);
	}

	const trackedHead = (
		await execOrThrow(
			exec,
			[args.git, "rev-parse", "--verify", `refs/remotes/origin/${args.branch}`],
			{ cwd: args.worktree },
		)
	).trim();
	if (trackedHead !== args.expectedRemoteHead) {
		throw new Error(
			`[escalate] bounded rebase: origin/${args.branch} moved from trusted head ` +
				`${args.expectedRemoteHead} to ${trackedHead} during validation.`,
		);
	}

	const remotePrCommits = await commitIds(
		exec,
		args,
		`origin/${args.baseBranch}..${args.expectedRemoteHead}`,
	);
	const runCommits = args.runCommitShas ?? [];
	const allowed = await fingerprints(exec, args, [...remotePrCommits, ...runCommits]);
	const remaining = new Map<string, number>();
	for (const { fingerprint } of allowed) {
		remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1);
	}

	const outgoingCommits = await commitIds(exec, args, `origin/${args.baseBranch}..HEAD`);
	const outgoing = await fingerprints(exec, args, outgoingCommits);
	const foreign: Array<{ commit: string; fingerprint: string }> = [];
	for (const entry of outgoing) {
		const count = remaining.get(entry.fingerprint) ?? 0;
		if (count === 0) {
			foreign.push(entry);
		} else {
			remaining.set(entry.fingerprint, count - 1);
		}
	}
	if (foreign.length > 0) {
		const detail = foreign
			.slice(0, 5)
			.map(({ commit, fingerprint }) => `${commit.slice(0, 12)} (${fingerprint})`)
			.join(", ");
		throw new Error(
			`[escalate] bounded rebase: ${foreign.length} commit(s) on "${args.branch}" ` +
				`were neither present on the remote PR branch before rebase nor authored in this run — ` +
				`refusing to push possible unrelated commits: ${detail}`,
		);
	}
}

/** Rebase a non-mergeable PR branch and publish it without changing its PR. */
export async function rebaseAndPush(
	exec: ExecFn,
	args: BoundedRebaseArgs & { testCommand?: string },
): Promise<string[]> {
	const run = (command: string[]) => execOrThrow(exec, command, { cwd: args.worktree });
	const actions: string[] = [];
	await run([
		args.git,
		"fetch",
		"origin",
		`+refs/heads/${args.baseBranch}:refs/remotes/origin/${args.baseBranch}`,
		`+refs/heads/${args.branch}:refs/remotes/origin/${args.branch}`,
	]);
	actions.push(`fetched origin/${args.baseBranch} and origin/${args.branch}`);
	const [currentBranch, remoteHead, localHead] = await Promise.all([
		run([args.git, "branch", "--show-current"]).then((value) => value.trim()),
		run([args.git, "rev-parse", `origin/${args.branch}`]).then((value) => value.trim()),
		run([args.git, "rev-parse", "HEAD"]).then((value) => value.trim()),
	]);
	if (currentBranch !== args.branch) {
		throw new Error(
			`[escalate] rebase baseline: worktree is on "${currentBranch || "detached"}", not "${args.branch}".`,
		);
	}
	if (remoteHead !== args.expectedRemoteHead) {
		throw new Error(
			`[escalate] rebase baseline: origin/${args.branch} moved from trusted head ` +
				`${args.expectedRemoteHead} to ${remoteHead}; refusing stale publication.`,
		);
	}
	const actualRunCommits = await commitIds(
		exec,
		args,
		`${args.expectedRemoteHead}..${localHead}`,
	);
	const reportedRunCommits = args.runCommitShas ?? [];
	if (
		actualRunCommits.length !== reportedRunCommits.length ||
		actualRunCommits.some((sha, index) => sha !== reportedRunCommits[index])
	) {
		throw new Error(
			`[escalate] rebase baseline: local commits ${JSON.stringify(actualRunCommits)} ` +
				`do not exactly match this run's persisted commits ${JSON.stringify(reportedRunCommits)}.`,
		);
	}
	actions.push(`verified trusted PR head ${args.expectedRemoteHead}`);
	await run([args.git, "rebase", `origin/${args.baseBranch}`]);
	actions.push(`rebased ${args.branch}`);
	await runRebaseTests(exec, args.worktree, args.testCommand);
	actions.push("tests passed after rebase");
	await assertBoundedRebase(exec, args);
	actions.push("bounded rebase verified");
	await run([
		args.git,
		"push",
		`--force-with-lease=${args.branch}:${args.expectedRemoteHead}`,
		"origin",
		`${args.branch}:${args.branch}`,
	]);
	actions.push(`force-with-lease pushed ${args.branch}`);
	return actions;
}
