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
export function assessCi(checkRuns: CheckRun[]): CiState {
	if (checkRuns.length === 0) return "none";
	let pending = false;
	for (const run of checkRuns) {
		if (run.status !== "completed") {
			pending = true;
			continue;
		}
		const conclusion = (run.conclusion ?? "").toLowerCase();
		if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") {
			return "red";
		}
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
		if (reviewer.isBot || self.has(login) || requested.has(login)) continue;
		// Activity after the last push means they have seen the current head.
		if (reviewer.lastActivityAt >= lastPushAt) {
			continue;
		}
		out.push(reviewer.login);
	}
	return out;
}

/**
 * Return false only for known automation banners. Human comments and unknown
 * bot comments remain actionable, even when their wording contains banner
 * keywords.
 */
export function isReviewFinding(comment: CommentActivity): boolean {
	if (!comment.isBot) return true;
	const author = comment.author.trim().toLowerCase();
	const body = (comment.body ?? "").trim();
	if (!/^(?:github merge queue-app|github merge queue|linear)\[bot\]$/.test(author)) return true;
	return !(
		/^###\s+GitHub merge queue Automations\b/i.test(body) ||
		/^<!--\s*linear-linkback\s*-->\s*$/i.test(body) ||
		/^(?:github merge queue|linear)\s+(?:banner|linkback):\s+generated\s+(?:link|banner)\.?$/i.test(body)
	);
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
	const needsRebase =
		snapshot.behindBy > 0 ||
		snapshot.mergeable === "CONFLICTING" ||
		["DIRTY", "BEHIND"].includes(snapshot.mergeStateStatus.toUpperCase());
	if (needsRebase) reasons.push("PR is out of date or not mergeable; needs rebase onto its base branch.");
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
	if (needReRequest.length > 0) {
		reasons.push(
			`reviewer(s) not re-requested after changes (requested_reviewers check): ${needReRequest.join(", ")}.`,
		);
	}

	const ci = assessCi(snapshot.checkRuns);
	if (snapshot.behindBy > 0) reasons.unshift(`PR is ${snapshot.behindBy} commit(s) behind base; update branch first.`);
	if (ci === "red") reasons.push("CI has hard-red check runs (agent-fixable class first).");
	if (ci === "will-be-green") reasons.push("CI is still running; Smithers will poll again.");
	if (ci === "none") reasons.push("CI has not reported checks; Smithers will poll again.");

	const actionable = needsRebase || unresolved > 0 || unanswered > 0 || needReRequest.length > 0 || ci === "red";
	const exitOk = !actionable && ci === "green";
	if (!actionable && ci === "green") reasons.push("CI is green; watch remains active to keep the PR mergeable while approval is pending.");
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
	};
}
