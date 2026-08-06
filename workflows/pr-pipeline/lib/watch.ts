/**
 * Step 4 watch truth and trigger selection.
 *
 * The poller gathers evidence; this module decides whether Smithers waits,
 * wakes a bounded seat, exits after both approval classes, or terminates with
 * a stated infrastructure/configuration escalation. An empty check rollup is
 * never inferred to be green.
 */

import type {
	CheckRun,
	CommitStatusEvidence,
	CiClassification,
	CiState,
	CommentActivity,
	ReviewerActivity,
	WatchExitVerdict,
	WatchSnapshot,
	WatchTrigger,
	WorkflowJobEvidence,
	WatchReviewPolicy,
} from "./types.ts";

export function observeHeadAge(
	headSha: string,
	previous: { headSha: string; headObservedAt?: string } | undefined,
	observedAt: string,
): { headObservedAt: string; ageSeconds: number } {
	const headObservedAt = previous?.headSha === headSha
		? previous.headObservedAt ?? observedAt
		: observedAt;
	const firstSeenMs = Date.parse(headObservedAt);
	const observedMs = Date.parse(observedAt);
	return {
		headObservedAt,
		ageSeconds: Number.isFinite(firstSeenMs) && Number.isFinite(observedMs)
			? Math.max(0, Math.floor((observedMs - firstSeenMs) / 1000))
			: 0,
	};
}


export function needsRebase(snapshot: Pick<WatchSnapshot, "mergeable" | "mergeStateStatus">): boolean {
	return snapshot.mergeable === "CONFLICTING"
		|| snapshot.mergeStateStatus.toUpperCase() === "DIRTY";
}

const SUCCESSFUL_CONCLUSIONS: Record<string, true> = {
	neutral: true,
	skipped: true,
	success: true,
};
const FAILED_CONCLUSIONS: Record<string, true> = {
	action_required: true,
	failure: true,
	stale: true,
	startup_failure: true,
	timed_out: true,
};
const ACTIVE_RUN_STATUSES: Record<string, true> = {
	in_progress: true,
	pending: true,
	queued: true,
	requested: true,
	waiting: true,
};

function checkWorkflow(run: CheckRun): string {
	return run.workflowName ?? run.name;
}

function cancelledCheckIsSuperseded(run: CheckRun, checkRuns: CheckRun[]): boolean {
	const workflow = checkWorkflow(run);
	return checkRuns.some((candidate) => {
		if (
			candidate === run
			|| candidate.name !== run.name
			|| checkWorkflow(candidate) !== workflow
			|| (
				run.appId !== undefined
				&& run.appId !== null
				&& candidate.appId !== undefined
				&& candidate.appId !== null
				&& candidate.appId !== run.appId
			)
			|| (
				run.headSha !== undefined
				&& candidate.headSha !== undefined
				&& candidate.headSha !== run.headSha
			)
		) return false;
		if (candidate.status !== "completed") return true;
		if (SUCCESSFUL_CONCLUSIONS[(candidate.conclusion ?? "").toLowerCase()] !== true) return false;
		if (run.completedAt === undefined || run.completedAt === null) return true;
		return (candidate.completedAt ?? "") > run.completedAt;
	});
}

export function failedCheckRuns(checkRuns: CheckRun[]): CheckRun[] {
	return checkRuns.filter((run) => {
		if (run.status !== "completed") return false;
		const conclusion = (run.conclusion ?? "").toLowerCase();
		if (FAILED_CONCLUSIONS[conclusion] === true) return true;
		return conclusion === "cancelled" && !cancelledCheckIsSuperseded(run, checkRuns);
	});
}

/** Coarse compatibility state; use classifyCiEvidence for watch decisions. */
export function assessCi(checkRuns: CheckRun[]): CiState {
	if (checkRuns.length === 0) return "none";
	if (failedCheckRuns(checkRuns).length > 0) return "red";
	if (checkRuns.some((run) => run.status !== "completed")) return "will-be-green";
	return "green";
}

export interface CiAssessment {
	classification: CiClassification;
	state: CiState;
	reason: string;
	terminalEscalation: boolean;
	failedChecks: CheckRun[];
	failedStatuses: CommitStatusEvidence[];
	infraRetryJobs: Array<{ runId: number; jobId: number; reason: string }>;
}

