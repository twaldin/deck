/**
 * Adopt-path safety checks: an existing PR may only be adopted when the live
 * PR record AND the local worktree both match what the run declared. Pure and
 * unit-testable; the pipeline feeds it fetchPrOverview + local git state.
 */

export interface PrOverview {
	number: number;
	url: string;
	state: string;
	draft: boolean;
	headRefName: string;
	headSha: string;
	baseRefName: string;
	headRepoFullName: string;
}

export interface AdoptExpectation {
	repo: string; // owner/name the run declared
	branch: string; // head branch the run declared
	baseBranch: string; // base branch the run declared
	worktreeBranch: string; // git branch currently checked out in the worktree
	worktreeHead: string; // git rev-parse HEAD in the worktree
}

/** Throws [escalate] on any mismatch; returns void when the PR is adoptable. */
export function assertAdoptable(overview: PrOverview, expected: AdoptExpectation): void {
	const pr = `PR #${overview.number}`;
	if (overview.state !== "open") {
		throw new Error(`[escalate] cannot adopt ${pr}: state is "${overview.state}", not open.`);
	}
	if (overview.draft) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: it is a draft — GitHub reports drafts as open, but the merge would fail because the PR is not ready for review. Mark it ready first.`,
		);
	}
	if (overview.headRepoFullName.toLowerCase() !== expected.repo.toLowerCase()) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: its head lives in "${overview.headRepoFullName}", not "${expected.repo}" — a fork PR cannot be updated by pushing to origin, so adopting it would fix the wrong branch.`,
		);
	}
	if (overview.headRefName !== expected.branch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: its head branch is "${overview.headRefName}" but the run was given branch "${expected.branch}" — adopting the wrong PR would watch/stamp the wrong diff.`,
		);
	}
	if (overview.baseRefName !== expected.baseBranch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: it targets base "${overview.baseRefName}" but the run declared baseBranch "${expected.baseBranch}" — landing verification and merge would act on the wrong base.`,
		);
	}
	if (expected.worktreeBranch !== expected.branch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree has branch "${expected.worktreeBranch}" checked out, not "${expected.branch}" — the watch fixer and merge run in this worktree and would act on the wrong branch.`,
		);
	}
	if (expected.worktreeHead !== overview.headSha) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: worktree HEAD is ${expected.worktreeHead} but the PR head is ${overview.headSha} — the worktree is stale or diverged; sync it to the PR head first.`,
		);
	}
}
