/**
 * Existing-stack adoption: validate a declared ordered PR chain against live
 * GitHub state, restack behind or conflicting children parent-first, and merge
 * parent-first with squash-landing verification. Every function takes an
 * injected exec so each path is unit-testable without network access.
 */
import { execOrThrow, type ExecFn } from "../../pr-pipeline/lib/gh.ts";
import { findLandingCommit } from "../../pr-pipeline/lib/landing.ts";
import { runMerge } from "../../pr-pipeline/lib/merge.ts";
import type { PollResult, StackPr } from "./poll.ts";

export interface AdoptedPrSpec {
	number: number;
	head: string;
	base: string;
}

export interface AdoptedPrLive {
	number: number;
	url: string;
	state: string;
	merged: boolean;
	draft: boolean;
	headRefName: string;
	headSha: string;
	baseRefName: string;
	headRepoFullName: string;
}

export interface ValidatedAdoptedPr extends AdoptedPrSpec {
	url: string;
	headSha: string;
	landed: boolean;
}

export async function fetchAdoptedPrs(exec: ExecFn, repo: string, numbers: number[], gh = "gh"): Promise<AdoptedPrLive[]> {
	const live: AdoptedPrLive[] = [];
	for (const number of numbers) {
		const result = await exec([gh, "api", `repos/${repo}/pulls/${number}`]);
		if (result.code !== 0) {
			throw new Error(`[escalate] cannot adopt PR #${number}: it does not exist in ${repo} or is unreadable: ${result.stderr.slice(0, 500)}`);
		}
		const pr = JSON.parse(result.stdout) as Record<string, unknown>;
		const head = pr.head as Record<string, unknown> | undefined;
		const base = pr.base as Record<string, unknown> | undefined;
		live.push({
			number,
			url: String(pr.html_url ?? `https://github.com/${repo}/pull/${number}`),
			state: String(pr.state ?? "unknown"),
			merged: pr.merged === true,
			draft: pr.draft === true,
			headRefName: String(head?.ref ?? ""),
			headSha: String(head?.sha ?? ""),
			baseRefName: String(base?.ref ?? ""),
			headRepoFullName: String((head?.repo as Record<string, unknown> | undefined)?.full_name ?? ""),
		});
	}
	return live;
}

/**
 * Conservative ref charset. Declared branch names flow into git argv and into
 * a review agent's shell command, so anything shell-active is rejected.
 */
const safeRef = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** The declared chain must be parent-first: each PR's base is the previous PR's head. */
export function assertDeclaredChain(baseBranch: string, declared: AdoptedPrSpec[]): void {
	if (declared.length === 0) throw new Error("[escalate] adoption needs at least one PR.");
	if (!safeRef.test(baseBranch)) throw new Error(`[escalate] unsafe base branch name "${baseBranch}".`);
	const seen = new Set<number>();
	declared.forEach((pr, index) => {
		if (!safeRef.test(pr.head) || !safeRef.test(pr.base)) throw new Error(`[escalate] PR #${pr.number} has an unsafe branch name.`);
		if (seen.has(pr.number)) throw new Error(`[escalate] PR #${pr.number} appears twice in the declared stack.`);
		seen.add(pr.number);
		const expectedBase = index === 0 ? baseBranch : declared[index - 1].head;
		if (pr.base !== expectedBase) {
			throw new Error(`[escalate] declared chain is broken at PR #${pr.number}: base is "${pr.base}" but the parent chain expects "${expectedBase}".`);
		}
	});
}