function ciAssessment(
	classification: CiClassification,
	state: CiState,
	reason: string,
	terminalEscalation = false,
	failedChecks: CheckRun[] = [],
	failedStatuses: CommitStatusEvidence[] = [],
	infraRetryJobs: Array<{ runId: number; jobId: number; reason: string }> = [],
): CiAssessment {
	return { classification, state, reason, terminalEscalation, failedChecks, failedStatuses, infraRetryJobs };
}
const INFRA_FAILURE = /failed to resolve action download info|service unavailable|runner (?:provisioning|registration)|image pull|network (?:error|timeout|unavailable)|lost communication with (?:the )?server|runner has received a shutdown signal|platform cancel/i;

function infraFailureReason(job: WorkflowJobEvidence): string | null {
	const log = job.logExcerpt ?? "";
	const marker = INFRA_FAILURE.exec(log)?.[0];
	if (marker !== undefined) return `setup/provider failure: ${marker}`;
	const failedSteps = (job.steps ?? []).filter((step) =>
		["failure", "cancelled", "timed_out"].includes((step.conclusion ?? "").toLowerCase())
	);
	const setupFailure = failedSteps.some((step) =>
		/^(set up job|initialize containers|prepare runner|request a runner)$/i.test(step.name.trim())
	);
	const executedWork = (job.steps ?? []).some((step) =>
		step.status === "completed"
		&& step.conclusion !== null
		&& !/^(set up job|initialize containers|prepare runner|request a runner|complete job)$/i.test(step.name.trim())
	);
	return setupFailure && !executedWork ? "setup failed before any job step executed" : null;
}

function retryableInfraJobs(
	snapshot: Pick<WatchSnapshot, "ciEvidence">,
	failedChecks: CheckRun[],
): Array<{ runId: number; jobId: number; reason: string }> {
	const evidence = snapshot.ciEvidence;
	if (evidence === undefined || failedChecks.length === 0) return [];
	const retries: Array<{ runId: number; jobId: number; reason: string }> = [];
	for (const check of failedChecks) {
		const run = evidence.currentRuns.find((candidate) =>
			check.checkSuiteId !== undefined
			&& check.checkSuiteId !== null
			&& candidate.checkSuiteId === check.checkSuiteId
		);
		if (run === undefined) return [];
		const failedJobs = run.jobs.filter((job) =>
			["failure", "cancelled", "timed_out"].includes((job.conclusion ?? "").toLowerCase())
		);
		const named = failedJobs.filter((job) =>
			job.name === check.name || check.name.endsWith(` / ${job.name}`)
		);
		const candidates = named.length > 0 ? named : failedJobs;
		if (candidates.length === 0) return [];
		for (const job of candidates) {
			const reason = infraFailureReason(job);
			if (reason === null) return [];
			retries.push({ runId: run.id, jobId: job.id, reason });
		}
	}
	return retries;
}

/**
 * Classify only evidence tied to the exact PR head. Required check runs must
 * match both the ruleset's App integration and a current workflow check suite;
 * an EXPECTED rollup placeholder is never an input to this function.
 */
