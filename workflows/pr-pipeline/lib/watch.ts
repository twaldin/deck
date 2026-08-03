/**
 * watch-ci-review loop: machine-checked exit condition (SOP stage 4).
 *
 * Exit requires: zero unresolved review threads + all actionable comments
 * answered + reviewers re-requested after changes (verified via the
 * requested_reviewers list - GH review requests silently no-op) + CI
 * green. Pending or absent CI stays in the persisted Smithers poll loop. It
 * never starts an agent.
 */

import type {
	CheckRun,
	CiState,
	CommentActivity,
	ReviewerActivity,
	WatchExitVerdict,
	WatchSnapshot,
} from "./types.ts";

/** Map raw check runs to a single CI assessment. */
export function needsRebase(snapshot: Pick<WatchSnapshot, "behindBy" | "mergeable" | "mergeStateStatus">): boolean {
	return snapshot.behindBy > 0 || snapshot.mergeable === "CONFLICTING" || ["DIRTY", "BEHIND"].includes(snapshot.mergeStateStatus.toUpperCase());
}

export function assessCi(checkRuns: CheckRun[]): CiState {
	if (checkRuns.length === 0) return "none";
	let pending = false;
	for (const run of checkRuns) {
		if (run.status !== "completed") {
			pending = true;
			continue;
		}
		const conclusion = (run.conclusion ?? "").toLowerCase();
		if (conclusion === "failure" || conclusion === "timed_out") return "red";
		if (conclusion !== "cancelled") continue;

		const workflow = run.workflowName ?? run.name;
		const newest = checkRuns
			.filter((candidate) => candidate.status === "completed" && (candidate.workflowName ?? candidate.name) === workflow)
			.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
		const newestConclusion = (newest?.conclusion ?? "").toLowerCase();
		if (newestConclusion !== "success" && newestConclusion !== "skipped") return "red";
	}
	return pending ? "will-be-green" : "green";
}

/**
 * Reviewers whose last activity predates the last push and who are not
 * currently in requested_reviewers: these are the silent no-ops the SOP
 * calls out. Bots and reviewers whose latest state is APPROVED after the
 * push are excluded.
 */
export function reviewersNeedingReRequest(
	reviewers: ReviewerActivity[],
	requestedReviewers: string[],
	lastPushAt: string,
	selfLogins: string[] = [],
): string[] {
	const requested = new Set(requestedReviewers.map((login) => login.toLowerCase()));
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	const out: string[] = [];
	for (const reviewer of reviewers) {
		const login = reviewer.login.toLowerCase();
		if (reviewer.isBot || self.has(login)) continue;
		// A review decision is authoritative even when it predates the last push.
		// CHANGES_REQUESTED must enter the response loop immediately; approval
		// polling here was the cause of PRs being parked while blockers remained.
		if (reviewer.lastReviewState === "CHANGES_REQUESTED") {
			// A stale changes request is still a blocker, even when the reviewer
			// already appears in requested_reviewers. Enter the response loop;
			// waiting here can park the run without answering the finding.
			if (reviewer.lastActivityAt < lastPushAt || !requested.has(login)) out.push(reviewer.login);
			continue;
		}
		if (requested.has(login)) continue;
		// Activity after the last push means they have seen the current head.
		if (reviewer.lastActivityAt >= lastPushAt) continue;
		out.push(reviewer.login);
	}
	return out;
}

/**
 * Return false only for verified automation banners. Human comments and unknown
 * bot comments remain actionable, even when their wording contains banner
 * keywords.
 */
export function isReviewFinding(comment: CommentActivity): boolean {
	if (!comment.isBot) return true;
	const author = comment.author.trim().toLowerCase();
	const body = (comment.body ?? "").trim();
	if (author !== "linear[bot]") return true;
	return !/^<!--\s*linear-linkback\s*-->\s*$/i.test(body);
}

