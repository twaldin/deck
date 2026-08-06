/**
 * Pure domain types for the lindy PR pipeline gate logic.
 *
 * Everything in lib/ is dependency-free TypeScript so the gate logic is
 * unit-testable without smithers, zod, or network access. The workflow file
 * (pipeline.tsx) wires these into smithers Tasks.
 */

/** Kill-switch declaration: named, or explicitly absent WITH a named break-signal. */
export type KillSwitch =
	| { kind: "named"; name: string }
	| { kind: "none" };

export interface DecisionEntry {
	question: string;
	decision: string | null;
	open: boolean;
}

/** The validated input brief (the workflow starts at "shape is done"). */
export interface Brief {
	ticket: string;
	title: string;
	summary: string;
	acceptanceCriteria: string[];
	decisionLedger: DecisionEntry[];
	killSwitch: KillSwitch;
	/** Named fallout signal (channel/alert/metric) - mandatory (SOP stage 9). */
	breakSignal: string;
	blastRadius?: string;
	suggestedReviewers?: string[];
}

export type BriefValidation =
	| { ok: true; brief: Brief }
	| { ok: false; openQuestions: string[] };

/** One review thread on the PR (GraphQL reviewThreads node, reduced). */
export interface ReviewThread {
	id: string;
	isResolved: boolean;
	/** login of the last commenter in the thread. */
	lastCommenter: string | null;
}

export type CiState = "green" | "will-be-green" | "red" | "none" | "not-configured" | "stuck";

/**
 * CI truth is deliberately more precise than the ready-gate traffic light.
 * In particular, an empty check rollup is never inferred to be green.
 */
export type CiClassification =
	| "RUNNING"
	| "STARTING"
	| "EXPECTED_STUCK"
	| "STALE_RUN_BLOCKED"
	| "NOT_TRIGGERED"
	| "RUNNER_QUEUED"
	| "INFRA_RETRY"
	| "WORKFLOW_BROKEN"
	| "MERGEABILITY_STALE"
	| "TERMINAL_FAILURE"
	| "TERMINAL_SUCCESS"
	| "NO_REQUIRED_CHECKS";

export interface RequiredStatusContext {
	context: string;
	integrationId: number | null;
}

export interface CheckRun {
	id?: number;
	/** Commit SHA reported by the checks API. */
	headSha?: string;
	name: string;
	/** Workflow name when GitHub provides it. */
	workflowName?: string;
	/** completed | in_progress | queued | pending ... */
	status: string;
	/** success | failure | neutral | skipped | cancelled | timed_out | null while running */
	conclusion: string | null;
	startedAt?: string | null;
	/** GitHub's completion time, used to identify the newest workflow run. */
	completedAt?: string | null;
	detailsUrl?: string | null;
	appId?: number | null;
	appSlug?: string | null;
	checkSuiteId?: number | null;
}

export interface CommitStatusEvidence {
	id: number;
	context: string;
	state: string;
	createdAt: string;
	updatedAt: string;
	targetUrl: string | null;
}

export interface WorkflowJobStepEvidence {
	name: string;
	status: string;
	conclusion: string | null;
}

export interface WorkflowJobEvidence {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	startedAt: string | null;
	completedAt: string | null;
	url: string;
	steps?: WorkflowJobStepEvidence[];
	/** Bounded tail of the failed job log; collected only for failed jobs. */
	logExcerpt?: string;
}

export interface WorkflowRunEvidence {
	id: number;
	checkSuiteId: number;
	headSha: string;
	status: string;
	conclusion: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	url: string;
	jobs: WorkflowJobEvidence[];
}

/**
 * Evidence collected for the exact PR head. Required contexts come from the
 * rules applying to rulesBranch; workflow runs are accepted only after the
 * API proves the PR number, base branch, and exact head SHA all match.
 */
export interface CiEvidence {
	requiredContexts: RequiredStatusContext[];
	rulesBranch: string;
	graceSeconds: number;
	currentHeadAgeSeconds: number;
	currentRuns: WorkflowRunEvidence[];
	staleActiveRuns: WorkflowRunEvidence[];
	statuses: CommitStatusEvidence[];
}

export interface ReviewerActivity {
	login: string;
	isBot: boolean;
	/** ISO timestamp of the reviewer's last review/comment activity. */
	lastActivityAt: string;
	/** Review commit SHA from GitHub; production approvals must match the PR head. */
	headSha?: string;
	/** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED */
	lastReviewState: string | null;
}