export function classifyCiEvidence(
	snapshot: Pick<WatchSnapshot, "checkRuns" | "ciEvidence">,
): CiAssessment {

	const evidence = snapshot.ciEvidence;
	if (evidence === undefined) {
		const failed = failedCheckRuns(snapshot.checkRuns);
		if (failed.length > 0) {
			return ciAssessment(
				"TERMINAL_FAILURE",
				"red",
				"One or more exact-head check runs failed; read their logs before deciding whether to fix or rerun.",
				false,
				failed,
			);
		}
		if (snapshot.checkRuns.length === 0) {
			return ciAssessment(
				"NOT_TRIGGERED",
				"stuck",
				"Zero checks were observed and no branch-rules/workflow evidence was collected; CI configuration versus non-reporting cannot be proven, so this poll terminates for operator investigation.",
				true,
			);
		}
		const state = assessCi(snapshot.checkRuns);
		if (state === "will-be-green") {
			return ciAssessment("RUNNER_QUEUED", state, "Exact-head checks exist but have not all completed.");
		}
		return ciAssessment("TERMINAL_SUCCESS", "green", "All observed exact-head checks completed successfully.");
	}
	const failedStatuses = evidence.statuses.filter((status) =>
		["error", "failure"].includes(status.state.toLowerCase())
	);

	const currentSuiteIds = new Set(evidence.currentRuns.map((run) => run.checkSuiteId));
	type ObservedRequired =
		| { kind: "check"; check: CheckRun }
		| { kind: "status"; status: CommitStatusEvidence };
	const observedRequired: ObservedRequired[] = [];
	for (const required of evidence.requiredContexts) {
		const check = snapshot.checkRuns
			.filter((run) =>
				run.name === required.context
				&& run.checkSuiteId !== undefined
				&& run.checkSuiteId !== null
				&& currentSuiteIds.has(run.checkSuiteId)
				&& (required.integrationId === null || run.appId === required.integrationId)
			)
			.sort((a, b) =>
				(b.completedAt ?? b.startedAt ?? "").localeCompare(a.completedAt ?? a.startedAt ?? "")
				|| (b.id ?? 0) - (a.id ?? 0)
			)[0];
		if (check !== undefined) {
			observedRequired.push({ kind: "check", check });
			continue;
		}
		if (required.integrationId !== null) continue;
		const status = evidence.statuses
			.filter((candidate) => candidate.context === required.context)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)[0];
		if (status !== undefined) observedRequired.push({ kind: "status", status });
	}
	const failedRequiredChecks = observedRequired.flatMap((observed) => {
		if (observed.kind !== "check") return [];
		const check = observed.check;
		const sameRequiredContext = snapshot.checkRuns.filter((candidate) =>
			candidate.name === check.name
			&& candidate.checkSuiteId === check.checkSuiteId
			&& candidate.appId === check.appId
			&& (
				check.headSha === undefined
				|| candidate.headSha === undefined
				|| candidate.headSha === check.headSha
			)
		);
		return failedCheckRuns(sameRequiredContext).includes(check) ? [check] : [];
	});
	const failedRequiredStatuses = observedRequired.flatMap((observed) =>
		observed.kind === "status" && ["error", "failure"].includes(observed.status.state.toLowerCase())
			? [observed.status]
			: []
	);
	const requiredInfraRetries = failedRequiredStatuses.length === 0
		? retryableInfraJobs(snapshot, failedRequiredChecks)
		: [];
	if (requiredInfraRetries.length > 0) {
		return ciAssessment(
			"INFRA_RETRY",
			"will-be-green",
			"Required CI failed during setup/provider work before code validation ran; retry with bounded backoff.",
			false,
			[],
			[],
			requiredInfraRetries,
		);
	}
	if (failedRequiredChecks.length > 0 || failedRequiredStatuses.length > 0) {
		return ciAssessment(
			"TERMINAL_FAILURE",
			"red",
			"A required exact-head context failed.",
			false,
			failedRequiredChecks,
			failedRequiredStatuses,
		);
	}

	const requiredSucceeded =
		evidence.requiredContexts.length > 0
		&& observedRequired.length === evidence.requiredContexts.length
		&& observedRequired.every((observed) =>
			observed.kind === "check"
				? observed.check.status === "completed"
					&& SUCCESSFUL_CONCLUSIONS[(observed.check.conclusion ?? "").toLowerCase()] === true
				: observed.status.state.toLowerCase() === "success"
		);
	const runningRequired = observedRequired.some((observed) =>
		observed.kind === "check"
		&& observed.check.status === "in_progress"
		&& Boolean(observed.check.startedAt)
	);
	if (runningRequired) {
		return ciAssessment(
			"RUNNING",
			"will-be-green",
			"A required exact-head check has a real start timestamp and is running.",
		);
	}
	if (observedRequired.some((observed) =>
		observed.kind === "check"
			? (
				observed.check.status !== "completed"
				&& ACTIVE_RUN_STATUSES[observed.check.status.toLowerCase()] === true
			)
			: observed.status.state.toLowerCase() === "pending"
	)) {
		return ciAssessment(
			"RUNNER_QUEUED",
			"will-be-green",
			"A required exact-head context is queued; another push would discard valid work.",
		);
	}

	if (requiredSucceeded) {
		return ciAssessment(
			"TERMINAL_SUCCESS",
			"green",
			"Every required context matched the exact head, workflow suite, and App integration and completed successfully.",
		);
	}
	if (evidence.requiredContexts.length === 0) {
		const optionalFailures = failedCheckRuns(snapshot.checkRuns);
		const optionalInfraRetries = failedStatuses.length === 0
			? retryableInfraJobs(snapshot, optionalFailures)
			: [];
		if (optionalInfraRetries.length > 0) {
			return ciAssessment(
				"INFRA_RETRY",
				"will-be-green",
				"Observed CI failed during setup/provider work before code validation ran; retry with bounded backoff.",
				false,
				[],
				[],
				optionalInfraRetries,
			);
		}
		if (optionalFailures.length > 0 || failedStatuses.length > 0) {
			return ciAssessment(
				"TERMINAL_FAILURE",
				"red",
				"Observed exact-head CI failed on a branch with no required contexts.",
				false,
				optionalFailures,
				failedStatuses,
			);
		}
		if (snapshot.checkRuns.length > 0) {
			if (assessCi(snapshot.checkRuns) === "will-be-green") {
				return ciAssessment(
					"RUNNER_QUEUED",
					"will-be-green",
					"Optional exact-head checks are still materializing or running.",
				);
			}
			return ciAssessment(
				"TERMINAL_SUCCESS",
				"green",
				"No contexts are required for this branch, but every observed exact-head check completed successfully.",
			);
		}
		if (evidence.statuses.some((status) => status.state.toLowerCase() === "pending")) {
			return ciAssessment("RUNNER_QUEUED", "will-be-green", "An optional exact-head commit status is pending.");
		}
		if (evidence.statuses.length > 0) {
			return ciAssessment(
				"TERMINAL_SUCCESS",
				"green",
				"No contexts are required for this branch, but every observed exact-head commit status succeeded.",
			);
		}
	}

	const activeCurrentRuns = evidence.currentRuns.filter((run) => ACTIVE_RUN_STATUSES[run.status] === true);
	const activeStaleRuns = evidence.staleActiveRuns.filter((run) => ACTIVE_RUN_STATUSES[run.status] === true);
	const runningJobs = activeCurrentRuns.flatMap((run) => run.jobs)
		.filter((job) => job.status === "in_progress" && Boolean(job.startedAt));
	if (runningJobs.length > 0) {
		return ciAssessment(
			"RUNNING",
			"will-be-green",
			"Real exact-head workflow jobs have started and are running.",
		);
	}
	const queuedJobs = activeCurrentRuns.flatMap((run) => run.jobs)
		.filter((job) => ["pending", "queued", "waiting"].includes(job.status));
	if (queuedJobs.length > 0) {
		return ciAssessment(
			"RUNNER_QUEUED",
			"will-be-green",
			"Real exact-head workflow jobs are queued; another push would discard valid work.",
		);
	}
	if (activeCurrentRuns.length > 0) {
		const jobless = activeCurrentRuns.every((run) => run.jobs.length === 0);
		if (evidence.currentHeadAgeSeconds <= evidence.graceSeconds) {
			return ciAssessment(
				"STARTING",
				"will-be-green",
				`An exact-head workflow exists inside the ${evidence.graceSeconds}s materialization window; poll without calling it running.`,
			);
		}
		if (jobless && activeStaleRuns.length > 0) {
			return ciAssessment(
				"STALE_RUN_BLOCKED",
				"stuck",
				"An exact-head jobless run is blocked behind active obsolete-SHA workflow runs.",
				true,
			);
		}
		return ciAssessment(
			"EXPECTED_STUCK",
			"stuck",
			"Required contexts did not materialize before the grace period expired.",
			true,
		);
	}

	if (evidence.currentRuns.length > 0) {
		return ciAssessment(
			"WORKFLOW_BROKEN",
			"stuck",
			"The exact-head workflow ended without satisfying the branch's required contexts.",
			true,
		);
	}


	if (evidence.requiredContexts.length === 0) {
		return ciAssessment(
			"NO_REQUIRED_CHECKS",
			"not-configured",
			`No required CI contexts apply to branch ${evidence.rulesBranch}; the empty rollup is classified as no CI configured, not as terminal success. A human must decide whether this branch may merge without CI.`,
			true,
		);
	}
	if (evidence.currentHeadAgeSeconds <= evidence.graceSeconds) {
		return ciAssessment(
			"STARTING",
			"will-be-green",
			`Required CI has not reported yet; the exact head is still inside the ${evidence.graceSeconds}s materialization window.`,
		);
	}
	return ciAssessment(
		"NOT_TRIGGERED",
		"stuck",
		"Required CI has not reported and no exact-head workflow run exists after the materialization window.",
		true,
	);
}