/** Validate every declared PR against live GitHub state. Throws [escalate] on any mismatch. */
export function validateAdoptedStack(repo: string, baseBranch: string, declared: AdoptedPrSpec[], live: AdoptedPrLive[]): ValidatedAdoptedPr[] {
	assertDeclaredChain(baseBranch, declared);
	let unlandedSeen = false;
	return declared.map((spec, index) => {
		const pr = live.find((row) => row.number === spec.number);
		const label = `PR #${spec.number}`;
		if (!pr) throw new Error(`[escalate] cannot adopt ${label}: no live PR data.`);
		if (!pr.merged && pr.state !== "open") {
			throw new Error(`[escalate] cannot adopt ${label}: state is "${pr.state}" and it is not merged.`);
		}
		if (pr.merged && unlandedSeen) {
			throw new Error(`[escalate] cannot adopt ${label}: a landed PR appears above an unlanded parent.`);
		}
		if (!pr.merged) unlandedSeen = true;
		if (!pr.merged && pr.draft) {
			throw new Error(`[escalate] cannot adopt ${label}: it is a draft — the merge would fail, so mark it ready for review first.`);
		}
		if (pr.headRepoFullName.toLowerCase() !== repo.toLowerCase()) {
			throw new Error(`[escalate] cannot adopt ${label}: its head lives in "${pr.headRepoFullName}", not "${repo}".`);
		}
		if (pr.headRefName !== spec.head) {
			throw new Error(`[escalate] cannot adopt ${label}: head branch is "${pr.headRefName}" but the stack declares "${spec.head}".`);
		}
		if (!pr.merged) {
			// A landed parent retargets this PR to the nearest unlanded ancestor.
			const allowed = new Set([spec.base]);
			let cursor = index - 1;
			while (cursor >= 0 && live.find((row) => row.number === declared[cursor].number)?.merged === true) cursor -= 1;
			allowed.add(cursor >= 0 ? declared[cursor].head : baseBranch);
			if (!allowed.has(pr.baseRefName)) {
				throw new Error(`[escalate] cannot adopt ${label}: base is "${pr.baseRefName}" but the declared chain expects one of ${[...allowed].map((name) => `"${name}"`).join(", ")}.`);
			}
		}
		return { ...spec, url: pr.url, headSha: pr.headSha, landed: pr.merged };
	});
}

/** Rebase only the flagged PRs, parent-first, so up-to-date PRs keep their GitHub approvals. */
export async function restackAdoptedPrs(
	exec: ExecFn,
	args: { git?: string; worktree: string; prs: AdoptedPrSpec[]; needsRebase: number[] },
): Promise<{ actions: string[]; conflicts: string[] }> {
	const git = args.git ?? "git";
	const flagged = new Set(args.needsRebase);
	const actions: string[] = [];
	const conflicts: string[] = [];
	if (flagged.size === 0) return { actions, conflicts };
	const run = (argv: string[]) => execOrThrow(exec, argv, { cwd: args.worktree });
	await run([git, "fetch", "origin"]);
	const updatedLocally = new Set<string>();
	const conflictedLineage = new Set<string>();
	for (const pr of args.prs) {
		// A descendant of a conflicted parent must not rebase onto the stale
		// parent; force-pushing it would discard its approval for nothing.
		if (conflictedLineage.has(pr.base)) {
			conflictedLineage.add(pr.head);
			if (flagged.has(pr.number)) conflicts.push(`PR #${pr.number} (${pr.head}) skipped: its base ${pr.base} did not rebase`);
			continue;
		}
		const parentChanged = updatedLocally.has(pr.base);
		if (!flagged.has(pr.number) && !parentChanged) continue;
		const baseRef = parentChanged ? pr.base : `origin/${pr.base}`;
		await run([git, "checkout", "-B", pr.head, `origin/${pr.head}`]);
		const rebase = await exec([git, "rebase", baseRef], { cwd: args.worktree });
		if (rebase.code !== 0) {
			await exec([git, "rebase", "--abort"], { cwd: args.worktree });
			conflicts.push(`PR #${pr.number} (${pr.head}) conflicts with ${baseRef}`);
			conflictedLineage.add(pr.head);
			continue;
		}
		try {
			await run([git, "push", "--force-with-lease", "origin", `${pr.head}:${pr.head}`]);
		} catch (error) {
			conflicts.push(`PR #${pr.number} (${pr.head}) push was rejected: ${error instanceof Error ? error.message : String(error)}`);
			conflictedLineage.add(pr.head);
			continue;
		}
		updatedLocally.add(pr.head);
		actions.push(`rebased ${pr.head} onto ${baseRef} and pushed with lease`);
	}
	return { actions, conflicts };
}