export interface CommentActivity {
	/** Stable GraphQL node id. Fixtures may use another stable opaque id. */
	id?: string;
	/** Numeric REST id when this is an inline review comment. */
	databaseId?: number;
	url?: string;
	/** issue_comment | review | review_comment */
	source?: "issue_comment" | "review" | "review_comment";
	threadId?: string;
	author: string;
	isBot: boolean;
	createdAt: string;
	/** Comment body is used to distinguish review findings from automation noise. */
	body?: string;
}

/** Snapshot of PR feedback state used by the watch-ci-review exit check. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface WatchSnapshot {
	headSha: string;
	/** GitHub's mergeability calculation for the current PR head. */
	mergeable: MergeableState;
	/** GitHub's merge queue status, including BEHIND and DIRTY rebase signals. */
	mergeStateStatus: string;
	/** Compare API's count of commits the head is behind its base. */
	behindBy: number;
	/** ISO timestamp of the last push to the PR branch. */
	lastPushAt: string;
	threads: ReviewThread[];
	/** All PR-level comments (issue comments + review summaries), ours included. */
	comments: CommentActivity[];
	/** Reviewer activity, derived from reviews. */
	reviewers: ReviewerActivity[];
	/** GitHub's aggregate review decision; CHANGES_REQUESTED is authoritative even when review history was truncated. */
	reviewDecision?: string | null;
	/** Logins currently in requested_reviewers (the machine check for re-request). */
	requestedReviewers: string[];
	checkRuns: CheckRun[];
	/**
	 * Exact-head CI proof. Real GitHub snapshots always provide it. Omitted
	 * evidence is treated as unverified, never as a successful empty rollup.
	 */
	ciEvidence?: CiEvidence;
}

export type WatchTriggerKind =
	| "failed_ci"
	| "merge_conflict"
	| "human_comment"
	| "bot_comment";

export interface WatchTrigger {
	id: string;
	kind: WatchTriggerKind;
	headSha: string;
	summary: string;
	payload: Record<string, unknown>;
}

export type ReviewRouteOutcome = "FIX_NOW" | "NOT_VALID" | "DECISION";

export interface ReviewRoute {
	triggerId: string;
	outcome: ReviewRouteOutcome;
	rationale: string;
	/** Required for NOT_VALID so the deterministic publisher can reply. */
	replyBody?: string;
	/** Required for DECISION so the captain sees the actual decision needed. */
	question?: string;
}

export interface RequiredBotReviewer {
	login: string;
	/** Optional profile-owned marker for bots that approve via issue comments. */
	approvalCommentPattern?: string;
	/** Optional profile-owned check-name marker for bots that approve via checks. */
	approvalCheckPattern?: string;
}

export interface WatchReviewPolicy {
	requireHuman: boolean;
	requiredBots: RequiredBotReviewer[];
}

export interface WatchExitVerdict {
	exitOk: boolean;
	/** Smithers owns waits; only a real trigger wakes an agent seat. */
	disposition: "complete" | "wait" | "fix" | "escalate";
	unresolvedThreads: number;
	unansweredComments: number;
	reviewersNeedingReRequest: string[];
	ci: CiState;
	ciClassification: CiClassification;
	reasons: string[];
	/** True exactly when one or more unhandled watch triggers need a seat. */
	actionable: boolean;
	triggers: WatchTrigger[];
	/** Step 4 exits only after every approver required by the profile is present. */
	humanApprovedBy: string | null;
	botApprovedBy: string[];
	/** Reviewers with a current-head changes request need a code response. */
	reviewersWithChangesRequested?: string[];
	/** Retryable setup/provider failures are rerun deterministically, never sent to a fix seat. */
	infraRetryJobs: Array<{ runId: number; jobId: number; reason: string }>;
	/** Structured mergeability signal for deterministic rebase selection. */
	rebaseRequired: boolean;
	/** CI lifecycle/configuration reached a stated terminal escalation, not a poll. */
	terminalEscalation: boolean;
}

export interface ReviewApproval {
	login: string;
	isBot: boolean;
	state: string;
	submittedAt: string;
	headSha?: string;
}

export interface ReadyVerdict {
	ready: boolean;
	approvedBy: string | null;
	ci: CiState;
	reasons: string[];
}

export interface MigrationEvidenceEntry {
	stage: "stg-run" | "stg-verify" | "prod-run" | "prod-verify";
	ok: boolean;
	detail: string;
	at: string;
}

export interface DoneEvidence {
	landedSha: string | null;
	deployEvidence: string | null;
	falloutVerdict: "clean" | "regression" | "parked" | null;
	migrationRequired: boolean;
	migrationEvidence: MigrationEvidenceEntry[];
}

export type DoneVerdict = { done: true } | { done: false; missing: string[] };