export function reviewersNeedingReRequest(
	reviewers: ReviewerActivity[],
	requestedReviewers: string[],
	lastPushAt: string,
	selfLogins: string[] = [],
	currentHead?: string,
): string[] {
	const requested = new Set(requestedReviewers.map((login) => login.toLowerCase()));
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	const out: string[] = [];
	for (const reviewer of reviewers) {
		const login = reviewer.login.toLowerCase();
		if (reviewer.isBot || self.has(login)) continue;
		if (reviewer.lastReviewState === "CHANGES_REQUESTED") {
			if (!requested.has(login)) out.push(reviewer.login);
			continue;
		}
		const staleApproval = reviewer.lastReviewState === "APPROVED"
			&& (
				reviewer.headSha !== undefined && currentHead !== undefined
					? reviewer.headSha !== currentHead
					: reviewer.lastActivityAt < lastPushAt
			);
		if (staleApproval) {
			if (!requested.has(login)) out.push(reviewer.login);
			continue;
		}
		if (reviewer.lastReviewState !== null || requested.has(login)) continue;
		if (reviewer.lastActivityAt < lastPushAt) out.push(reviewer.login);
	}
	return out;
}

function normalizedBotLogins(policy: WatchReviewPolicy): Set<string> {
	return new Set(policy.requiredBots.map((bot) => bot.login.trim().toLowerCase()));
}

