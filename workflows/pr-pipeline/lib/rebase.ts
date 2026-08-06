import { execOrThrow, type ExecFn } from "./gh.ts";
import { testLaneCommand } from "./test-lane.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentLike } from "smithers-orchestrator";
import { z } from "zod";

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

async function provenanceFingerprint(
	exec: ExecFn,
	args: BoundedRebaseArgs,
	commit: string,
): Promise<string> {
	const [patch, authoredMetadata] = await Promise.all([
		execOrThrow(
			exec,
			[args.git, "show", "--format=", "--binary", "--no-ext-diff", commit],
			{ cwd: args.worktree },
		),
		execOrThrow(
			exec,
			[args.git, "show", "-s", "--format=%an%x1f%ae%x1f%aI%x1f%B", commit],
			{ cwd: args.worktree },
		),
	]);
	const patchId = (
		await execOrThrow(exec, [args.git, "patch-id", "--stable"], {
			cwd: args.worktree,
			stdin: patch,
		})
	)
		.trim()
		.split(/\s+/, 1)[0];
	// A rebase preserves the patch plus author identity/date and message while
	// necessarily changing the parent and committer metadata. Empty commits
	// have no patch-id, so only their exact object id is trusted.
	return patchId
		? `authored:${patchId}\u0000${authoredMetadata}`
		: `commit:${commit}`;
}

async function fingerprints(
	exec: ExecFn,
	args: BoundedRebaseArgs,
	commits: string[],
): Promise<Array<{ commit: string; fingerprint: string }>> {
	return Promise.all(
		commits.map(async (commit) => ({
			commit,
			fingerprint: await provenanceFingerprint(exec, args, commit),
		})),
	);
}

/**
 * Fail closed unless every commit about to be force-pushed is either already
 * on the remote PR branch or explicitly attributed to this workflow run.
 *
 * The fingerprint combines stable patch-id with rebase-preserved author
 * identity/date and message. A multiset also prevents one allowlisted logical
 * commit from authorizing duplicates.
 */
