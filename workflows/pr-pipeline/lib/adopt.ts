/**
 * Adopt-path safety checks: an existing PR may only be adopted when the live
 * PR record AND the local worktree both match what the run declared. Pure and
 * unit-testable; the pipeline feeds it fetchPrOverview + local git state.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
	baseBranch: string; // base branch used by this run
	worktreeBranch: string; // git branch currently checked out in the worktree
	worktreeHead: string; // git rev-parse HEAD in the worktree
	worktreeStatus: string; // git status --porcelain output for the worktree
	worktreeOriginUrl: string; // git remote get-url origin for the worktree
	/** Local adversarial fixes may make the worktree a clean descendant of the PR head. */
	allowWorktreeAhead?: boolean;
	/** Result of git merge-base --is-ancestor when the heads differ. */
	worktreeIsDescendant?: boolean;
}

/** Extracts "owner/name" from a git remote URL (ssh, https, or git@ form); "" when unparseable. */
export function repoFromRemoteUrl(url: string): string {
	const match = /(?:[/:])([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? match[1] : "";
}

/** Throws [escalate] on any mismatch; returns void when the PR is adoptable. */
export const KNOWN_SCRATCH_FILES = [".deck-deps-failed", ".deck-deps-failed.log", ".husky/_"] as const;

/** Remove dependency and hook scratch files before checking adopt cleanliness. */
export function cleanKnownScratchFiles(worktree: string, remove: (file: string) => void = (file) => {
	fs.rmSync(file, { force: true, recursive: true });
}): void {
	for (const file of KNOWN_SCRATCH_FILES) remove(path.join(worktree, file));
}

/**
 * Reconcile an adopted PR to the base GitHub reports. `main` is the default
 * run base, so a stack child may replace it with its actual non-main base.
 * Two different non-main bases remain unsafe to reconcile.
 */
export function reconcileAdoptBaseBranch(declaredBaseBranch: string | undefined, actualBaseBranch: string): string {
	if (actualBaseBranch === "") {
		throw new Error("[escalate] cannot adopt PR: GitHub did not report a base branch.");
	}
	if (
		declaredBaseBranch === undefined ||
		declaredBaseBranch === actualBaseBranch ||
		declaredBaseBranch === "main" ||
		actualBaseBranch === "main"
	) {
		return actualBaseBranch;
	}
	throw new Error(
		`[escalate] cannot adopt PR: it targets base "${actualBaseBranch}" but the run declared baseBranch "${declaredBaseBranch}".`,
	);
}

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
			`[escalate] cannot adopt ${pr}: it targets base "${overview.baseRefName}" but this run uses baseBranch "${expected.baseBranch}" — landing verification and merge would act on the wrong base.`,
		);
	}
	if (expected.worktreeBranch !== expected.branch) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree has branch "${expected.worktreeBranch}" checked out, not "${expected.branch}" — the watch fixer and merge run in this worktree and would act on the wrong branch.`,
		);
	}
	if (expected.worktreeHead !== overview.headSha && expected.worktreeIsDescendant !== true) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: worktree HEAD is ${expected.worktreeHead} but the PR head is ${overview.headSha} — the worktree is stale or diverged; sync it to the PR head first.`,
		);
	}
	const worktreeRepo = repoFromRemoteUrl(expected.worktreeOriginUrl);
	if (worktreeRepo.toLowerCase() !== expected.repo.toLowerCase()) {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree origin is "${expected.worktreeOriginUrl}" (${worktreeRepo || "unparseable"}), not "${expected.repo}" — the watch fixer and merge run in this worktree and would push to the wrong repository.`,
		);
	}
	if (expected.worktreeStatus.trim() !== "") {
		throw new Error(
			`[escalate] cannot adopt ${pr}: the worktree is not clean:\n${expected.worktreeStatus.trim()}\n— the watch fixer commits in this worktree and would push these unrelated changes into the PR. Clean or stash them first.`,
		);
	}
}

export type AdoptPushDecision = "proceed" | "push" | "escalate";

/** Decides whether adopt may continue, or may safely overwrite the PR branch. */
export function decideAdoptPush(args: {
	worktreeHead: string;
	prHead: string;
	isAncestor: boolean;
}): AdoptPushDecision {
	if (args.worktreeHead === args.prHead) return "proceed";
	return args.isAncestor ? "push" : "escalate";
}