/** Humans plus only the profile's named review bots are findings. */
export function isReviewFinding(comment: CommentActivity, botLogins: string[] = []): boolean {
	if (!comment.isBot) return true;
	const configured = new Set(botLogins.map((login) => login.trim().toLowerCase()));
	return configured.has(comment.author.trim().toLowerCase());
}

function latestOwnActivity(comments: CommentActivity[], selfLogins: string[], fallback: string): string {
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	return comments.reduce(
		(latest, comment) =>
			self.has(comment.author.toLowerCase()) && comment.createdAt > latest
				? comment.createdAt
				: latest,
		fallback,
	);
}

export function unansweredComments(
	comments: CommentActivity[],
	selfLogins: string[],
	lastPushAt: string,
	botLogins: string[] = [],
): number {
	const self = new Set(selfLogins.map((login) => login.toLowerCase()));
	const ourLatest = latestOwnActivity(comments, selfLogins, lastPushAt);
	return comments.filter((comment) =>
		!self.has(comment.author.toLowerCase())
		&& isReviewFinding(comment, botLogins)
		&& comment.createdAt > ourLatest
	).length;
}

function commentTriggerId(comment: CommentActivity): string {
	if (comment.id !== undefined && comment.id !== "") return `comment:${comment.id}`;
	return [
		"comment",
		comment.source ?? "unknown",
		comment.author.toLowerCase(),
		comment.createdAt,
		comment.body ?? "",
	].join(":");
}

function commentTriggers(
	snapshot: WatchSnapshot,
	options: WatchExitOptions & { reviewPolicy: WatchReviewPolicy },
	handled: Set<string>,
): WatchTrigger[] {
	const self = new Set(options.selfLogins.map((login) => login.toLowerCase()));
	const requiredBots = normalizedBotLogins(options.reviewPolicy);
	const ourLatest = latestOwnActivity(snapshot.comments, options.selfLogins, snapshot.lastPushAt);
	const triggers: WatchTrigger[] = [];
	for (const comment of snapshot.comments) {
		const author = comment.author.trim().toLowerCase();
		if (self.has(author) || comment.createdAt <= ourLatest) continue;
		const kind = comment.isBot && requiredBots.has(author)
			? "bot_comment"
			: !comment.isBot
				? "human_comment"
				: null;
		if (kind === null) continue;
		const id = commentTriggerId(comment);
		if (handled.has(id)) continue;
		triggers.push({
			id,
			kind,
			headSha: snapshot.headSha,
			summary: `${kind === "bot_comment" ? "Configured review bot" : "Human"} comment from ${comment.author}`,
			payload: {
				author: comment.author,
				body: comment.body ?? "",
				createdAt: comment.createdAt,
				source: comment.source ?? "unknown",
				threadId: comment.threadId ?? null,
				databaseId: comment.databaseId ?? null,
				url: comment.url ?? null,
			},
		});
	}
	return triggers;
}

function latestApprover(
	reviewers: ReviewerActivity[],
	predicate: (reviewer: ReviewerActivity) => boolean,
	headSha: string,
	lastPushAt: string,
): string | null {
	const candidates = reviewers.filter((reviewer) =>
		predicate(reviewer)
		&& reviewer.lastReviewState === "APPROVED"
		&& (reviewer.headSha !== undefined
			? reviewer.headSha === headSha
			: reviewer.lastActivityAt >= lastPushAt)
	);
	candidates.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
	return candidates[0]?.login ?? null;
}