export async function assertBoundedRebase(
	exec: ExecFn,
	args: BoundedRebaseArgs,
	trustedResolvedCommitShas: readonly string[] = [],
): Promise<void> {
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
	const unresolvedTrusted = new Set(trustedResolvedCommitShas);
	const foreign: Array<{ commit: string; fingerprint: string }> = [];
	for (const entry of outgoing) {
		if (unresolvedTrusted.delete(entry.commit)) continue;
		const count = remaining.get(entry.fingerprint) ?? 0;
		if (count === 0) {
			foreign.push(entry);
		} else {
			remaining.set(entry.fingerprint, count - 1);
		}
	}
	if (unresolvedTrusted.size > 0) {
		throw new Error(
			`[escalate] bounded rebase: trusted conflict-resolution commit(s) are not outgoing: ` +
				[...unresolvedTrusted].join(", "),
		);
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

export interface RebaseConflictContext {
	attempt: number;
	branch: string;
	baseBranch: string;
	originalHead: string;
	rebasingCommit: string;
	rebasingCommitDetails: string;
	currentHead: string;
	conflictedFiles: string[];
	stagedFilesBeforeResolution: string[];
	protectedIndexEntriesBeforeResolution: string;
	unmergedIndex: string;
	status: string;
	conflictDiff: string;
	gitError: string;
}

export type RebaseConflictResolution =
	| {
			disposition: "resolved";
			/** Continue commits a staged semantic merge; drop removes a commit the seat found fully superseded. */
			strategy: "continue" | "drop";
			summary: string;
	  }
	| {
			disposition: "decision";
			summary: string;
			question: string;
	  };

export const rebaseConflictResolutionSchema = z.discriminatedUnion("disposition", [
	z.object({
		disposition: z.literal("resolved"),
		strategy: z.enum(["continue", "drop"]),
		summary: z.string().min(1),
	}),
	z.object({
		disposition: z.literal("decision"),
		summary: z.string().min(1),
		question: z.string().min(1),
	}),
]);
const conflictSeatResultSchema = z.object({ output: z.unknown() });

export type RebaseConflictResolver = (
	context: RebaseConflictContext,
) => Promise<RebaseConflictResolution>;

export class RebaseDecisionRequired extends Error {
	readonly context: RebaseConflictContext;
	readonly resolution: Extract<RebaseConflictResolution, { disposition: "decision" }>;

	constructor(
		context: RebaseConflictContext,
		resolution: Extract<RebaseConflictResolution, { disposition: "decision" }>,
	) {
		super(
			`[decision] rebase conflict at ${context.rebasingCommit.slice(0, 12)} ` +
				`in ${context.conflictedFiles.join(", ")} needs the captain: ${resolution.question}`,
		);
		this.name = "RebaseDecisionRequired";
		this.context = context;
		this.resolution = resolution;
	}
}

const REBASE_STATE_PATHS = [
	"rebase-merge",
	"rebase-apply",
	"gh-stack-rebase-state",
	"REBASE_HEAD",
	"MERGE_MSG",
	"MERGE_RR",
] as const;
const ARTIFACT_PATHSPECS = ["*.orig", "*.rej"] as const;
const CONFLICT_MARKER_PATTERN = "^(<{7,} |>{7,} )";

function splitNul(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function commandError(command: string[], code: number, stderr: string): Error {
	return new Error(
		`command failed (${code}): ${command.join(" ")}\n${stderr.slice(0, 2000)}`,
	);
}

async function rebaseStateResidue(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<string[]> {
	const paths = await Promise.all(
		REBASE_STATE_PATHS.map(async (name) => {
			const reported = (
				await execOrThrow(
					exec,
					[args.git, "rev-parse", "--path-format=absolute", "--git-path", name],
					{ cwd: args.worktree },
				)
			).trim();
			const absolute = path.isAbsolute(reported)
				? reported
				: path.resolve(args.worktree, reported);
			return fs.existsSync(absolute) ? absolute : null;
		}),
	);
	return paths.filter((entry): entry is string => entry !== null);
}

export async function removeRebaseStateResidue(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<void> {
	for (const residue of await rebaseStateResidue(exec, args)) {
		fs.rmSync(residue, { recursive: true, force: true });
	}
}
export async function clearCompletedRebaseMetadata(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<void> {
	for (const ref of ["REBASE_HEAD", "AUTO_MERGE"]) {
		const result = await exec([args.git, "update-ref", "-d", ref], {
			cwd: args.worktree,
		});
		if (result.code !== 0) {
			throw commandError(
				[args.git, "update-ref", "-d", ref],
				result.code,
				result.stderr,
			);
		}
	}
	for (const name of ["MERGE_MSG", "MERGE_RR"]) {
		const reported = (
			await execOrThrow(
				exec,
				[args.git, "rev-parse", "--path-format=absolute", "--git-path", name],
				{ cwd: args.worktree },
			)
		).trim();
		const absolute = path.isAbsolute(reported)
			? reported
			: path.resolve(args.worktree, reported);
		fs.rmSync(absolute, { recursive: true, force: true });
	}
}

async function listedArtifactPaths(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
	includeTracked: boolean,
): Promise<string[]> {
	const commands: string[][] = [
		[
			args.git,
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
			"--",
			...ARTIFACT_PATHSPECS,
		],
		[
			args.git,
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			...ARTIFACT_PATHSPECS,
		],
	];
	if (includeTracked) {
		commands.push([
			args.git,
			"ls-files",
			"--cached",
			"-z",
			"--",
			...ARTIFACT_PATHSPECS,
		]);
	}
	const outputs = await Promise.all(
		commands.map((command) =>
			execOrThrow(exec, command, { cwd: args.worktree })
		),
	);
	return [...new Set(outputs.flatMap(splitNul))].sort();
}

async function conflictMarkerMatches(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<string> {
	const command = [
		args.git,
		"grep",
		"-n",
		"-z",
		"-I",
		"-E",
		"^(<{7,} |={7,}|>{7,} )",
		"--",
		".",
	];
	const result = await exec(command, { cwd: args.worktree });
	if (result.code === 1) return "";
	if (result.code !== 0) throw commandError(command, result.code, result.stderr);
	const openByFile = new Map<
		string,
		{ start: string; width: number; middle?: string }
	>();
	const blocks: string[] = [];
	for (const row of result.stdout.split("\n")) {
		const firstSeparator = row.indexOf("\0");
		const secondSeparator = row.indexOf("\0", firstSeparator + 1);
		if (firstSeparator < 0 || secondSeparator < 0) continue;
		const file = row.slice(0, firstSeparator);
		const text = row.slice(secondSeparator + 1);
		const display = `${file}:${row.slice(firstSeparator + 1, secondSeparator)}:${text}`;
		const start = /^(<{7,}) /.exec(text);
		const middle = /^(={7,})$/.exec(text);
		const end = /^(>{7,}) /.exec(text);
		if (start !== null) {
			openByFile.set(file, { start: display, width: start[1].length });
		} else if (middle !== null) {
			const open = openByFile.get(file);
			if (open !== undefined && open.width === middle[1].length) {
				open.middle = display;
			}
		} else if (end !== null) {
			const open = openByFile.get(file);
			if (open?.middle !== undefined && open.width === end[1].length) {
				blocks.push(open.start, open.middle, display);
			}
			openByFile.delete(file);
		}
	}
	return blocks.join("\n");
}
async function unmergedFiles(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<string[]> {
	const output = await execOrThrow(
		exec,
		[args.git, "diff", "--name-only", "--diff-filter=U", "-z"],
		{ cwd: args.worktree },
	);
	return splitNul(output);
}

export async function activeRebaseConflictFiles(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<string[]> {
	if ((await rebaseStateResidue(exec, args)).length === 0) return [];
	return unmergedFiles(exec, args);
}

export async function assertCleanRebaseState(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree" | "branch">,
	expectedHead?: string,
): Promise<void> {
	const [state, artifacts, markers, status, branch, head, unmerged] =
		await Promise.all([
			rebaseStateResidue(exec, args),
			listedArtifactPaths(exec, args, true),
			conflictMarkerMatches(exec, args),
			execOrThrow(
				exec,
				[args.git, "status", "--porcelain=v1", "--untracked-files=all"],
				{ cwd: args.worktree },
			),
			execOrThrow(exec, [args.git, "branch", "--show-current"], {
				cwd: args.worktree,
			}).then((value) => value.trim()),
			execOrThrow(exec, [args.git, "rev-parse", "HEAD"], {
				cwd: args.worktree,
			}).then((value) => value.trim()),
			unmergedFiles(exec, args),
		]);
	const problems: string[] = [];
	if (state.length > 0) problems.push(`rebase state: ${state.join(", ")}`);
	if (artifacts.length > 0) {
		problems.push(`artifact files: ${artifacts.join(", ")}`);
	}
	if (markers !== "") {
		problems.push(`conflict markers in tracked files: ${markers.slice(0, 1000)}`);
	}
	if (status.trim() !== "") {
		problems.push(`dirty worktree: ${status.trim().slice(0, 1000)}`);
	}
	if (branch !== args.branch) {
		problems.push(`branch is "${branch || "detached"}", expected "${args.branch}"`);
	}
	if (expectedHead !== undefined && head !== expectedHead) {
		problems.push(`HEAD is ${head}, expected ${expectedHead}`);
	}
	if (unmerged.length > 0) {
		problems.push(`unmerged files: ${unmerged.join(", ")}`);
	}
	if (problems.length > 0) {
		throw new Error(`[escalate] unclean rebase worktree: ${problems.join("; ")}`);
	}
}

export async function removeUntrackedArtifactFiles(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree">,
): Promise<void> {
	const root = path.resolve(args.worktree);
	for (const relative of await listedArtifactPaths(exec, args, false)) {
		const absolute = path.resolve(root, relative);
		const backToRoot = path.relative(root, absolute);
		if (
			backToRoot === "" ||
			backToRoot === ".." ||
			backToRoot.startsWith(`..${path.sep}`) ||
			path.isAbsolute(backToRoot)
		) {
			throw new Error(`refusing unsafe artifact cleanup path: ${relative}`);
		}
		fs.rmSync(absolute, { recursive: true, force: true });
	}
}

async function restoreOriginalBranch(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree" | "branch">,
	originalHead: string,
): Promise<void> {
	let state = await rebaseStateResidue(exec, args);
	if (state.length > 0) {
		await exec([args.git, "rebase", "--abort"], { cwd: args.worktree });
		state = await rebaseStateResidue(exec, args);
	}
	if (state.length > 0) {
		await exec([args.git, "rebase", "--quit"], { cwd: args.worktree });
		state = await rebaseStateResidue(exec, args);
	}
	// --abort/--quit are normally sufficient. If Git's state is corrupt, remove
	// only the exact operation-owned paths before restoring the trusted ref.
	for (const residue of state) fs.rmSync(residue, { recursive: true, force: true });
	await execOrThrow(exec, [args.git, "checkout", "--force", args.branch], {
		cwd: args.worktree,
	});
	await execOrThrow(exec, [args.git, "reset", "--hard", originalHead], {
		cwd: args.worktree,
	});
	// The baseline is required to be clean, so every non-ignored untracked path
	// here was created by this failed attempt or its resolver seat.
	await execOrThrow(exec, [args.git, "clean", "-fd"], { cwd: args.worktree });
	await clearCompletedRebaseMetadata(exec, args);
	await removeUntrackedArtifactFiles(exec, args);
	await assertCleanRebaseState(exec, args, originalHead);
}

async function captureConflictContext(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree" | "branch" | "baseBranch">,
	originalHead: string,
	attempt: number,
	gitError: string,
): Promise<RebaseConflictContext> {
	const [
		currentHead,
		rebasingCommit,
		rebasingCommitDetails,
		conflictedFiles,
		stagedFilesBeforeResolution,
		unmergedIndex,
		status,
		conflictDiff,
	] = await Promise.all([
		execOrThrow(exec, [args.git, "rev-parse", "HEAD"], {
			cwd: args.worktree,
		}).then((value) => value.trim()),
		execOrThrow(exec, [args.git, "rev-parse", "--verify", "REBASE_HEAD"], {
			cwd: args.worktree,
		}).then((value) => value.trim()),
		execOrThrow(
			exec,
			[
				args.git,
				"show",
				"-s",
				"--format=%H%nAuthor: %an <%ae>%nAuthor-Date: %aI%nSubject: %s%n%n%B",
				"REBASE_HEAD",
			],
			{ cwd: args.worktree },
		).then((value) => value.slice(0, 12_000)),
		unmergedFiles(exec, args),
		execOrThrow(exec, [args.git, "diff", "--cached", "--name-only", "-z"], {
			cwd: args.worktree,
		}).then(splitNul),
		execOrThrow(exec, [args.git, "ls-files", "-u"], {
			cwd: args.worktree,
		}).then((value) => value.slice(0, 12_000)),
		execOrThrow(
			exec,
			[args.git, "status", "--short", "--branch", "--untracked-files=all"],
			{ cwd: args.worktree },
		).then((value) => value.slice(0, 12_000)),
		execOrThrow(exec, [args.git, "diff", "--cc", "--no-ext-diff", "--"], {
			cwd: args.worktree,
		}).then((value) => value.slice(0, 30_000)),
	]);
	const protectedStagedFiles = stagedFilesBeforeResolution.filter(
		(file) => !conflictedFiles.includes(file),
	);
	const protectedIndexEntriesBeforeResolution =
		protectedStagedFiles.length === 0
			? ""
			: await execOrThrow(
					exec,
					[args.git, "ls-files", "--stage", "-z", "--", ...protectedStagedFiles],
					{ cwd: args.worktree },
				);
	return {
		attempt,
		branch: args.branch,
		baseBranch: args.baseBranch,
		originalHead,
		currentHead,
		rebasingCommit,
		rebasingCommitDetails,
		conflictedFiles,
		stagedFilesBeforeResolution,
		unmergedIndex,
		protectedIndexEntriesBeforeResolution,
		status,
		conflictDiff,
		gitError: gitError.slice(0, 4000),
	};
}

async function assertResolutionReady(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree" | "branch" | "baseBranch">,
	resolution: Extract<RebaseConflictResolution, { disposition: "resolved" }>,
	conflict: RebaseConflictContext,
): Promise<void> {
	const [
		state,
		unmerged,
		artifacts,
		markers,
		unstaged,
		staged,
		head,
		currentUnmergedIndex,
		currentStatus,
	] = await Promise.all([
		rebaseStateResidue(exec, args),
		unmergedFiles(exec, args),
		listedArtifactPaths(exec, args, true),
		conflictMarkerMatches(exec, args),
		execOrThrow(exec, [args.git, "diff", "--name-only", "-z"], {
			cwd: args.worktree,
		}).then(splitNul),
		execOrThrow(exec, [args.git, "diff", "--cached", "--name-only", "-z"], {
			cwd: args.worktree,
		}).then(splitNul),
		execOrThrow(exec, [args.git, "rev-parse", "HEAD"], {
			cwd: args.worktree,
		}).then((value) => value.trim()),
		execOrThrow(exec, [args.git, "ls-files", "-u"], {
			cwd: args.worktree,
		}).then((value) => value.slice(0, 12_000)),
		execOrThrow(
			exec,
			[args.git, "status", "--short", "--branch", "--untracked-files=all"],
			{ cwd: args.worktree },
		).then((value) => value.slice(0, 12_000)),
	]);
	const problems: string[] = [];
	const protectedStagedFiles = conflict.stagedFilesBeforeResolution.filter(
		(file) => !conflict.conflictedFiles.includes(file),
	);
	const protectedIndexEntries =
		protectedStagedFiles.length === 0
			? ""
			: await execOrThrow(
					exec,
					[args.git, "ls-files", "--stage", "-z", "--", ...protectedStagedFiles],
					{ cwd: args.worktree },
				);
	if (state.length === 0) {
		problems.push("resolver ended or removed the rebase operation");
	}
	if (head !== conflict.currentHead) {
		problems.push(
			`resolver moved HEAD from ${conflict.currentHead} to ${head}; only the publisher may continue or commit`,
		);
	}
	if (artifacts.length > 0) {
		problems.push(`artifact files remain: ${artifacts.join(", ")}`);
	}
	if (resolution.strategy === "continue") {
		if (unmerged.length > 0) {
			problems.push(`unmerged files remain: ${unmerged.join(", ")}`);
		}
		if (markers !== "") {
			problems.push(`conflict markers remain: ${markers.slice(0, 1000)}`);
		}
		if (unstaged.length > 0) {
			problems.push(`resolved edits were not staged: ${unstaged.join(", ")}`);
		}
		if (staged.length === 0) {
			problems.push("continue resolution has no staged semantic change");
		}
		const allowedStaged = new Set([
			...conflict.stagedFilesBeforeResolution,
			...conflict.conflictedFiles,
		]);
		const unexpectedStaged = staged.filter((file) => !allowedStaged.has(file));
		if (unexpectedStaged.length > 0) {
			problems.push(
				`resolver staged paths outside the halted commit: ${unexpectedStaged.join(", ")}`,
			);
		}
	} else {
		if (currentUnmergedIndex !== conflict.unmergedIndex) {
			problems.push("drop resolution changed the halted commit's unmerged index");
		}
		if (currentStatus !== conflict.status) {
			problems.push("drop resolution changed the halted conflict worktree");
		}
	}
	if (protectedIndexEntries !== conflict.protectedIndexEntriesBeforeResolution) {
		problems.push(
			"resolver modified a non-conflicting path already staged by the halted commit",
		);
	}
	if (problems.length > 0) {
		throw new Error(
			`[escalate] rebase conflict resolver did not produce a safe resolution: ${problems.join("; ")}`,
		);
	}
}

export async function resolveActiveRebaseConflict(
	exec: ExecFn,
	args: Pick<BoundedRebaseArgs, "git" | "worktree" | "branch" | "baseBranch">,
	originalHead: string,
	attempt: number,
	gitError: string,
	resolveConflict?: RebaseConflictResolver,
): Promise<{
	conflict: RebaseConflictContext;
	resolution: Extract<RebaseConflictResolution, { disposition: "resolved" }>;
}> {
	const conflict = await captureConflictContext(
		exec,
		args,
		originalHead,
		attempt,
		gitError,
	);
	if (resolveConflict === undefined) {
		throw new Error(
			`[escalate] rebase conflict requires an agent seat; deterministic publisher ` +
				`will not choose ours/theirs. Conflict context: ${JSON.stringify(conflict)}`,
		);
	}
	const resolution = rebaseConflictResolutionSchema.parse(
		await resolveConflict(conflict),
	);
	if (resolution.disposition === "decision") {
		throw new RebaseDecisionRequired(conflict, resolution);
	}
	await assertResolutionReady(exec, args, resolution, conflict);
	return { conflict, resolution };
}
export function rebaseConflictPrompt(args: {
	worktree: string;
	originalEffortContext: unknown;
	prContext: unknown;
	trigger: unknown;
	conflict: RebaseConflictContext;
}): string {
	return [
		"You are the judgment seat for an ACTIVE git rebase conflict.",
		`Worktree: ${args.worktree}`,
		"",
		"Original effort context:",
		JSON.stringify(args.originalEffortContext, null, 2),
		"",
		"PR context:",
		JSON.stringify(args.prContext, null, 2),
		"",
		"Trigger payload:",
		JSON.stringify(args.trigger, null, 2),
		"",
		"Exact conflict context:",
		JSON.stringify(args.conflict, null, 2),
		"",
		"Inspect the real worktree, the base-side code, the rebasing commit, callers, and relevant tests.",
		"Resolve only when the intended combined behavior is supported by that evidence.",
		"Never blind-take a side: do not use checkout/restore --ours or --theirs, or an ours/theirs merge strategy.",
		"Never run rebase --continue/--skip/--abort, commit, push, comment, approve, stamp, or merge.",
		"For a semantic resolution, edit the conflicted tracked files, remove every marker and .orig/.rej file,",
		"and git add -- only the resolved paths. Return disposition=resolved, strategy=continue, and a concise summary.",
		"If the rebasing commit is fully superseded and should deliberately disappear, leave no staged/unstaged changes",
		"and return disposition=resolved, strategy=drop with the evidence in the summary.",
		"If product/design intent is genuinely ambiguous, do not guess. Return disposition=decision with the exact",
		"captain question and a concise summary. The deterministic publisher retains all rebase and push authority.",
	].join("\n");
}

export async function wakeRebaseConflictSeat(
	agent: Pick<AgentLike, "generate">,
	args: {
		worktree: string;
		originalEffortContext: unknown;
		prContext: unknown;
		trigger: unknown;
		conflict: RebaseConflictContext;
		taskContext: {
			runId: string;
			nodeId: string;
			iteration: number;
			attempt: number;
		};
	},
): Promise<RebaseConflictResolution> {
	const generated = await agent.generate({
		prompt: rebaseConflictPrompt(args),
		outputSchema: rebaseConflictResolutionSchema,
		taskContext: args.taskContext,
	});
	const { output } = conflictSeatResultSchema.parse(generated);
	return rebaseConflictResolutionSchema.parse(output);
}

/** Rebase a non-mergeable PR branch and publish it without changing its PR. */
export async function rebaseAndPush(
	exec: ExecFn,
	args: BoundedRebaseArgs & {
		testCommand?: string;
		resolveConflict?: RebaseConflictResolver;
	},
): Promise<string[]> {
	const run = (command: string[]) =>
		execOrThrow(exec, command, { cwd: args.worktree });
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
		run([args.git, "rev-parse", `origin/${args.branch}`]).then((value) =>
			value.trim()
		),
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
	await assertCleanRebaseState(exec, args, localHead);
	const trustedAncestor = await exec(
		[args.git, "merge-base", "--is-ancestor", args.expectedRemoteHead, localHead],
		{ cwd: args.worktree },
	);
	if (trustedAncestor.code !== 0) {
		throw new Error(
			`[escalate] rebase baseline: trusted PR head ${args.expectedRemoteHead} ` +
				`is not an ancestor of local HEAD ${localHead}.`,
		);
	}
	const outgoingMerges = (
		await run([
			args.git,
			"rev-list",
			"--merges",
			`origin/${args.baseBranch}..${localHead}`,
		])
	).trim();
	if (outgoingMerges !== "") {
		throw new Error(
			`[escalate] rebase baseline: merge commits are not supported in the PR/run range because ` +
				`flattening can discard merge-resolution content: ${outgoingMerges}.`,
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

	let published = false;
	try {
		let rebaseResult = await exec(
			[
				args.git,
				"-c",
				"rebase.autoStash=false",
				"rebase",
				"--merge",
				"--no-keep-empty",
				"--empty=drop",
				`origin/${args.baseBranch}`,
			],
			{ cwd: args.worktree },
		);
		const resolvedConflictCommits: string[] = [];
		let attempt = 0;
		while (rebaseResult.code !== 0) {
			const state = await rebaseStateResidue(exec, args);
			const unmerged = await unmergedFiles(exec, args);
			if (state.length === 0 || unmerged.length === 0) {
				throw commandError(
					[args.git, "rebase", `origin/${args.baseBranch}`],
					rebaseResult.code,
					rebaseResult.stderr,
				);
			}
			attempt += 1;
			const { conflict, resolution } = await resolveActiveRebaseConflict(
				exec,
				args,
				localHead,
				attempt,
				rebaseResult.stderr,
				args.resolveConflict,
			);
			const nextCommand =
				resolution.strategy === "drop"
					? [args.git, "rebase", "--skip"]
					: [
							args.git,
							"-c",
							"core.editor=true",
							"rebase",
							"--continue",
						];
			rebaseResult = await exec(nextCommand, { cwd: args.worktree });
			if (resolution.strategy === "continue") {
				const replayedCommits = await commitIds(
					exec,
					args,
					`${conflict.currentHead}..HEAD`,
				);
				const resolvedCommit = replayedCommits[0];
				if (resolvedCommit === undefined) {
					throw new Error(
						`[escalate] rebase continued ${conflict.rebasingCommit} without producing its resolved commit.`,
					);
				}
				const [originalAuthorship, replayedAuthorship] = await Promise.all([
					execOrThrow(
						exec,
						[
							args.git,
							"show",
							"-s",
							"--format=%an%x1f%ae%x1f%aI%x1f%B",
							conflict.rebasingCommit,
						],
						{ cwd: args.worktree },
					),
					execOrThrow(
						exec,
						[
							args.git,
							"show",
							"-s",
							"--format=%an%x1f%ae%x1f%aI%x1f%B",
							resolvedCommit,
						],
						{ cwd: args.worktree },
					),
				]);
				if (replayedAuthorship !== originalAuthorship) {
					throw new Error(
						`[escalate] resolved rebase commit ${resolvedCommit} lost authorship or message provenance from ${conflict.rebasingCommit}.`,
					);
				}
				resolvedConflictCommits.push(resolvedCommit);
			}
			actions.push(
				`agent resolved rebase conflict ${attempt} at ${conflict.rebasingCommit.slice(0, 12)} ` +
					`with ${resolution.strategy}: ${resolution.summary}`,
			);
		}
		await clearCompletedRebaseMetadata(exec, args);
		actions.push(`rebased ${args.branch}`);
		await assertCleanRebaseState(exec, args);
		await runRebaseTests(exec, args.worktree, args.testCommand);
		actions.push("tests passed after rebase");
		await assertCleanRebaseState(exec, args);
		await assertBoundedRebase(exec, args, resolvedConflictCommits);
		actions.push("bounded rebase verified");
		await run([
			args.git,
			"push",
			`--force-with-lease=${args.branch}:${args.expectedRemoteHead}`,
			"origin",
			`${args.branch}:${args.branch}`,
		]);
		published = true;
		actions.push(`force-with-lease pushed ${args.branch}`);
		try {
			await assertCleanRebaseState(exec, args);
		} catch (residueCause) {
			const publishedHead = (
				await execOrThrow(exec, [args.git, "rev-parse", `refs/heads/${args.branch}`], {
					cwd: args.worktree,
				})
			).trim();
			try {
				await restoreOriginalBranch(exec, args, publishedHead);
			} catch (cleanupCause) {
				throw new AggregateError(
					[residueCause, cleanupCause],
					`published rebase left residue and cleanup could not restore ${args.branch}@${publishedHead}`,
				);
			}
			actions.push("cleaned post-push worktree residue");
		}
		return actions;
	} catch (cause) {
		if (!published) {
			try {
				await restoreOriginalBranch(exec, args, localHead);
			} catch (cleanupCause) {
				throw new AggregateError(
					[cause, cleanupCause],
					`rebase failed and cleanup could not restore ${args.branch}@${localHead}`,
				);
			}
		}
		throw cause;
	}
}

/**
 * Workflow-facing entry point: unlike the low-level publisher, a live
 * pipeline rebase cannot be constructed without a judgment-seat resolver.
 */
export async function rebaseAndPushAgentic(
	exec: ExecFn,
	args: BoundedRebaseArgs & {
		testCommand?: string;
		resolveConflict: RebaseConflictResolver;
	},
): Promise<string[]> {
	return rebaseAndPush(exec, args);
}
