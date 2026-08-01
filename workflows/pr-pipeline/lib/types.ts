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

export type CiState = "green" | "will-be-green" | "red" | "none";

export interface CheckRun {
	name: string;
	/** completed | in_progress | queued | pending ... */
	status: string;
	/** success | failure | neutral | skipped | cancelled | timed_out | null while running */
	conclusion: string | null;
}

export interface ReviewerActivity {
	login: string;
	isBot: boolean;
	/** ISO timestamp of the reviewer's last review/comment activity. */
	lastActivityAt: string;
	/** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED */
	lastReviewState: string | null;
}

export interface CommentActivity {
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
	/** Logins currently in requested_reviewers (the machine check for re-request). */
	requestedReviewers: string[];
	checkRuns: CheckRun[];
}

export interface WatchExitVerdict {
	exitOk: boolean;
	/** Smithers owns wait; an agent is used only for a bounded fix. */
	disposition: "complete" | "wait" | "fix";
	unresolvedThreads: number;
	unansweredComments: number;
	reviewersNeedingReRequest: string[];
	ci: CiState;
	reasons: string[];
	/** True when there is agent-actionable work (fix CI, answer, re-request). */
	actionable: boolean;
	/** Structured mergeability signal for deterministic rebase selection. */
	rebaseRequired: boolean;
}

export interface ReviewApproval {
	login: string;
	isBot: boolean;
	state: string;
	submittedAt: string;
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