function compilePattern(value: string, label: string): RegExp {
	try {
		return new RegExp(value, "i");
	} catch (error) {
		throw new Error(`Invalid ${label} review-policy pattern: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function botApproved(snapshot: WatchSnapshot, bot: WatchReviewPolicy["requiredBots"][number]): boolean {
	const login = bot.login.trim().toLowerCase();
	if (latestApprover(
		snapshot.reviewers,
		(reviewer) => reviewer.isBot && reviewer.login.trim().toLowerCase() === login,
		snapshot.headSha,
		snapshot.lastPushAt,
	) !== null) return true;
	if (bot.approvalCommentPattern !== undefined) {
		const latest = snapshot.comments
			.filter((comment) =>
				comment.isBot
				&& comment.author.trim().toLowerCase() === login
				&& comment.createdAt >= snapshot.lastPushAt
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		if (latest !== undefined && compilePattern(bot.approvalCommentPattern, `${bot.login} comment`).test(latest.body ?? "")) return true;
	}
	if (bot.approvalCheckPattern !== undefined) {
		const checkPattern = compilePattern(bot.approvalCheckPattern, `${bot.login} check`);
		const currentSuiteIds = new Set(snapshot.ciEvidence?.currentRuns.map((run) => run.checkSuiteId) ?? []);
		if (snapshot.checkRuns.some((check) =>
			checkPattern.test(check.name)
			&& check.status === "completed"
			&& (check.headSha === undefined || check.headSha === snapshot.headSha)
			&& (snapshot.ciEvidence === undefined
				|| (check.checkSuiteId !== undefined
					&& check.checkSuiteId !== null
					&& currentSuiteIds.has(check.checkSuiteId)))
			&& SUCCESSFUL_CONCLUSIONS[(check.conclusion ?? "").toLowerCase()] === true
		)) return true;
	}
	return false;
}

const RETRYABLE_MERGE_CI = new Set<CiClassification>([
	"RUNNING",
	"STARTING",
	"RUNNER_QUEUED",
	"MERGEABILITY_STALE",
]);

export interface MergeSafetyAssessment {
	ok: boolean;
	retryable: boolean;
	ciClassification: CiClassification;
	reason: string;
}

/**
 * Final merge-boundary truth. Approval/stamp authorization is deliberately
 * separate: enqueue requires a fresh exact-head terminal-success snapshot and
 * GitHub's current mergeability signal.
 */
export function assessMergeSafety(
	snapshot: WatchSnapshot,
	expectedHead: string,
	reviewOptions?: WatchExitOptions,
): MergeSafetyAssessment {
	const ci = classifyCiEvidence(snapshot);
	if (snapshot.headSha !== expectedHead) {
		return {
			ok: false,
			retryable: false,
			ciClassification: ci.classification,
			reason: `PR head moved from approved ${expectedHead} to ${snapshot.headSha}.`,
		};
	}
	if (needsRebase(snapshot)) {
		return {
			ok: false,
			retryable: false,
			ciClassification: ci.classification,
			reason: `PR ${snapshot.mergeable}/${snapshot.mergeStateStatus} has a merge conflict.`,
		};
	}
	if (reviewOptions !== undefined) {
		const review = evaluateWatchExit(snapshot, reviewOptions);
		if (!review.exitOk) {
			return {
				ok: false,
				retryable: false,
				ciClassification: review.ciClassification,
				reason: `Fresh review watch regressed before merge: ${review.reasons.join(" ")}`,
			};
		}
	}
	if (ci.classification !== "TERMINAL_SUCCESS" || ci.state !== "green") {
		return {
			ok: false,
			retryable: RETRYABLE_MERGE_CI.has(ci.classification),
			ciClassification: ci.classification,
			reason: `Exact-head CI is ${ci.classification} (${ci.reason}); merge requires TERMINAL_SUCCESS.`,
		};
	}
	if (snapshot.mergeable === "UNKNOWN") {
		return {
			ok: false,
			retryable: true,
			ciClassification: "MERGEABILITY_STALE",
			reason: `GitHub mergeability is still calculating (${snapshot.mergeable}/${snapshot.mergeStateStatus}).`,
		};
	}
	if (snapshot.mergeable !== "MERGEABLE") {
		return {
			ok: false,
			retryable: false,
			ciClassification: ci.classification,
			reason: `GitHub mergeability is ${snapshot.mergeable}/${snapshot.mergeStateStatus}, not MERGEABLE.`,
		};
	}
	return {
		ok: true,
		retryable: false,
		ciClassification: ci.classification,
		reason: "Fresh exact-head CI is TERMINAL_SUCCESS and GitHub reports MERGEABLE.",
	};
}

export interface WatchExitOptions {
	selfLogins: string[];
	handledTriggerIds?: string[];
	reviewPolicy: WatchReviewPolicy;
	infraRetryAttempts?: Record<string, number>;
}

/** The machine-checked exit condition for the single step-4 watch loop. */
export function evaluateWatchExit(snapshot: WatchSnapshot, options: WatchExitOptions): WatchExitVerdict {
	const reasons: string[] = [];
	const handled = new Set(options.handledTriggerIds ?? []);
	const reviewPolicy = options.reviewPolicy;
	const ci = classifyCiEvidence(snapshot);
	const retryLimit = 3;
	const exhaustedInfraRetries = ci.infraRetryJobs.filter(
		(job) => (options.infraRetryAttempts?.[String(job.runId)] ?? 0) >= retryLimit,
	);
	const infraRetriesExhausted = exhaustedInfraRetries.length > 0;
	const infraRetryJobs = ci.infraRetryJobs.filter(
		(job) => (options.infraRetryAttempts?.[String(job.runId)] ?? 0) < retryLimit,
	);
	const terminalEscalation = ci.terminalEscalation || infraRetriesExhausted;
	const rebaseRequired = needsRebase(snapshot);
	const triggers: WatchTrigger[] = [];

	if (rebaseRequired) {
		const id = `merge:${snapshot.headSha}:${snapshot.behindBy}:${snapshot.mergeable}:${snapshot.mergeStateStatus}`;
		if (!handled.has(id)) {
			triggers.push({
				id,
				kind: "merge_conflict",
				headSha: snapshot.headSha,
				summary: "GitHub reports a merge conflict",
				payload: {
					behindBy: snapshot.behindBy,
					mergeable: snapshot.mergeable,
					mergeStateStatus: snapshot.mergeStateStatus,
				},
			});
		}
	}
	for (const check of ci.failedChecks) {
		const id = `ci:${snapshot.headSha}:${check.id ?? `${check.name}:${check.completedAt ?? ""}`}`;
		if (handled.has(id)) continue;
		triggers.push({
			id,
			kind: "failed_ci",
			headSha: snapshot.headSha,
			summary: `Check ${check.name} concluded ${check.conclusion ?? "failure"}`,
			payload: {
				checkId: check.id ?? null,
				name: check.name,
				workflowName: check.workflowName ?? null,
				conclusion: check.conclusion,
				completedAt: check.completedAt ?? null,
				detailsUrl: check.detailsUrl ?? null,
			},
		});
	}
	for (const status of ci.failedStatuses) {
		const id = `ci:${snapshot.headSha}:status:${status.id}`;
		if (handled.has(id)) continue;
		triggers.push({
			id,
			kind: "failed_ci",
			headSha: snapshot.headSha,
			summary: `Status ${status.context} concluded ${status.state}`,
			payload: {
				statusId: status.id,
				context: status.context,
				state: status.state,
				updatedAt: status.updatedAt,
				targetUrl: status.targetUrl,
			},
		});
	}
	triggers.push(...commentTriggers(snapshot, { ...options, reviewPolicy }, handled));

	const unresolved = snapshot.threads.filter((thread) => !thread.isResolved).length;
	const unanswered = unansweredComments(
		snapshot.comments,
		options.selfLogins,
		snapshot.lastPushAt,
		reviewPolicy.requiredBots.map((bot) => bot.login),
	);
	const needReRequest = reviewersNeedingReRequest(
		snapshot.reviewers,
		snapshot.requestedReviewers,
		snapshot.lastPushAt,
		options.selfLogins,
		snapshot.headSha,
	);
	const changesRequested = snapshot.reviewers
		.filter((reviewer) =>
			!reviewer.isBot
			&& !options.selfLogins.some((login) => login.toLowerCase() === reviewer.login.toLowerCase())
			&& (reviewer.headSha !== undefined
				? reviewer.headSha === snapshot.headSha
				: reviewer.lastActivityAt >= snapshot.lastPushAt)
			&& reviewer.lastReviewState === "CHANGES_REQUESTED"
		)
		.map((reviewer) => reviewer.login);
	const reviewDecisionBlocks = snapshot.reviewDecision?.toUpperCase() === "CHANGES_REQUESTED";
	const existingHumanAuthors = new Set(
		triggers
			.filter((trigger) => trigger.kind === "human_comment")
			.map((trigger) => String(trigger.payload.author ?? "").toLowerCase()),
	);
	for (const reviewer of snapshot.reviewers) {
		if (!changesRequested.includes(reviewer.login)) continue;
		const id = `review-state:${snapshot.headSha}:${reviewer.login.toLowerCase()}:${reviewer.lastActivityAt}:CHANGES_REQUESTED`;
		if (handled.has(id) || existingHumanAuthors.has(reviewer.login.toLowerCase())) continue;
		triggers.push({
			id,
			kind: "human_comment",
			headSha: snapshot.headSha,
			summary: `Human reviewer ${reviewer.login} requested changes on the current head`,
			payload: {
				author: reviewer.login,
				body: "",
				createdAt: reviewer.lastActivityAt,
				source: "review_state",
				reviewState: "CHANGES_REQUESTED",
				reviewHeadSha: reviewer.headSha ?? null,
			},
		});
	}
	if (reviewDecisionBlocks && changesRequested.length === 0) {
		const id = `review-decision:${snapshot.headSha}:CHANGES_REQUESTED`;
		if (!handled.has(id)) {
			triggers.push({
				id,
				kind: "human_comment",
				headSha: snapshot.headSha,
				summary: "GitHub reports aggregate CHANGES_REQUESTED without a visible review body",
				payload: {
					author: "unknown-reviewer",
					body: "",
					createdAt: snapshot.lastPushAt,
					source: "aggregate_review_decision",
					reviewState: "CHANGES_REQUESTED",
				},
			});
		}
	}
	const self = new Set(options.selfLogins.map((login) => login.toLowerCase()));
	const humanApprovedBy = latestApprover(
		snapshot.reviewers,
		(reviewer) => !reviewer.isBot && !self.has(reviewer.login.toLowerCase()),
		snapshot.headSha,
		snapshot.lastPushAt,
	);
	const botApprovedBy = reviewPolicy.requiredBots
		.filter((bot) => botApproved(snapshot, bot))
		.map((bot) => bot.login);
	if (rebaseRequired) {
		reasons.push("PR is conflicting or dirty; needs rebase.");
	}
	const mergeabilityStale = !rebaseRequired && snapshot.mergeable === "UNKNOWN";
	if (mergeabilityStale) {
		reasons.push("GitHub mergeability is temporarily UNKNOWN; this is stale metadata, not a rebase trigger.");
	}
	if (unresolved > 0) reasons.push(`${unresolved} unresolved review thread(s) remain visible.`);
	if (unanswered > 0) reasons.push(`${unanswered} new human/configured-bot comment(s) have not been answered.`);
	if (reviewDecisionBlocks) reasons.push("GitHub's aggregate review decision is CHANGES_REQUESTED.");
	if (needReRequest.length > 0) {
		reasons.push(`reviewer(s) need a response cycle: ${needReRequest.join(", ")}.`);
	}
	reasons.push(`CI ${ci.classification}: ${ci.reason}`);
	for (const job of infraRetryJobs) {
		const attempt = (options.infraRetryAttempts?.[String(job.runId)] ?? 0) + 1;
		reasons.push(`Infrastructure retry ${attempt}/${retryLimit} for workflow run ${job.runId}: ${job.reason}.`);
	}
	if (infraRetriesExhausted) {
		reasons.push(`Infrastructure failed after ${retryLimit} bounded retries; escalating instead of waking a code-fix seat.`);
	}
	if (reviewPolicy.requireHuman && humanApprovedBy === null) reasons.push("Waiting for a real human approval.");
	for (const bot of reviewPolicy.requiredBots) {
		if (!botApprovedBy.some((login) => login.toLowerCase() === bot.login.toLowerCase())) {
			reasons.push(`Waiting for required review bot ${bot.login}.`);
		}
	}

	const actionable = triggers.length > 0 || needReRequest.length > 0;
	const approvalsComplete =
		(!reviewPolicy.requireHuman || humanApprovedBy !== null)
		&& botApprovedBy.length === reviewPolicy.requiredBots.length
		&& changesRequested.length === 0
		&& !reviewDecisionBlocks;
	const exitOk = approvalsComplete && !actionable && infraRetryJobs.length === 0 && !terminalEscalation;
	const disposition = exitOk
		? "complete"
		: actionable
			? "fix"
			: terminalEscalation
				? "escalate"
				: "wait";

	return {
		exitOk,
		disposition,
		unresolvedThreads: unresolved,
		unansweredComments: unanswered,
		reviewersNeedingReRequest: needReRequest,
		ci: ci.state,
		ciClassification: infraRetriesExhausted
			? "WORKFLOW_BROKEN"
			: mergeabilityStale
				? "MERGEABILITY_STALE"
				: ci.classification,
		reasons,
		actionable,
		triggers,
		humanApprovedBy,
		botApprovedBy,
		reviewersWithChangesRequested: changesRequested,
		infraRetryJobs,
		rebaseRequired,
		terminalEscalation,
	};
}