export function unansweredComments(
	comments: CommentActivity[],
	selfLogins: string[],
	lastPushAt: string,
): number {
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	let ourLatest = lastPushAt;
	for (const comment of comments) {
		if (self.has(comment.author.toLowerCase()) && comment.createdAt > ourLatest) {
			ourLatest = comment.createdAt;
		}
	}
	let count = 0;
	for (const comment of comments) {
		if (self.has(comment.author.toLowerCase()) || !isReviewFinding(comment)) continue;
		if (comment.createdAt > ourLatest) count++;
	}
	return count;
}

export interface WatchExitOptions {
	selfLogins: string[];
}

/** The machine-checked exit condition for the watch-ci-review loop. */
export function evaluateWatchExit(snapshot: WatchSnapshot, options: WatchExitOptions): WatchExitVerdict {
	const reasons: string[] = [];
	// behindBy is authoritative. GitHub can report BLOCKED while checks are green;
	// that state must rebase before any review or approval work.
	const needsRebaseNow = needsRebase(snapshot);
	if (needsRebaseNow) reasons.push("PR is out of date or not mergeable; needs rebase onto its base branch.");
	const unresolved = snapshot.threads.filter((thread) => !thread.isResolved).length;
	if (unresolved > 0) reasons.push(`${unresolved} unresolved review thread(s).`);

	const unanswered = unansweredComments(snapshot.comments, options.selfLogins, snapshot.lastPushAt);
	if (unanswered > 0) reasons.push(`${unanswered} actionable comment(s) not yet answered.`);

	const needReRequest = reviewersNeedingReRequest(
		snapshot.reviewers,
		snapshot.requestedReviewers,
		snapshot.lastPushAt,
		options.selfLogins,
	);
	const changesRequested = snapshot.reviewers
		.filter((reviewer) => !reviewer.isBot && !options.selfLogins.some((login) => login.toLowerCase() === reviewer.login.toLowerCase()) && reviewer.lastReviewState === "CHANGES_REQUESTED")
		.map((reviewer) => reviewer.login);
	const awaitingReview = snapshot.reviewers
		.filter((reviewer) => changesRequested.includes(reviewer.login) && reviewer.lastActivityAt >= snapshot.lastPushAt && snapshot.requestedReviewers.some((login) => login.toLowerCase() === reviewer.login.toLowerCase()))
		.map((reviewer) => reviewer.login);
	if (needReRequest.length > 0) {
		reasons.push(
			`reviewer(s) need a response cycle (requested_reviewers check): ${needReRequest.join(", ")}.`,
		);
	}
	if (awaitingReview.length > 0) reasons.push(`waiting for reviewer re-review: ${awaitingReview.join(", ")}.`);

	const ci = assessCi(snapshot.checkRuns);
	if (snapshot.behindBy > 0) reasons.unshift(`PR is ${snapshot.behindBy} commit(s) behind base; update branch first.`);
	if (ci === "red") reasons.push("CI has hard-red check runs (agent-fixable class first).");
	if (ci === "will-be-green") reasons.push("CI is still running; Smithers will poll again.");
	if (ci === "none") reasons.push("CI has not reported checks; Smithers will poll again.");

	const actionable = needsRebaseNow || unresolved > 0 || unanswered > 0 || needReRequest.length > 0 || ci === "red";
	const exitOk = !actionable && awaitingReview.length === 0 && ci === "green";
	if (!actionable && awaitingReview.length === 0 && ci === "green") reasons.push("CI is green; watch remains active to keep the PR mergeable while approval is pending.");
	const disposition = exitOk ? "complete" : actionable ? "fix" : "wait";

	return {
		exitOk,
		disposition,
		unresolvedThreads: unresolved,
		unansweredComments: unanswered,
		reviewersNeedingReRequest: needReRequest,
		ci,
		reasons,
		actionable,
		reviewersWithChangesRequested: changesRequested,
		rebaseRequired: needsRebaseNow,
	};
}