/** Approval evidence: every PR URL, head SHA, state, and the local validation receipt. */
export function adoptionApprovalSummary(prs: StackPr[], receiptPath: string): string {
	const lines = prs.map((pr) => [
		`PR #${pr.number} ${pr.url}`,
		`  head ${pr.headSha}; state: ${pr.merged ? "LANDED" : pr.state.toUpperCase()}; CI: ${pr.ci}; review: ${pr.reviewState}; mergeability: ${pr.mergeable ? "MERGEABLE" : "NOT MERGEABLE"} (${pr.mergeStateStatus})`,
	].join("\n"));
	return `${lines.join("\n")}\nLocal validation receipt: ${receiptPath}`;
}

/** Recheck the whole stack, then merge parent-first and verify each squash commit "(#N)" on the actual base. */
export async function mergeAdoptedStack(args: {
	exec: ExecFn;
	gh: string;
	repo: string;
	worktree: string;
	baseBranch: string;
	prs: AdoptedPrSpec[];
	poll: () => Promise<PollResult>;
	/** Head SHAs the human saw in the approval gate; any drift stops the merge. */
	approved?: Array<{ number: number; headSha: string }>;
	wait?: (ms: number) => Promise<void>;
	attempts?: number;
	waitMs?: number;
}): Promise<string[]> {
	const wait = args.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = args.attempts ?? 40;
	const waitMs = args.waitMs ?? 15_000;
	const verified = await args.poll();
	if (verified.signal !== "complete") throw new Error(`stack changed after approval: ${verified.reason}`);
	for (const snapshot of args.approved ?? []) {
		const current = verified.prs.find((pr) => pr.number === snapshot.number);
		if (!current) throw new Error(`[escalate] PR #${snapshot.number} disappeared after approval.`);
		if (!current.merged && current.headSha !== snapshot.headSha) {
			throw new Error(`[escalate] PR #${snapshot.number} head moved from ${snapshot.headSha} to ${current.headSha} after approval; the captain approved a different diff.`);
		}
	}
	const landedBefore = new Set(verified.prs.filter((pr) => pr.merged).map((pr) => pr.number));
	let unlandedSeen = false;
	for (const pr of args.prs) {
		if (landedBefore.has(pr.number)) {
			if (unlandedSeen) throw new Error(`[escalate] PR #${pr.number} is landed above an unlanded parent.`);
			continue;
		}
		unlandedSeen = true;
	}
	const receipts: string[] = [];
	for (const pr of args.prs) {
		if (landedBefore.has(pr.number)) {
			receipts.push(`PR #${pr.number}: already landed`);
			continue;
		}
		// After a parent lands, merge each remaining child into the real stack
		// base. This prevents a child from landing only on its former parent ref.
		await execOrThrow(args.exec, [args.gh, "pr", "edit", String(pr.number), "--repo", args.repo, "--base", args.baseBranch], { cwd: args.worktree });
		await runMerge({ exec: args.exec, gh: args.gh, prNumber: pr.number, cwd: args.worktree, args: ["--auto", "--squash"] });
		let landing: { sha: string; base: string } | null = null;
		for (let attempt = 0; attempt < attempts && landing === null; attempt += 1) {
			if (attempt > 0) await wait(waitMs);
			const prJson = JSON.parse(await execOrThrow(args.exec, [args.gh, "api", `repos/${args.repo}/pulls/${pr.number}`])) as Record<string, unknown>;
			if (prJson.merged !== true) continue;
			const base = String((prJson.base as Record<string, unknown> | undefined)?.ref ?? pr.base);
			const commits = JSON.parse(await execOrThrow(args.exec, [args.gh, "api", `repos/${args.repo}/commits?sha=${encodeURIComponent(base)}&per_page=100`])) as Array<{ sha?: string; commit?: { message?: string } }>;
			const found = findLandingCommit(commits.map((commit) => ({ sha: String(commit.sha ?? ""), subject: String(commit.commit?.message ?? "").split("\n")[0] })), pr.number);
			if (found) landing = { sha: found.sha, base };
		}
		if (!landing) throw new Error(`[escalate] PR #${pr.number} merge not verified: no squash commit (#${pr.number}) found on its base. Landed so far: ${receipts.length > 0 ? receipts.join("; ") : "none"}.`);
		receipts.push(`PR #${pr.number}: squash ${landing.sha} landed on ${landing.base}`);
	}
	return receipts;
}
