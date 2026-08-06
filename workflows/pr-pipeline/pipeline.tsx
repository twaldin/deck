/** @jsxImportSource smithers-orchestrator */
/**
 * lindy PR pipeline - enforced OUTER workflow (SOP: ~/dev/fm2/data/lindy-pipeline.md).
 *
 * Design thesis: step-dropping is THE failure mode. Every stage is a smithers
 * node whose successors are render-gated on its VALIDATED output row, so a
 * stage cannot be skipped: the next node's input is the previous node's
 * persisted output. Stamp/merge-word are durable <Approval> parks - no
 * workflow agent ever holds merge authority.
 *
 * Stages (stable node ids in brackets):
 *   0 preflight gate            [preflight, preflight-refusal]
 *   1 implement                 [implement]
 *   2 local adversarial review  [local-review-loop / local-review / local-fix, review-escalation]
 *   3 push + PR (+watch-set)    [push-pr]
 *   3b request reviewers        [request-reviewers]
 *   4 watch-ci-review loop      [r{N}-watch-loop / r{N}-watch-poll / r{N}-watch-fix, r{N}-watch-escalation]
 *   5 migration gate            [migration-check, migration-gate, migration-{stg,prod}-{run,verify}]
 *   6 ready-for-stamp           [r{N}-ready-loop / r{N}-ready-poll, r{N}-ready-exhausted]
 *   7 stamp + merge word        [r{N}-stamp (Approval), r{N}-stamp-validity]
 *   8 MQ merge                  [enqueue-merge]
 *   8b landing verification     [landing-loop / landing-poll, landing-exhausted]
 *   9 fallout watch             [deploy-evidence, fallout-window, fallout-wait, fallout-watch, fallout-escalation]
 *  10 evidence-gated done       [done]
 *
 * Head change after stamp -> r{N}-stamp-validity invalid -> round N ends ->
 * round N+1 re-enters watch-ci (fresh r{N+1}-* nodes). Never a silent re-stamp.
 */

import {
	Approval,
	Loop,
	Parallel,
	PiAgent,
	Sequence,
	approvalDecisionSchema,
	createSmithers,
	type AgentLike,
} from "smithers-orchestrator";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAdoptable,
	assertLocalStackTracking,
	cleanKnownScratchFiles,
	compareStackHeads,
	decideAdoptPush,
	enqueueStackParentFirst,
	fetchAdoptedPrs,
	normalizeStackSpecs,
	nextStackMergeCar,
	rebaseStackUpstack,
	reconcileAdoptBaseBranch,
	submitStack,
	syncStackPrune,
	validateAdoptedStack,
	verifyStackImplementation,
	type StackCarRecord,
	type StackCarSpec,
	type StackHeadStamp,
} from "./lib/adopt.ts";
import { validateBrief } from "./lib/brief.ts";
import { evaluateDone } from "./lib/done.ts";
import {
	bunExec,
	execOrThrow,
	fetchChangedFiles,
	fetchCodeowners,
	fetchHeadSha,
	fetchBaseCommitSubjects,
	fetchBranchCheckRuns,
	fetchPrLifecycle,
	fetchPrApprovalsAndCi,
	fetchPrOverview,
	fetchRecentAuthors,
	fetchRequestedReviewers,
	fetchWatchSnapshot,
	isCollaborator,
	requestReviewers,
	resolveReviewerLogin,
} from "./lib/gh.ts";
import { findLandingCommit } from "./lib/landing.ts";
import { runMerge } from "./lib/merge.ts";
import { detectMigrations, MIGRATION_STAGES, migrationEvidenceComplete } from "./lib/migrations.ts";
import {
	formatPullRequestTitle,
	generatePullRequestDescription,
	sanitizeDescriptionInput,
} from "./lib/description.ts";
import { buildSeatEnvironment, PrimeSeatAgent } from "./lib/engines/prime.ts";
import {
	DECK_PROVIDER,
	defaultModelPolicy,
	parseModelRef,
	resolveAdversary,
	validateModelPolicy,
	type ModelPolicy,
} from "./lib/models.ts";
import { findProfile, type ModelSeat, type ProjectProfile, type SeatEngine } from "./lib/profiles.ts";
import {
	assertProductWorkspace,
	DEV_WORKSPACE_OVERRIDE,
	isProductRepo,
	productWorkspaceViolation,
} from "./lib/workspace-guard.ts";

export async function changedFilesForBranch(exec: typeof bunExec, worktree: string, baseBranch: string): Promise<string[]> {
	const output = await execOrThrow(exec, ["git", "diff", "--name-only", `origin/${baseBranch}...HEAD`], { cwd: worktree });
	return output.split("\n").map((file) => file.trim()).filter(Boolean);
}
import {
	falloutPrompt,
	implementPrompt,
	stackImplementPrompt,
	reviewersDecisionPrompt,
	localFixPrompt,
	localReviewPrompt,
	watchFixPrompt,
} from "./lib/prompts.ts";
import { evaluateReadyForStamp } from "./lib/ready.ts";
import { executeReviewerRequest } from "./lib/reviewers.ts";
import { assessCi, evaluateWatchExit, parseDecisionClassBlocker } from "./lib/watch.ts";
import { rebaseAndPush } from "./lib/rebase.ts";
import type { Brief, MigrationEvidenceEntry } from "./lib/types.ts";
import { claimMainFailure, publishWakeProducer, releaseMainFailure } from "../../v2/src/wake-producers.ts";
import { smithersWorkspaceCwd } from "../../v2/src/workspace.ts";
import { runTestCommand } from "./lib/test-lane.ts";
import {
	askWorkflowQuestion,
	queueFile,
	resolveWorkflowQuestion,
	workflowQuestions,
	type PrQuestionContext,
} from "../../v2/src/questions-store.ts";

// ---------------------------------------------------------------------------
// Defaults (normalized in code, not via zod .default(), to keep semantics
// explicit and version-proof)
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS = {
	localReviewRounds: 8,
	watchPolls: 60,
	readyPolls: 40,
	landingPolls: 60,
	stampRounds: 5,
	watchPollSeconds: 120,
	readyPollSeconds: 120,
	landingPollSeconds: 30,
	falloutWindowMinutes: 60,
};

const DEFAULT_FIXTURES = {
	changedFiles: ["packages/database-migrations/0042_add_flag.sql", "src/feature.ts"],
	localReviewRounds: 2,
	watchPollsToExit: 2,
	watchWaitPolls: 0,
	prNumber: 4242,
	stackPrNumbers: [] as number[],
	stackMovedPrNumbers: [] as number[],
	queueLifecycle: [] as Array<{ state: "open" | "closed"; autoMergeRequest: boolean }>,
	landingPollLanded: true,
	noFalloutProbe: false,
	headChangeRounds: [] as number[],
};

export const DEFAULT_GITHUB = {
	gh: "gh",
	git: "git",
	selfLogins: [] as string[],
	excludedApprovers: [] as string[],
	reviewerDenylist: [] as string[],
	reviewers: [] as string[],
	/** Explicit opt-out only: reviewers are always requested by default. */
	skipReviewerRequest: false,
	maxReviewers: 2,
};

const DEFAULT_COMMANDS = {
	merge: "gt merge",
	deployEvidence: undefined as string | undefined,
	migrationStgRun: undefined as string | undefined,
	migrationStgVerify: undefined as string | undefined,
	migrationProdRun: undefined as string | undefined,
	migrationProdVerify: undefined as string | undefined,
	falloutProbes: [] as string[],
	test: "bun test",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const stackCarSpecSchema = z.object({
	branch: z.string().min(1),
	baseBranch: z.string().min(1).optional(),
	title: z.string().min(1).optional(),
	body: z.string().min(1).optional(),
});

/**
 * Exactly one stack source is allowed. `specs` creates/updates a native
 * gh-stack from already-planned parent-first branches. `existingPrNumbers`
 * adopts those live PR identities and never invokes a create/submit command.
 */
export const stackInputSchema = z.union([
	z.object({
		specs: z.array(stackCarSpecSchema).min(1),
		existingPrNumbers: z.never().optional(),
	}),
	z.object({
		existingPrNumbers: z.array(z.number().int().positive()).min(1),
		specs: z.never().optional(),
	}),
]);

const stackCarRecordSchema = z.object({
	prNumber: z.number().int().positive(),
	url: z.string(),
	branch: z.string().min(1),
	baseBranch: z.string().min(1),
	headSha: z.string(),
	landed: z.boolean(),
});

const stackWatchCarSchema = z.object({
	prNumber: z.number().int().positive(),
	branch: z.string().min(1),
	baseBranch: z.string().min(1),
	headSha: z.string(),
	exitOk: z.boolean(),
	actionable: z.boolean(),
	ci: z.string(),
	unresolvedThreads: z.number().int(),
	unansweredComments: z.number().int(),
	reviewersToReRequest: z.array(z.string()),
	reasons: z.array(z.string()),
	rebaseRequired: z.boolean(),
});

const stackReadyCarSchema = z.object({
	prNumber: z.number().int().positive(),
	branch: z.string().min(1),
	baseBranch: z.string().min(1),
	headSha: z.string(),
	ready: z.boolean(),
	approvedBy: z.string().nullable(),
	ci: z.string(),
	reasons: z.array(z.string()),
	migrationFiles: z.array(z.string()),
});

const stackStampCarSchema = z.object({
	prNumber: z.number().int().positive(),
	branch: z.string().min(1),
	baseBranch: z.string().min(1),
	headSha: z.string(),
	currentHead: z.string(),
	ok: z.boolean(),
});

const stackMergeCarSchema = stackStampCarSchema.extend({
	submittedAt: z.string().nullable(),
	receipt: z.string().nullable(),
	alreadyLanded: z.boolean(),
	mergePath: z.enum(["github-merge-queue", "dry-run", "already-landed"]).nullable(),
});

const stackQueueCarSchema = z.object({
	prNumber: z.number().int().positive(),
	merged: z.boolean(),
	state: z.enum(["open", "closed"]),
	baseBranch: z.string().min(1),
	autoMergeRequest: z.boolean(),
	ejected: z.boolean(),
});

const stackLandingCarSchema = z.object({
	prNumber: z.number().int().positive(),
	baseBranch: z.string().min(1),
	landed: z.boolean(),
	sha: z.string().nullable(),
	subject: z.string().nullable(),
});

export const inputSchema = z.object({
	ticket: z.string().min(1),
	repo: z.string().min(1),
	worktree: z.string().min(1),
	branch: z.string().min(1),
	baseBranch: z.string().optional(),
	/**
	 * Project profile id or repo name (config/projects.json under the deck
	 * home). yolo profiles (e.g. deck) skip the stamp gate: ready is CI-green
	 * and the workflow auto-approves the stamp row. stamp profiles (e.g. lindy)
	 * park at the durable <Approval> as always. Omitted = stamp behavior.
	 */
	profile: z.string().optional(),
	/**
	 * Adopt an already-open PR instead of implementing greenfield: implement is
	 * stubbed, local adversarial review still runs, push-pr verifies the branch matches the PR head and seeds prRecord
	 * from gh — it NEVER creates a second PR. Watch/ready/stamp are unchanged:
	 * the run owns continuous CI/review polling until merge, same as a ship.
	 */
	existingPr: z.number().int().positive().optional(),
	/**
	 * Optional ordered stack mode. It is mutually exclusive with `existingPr`;
	 * `specs` creates a native stack and `existingPrNumbers` adopts one.
	 */
	stack: stackInputSchema.optional(),
	brief: z.unknown().optional(),
	/** Default TRUE: real GH writes require explicit dryRun:false. */
	dryRun: z.boolean().optional(),
	/** Test-only wake suppression for render-only workflow inspection. */
	wakeDryRun: z.boolean().optional(),
	/**
	 * Test-only: replace <Approval> parks with auto-approved compute rows so
	 * simulate() can traverse the full graph. Preflight REFUSES bypass unless
	 * dryRun is also true - no real run can self-approve.
	 */
	bypassApprovals: z.boolean().optional(),
	models: z
		.object({
			implementer: z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().min(1).optional() })]).optional(),
			reviewer: z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().min(1).optional() })]).optional(),
			watcher: z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().min(1).optional() })]).optional(),
			fallout: z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().min(1).optional() })]).optional(),
			familyOpposition: z.boolean().optional(),
			oppositionDefaults: z.record(z.string(), z.string()).optional(),
			reasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
			reasoningImplementer: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
			reasoningReviewer: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
			reasoningWatcher: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
			reasoningFallout: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
		})
		.nullable()
		.optional(),
	limits: z
		.object({
			localReviewRounds: z.number().int().positive().optional(),
			watchPolls: z.number().int().positive().optional(),
			readyPolls: z.number().int().positive().optional(),
			landingPolls: z.number().int().positive().optional(),
			stampRounds: z.number().int().positive().optional(),
			watchPollSeconds: z.number().positive().optional(),
			readyPollSeconds: z.number().positive().optional(),
			landingPollSeconds: z.number().positive().optional(),
			falloutWindowMinutes: z.number().nonnegative().optional(),
		})
		.optional(),
	github: z
		.object({
			gh: z.string().optional(),
			git: z.string().optional(),
			selfLogins: z.array(z.string()).optional(),
			excludedApprovers: z.array(z.string()).optional(),
			reviewerDenylist: z.array(z.string()).optional(),
			reviewers: z.array(z.string()).optional(),
			skipReviewerRequest: z.boolean().optional(),
			maxReviewers: z.number().int().positive().optional(),
		})
		.optional(),
	commands: z
		.object({
			merge: z.string().optional(),
			deployEvidence: z.string().optional(),
			migrationStgRun: z.string().optional(),
			migrationStgVerify: z.string().optional(),
			migrationProdRun: z.string().optional(),
			migrationProdVerify: z.string().optional(),
			falloutProbes: z.array(z.string()).optional(),
			test: z.string().optional(),
		})
		.optional(),
	watchSetPath: z.string().optional(),
	fixtures: z
		.object({
			changedFiles: z.array(z.string()).optional(),
			localReviewRounds: z.number().int().positive().optional(),
			localReviewNitsOnly: z.boolean().optional(),
			watchPollsToExit: z.number().int().positive().optional(),
			watchWaitPolls: z.number().int().nonnegative().optional(),
			prNumber: z.number().int().positive().optional(),
			stackPrNumbers: z.array(z.number().int().positive()).optional(),
			stackMovedPrNumbers: z.array(z.number().int().positive()).optional(),
			queueLifecycle: z.array(z.object({ state: z.enum(["open", "closed"]), autoMergeRequest: z.boolean() })).optional(),
			landingPollLanded: z.boolean().optional(),
			noFalloutProbe: z.boolean().optional(),
			headChangeRounds: z.array(z.number().int().nonnegative()).optional(),
		})
		.optional(),
}).superRefine((input, ctx) => {
	if (input.existingPr !== undefined && input.stack !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["stack"],
			message: "existingPr and stack are mutually exclusive; declare one effort shape",
		});
	}
});

export const localReviewSchema = z.object({
	round: z.number().int(),
	approved: z.boolean(),
	blockingFindings: z.array(z.string()),
	nits: z.array(z.string()),
	summary: z.string(),
});
export const mergePathSchema = z.enum(["github-merge-queue", "dry-run", "already-landed"]);


export const schemas = {
	input: inputSchema,
	preflight: z.object({
		ok: z.boolean(),
		openQuestions: z.array(z.string()),
		briefDigest: z.string(),
		resolvedReviewerModel: z.string(),
	}),
	adoptBase: z.object({
		baseBranch: z.string().min(1),
		cars: z.array(stackCarRecordSchema).optional(),
	}),
	implementation: z.object({
		commits: z.array(z.string()),
		summary: z.string(),
		testEvidence: z.string(),
		stackCars: z.array(z.object({
			branch: z.string().min(1),
			commits: z.array(z.string()),
			testEvidence: z.string(),
		})).optional(),
	}),
	localReview: localReviewSchema,
	localFix: z.object({
		afterRound: z.number().int(),
		addressed: z.array(z.string()),
		summary: z.string(),
	}),
	approvals: approvalDecisionSchema,
	reviewerRequest: z.object({
		skipped: z.boolean(),
		requested: z.array(z.string()),
		verified: z.array(z.string()),
		skippedNonCollaborators: z.array(z.string()).optional(),
		source: z.string(),
		at: z.string(),
		reviewerPrompt: z.string(),
		cars: z.array(z.object({
			prNumber: z.number().int().positive(),
			requested: z.array(z.string()),
			verified: z.array(z.string()),
		})).optional(),
	}),
	prRecord: z.object({
		prNumber: z.number().int(),
		url: z.string(),
		headSha: z.string(),
		baseBranch: z.string().min(1),
		watchSetRegistered: z.boolean(),
		watchSetPath: z.string(),
		receipt: z.string(),
		createdAt: z.string(),
		cars: z.array(stackCarRecordSchema).optional(),
	}),
	watchPoll: z.object({
		round: z.number().int(),
		poll: z.number().int(),
		headSha: z.string(),
		exitOk: z.boolean(),
		disposition: z.enum(["complete", "wait", "fix"]),
		actionable: z.boolean(),
		ci: z.string(),
		unresolvedThreads: z.number().int(),
		unansweredComments: z.number().int(),
		reviewersToReRequest: z.array(z.string()),
		reasons: z.array(z.string()),
		rebaseRequired: z.boolean(),
		cars: z.array(stackWatchCarSchema).optional(),
	}),
	watchFix: z.object({
		round: z.number().int(),
		afterPoll: z.number().int(),
		actions: z.array(z.string()),
		commits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/i)),
		pushed: z.boolean(),
		reRequested: z.array(z.string()),
		summary: z.string(),
	}),
	watchBaseline: z.object({
		round: z.number().int(),
		afterPoll: z.number().int(),
		headSha: z.string(),
		valid: z.boolean(),
		reason: z.string(),
	}),
	watchPublish: z.object({
		round: z.number().int(),
		afterPoll: z.number().int(),
		actions: z.array(z.string()),
		pushed: z.boolean(),
		reRequested: z.array(z.string()),
		summary: z.string(),
	}),
	migrationCheck: z.object({
		required: z.boolean(),
		files: z.array(z.string()),
	}),
	migrationScope: z.object({
		files: z.array(z.string()),
		capturedAt: z.string(),
	}),
	migrationRun: z.object({
		stage: z.enum(["stg-run", "stg-verify", "prod-run", "prod-verify"]),
		ok: z.boolean(),
		detail: z.string(),
		at: z.string(),
	}),
	readyPoll: z.object({
		round: z.number().int(),
		poll: z.number().int(),
		ready: z.boolean(),
		regressed: z.boolean(),
		approvedBy: z.string().nullable(),
		ci: z.string(),
		headSha: z.string(),
		reasons: z.array(z.string()),
		migrationDetected: z.boolean(),
		migrationFiles: z.array(z.string()),
		at: z.string(),
		cars: z.array(stackReadyCarSchema).optional(),
	}),
	stampValidity: z.object({
		round: z.number().int(),
		stampedHead: z.string(),
		currentHead: z.string(),
		valid: z.boolean(),
		checkedAt: z.string(),
		cars: z.array(stackStampCarSchema).optional(),
	}),
	mergeHeadCheck: z.object({
		round: z.number().int(),
		expectedHead: z.string(),
		currentHead: z.string(),
		ok: z.boolean(),
		diffSummary: z.string(),
		checkedAt: z.string(),
		submittedAt: z.string().nullable(),
		receipt: z.string().nullable(),
		alreadyLanded: z.boolean(),
		mergePath: mergePathSchema.nullable(),
		cars: z.array(stackMergeCarSchema).optional(),
	}),
	mergeReceipt: z.object({
		round: z.number().int(),
		submittedAt: z.string(),
		receipt: z.string(),
		alreadyLanded: z.boolean(),
		mergePath: mergePathSchema,
		cars: z.array(stackMergeCarSchema).optional(),
	}),
	queuePoll: z.object({
		poll: z.number().int(),
		state: z.enum(["open", "closed"]),
		baseBranch: z.string().min(1),
		autoMergeRequest: z.boolean(),
		ejected: z.boolean(),
		reason: z.string(),
		cars: z.array(stackQueueCarSchema).optional(),
	}),
	landingPoll: z.object({
		poll: z.number().int(),
		landed: z.boolean(),
		sha: z.string().nullable(),
		subject: z.string().nullable(),
		cars: z.array(stackLandingCarSchema).optional(),
	}),
	stackSync: z.object({
		synced: z.boolean(),
		receipt: z.string(),
	}),
	deployEvidence: z.object({
		evidence: z.string(),
		deployedAt: z.string(),
	}),
	falloutWindow: z.object({
		windowStart: z.string(),
		windowEnd: z.string(),
	}),
	falloutWait: z.object({
		complete: z.boolean(),
		waitedUntil: z.string(),
	}),
	fallout: z.object({
		verdict: z.enum(["clean", "regression", "parked"]),
		breakSignal: z.string(),
		probeResults: z.array(z.string()),
		notes: z.string(),
	}),
	doneRecord: z.object({
		ticket: z.string(),
		prNumber: z.number().int(),
		prNumbers: z.array(z.number().int().positive()).optional(),
		landedSha: z.string(),
		falloutVerdict: z.string(),
		migrationRequired: z.boolean(),
		completedAt: z.string(),
	}),
};

const { Workflow, Task, outputs, smithers } = createSmithers(schemas);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleepSeconds(total: number): Promise<void> {
	const end = Date.now() + total * 1000;
	while (Date.now() < end) {
		const chunk = Math.min(30_000, end - Date.now());
		await new Promise((resolve) => setTimeout(resolve, chunk));
	}
}

async function runShell(command: string, cwd: string): Promise<string> {
	return execOrThrow(bunExec, ["bash", "-lc", command], { cwd });
}

async function runTests(command: string, cwd: string): Promise<string> {
	return runTestCommand(bunExec, cwd, command);
}

function nowIso(): string {
	return new Date().toISOString();
}

function registerWatchCars(args: {
	watchSetPath: string;
	ticket: string;
	repo: string;
	runId: string;
	cars: StackCarRecord[];
}): void {
	fs.mkdirSync(path.dirname(args.watchSetPath), { recursive: true });
	const registeredAt = nowIso();
	fs.appendFileSync(
		args.watchSetPath,
		args.cars
			.map((car) =>
				JSON.stringify({
					ticket: args.ticket,
					repo: args.repo,
					pr: car.prNumber,
					url: car.url,
					registeredAt,
					runId: args.runId,
					stack: args.cars.map((topologyCar) => ({
						pr: topologyCar.prNumber,
						branch: topologyCar.branch,
						baseBranch: topologyCar.baseBranch,
						headSha: topologyCar.headSha,
					})),
				}),
			)
			.join("\n") + "\n",
	);
}
export type ApprovalStampMetadata = {
	headSha: string;
	prNumber: number;
	stackTopology?:
		| {
				headBranch: string;
				baseBranch: string;
			}
		| {
				cars: StackHeadStamp[];
			};
};

export function buildApprovalStampMetadata(args: {
	headSha: string;
	prNumber: number;
	headBranch: string;
	baseBranch: string;
	cars?: StackHeadStamp[];
}): ApprovalStampMetadata {
	if (args.cars !== undefined) {
		return {
			headSha: args.headSha,
			prNumber: args.prNumber,
			stackTopology: {
				cars: args.cars.map((car) => ({ ...car })),
			},
		};
	}
	return {
		headSha: args.headSha,
		prNumber: args.prNumber,
		...(args.baseBranch === "main"
			? {}
			: {
					stackTopology: {
						headBranch: args.headBranch,
						baseBranch: args.baseBranch,
					},
				}),
	};
}

export interface StampComparison {
	expectedHead: string;
	currentHead: string;
	ok: boolean;
	diffSummary: string;
}

/**
 * Fetch the PR head at the merge boundary. A mismatch is a normal invalidation
 * result, not a thrown merge failure, so the round state machine can re-enter
 * watch/review with useful evidence.
 */
export async function compareApprovalStamp(args: {
	exec: typeof bunExec;
	gh: string;
	repo: string;
	prNumber: number;
	expectedHead: string;
}): Promise<StampComparison> {
	const currentHead = (
		await execOrThrow(
			args.exec,
			[args.gh, "api", `repos/${args.repo}/pulls/${args.prNumber}`, "--jq", ".head.sha"],
		)
	).trim();
	if (currentHead === args.expectedHead) {
		return {
			expectedHead: args.expectedHead,
			currentHead,
			ok: true,
			diffSummary: "head unchanged since approval",
		};
	}

	let diffSummary = `head changed ${args.expectedHead} -> ${currentHead}`;
	try {
		const raw = await execOrThrow(args.exec, [
			args.gh,
			"api",
			`repos/${args.repo}/compare/${args.expectedHead}...${currentHead}`,
		]);
		const comparison = JSON.parse(raw) as {
			status?: unknown;
			ahead_by?: unknown;
			behind_by?: unknown;
			total_commits?: unknown;
			files?: Array<{ filename?: unknown }>;
		};
		const files = Array.isArray(comparison.files)
			? comparison.files
					.map((file) => (typeof file.filename === "string" ? file.filename : ""))
					.filter(Boolean)
					.slice(0, 10)
			: [];
		diffSummary = [
			diffSummary,
			`status=${String(comparison.status ?? "unknown")}`,
			`ahead=${String(comparison.ahead_by ?? "unknown")}`,
			`behind=${String(comparison.behind_by ?? "unknown")}`,
			`commits=${String(comparison.total_commits ?? "unknown")}`,
			`files=${files.length > 0 ? files.join(", ") : "unknown"}`,
		].join("; ");
	} catch (error) {
		diffSummary = `${diffSummary}; compare summary unavailable: ${String(error).slice(0, 300)}`;
	}
	return {
		expectedHead: args.expectedHead,
		currentHead,
		ok: false,
		diffSummary,
	};
}


function seat(ref: ModelSeat): { ref: string; reasoning?: string } {
	return typeof ref === "string" ? { ref } : { ref: ref.model, reasoning: ref.reasoning };
}

function makeAgent(
	engine: SeatEngine,
	ref: ModelSeat,
	cwd: string,
	timeoutMs: number,
	effortLabel: string,
	reasoning = "medium",
): AgentLike {
	const selected = seat(ref);
	const { provider, model } = parseModelRef(selected.ref);
	const thinking = selected.reasoning ?? reasoning;
	if (engine === "prime") {
		return new PrimeSeatAgent({
			provider: DECK_PROVIDER,
			model,
			cwd,
			effortLabel,
			timeoutMs,
			thinking: thinking as never,
		});
	}
	const configuredExtension = process.env.DECK_SUBAGENT_EXTENSION;
	const bundledExtension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../subagents/deck-subagents.ts");
	const subagentExtension = configuredExtension ?? (fs.existsSync(bundledExtension) ? bundledExtension : undefined);
	const extension = subagentExtension === undefined ? undefined : [subagentExtension];
	// Pi still needs bash for tests and gh, but receives only the explicit
	// non-credential seat environment. The deterministic publisher alone keeps
	// push/merge/stamp credentials and authority.
	return new PiAgent({
		provider,
		model,
		cwd,
		timeoutMs,
		thinking: thinking as never,
		noSession: true,
		inheritEnv: false,
		env: buildSeatEnvironment(),
		...(extension === undefined ? {} : { extension }),
	});
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export function buildModelPolicy(
	profile: ProjectProfile | null,
	profileRepoMismatch: boolean,
	inputModels: {
		implementer?: ModelSeat;
		reviewer?: ModelSeat;
		watcher?: ModelSeat;
		fallout?: ModelSeat;
		familyOpposition?: boolean;
		oppositionDefaults?: Record<string, string>;
		reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoningImplementer?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoningReviewer?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoningWatcher?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoningFallout?: "low" | "medium" | "high" | "xhigh" | "max";
	} | null | undefined,
): ModelPolicy {
	// The project-profile loader can preserve a JSON `models: null` value from
	// config/projects.json. Normalize it before reading `profileModels.reviewer`
	// or `profileModels.oppositionDefaults`; mismatched profiles provide neither
	// their loaded policy nor their input snapshot.
	const profileModels =
		profile !== null && !profileRepoMismatch && profile.models !== null && typeof profile.models === "object"
			? profile.models
			: undefined;
	const models = profileRepoMismatch ? undefined : inputModels ?? undefined;
	return {
		...defaultModelPolicy(),
		...(profileModels ?? {}),
		...(profileModels !== undefined ? { reviewer: profileModels.reviewer } : {}),
		...(models ?? {}),
		...(profileModels?.reasoning !== undefined && profileModels.reasoningImplementer === undefined ? { reasoningImplementer: profileModels.reasoning } : {}),
		...(profileModels?.reasoning !== undefined && profileModels.reasoningReviewer === undefined ? { reasoningReviewer: profileModels.reasoning } : {}),
		...(profileModels?.reasoning !== undefined && profileModels.reasoningWatcher === undefined ? { reasoningWatcher: profileModels.reasoning } : {}),
		...(profileModels?.reasoning !== undefined && profileModels.reasoningFallout === undefined ? { reasoningFallout: profileModels.reasoning } : {}),
		...(models?.reasoning !== undefined && models.reasoningImplementer === undefined ? { reasoningImplementer: models.reasoning } : {}),
		...(models?.reasoning !== undefined && models.reasoningReviewer === undefined ? { reasoningReviewer: models.reasoning } : {}),
		...(models?.reasoning !== undefined && models.reasoningWatcher === undefined ? { reasoningWatcher: models.reasoning } : {}),
		...(models?.reasoning !== undefined && models.reasoningFallout === undefined ? { reasoningFallout: models.reasoning } : {}),
		oppositionDefaults: {
			...defaultModelPolicy().oppositionDefaults,
			...(profileModels?.oppositionDefaults ?? {}),
			...(models?.oppositionDefaults ?? {}),
		},
	};
}

export default smithers((ctx) => {
	const input = ctx.input;
	const workspaceRootAtRunStart = process.cwd();
	const productWorkspaceHomeAtRunStart = process.env.HOME ?? os.homedir();
	const devWorkspaceAllowedAtRunStart = process.env[DEV_WORKSPACE_OVERRIDE] === "1";
	const dryRun = input.dryRun !== false;
	const wakeDryRun = dryRun || (process.env.NODE_ENV === "test" && input.wakeDryRun === true);
	const bypass = input.bypassApprovals === true;
	const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
	const fixtures = { ...DEFAULT_FIXTURES, ...(input.fixtures ?? {}) };
	const github = { ...DEFAULT_GITHUB, ...(input.github ?? {}) };
	const commands = { ...DEFAULT_COMMANDS, ...(input.commands ?? {}) };
	const declaredBaseBranch = input.baseBranch ?? "main";
	const stackCreateSpecs =
		input.stack !== undefined && "specs" in input.stack
			? input.stack.specs
			: undefined;
	const stackExistingNumbers =
		input.stack !== undefined && "existingPrNumbers" in input.stack
			? input.stack.existingPrNumbers
			: undefined;
	const stackMode = input.stack !== undefined;
	const adopt = input.existingPr != null || stackExistingNumbers !== undefined;
	// Resolved once per render; yolo=false (stamp behavior) when omitted.
	const profile: ProjectProfile | null =
		input.profile === undefined ? null : findProfile(input.profile);
	const profileUnknown = input.profile !== undefined && profile === null;
	// The profile must be THIS repo's profile: without the binding, any caller
	// could attach the deck yolo profile to a lindy run and skip the stamp.
	const profileRepoMismatch =
		profile !== null && profile.repo.toLowerCase() !== input.repo.toLowerCase();
	const workspaceGuardProfile =
		isProductRepo(input.repo, profile) || (profile !== null && !profileRepoMismatch)
			? profile
			: findProfile(input.repo);
	const productWorkspaceAssertion = {
		repo: input.repo,
		profile: workspaceGuardProfile,
		dryRun,
		workspaceRoot: workspaceRootAtRunStart,
		home: productWorkspaceHomeAtRunStart,
		devWorkspaceAllowed: devWorkspaceAllowedAtRunStart,
	};
	const productWorkspaceViolationAtRunStart =
		productWorkspaceViolation(productWorkspaceAssertion);
	if (productWorkspaceViolationAtRunStart !== null) {
		return (
			<Workflow name="lindy-pr-pipeline">
				<Task id="workspace-assert" output={outputs.preflight} retries={0}>
					{() => assertProductWorkspace(productWorkspaceAssertion)}
				</Task>
			</Workflow>
		);
	}
	const yolo = profile !== null && !profileRepoMismatch && profile.yolo;
	const seatEngine: SeatEngine =
		profile !== null && !profileRepoMismatch ? profile.engine ?? "pi" : "pi";
	const watchSetPath =
		input.watchSetPath ?? `${process.env.HOME ?? "~"}/dev/fm2/data/watch-set.jsonl`;

	const policy = buildModelPolicy(profile, profileRepoMismatch, input.models);

	const ghCtx = { gh: github.gh, repo: input.repo, exec: bunExec };
	const project = input.profile ?? input.repo.split("/").at(-1);

	// -- persisted state reads ------------------------------------------------
	const preflight = ctx.latest(outputs.preflight, "preflight");
	const implementation = ctx.latest(outputs.implementation, "implement");
	const latestLocalReview = ctx.latest(outputs.localReview, "local-review");
	const latestLocalFix = ctx.latest(outputs.localFix, "local-fix");
	const localReviewRows = (ctx.outputs.localReview ?? []) as Array<{
		round: number;
		blockingFindings: string[];
	}>;
	const findingFingerprint = (findings: string[]): string =>
		findings
			.map((finding) => finding.trim().toLowerCase().replace(/\s+/g, " "))
			.sort()
			.join("|");
	const repeatedLocalFinding =
		localReviewRows.length >= 2 &&
		findingFingerprint(localReviewRows.at(-1)?.blockingFindings ?? []) !== "" &&
		findingFingerprint(localReviewRows.at(-1)?.blockingFindings ?? []) ===
			findingFingerprint(localReviewRows.at(-2)?.blockingFindings ?? []);
	const reviewEscalation = ctx.latest(outputs.approvals, "review-escalation");
	const adoptedBase = ctx.latest(outputs.adoptBase, "adopt-base");
	const pr = ctx.latest(outputs.prRecord, "push-pr");
	// Stack mode always uses the root branch here. Per-car bases live in the
	// durable car records and are consulted by every iterative stage.
	const baseBranch = adoptedBase?.baseBranch ?? pr?.baseBranch ?? declaredBaseBranch;
	const effortCars: StackCarRecord[] =
		pr?.cars ??
		(pr === undefined
			? []
			: [{
					prNumber: pr.prNumber,
					url: pr.url,
					branch: input.branch,
					baseBranch: pr.baseBranch,
					headSha: pr.headSha,
					landed: false,
				}]);
	const topCar = effortCars.at(-1);
	const reviewerRequest = ctx.latest(outputs.reviewerRequest, "request-reviewers");
	const migCheck = ctx.latest(outputs.migrationCheck, "migration-check");
	const migGate = ctx.latest(outputs.approvals, "migration-gate");
	const migScope = ctx.latest(outputs.migrationScope, "migration-scope");
	const migrationRows = (ctx.outputs.migrationRun ?? []) as MigrationEvidenceEntry[];
	const falloutRow = ctx.latest(outputs.fallout, "fallout-watch");
	const falloutEscalation = ctx.latest(outputs.approvals, "fallout-escalation");
	const workflowDir = path.dirname(fileURLToPath(import.meta.url));
	const questionsFile = queueFile();
	const approvalRows = (ctx.outputs.approvals ?? []) as Array<{
		nodeId?: string;
		approved: boolean;
		note?: string;
		decidedBy?: string;
	}>;
	if (!bypass) {
		for (const decision of approvalRows) {
			if (decision.nodeId === undefined) continue;
			resolveWorkflowQuestion(questionsFile, {
				runId: ctx.runId,
				nodeId: decision.nodeId,
				answer: [
					decision.approved ? "Approved" : "Denied",
					decision.decidedBy ? `by ${decision.decidedBy}` : "",
					decision.note ? `— ${decision.note}` : "",
				].filter(Boolean).join(" "),
			});
		}
	}

	const brief: Brief | null = (() => {
		const validated = validateBrief(input.brief);
		return validated.ok ? validated.brief : null;
	})();

	// -- rounds ----------------------------------------------------------------
	const readyPollRows = (ctx.outputs.readyPoll ?? []) as Array<{
		round: number;
		poll: number;
		ready: boolean;
		regressed: boolean;
		migrationDetected: boolean;
		migrationFiles: string[];
		approvedBy: string | null;
		ci: string;
		headSha: string;
		at: string;
	}>;
	const watchPollRows = (ctx.outputs.watchPoll ?? []) as Array<{ round: number; poll: number; exitOk: boolean }>;

	const roundEnded = (k: number): boolean => {
		const ready = ctx.latest(outputs.readyPoll, `r${k}-ready-poll`);
		if (ready?.regressed === true) return true;
		// Synthetic exhaustion row (poll === -1) also ends the round.
		if (readyPollRows.some((row) => row.round === k && row.poll === -1)) return true;
		const validity = ctx.latest(outputs.stampValidity, `r${k}-stamp-validity`);
		if (validity !== undefined && validity.valid === false) return true;
		// A failed pre-merge head check also ends the round (TOCTOU guard).
		const headCheck = ctx.latest(outputs.mergeHeadCheck, `r${k}-merge-head-check`);
		if (headCheck !== undefined && headCheck.ok === false) return true;
		return false;
	};

	let currentRound = 0;
	while (currentRound < limits.stampRounds && roundEnded(currentRound)) {
		currentRound++;
	}
	const roundsExhausted = currentRound >= limits.stampRounds;

	const anyWatchSettled = (() => {
		for (let k = 0; k <= Math.min(currentRound, limits.stampRounds - 1); k++) {
			if (ctx.latest(outputs.watchPoll, `r${k}-watch-poll`)?.exitOk === true) return true;
			if (ctx.latest(outputs.approvals, `r${k}-watch-escalation`)?.approved === true) return true;
		}
		return false;
	})();

	// -- migration state --------------------------------------------------------
	const readyPollDetectedMigration = readyPollRows.some((row) => row.migrationDetected === true);
	const migRequired = migCheck?.required === true || readyPollDetectedMigration;
	const migEvidenceOk = migrationEvidenceComplete(migrationRows);

	// -- migration staleness (fail closed) ---------------------------------------
	// Evidence covers the APPROVED SCOPE captured by migration-scope at gate
	// time. If any later ready-poll observes a DIFFERENT migration set (added,
	// changed, or removed files), the recorded stg/prod evidence no longer
	// matches the diff that will land -> escalate instead of landing it.
	const migStale = (() => {
		if (migScope === undefined || migrationRows.length === 0) return false;
		const scopeFiles = new Set(migScope.files);
		// Latest real poll AFTER the scope existed; compare sets exactly
		// (removal also diverges - evidence was recorded for a diff that no
		// longer exists).
		const latestPoll = [...readyPollRows]
			.filter((row) => row.poll >= 0 && row.at > migScope.capturedAt)
			.pop();
		if (latestPoll === undefined) return false;
		const current = latestPoll.migrationFiles ?? [];
		if (current.length !== scopeFiles.size) return true;
		return current.some((file) => !scopeFiles.has(file));
	})();

	// -- merge authorization -----------------------------------------------------
	// A round authorizes the receipt node only after its approved stamp has
	// survived the merge attempt's last-instant head comparison. A mismatch is
	// persisted as ok=false and ends the round before any MQ command runs.
	const stampedRound = (() => {
		for (let k = 0; k <= currentRound && k < limits.stampRounds; k++) {
			const stamp = ctx.latest(outputs.approvals, `r${k}-stamp`);
			const validity = ctx.latest(outputs.stampValidity, `r${k}-stamp-validity`);
			const headCheck = ctx.latest(outputs.mergeHeadCheck, `r${k}-merge-head-check`);
			if (stamp?.approved === true && validity?.valid === true && headCheck?.ok !== false) {
				return {
					round: k,
					headSha: validity.stampedHead,
					cars: validity.cars?.map((car) => ({
						prNumber: car.prNumber,
						branch: car.branch,
						baseBranch: car.baseBranch,
						headSha: car.headSha,
					})),
					headCheck,
				};
			}
		}
		return null;
	})();
	const authorizedRound =
		stampedRound !== null && stampedRound.headCheck?.ok === true
			? {
					round: stampedRound.round,
					headSha: stampedRound.headSha,
					headCheck: stampedRound.headCheck,
					cars: stampedRound.cars,
				}
			: null;

	const mergeReceipt = ctx.latest(outputs.mergeReceipt, "enqueue-merge");
	const latestQueue = ctx.latest(outputs.queuePoll, "queue-poll");
	const queueRows = (ctx.outputs.queuePoll ?? []) as Array<{
		poll: number;
		state: string;
		baseBranch: string;
		autoMergeRequest: boolean;
		ejected: boolean;
		cars?: Array<{
			prNumber: number;
			state: "open" | "closed";
			autoMergeRequest: boolean;
			ejected: boolean;
		}>;
	}>;
	const latestLanding = ctx.latest(outputs.landingPoll, "landing-poll");
	const landingRows = (ctx.outputs.landingPoll ?? []) as Array<{ poll: number; landed: boolean }>;
	const stackSync = ctx.latest(outputs.stackSync, "stack-sync-prune");
	const deploy = ctx.latest(outputs.deployEvidence, "deploy-evidence");
	const falloutWindow = ctx.latest(outputs.falloutWindow, "fallout-window");
	const falloutWait = ctx.latest(outputs.falloutWait, "fallout-wait");

	// -- agents (real mode only) --------------------------------------------------
	const reviewerModel = (() => {
		try {
			return resolveAdversary(policy.implementer, policy);
		} catch {
			return "unresolvable";
		}
	})();
	const repoLabel = input.repo.split("/").pop() ?? input.repo;
	const ticketLabel = input.ticket.replace(/^[^0-9]*/, "") || input.ticket;
	const effortLabel = `${repoLabel}#${ticketLabel}`;
	const modelViolationsAtRender = validateModelPolicy(policy);
	const agents = dryRun || (seatEngine === "prime" && modelViolationsAtRender.length > 0)
		? null
		: {
				implementer: makeAgent(seatEngine, policy.implementer, input.worktree, 45 * 60_000, effortLabel, policy.reasoningImplementer),
				reviewer: makeAgent(seatEngine, { model: reviewerModel, reasoning: seat(policy.reviewer ?? reviewerModel).reasoning }, input.worktree, 20 * 60_000, effortLabel, policy.reasoningReviewer),
				watcher: makeAgent(seatEngine, policy.watcher, input.worktree, 30 * 60_000, effortLabel, policy.reasoningWatcher),
				fallout: makeAgent(seatEngine, policy.fallout, input.worktree, 15 * 60_000, effortLabel, policy.reasoningFallout),
			};

	// -- approval gate helper (bypass only allowed with dryRun; preflight enforces) --
	const Gate = (props: {
		id: string;
		title: string;
		summary: string;
		metadata?: Record<string, unknown>;
		originalIssue?: string;
		proposedAction?: string;
		blastRadius?: string;
	}) => {
		if (bypass) {
			return (
				<Task id={props.id} output={outputs.approvals}>
					{() => ({
						approved: true,
						note: "bypassApprovals (dry-run test mode)",
						decidedBy: "bypass",
						decidedAt: nowIso(),
					})}
				</Task>
			);
		}
		const stamp = /^r\d+-stamp$/.test(props.id);
		const prNumber = pr?.prNumber ?? input.existingPr;
		const headSha =
			typeof props.metadata?.headSha === "string"
				? props.metadata.headSha
				: pr?.headSha;
		const prContext: PrQuestionContext = {
			...(pr?.url === undefined ? {} : { prUrl: pr.url }),
			prRepo: input.repo,
			...(prNumber === undefined ? {} : { prNumber }),
			...(headSha === undefined ? {} : { headSha }),
			originalIssue: brief?.summary ?? props.title,
			ourFix: implementation?.summary ?? "The pipeline reached this human decision gate.",
			whyCorrect: props.summary,
			workflowDir,
			workflowFile: "pipeline.tsx",
		};
		const resumeHint =
			`Answer through deck-questions or the Smithers Gateway for run ${ctx.runId}, node ${props.id}. ` +
			`If the engine is detached: smithers up pipeline.tsx --run-id ${ctx.runId} --resume true`;
		askWorkflowQuestion(questionsFile, {
			runId: ctx.runId,
			nodeId: props.id,
			answerLane: "smithers-approval",
			resumeHint,
			originalIssue: props.originalIssue ?? props.summary,
			proposedAction: props.proposedAction ?? (
				stamp
					? `Stamp the reviewed head ${headSha ?? "unknown"} and release PR #${prNumber ?? "pending"} to the merge boundary.`
					: `Approve this gate to release the next pipeline stage, or deny it to stop the run.`
			),
			blastRadius: props.blastRadius ?? (
				stamp
					? `Only PR #${prNumber ?? "pending"} at ${headSha ?? "the recorded head"}; any head change invalidates this stamp before merge.`
					: `Only run ${ctx.runId} at node ${props.id} and PR #${prNumber ?? "pending"}; approval advances it and denial fails it.`
			),
			cwd: workflowDir,
			prNumber,
			prContext,
			approvalValue: props.metadata,
			questionKind: stamp ? "stamp" : "approve",
			options: stamp ? ["Stamp", "Hold", "Deny gate"] : ["Approve", "Hold", "Deny gate"],
			actions: stamp
				? ["stamp", "hold", "deny-gate"]
				: ["approve", "hold", "deny-gate"],
			recommendation: stamp ? "Hold until the recorded head and evidence are reviewed." : "Approve only if the stated issue, action, and blast radius are acceptable.",
		});
		return (
			<Approval
				id={props.id}
				output={outputs.approvals}
				request={{ title: props.title, summary: props.summary, metadata: props.metadata }}
				onDeny="fail"
			/>
		);
	};

	// -- reviewApproved gate for push -----------------------------------------------
	const reviewApproved = latestLocalReview?.approved === true;
	const reviewExhausted =
		(localReviewRows.length >= limits.localReviewRounds || repeatedLocalFinding) &&
		!reviewApproved;
	const pushAllowed = reviewApproved || reviewEscalation?.approved === true;
	const producerWatch = ctx.latest(outputs.watchPoll, `r${currentRound}-watch-poll`);
	const coordinationRoot = path.join(smithersWorkspaceCwd(), ".deck-coordination");
	const mainFingerprint = `${input.repo}:${baseBranch}`;
	const mainFailureClaimed = producerWatch?.ci === "red"
		? claimMainFailure(coordinationRoot, mainFingerprint, input.ticket)
		: (releaseMainFailure(coordinationRoot, mainFingerprint), false);
	publishWakeProducer({
		dryRun: wakeDryRun,
		snapshot: {
			taskId: input.ticket,
			maxAdversarial: reviewExhausted && !pushAllowed,
			reviewerSilent: producerWatch?.disposition === "wait" && producerWatch?.poll >= 3,
			mainRed: producerWatch?.ci === "red" && mainFailureClaimed,
			migrationBlocked: migRequired && anyWatchSettled && migGate === undefined,
			brokerNoQuota: process.env.DECK_BROKER_NO_QUOTA === "1" || (() => {
				try {
					const roster = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".deck", "broker", "usage.json"), "utf8")) as { reports?: Array<{ limits?: Array<{ amount?: { remainingFraction?: number } }> }> };
					return (roster.reports ?? []).some((report) => (report.limits ?? []).some((limit) => limit.amount?.remainingFraction === 0));
				} catch { return false; }
			})(),
			needsDecision: preflight !== undefined && !preflight.ok
				? `PREFLIGHT REFUSED: ${preflight.openQuestions.join("; ")}`
				: undefined,
		},
	});

	// ===========================================================================
	// Render
	// ===========================================================================
	return (
		<Workflow name="lindy-pr-pipeline">
			<Parallel maxConcurrency={4}>
				{/* ------------------------------------------------ stage 0: preflight */}
				<Task id="preflight" output={outputs.preflight} retries={0}>
					{() => {
						const validated = validateBrief(input.brief);
						const questions: string[] = validated.ok ? [] : [...validated.openQuestions];
						const modelViolations = validateModelPolicy(policy);
						questions.push(...modelViolations);
						if (profileUnknown) {
							questions.push(
								`unknown project profile "${input.profile}": not in config/projects.json (deck home) or the built-in seeds.`,
							);
						}
						if (profileRepoMismatch) {
							questions.push(
								`profile "${profile?.id}" belongs to repo ${profile?.repo}, not ${input.repo}: a profile's yolo/stamp policy may never be attached to another repo.`,
							);
						}
						if (bypass && !dryRun) {
							questions.push(
								"bypassApprovals=true requires dryRun=true: no real run may self-approve its gates.",
							);
						}
						if (input.existingPr !== undefined && stackMode) {
							questions.push("existingPr and stack are mutually exclusive; declare one effort shape.");
						}
						if (stackCreateSpecs !== undefined) {
							try {
								const normalized = normalizeStackSpecs(declaredBaseBranch, stackCreateSpecs);
								const top = normalized.at(-1)?.branch;
								if (top !== input.branch) {
									questions.push(
										`stack top branch "${top ?? "(missing)"}" must equal checked-out input.branch "${input.branch}".`,
									);
								}
							} catch (error) {
								questions.push(error instanceof Error ? error.message : String(error));
							}
						}
						if (
							stackExistingNumbers !== undefined &&
							new Set(stackExistingNumbers).size !== stackExistingNumbers.length
						) {
							questions.push("stack.existingPrNumbers contains a duplicate PR number.");
						}
						if (!dryRun) {
							const worktreeExists = require("node:fs").existsSync(input.worktree);
							if (!worktreeExists) {
								questions.push(`worktree does not exist on disk: ${input.worktree}`);
							}

						}
						let resolvedReviewer = "unresolvable";
						try {
							resolvedReviewer = resolveAdversary(policy.implementer, policy);
						} catch {
							/* violation already recorded by validateModelPolicy */
						}
						return {
							ok: questions.length === 0,
							openQuestions: questions,
							briefDigest: validated.ok
								? `${validated.brief.ticket}: ${validated.brief.title} | kill-switch: ${JSON.stringify(validated.brief.killSwitch)} | break-signal: ${validated.brief.breakSignal}`
								: "(invalid brief)",
							resolvedReviewerModel: resolvedReviewer,
						};
					}}
				</Task>

				{preflight !== undefined && !preflight.ok ? (
					<Task id="preflight-refusal" output={outputs.preflight} retries={0}>
						{() => {
							const reason = `PREFLIGHT REFUSED - the brief is not dispatchable. Open questions:\n` +
								preflight.openQuestions.map((question) => `  - ${question}`).join("\n") +
								`\nResolve every item and start a NEW run (input is immutable).`;
							publishWakeProducer({ dryRun: wakeDryRun, snapshot: { taskId: input.ticket, needsDecision: reason } });
							throw new Error(reason);
						}}
					</Task>
				) : null}

				{preflight?.ok === true && adopt ? (
					<Task id="adopt-base" output={outputs.adoptBase} retries={1}>
						{() => (async () => {
							if (stackExistingNumbers !== undefined) {
								if (dryRun) {
									const branches = stackExistingNumbers.map((number, index) =>
										index === stackExistingNumbers.length - 1
											? input.branch
											: `${input.branch}-car-${index + 1}`,
									);
									const cars = stackExistingNumbers.map((number, index) => ({
										prNumber: number,
										url: `https://github.com/${input.repo}/pull/${number}`,
										branch: branches[index],
										baseBranch: index === 0 ? declaredBaseBranch : branches[index - 1],
										headSha: `dryrun-head-sha-${number}`,
										landed: false,
									}));
									return { baseBranch: declaredBaseBranch, cars };
								}
								const live = await fetchAdoptedPrs(
									bunExec,
									input.repo,
									stackExistingNumbers,
									github.gh,
								);
								const rootBaseBranch = input.baseBranch ?? live[0]?.baseRefName ?? "main";
								const cars = validateAdoptedStack(
									input.repo,
									rootBaseBranch,
									stackExistingNumbers,
									live,
								);
								await execOrThrow(
									bunExec,
									[github.git, "ls-remote", "--exit-code", "--heads", "origin", rootBaseBranch],
									{ cwd: input.worktree },
								);
								return { baseBranch: rootBaseBranch, cars };
							}
							if (dryRun) return { baseBranch: declaredBaseBranch };
							const overview = await fetchPrOverview(ghCtx, input.existingPr as number);
							const baseBranch = reconcileAdoptBaseBranch(input.baseBranch, overview.baseRefName);
							await execOrThrow(bunExec, [github.git, "ls-remote", "--exit-code", "--heads", "origin", baseBranch], { cwd: input.worktree });
							return { baseBranch };
						})()}
					</Task>
				) : null}

				{/* ------------------------------------------------ stage 1: implement */}
				{/* Adopt path: the code already lives on the PR. The implement node
				    still runs (downstream gates key off its row) but as a stub compute
				    task — no agent, no greenfield work. */}
				{preflight?.ok === true && brief !== null && adopt && adoptedBase !== undefined ? (
					<Task id="implement" output={outputs.implementation} retries={0}>
						{() => {
							const numbers = adoptedBase.cars?.map((car) => car.prNumber) ??
								[input.existingPr as number];
							return {
								commits: [],
								summary: `adopted existing ${numbers.length === 1 ? `PR #${numbers[0]}` : `ordered stack ${numbers.map((number) => `#${number}`).join(" → ")}`}: implementation lives on GitHub`,
								testEvidence: "adopted effort: CI on every existing PR is the evidence",
							};
						}}
					</Task>
				) : null}
				{preflight?.ok === true && brief !== null && !adopt ? (
					<Task
						id="implement"
						output={outputs.implementation}
						agent={dryRun ? undefined : agents?.implementer}
						retries={1}
					>
						{dryRun
							? () => {
									if (stackCreateSpecs !== undefined) {
										return {
											commits: [],
											summary: `dry-run: implemented stack for "${brief.title}"`,
											testEvidence: "dry-run: stack tests simulated green",
											stackCars: stackCreateSpecs.map((spec, index) => ({
												branch: spec.branch,
												commits: [`dryrun-stack-commit-${index + 1}`],
												testEvidence: "dry-run: tests simulated green",
											})),
										};
									}
									return {
										commits: ["dryrun-commit-1"],
										summary: `dry-run: implemented "${brief.title}"`,
										testEvidence: "dry-run: tests simulated green",
									};
								}
							: stackCreateSpecs !== undefined
								? stackImplementPrompt(brief, input.worktree, declaredBaseBranch, stackCreateSpecs)
								: implementPrompt(brief, input.worktree, input.branch)}
					</Task>
				) : null}

				{/* ---------------------------------- stage 2: local adversarial review */}
				{/* Adopt skips implementation only; local adversarial review remains mandatory. */}
				{implementation !== undefined && brief !== null ? (
					<Loop
						id="local-review-loop"
						until={latestLocalReview?.approved === true || repeatedLocalFinding}
						maxIterations={limits.localReviewRounds}
						onMaxReached="return-last"
					>
						<Sequence>
							<Task
								id="local-review"
								output={outputs.localReview}
								agent={dryRun ? undefined : agents?.reviewer}
								maxSchemaRetries={5}
								retries={1}
							>
								{dryRun
									? () => {
											const round = localReviewRows.length;
											const approved = round + 1 >= fixtures.localReviewRounds;
											const nitsOnly = fixtures.localReviewNitsOnly === true;
											const blockingFindings = approved || nitsOnly ? [] : [`dry-run finding in round ${round}`];
											return {
												round,
												approved: blockingFindings.length === 0,
												blockingFindings,
												nits: nitsOnly ? [`dry-run nit in round ${round}`] : [],
												summary: blockingFindings.length === 0
													? "dry-run: adversarial review approved"
													: "dry-run: blocking findings",
											};
										}
									: localReviewPrompt(
												brief,
												input.worktree,
												baseBranch,
												localReviewRows.length,
												latestLocalReview,
											)}
							</Task>
							{latestLocalReview !== undefined &&
							!latestLocalReview.approved &&
							latestLocalReview.blockingFindings.length > 0 &&
							!repeatedLocalFinding &&
							(latestLocalFix === undefined || latestLocalFix.afterRound < latestLocalReview.round) ? (
								<Task
									id="local-fix"
									output={outputs.localFix}
									agent={dryRun ? undefined : agents?.implementer}
									retries={1}
								>
									{dryRun
										? () => ({
												afterRound: latestLocalReview.round,
												addressed: latestLocalReview.blockingFindings,
												summary: "dry-run: findings addressed",
											})
										: localFixPrompt(latestLocalReview.blockingFindings, input.worktree, latestLocalReview.round)}
								</Task>
							) : null}
						</Sequence>
					</Loop>
				) : null}

				{reviewExhausted && !pushAllowed ? (
					<Gate
						id="review-escalation"
						title={`Local review not converging: ${input.ticket}`}
						summary={
							`Adversarial review did not approve after ${localReviewRows.length} round(s).\n` +
							`Blocking findings remain: ${JSON.stringify(latestLocalReview?.blockingFindings ?? [])}\n` +
							`Non-blocking nits: ${JSON.stringify(latestLocalReview?.nits ?? [])}\n` +
							`Approve to push anyway (blocking findings become PR-review work); deny to kill the run.`
						}
					/>
				) : null}

				{/* ------------------------------------------------ stage 3: push + PR */}
				{implementation !== undefined && pushAllowed ? (
					<Task id="push-pr" output={outputs.prRecord} retries={1}>
						{() =>
							(async () => {
								if (adopt) {
									// Adopt: verify and seed the live PR. Never create a second PR.
									if (stackExistingNumbers !== undefined) {
										const seededCars = adoptedBase?.cars ?? [];
										const seededTop = seededCars.at(-1);
										if (seededTop === undefined) {
											throw new Error("[escalate] adopted stack validation produced no cars.");
										}
										if (dryRun) {
											return {
												prNumber: seededTop.prNumber,
												url: seededTop.url,
												headSha: seededTop.headSha,
												baseBranch: adoptedBase?.baseBranch ?? declaredBaseBranch,
												watchSetRegistered: true,
												watchSetPath: "(dry-run: not written)",
												receipt: `dry-run: adopted stack ${seededCars.map((car) => `#${car.prNumber}`).join(" → ")}`,
												createdAt: nowIso(),
												cars: seededCars,
											};
										}
										await assertLocalStackTracking(bunExec, {
											gh: github.gh,
											worktree: input.worktree,
											rootBaseBranch: adoptedBase?.baseBranch ?? declaredBaseBranch,
											cars: seededCars,
											allowTopAhead: true,
										});
										const [worktreeBranch, worktreeHead, worktreeOriginUrl] =
											await Promise.all([
												execOrThrow(
													bunExec,
													[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
													{ cwd: input.worktree },
												).then((value) => value.trim()),
												execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
													cwd: input.worktree,
												}).then((value) => value.trim()),
												execOrThrow(
													bunExec,
													[github.git, "remote", "get-url", "origin"],
													{ cwd: input.worktree },
												).then((value) => value.trim()),
											]);
										cleanKnownScratchFiles(input.worktree);
										const worktreeStatus = await execOrThrow(
											bunExec,
											[github.git, "status", "--porcelain"],
											{ cwd: input.worktree },
										);
										const topOverview = await fetchPrOverview(ghCtx, seededTop.prNumber);
										const ancestor = worktreeHead === topOverview.headSha
											? null
											: await bunExec(
													[github.git, "merge-base", "--is-ancestor", topOverview.headSha, worktreeHead],
													{ cwd: input.worktree },
												);
										const worktreeIsDescendant = ancestor === null || ancestor.code === 0;
										assertAdoptable(topOverview, {
											repo: input.repo,
											branch: seededTop.branch,
											baseBranch: seededTop.baseBranch,
											worktreeBranch,
											worktreeHead,
											worktreeStatus,
											worktreeOriginUrl,
											allowWorktreeAhead: true,
											worktreeIsDescendant,
										});
										if (
											worktreeHead !== topOverview.headSha &&
											decideAdoptPush({
												worktreeHead,
												prHead: topOverview.headSha,
												isAncestor: worktreeIsDescendant,
											}) !== "push"
										) {
											throw new Error(
												`[escalate] adopted stack worktree ${worktreeHead} is not a descendant of top PR head ${topOverview.headSha}.`,
											);
										}
										if (worktreeHead !== topOverview.headSha) {
											await execOrThrow(
												bunExec,
												[github.gh, "stack", "push"],
												{ cwd: input.worktree },
											);
										}
										const refreshedLive = await fetchAdoptedPrs(
											bunExec,
											input.repo,
											stackExistingNumbers,
											github.gh,
										);
										const cars = validateAdoptedStack(
											input.repo,
											adoptedBase?.baseBranch ?? declaredBaseBranch,
											stackExistingNumbers,
											refreshedLive,
										);
										const top = cars.at(-1);
										if (top === undefined || top.headSha !== worktreeHead) {
											throw new Error(
												`[escalate] adopted stack top did not advance to verified worktree HEAD ${worktreeHead}.`,
											);
										}
										registerWatchCars({
											watchSetPath,
											ticket: input.ticket,
											repo: input.repo,
											runId: ctx.runId,
											cars,
										});
										return {
											prNumber: top.prNumber,
											url: top.url,
											headSha: top.headSha,
											baseBranch: adoptedBase?.baseBranch ?? declaredBaseBranch,
											watchSetRegistered: true,
											watchSetPath,
											receipt: `adopted existing stack ${cars.map((car) => `#${car.prNumber}@${car.headSha}`).join(" → ")}`,
											createdAt: nowIso(),
											cars,
										};
									}
									const prNumber = input.existingPr as number;
									if (dryRun) {
										return {
											prNumber,
											url: `https://github.com/${input.repo}/pull/${prNumber}`,
											headSha: "dryrun-head-sha",
											baseBranch: declaredBaseBranch,
											watchSetRegistered: true,
											watchSetPath: "(dry-run: not written)",
											receipt: `dry-run: adopted existing PR #${prNumber}`,
											createdAt: nowIso(),
											runId: ctx.runId,
										};
									}
									let overview = await fetchPrOverview(ghCtx, prNumber);
									const adoptedBaseBranch = reconcileAdoptBaseBranch(
										adoptedBase?.baseBranch ?? input.baseBranch,
										overview.baseRefName,
									);
									await execOrThrow(
										bunExec,
										[github.git, "ls-remote", "--exit-code", "--heads", "origin", adoptedBaseBranch],
										{ cwd: input.worktree },
									);
									// The local and watch fixers commit/push, and enqueue-merge runs
									// in THIS worktree. Verify the branch, repository, and clean state;
									// a clean descendant is allowed when local review fixed the PR.
									const worktreeBranch = (
										await execOrThrow(
											bunExec,
											[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
											{ cwd: input.worktree },
										)
									).trim();
									const worktreeHead = (
										await execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
											cwd: input.worktree,
										})
									).trim();
									cleanKnownScratchFiles(input.worktree);
					const worktreeStatus = await execOrThrow(
										bunExec,
										[github.git, "status", "--porcelain"],
										{ cwd: input.worktree },
									);
									const worktreeOriginUrl = (
										await execOrThrow(
											bunExec,
											[github.git, "remote", "get-url", "origin"],
											{ cwd: input.worktree },
										)
									).trim();
									const ancestor = worktreeHead === overview.headSha ? null : await bunExec(
										[github.git, "merge-base", "--is-ancestor", overview.headSha, worktreeHead],
										{ cwd: input.worktree },
									);
									const worktreeIsDescendant = ancestor === null || ancestor.code === 0;
									assertAdoptable(overview, {
										repo: input.repo,
										branch: input.branch,
										baseBranch: adoptedBaseBranch,
										worktreeBranch,
										worktreeHead,
										worktreeStatus,
										worktreeOriginUrl,
										allowWorktreeAhead: true,
										worktreeIsDescendant,
									});
									if (worktreeHead !== overview.headSha) {
										const decision = decideAdoptPush({
											worktreeHead,
											prHead: overview.headSha,
											isAncestor: worktreeIsDescendant,
										});
										if (decision === "escalate") {
											throw new Error(
												`[escalate] adopted worktree HEAD ${worktreeHead} is not ahead of PR head ${overview.headSha}; refusing to overwrite the PR branch.`,
											);
										}
										await execOrThrow(
											bunExec,
											[
												github.git,
												"push",
												"--no-verify",
												"origin",
												input.branch,
											],
											{ cwd: input.worktree },
										);
										const pushedHead = (
											await execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
												cwd: input.worktree,
											})
									).trim();
										for (let attempt = 0; attempt < 3; attempt++) {
											overview = await fetchPrOverview(ghCtx, prNumber);
											if (pushedHead === overview.headSha) break;
											if (attempt < 2) await Bun.sleep(250);
										}
										if (pushedHead !== overview.headSha) {
											throw new Error(
													`[escalate] existing PR #${prNumber} did not advance to local HEAD ${pushedHead} after the push.`,
												);
										}
									}
									const fs = await import("node:fs");
									const path = await import("node:path");
									fs.mkdirSync(path.dirname(watchSetPath), { recursive: true });
									fs.appendFileSync(
										watchSetPath,
										`${JSON.stringify({
											ticket: input.ticket,
											repo: input.repo,
											pr: prNumber,
											url: overview.url,
											registeredAt: nowIso(),
											runId: ctx.runId,
										})}\n`,
									);
									return {
										prNumber,
										url: overview.url,
										headSha: overview.headSha,
										baseBranch: adoptedBaseBranch,
										watchSetRegistered: true,
										watchSetPath,
										receipt: `adopted existing PR #${prNumber} (head ${overview.headSha})`,
										createdAt: nowIso(),
										runId: ctx.runId,
									};
								}
								if (stackCreateSpecs !== undefined) {
									const specs = normalizeStackSpecs(declaredBaseBranch, stackCreateSpecs);
									if (dryRun) {
										const numbers =
											fixtures.stackPrNumbers.length === specs.length
												? fixtures.stackPrNumbers
												: specs.map((_, index) => fixtures.prNumber + index);
										const cars = specs.map((spec, index) => ({
											prNumber: numbers[index],
											url: `https://github.com/${input.repo}/pull/${numbers[index]}`,
											branch: spec.branch,
											baseBranch: spec.baseBranch,
											headSha: `dryrun-head-sha-${numbers[index]}`,
											landed: false,
										}));
										const top = cars[cars.length - 1];
										return {
											prNumber: top.prNumber,
											url: top.url,
											headSha: top.headSha,
											baseBranch: declaredBaseBranch,
											watchSetRegistered: true,
											watchSetPath: "(dry-run: not written)",
											receipt: `dry-run: submitted native stack ${cars.map((car) => `#${car.prNumber}`).join(" → ")}`,
											createdAt: nowIso(),
											cars,
										};
									}
									if (implementation.stackCars === undefined) {
										throw new Error(
											"[escalate] stack implementer did not report per-car commit attribution.",
										);
									}
									cleanKnownScratchFiles(input.worktree);
									const worktreeStatus = await execOrThrow(
										bunExec,
										[github.git, "status", "--porcelain"],
										{ cwd: input.worktree },
									);
									if (worktreeStatus.trim() !== "") {
										throw new Error(
											`[escalate] stack worktree is dirty before publication:\n${worktreeStatus.trim()}`,
										);
									}
									const verified = await verifyStackImplementation(bunExec, {
										git: github.git,
										worktree: input.worktree,
										rootBaseBranch: declaredBaseBranch,
										specs: stackCreateSpecs,
										reported: implementation.stackCars,
									});
									const stackDescriptions: Array<{ title: string; body: string }> = [];
									for (let index = 0; index < specs.length; index += 1) {
										const spec = specs[index];
										const changedFiles = (
											await execOrThrow(
												bunExec,
												[github.git, "diff", "--name-only", `${spec.baseBranch}...${spec.branch}`],
												{ cwd: input.worktree },
											)
										)
											.split("\n")
											.map((file) => file.trim())
											.filter(Boolean);
										const descriptionInput = sanitizeDescriptionInput({
											title: formatPullRequestTitle(
												input.ticket,
												spec.title ?? `${brief?.title ?? input.ticket} (${index + 1}/${specs.length})`,
											),
											summary: spec.body ?? brief?.summary ?? "",
											acceptanceCriteria: brief?.acceptanceCriteria ?? [],
											testing: implementation.stackCars[index].testEvidence,
											reviewOutcome: latestLocalReview?.summary,
											changedFiles,
										});
										stackDescriptions.push({
											title: descriptionInput.title,
											body: generatePullRequestDescription(descriptionInput),
										});
									}
									const cars = await submitStack(bunExec, {
										gh: github.gh,
										repo: input.repo,
										worktree: input.worktree,
										rootBaseBranch: declaredBaseBranch,
										specs: stackCreateSpecs,
									});
									for (let index = 0; index < cars.length; index += 1) {
										const car = cars[index];
										if (car.headSha !== verified[index].headSha) {
											throw new Error(
												`[escalate] submitted stack PR #${car.prNumber} head ${car.headSha} does not match verified branch head ${verified[index].headSha}.`,
											);
										}
										const description = stackDescriptions[index];
										if (description === undefined) {
											throw new Error(`[escalate] missing validated description for stack car ${index + 1}.`);
										}
										await execOrThrow(
											bunExec,
											[
												github.gh,
												"pr",
												"edit",
												String(car.prNumber),
												"--repo",
												input.repo,
												"--title",
												description.title,
												"--body",
												description.body,
											],
											{ cwd: input.worktree },
										);
									}
									registerWatchCars({
										watchSetPath,
										ticket: input.ticket,
										repo: input.repo,
										runId: ctx.runId,
										cars,
									});
									const top = cars[cars.length - 1];
									return {
										prNumber: top.prNumber,
										url: top.url,
										headSha: top.headSha,
										baseBranch: declaredBaseBranch,
										watchSetRegistered: true,
										watchSetPath,
										receipt: `submitted native stack ${cars.map((car) => `#${car.prNumber}@${car.headSha}`).join(" → ")}`,
										createdAt: nowIso(),
										cars,
									};
								}
								if (dryRun) {
									return {
										prNumber: fixtures.prNumber,
										url: `https://github.com/${input.repo}/pull/${fixtures.prNumber}`,
										headSha: "dryrun-head-sha",
										baseBranch: declaredBaseBranch,
										watchSetRegistered: true,
										watchSetPath: "(dry-run: not written)",
										receipt: "dry-run push receipt",
										createdAt: nowIso(),
									};
								}
								// 1. push the branch (idempotent).
								await execOrThrow(
									bunExec,
									[github.git, "fetch", "origin", baseBranch],
									{ cwd: input.worktree },
								);
								const [publishedLocalHead, actualCommitText] = await Promise.all([
									execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
										cwd: input.worktree,
									}).then((value) => value.trim()),
									execOrThrow(
										bunExec,
										[
											github.git,
											"rev-list",
											"--reverse",
											`origin/${baseBranch}..HEAD`,
										],
										{ cwd: input.worktree },
									),
								]);
								const actualCommits = actualCommitText
									.split("\n")
									.map((sha) => sha.trim())
									.filter(Boolean);
								const reportedCommits = await Promise.all(
									implementation.commits.map((sha) =>
										execOrThrow(
											bunExec,
											[github.git, "rev-parse", "--verify", `${sha}^{commit}`],
											{ cwd: input.worktree },
										).then((value) => value.trim()),
									),
								);
								if (
									actualCommits.length !== reportedCommits.length ||
									actualCommits.some((sha, index) => sha !== reportedCommits[index])
								) {
									throw new Error(
										`[escalate] implementation reported commits ${JSON.stringify(reportedCommits)}, ` +
											`but origin/${baseBranch}..HEAD is ${JSON.stringify(actualCommits)}; refusing initial publication.`,
									);
								}
								await execOrThrow(
									bunExec,
									[github.git, "push", "-u", "origin", input.branch],
									{ cwd: input.worktree },
								);
								// 2. find-or-create the PR (idempotent across retries).
								const listOut = await execOrThrow(bunExec, [
									github.gh, "pr", "list",
									"--repo", input.repo,
									"--head", input.branch,
									"--state", "open",
									"--json", "number,url",
								]);
								const existing = JSON.parse(listOut) as Array<{ number: number; url: string }>;
								let prNumber: number;
								let url: string;
								if (existing.length > 0) {
									prNumber = existing[0].number;
									url = existing[0].url;
								} else {
									// Reviewers are NOT requested here: request-reviewers owns
									// that (create --reviewer is the silent-no-op path with no
									// verification read).
									const descriptionInput = sanitizeDescriptionInput({
										title: formatPullRequestTitle(input.ticket, brief?.title ?? input.ticket),
										summary: brief?.summary ?? "",
										acceptanceCriteria: brief?.acceptanceCriteria ?? [],
										testing: implementation.testEvidence,
										reviewOutcome: latestLocalReview?.summary,
										changedFiles: dryRun ? fixtures.changedFiles : await changedFilesForBranch(bunExec, input.worktree, baseBranch),
									});
									const createOut = await execOrThrow(bunExec, [
										github.gh, "pr", "create",
										"--repo", input.repo,
										"--head", input.branch,
										"--base", baseBranch,
										"--title", descriptionInput.title,
										"--body",
										generatePullRequestDescription(descriptionInput),
									]);
									url = createOut.trim().split("\n").pop() ?? "";
									const match = url.match(/\/pull\/(\d+)/);
									if (match === null) throw new Error(`could not parse PR number from: ${url}`);
									prNumber = Number(match[1]);
								}
								const headSha = await fetchHeadSha(ghCtx, prNumber);
								if (headSha !== publishedLocalHead) {
									throw new Error(
										`[escalate] PR #${prNumber} head moved to ${headSha} after publishing ` +
											`local HEAD ${publishedLocalHead}; refusing to register an unattributed PR state.`,
									);
								}
								// 3. register in the watch-set (side effect of THIS node; nothing untracked).
								const fs = await import("node:fs");
								const path = await import("node:path");
								fs.mkdirSync(path.dirname(watchSetPath), { recursive: true });
								fs.appendFileSync(
									watchSetPath,
									`${JSON.stringify({
										ticket: input.ticket,
										repo: input.repo,
										pr: prNumber,
										url,
										registeredAt: nowIso(),
										runId: ctx.runId,
									})}\n`,
								);
								return {
									prNumber,
									url,
									headSha,
									baseBranch: declaredBaseBranch,
									watchSetRegistered: true,
									watchSetPath,
									receipt: `pushed ${input.branch}; PR #${prNumber}`,
									createdAt: nowIso(),
								};
							})()
						}
					</Task>
				) : null}

				{/* ------------------------------- stage 3b: request reviewers */}
				{pr !== undefined ? (
					<Task id="request-reviewers" output={outputs.reviewerRequest} retries={1}>
						{() =>
							(async () => {
								if (github.skipReviewerRequest) {
									return {
										skipped: true,
										requested: [],
										verified: [],
										source: "explicit-skip",
										at: nowIso(),
										reviewerPrompt: reviewersDecisionPrompt(github.reviewerDenylist),
										...(stackMode
											? { cars: effortCars.map((car) => ({ prNumber: car.prNumber, requested: [], verified: [] })) }
											: {}),
									};
								}
								if (dryRun) {
									return {
										skipped: false,
										requested: ["dry-reviewer"],
										verified: ["dry-reviewer"],
										source: "dry-run",
										at: nowIso(),
										reviewerPrompt: reviewersDecisionPrompt(github.reviewerDenylist),
										...(stackMode
											? {
													cars: effortCars.map((car) => ({
														prNumber: car.prNumber,
														requested: ["dry-reviewer"],
														verified: ["dry-reviewer"],
													})),
												}
											: {}),
									};
								}
								const carResults: Array<{
									prNumber: number;
									requested: string[];
									verified: string[];
									source: string;
									skippedNonCollaborators?: string[];
								}> = [];
								for (const car of effortCars) {
									const result = await executeReviewerRequest(
										{
											explicit: [...(brief?.suggestedReviewers ?? []), ...github.reviewers],
											exclude: [...github.selfLogins, ...github.excludedApprovers],
											denylist: github.reviewerDenylist,
											max: github.maxReviewers,
										},
										{
											fetchChangedFiles: () => fetchChangedFiles(ghCtx, car.prNumber),
											fetchCodeowners: () => fetchCodeowners(ghCtx),
											fetchRecentAuthors: (files) => fetchRecentAuthors(ghCtx, files),
											resolveLogin: (entry) => resolveReviewerLogin(ghCtx, entry),
											isCollaborator: (login) => isCollaborator(ghCtx, login),
											logSkip: (login, reason) => console.warn(`[reviewer-skip] ${login}: ${reason}`),
											requestReviewers: (logins) => requestReviewers(ghCtx, car.prNumber, logins),
											fetchRequestedReviewers: () => fetchRequestedReviewers(ghCtx, car.prNumber),
										},
									);
									carResults.push({ prNumber: car.prNumber, ...result });
								}
								const requested = [...new Set(carResults.flatMap((result) => result.requested))];
								const verified = [...new Set(carResults.flatMap((result) => result.verified))];
								return {
									skipped: false,
									requested,
									verified,
									skippedNonCollaborators: [
										...new Set(carResults.flatMap((result) => result.skippedNonCollaborators ?? [])),
									],
									source: stackMode ? "per-car stack routing" : carResults[0]?.source ?? "selection",
									at: nowIso(),
									reviewerPrompt: reviewersDecisionPrompt(github.reviewerDenylist),
									...(stackMode
										? {
												cars: carResults.map((result) => ({
													prNumber: result.prNumber,
													requested: result.requested,
													verified: result.verified,
												})),
											}
										: {}),
								};
							})()
						}
					</Task>
				) : null}

				{/* -------------------------------- stage 5 (conditional): migration gate */}
				{pr !== undefined ? (
					<Task id="migration-check" output={outputs.migrationCheck} retries={1}>
						{() =>
							(async () => {
								const files = dryRun
									? fixtures.changedFiles
									: [
											...new Set(
												(await Promise.all(
													effortCars.map((car) => fetchChangedFiles(ghCtx, car.prNumber)),
												)).flat(),
											),
										];
								const migrationFiles = detectMigrations(files);
								return { required: migrationFiles.length > 0, files: migrationFiles };
							})()
						}
					</Task>
				) : null}

				{migRequired && anyWatchSettled && migGate === undefined ? (
					<Gate
						id="migration-gate"
						title={`Migration gate: ${input.ticket} touches migrations`}
						summary={
							`PR #${pr?.prNumber} diff touches migration paths:\n${JSON.stringify(
								migCheck?.files ?? [],
								null,
								2,
							)}\n` +
							`Approving runs: stg -> verify -> prod -> verify (evidence recorded; done is blocked without it).\n` +
							`The APPROVED SCOPE is re-captured from the live diff at approval time (migration-scope node);\n` +
							`any later divergence from that scope fails closed via migration-stale.\n` +
							`Denying kills the landing path (migrations may never be skipped once triggered).`
						}
					/>
				) : null}
				{migRequired && anyWatchSettled && migGate !== undefined && !migGate.approved && !bypass ? (
					// A denied migration gate must fail closed (Gate onDeny="fail" already
					// fails the run; this branch is unreachable belt-and-braces).
					<Task id="migration-denied" output={outputs.migrationCheck} retries={0}>
						{() => {
							throw new Error("migration gate denied - landing path is closed.");
						}}
					</Task>
				) : null}

				{/* Approved scope: the file set the gate decision covers, captured at
				    approval time (NOT migration-check time - migrations may have been
				    added by watch-loop rework between check and gate). */}
				{migGate?.approved === true && pr !== undefined ? (
					<Task id="migration-scope" output={outputs.migrationScope} retries={1}>
						{() =>
							(async () => {
								const files = dryRun
									? fixtures.changedFiles
									: [
											...new Set(
												(await Promise.all(
													effortCars.map((car) => fetchChangedFiles(ghCtx, car.prNumber)),
												)).flat(),
											),
										];
								return { files: detectMigrations(files), capturedAt: nowIso() };
							})()
						}
					</Task>
				) : null}

				{migGate?.approved === true && migScope !== undefined
					? MIGRATION_STAGES.map((stage, index) => {
							const prior =
								index === 0
									? true
									: migrationRows.some((row) => row.stage === MIGRATION_STAGES[index - 1] && row.ok);
							if (!prior) return null;
							const commandKey = (
								{
									"stg-run": "migrationStgRun",
									"stg-verify": "migrationStgVerify",
									"prod-run": "migrationProdRun",
									"prod-verify": "migrationProdVerify",
								} as const
							)[stage];
							return (
								<Task key={stage} id={`migration-${stage}`} output={outputs.migrationRun} retries={1}>
									{() =>
										(async () => {
											if (dryRun) {
												return { stage, ok: true, detail: `dry-run: ${stage} simulated`, at: nowIso() };
											}
											const command = commands[commandKey];
											if (command === undefined) {
												throw new Error(
													`[escalate] migration stage ${stage} has no configured command (commands.${commandKey}). ` +
														`Configure it and resume, or run manually and record evidence via a patched input on a new run.`,
												);
											}
											const out = await runTests(command, input.worktree);
											return { stage, ok: true, detail: out.slice(-2000), at: nowIso() };
										})()
									}
								</Task>
							);
						})
					: null}

				{/* ------------------------- stages 4/6/7: per-round watch/ready/stamp */}
				{roundsExhausted ? (
					<Task id="rounds-exhausted" output={outputs.preflight} retries={0}>
						{() => {
							throw new Error(
								`[escalate] ${limits.stampRounds} stamp rounds exhausted (head kept moving or reviews kept regressing). Human decision needed; start a new run after resolution.`,
							);
						}}
					</Task>
				) : null}

				{pr !== undefined && reviewerRequest !== undefined && !roundsExhausted
					? Array.from({ length: currentRound + 1 }, (_, k) => k)
							.filter((k) => k < limits.stampRounds)
							.map((k) => {
								const watchNode = `r${k}-watch-poll`;
								const latestWatch = ctx.latest(outputs.watchPoll, watchNode);
								const activeWatchCar =
									latestWatch?.cars?.find((car) => car.actionable) ??
									(latestWatch === undefined || topCar === undefined
										? undefined
										: {
												...topCar,
												actionable: latestWatch.actionable,
												reviewersToReRequest: latestWatch.reviewersToReRequest,
											});
								const watchRows = watchPollRows.filter((row) => row.round === k);
								const watchExhausted =
									watchRows.length >= limits.watchPolls && latestWatch?.exitOk !== true;
								const watchEscalation = ctx.latest(outputs.approvals, `r${k}-watch-escalation`);
								const watchSettled =
									latestWatch?.exitOk === true || watchEscalation?.approved === true;
								const latestFix = ctx.latest(outputs.watchFix, `r${k}-watch-fix`);
								const latestBaseline = ctx.latest(outputs.watchBaseline, `r${k}-watch-baseline`);
								const latestPublish = ctx.latest(outputs.watchPublish, `r${k}-watch-publish`);
								const watchFixNode = `r${k}-watch-fix`;
								const decisionBlockers = (latestFix?.actions ?? [])
									.map(parseDecisionClassBlocker)
									.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
								const activeDecisionIds = new Set<string>();
								if (!bypass && latestFix !== undefined) {
									for (const blocker of decisionBlockers) {
										const asked = askWorkflowQuestion(questionsFile, {
											runId: ctx.runId,
											nodeId: watchFixNode,
											decisionKey: blocker.threadRef,
											generation: latestFix.afterPoll,
											answerLane: "store",
											resumeHint:
												`Answer in deck-questions; the next ${watchFixNode} seat for run ${ctx.runId} hydrates the stored decision.`,
											originalIssue:
												`Review thread ${blocker.threadRef} cannot be resolved mechanically: ${blocker.decision}`,
											proposedAction:
												"State the intended product or implementation behavior for this thread; the next watch-fix seat will apply it.",
											blastRadius:
												`Only ${blocker.threadRef} on PR #${pr.prNumber}; this answer grants no merge or push authority.`,
											cwd: workflowDir,
											prNumber: pr.prNumber,
											prContext: {
												prUrl: pr.url,
												prRepo: input.repo,
												prNumber: pr.prNumber,
												headSha: latestWatch?.headSha ?? pr.headSha,
												originalIssue: brief?.summary,
												ourFix: implementation?.summary,
												whyCorrect: blocker.decision,
												workflowDir,
												workflowFile: "pipeline.tsx",
											},
											questionKind: "agent",
											recommendation:
												"Answer with the intended behavior and any boundary the fixer must preserve.",
										});
										activeDecisionIds.add(asked.id);
									}
								}
								const watchDecisionQuestions = bypass
									? []
									: workflowQuestions(questionsFile, ctx.runId, watchFixNode);
								if (!bypass && (latestFix !== undefined || latestWatch?.exitOk === true)) {
									for (const question of watchDecisionQuestions) {
										if (question.status !== "open") continue;
										if (latestWatch?.exitOk !== true && activeDecisionIds.has(question.id)) continue;
										resolveWorkflowQuestion(questionsFile, {
											runId: ctx.runId,
											nodeId: watchFixNode,
											decisionKey: question.workflow?.decisionKey,
											answer:
												latestWatch?.exitOk === true
													? "Watch completed; this decision is no longer blocking."
													: "The watch fixer no longer reports this decision-class blocker.",
											status: "dismissed",
										});
									}
								}
								const captainDecisionAnswers = watchDecisionQuestions
									.filter((question) => question.status === "answered" && question.answer !== undefined)
									.map((question) => ({
										threadRef: question.workflow?.decisionKey ?? "unknown",
										answer: question.answer ?? "",
									}));


								const readyNode = `r${k}-ready-poll`;
								const latestReady = ctx.latest(outputs.readyPoll, readyNode);
								const readyRows = readyPollRows.filter((row) => row.round === k && row.poll >= 0);
								const readyExhausted =
									readyRows.length >= limits.readyPolls &&
									latestReady?.ready !== true &&
									latestReady?.regressed !== true;
								const readyGateOpen =
									watchSettled && (!migRequired || migEvidenceOk);

								const stamp = ctx.latest(outputs.approvals, `r${k}-stamp`);

								return (
									<Sequence key={`round-${k}`}>
										{/* stage 4: watch-ci-review loop */}
										<Loop
											id={`r${k}-watch-loop`}
											until={latestWatch?.exitOk === true}
											maxIterations={limits.watchPolls}
											onMaxReached="return-last"
										>
											<Sequence>
												<Task id={watchNode} output={outputs.watchPoll} retries={1}>
													{() =>
														(async () => {
															const pollNo = watchRows.length;
															if (dryRun) {
																const waiting = pollNo < fixtures.watchWaitPolls;
																const exitOk =
																	!waiting &&
																	(k > 0 || pollNo + 1 >= fixtures.watchPollsToExit);
																const actionable = !waiting && !exitOk;
																const cars = effortCars.map((car) => ({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: car.headSha,
																	exitOk,
																	actionable,
																	ci: exitOk ? "green" : "will-be-green",
																	unresolvedThreads: actionable ? 1 : 0,
																	unansweredComments: actionable ? 1 : 0,
																	reviewersToReRequest: actionable ? ["dry-reviewer"] : [],
																	reasons: exitOk
																		? []
																		: waiting
																			? ["dry-run: CI is pending; Smithers owns the next poll"]
																			: ["dry-run: 1 unresolved thread"],
																	rebaseRequired: false,
																}));
																return {
																	round: k,
																	poll: pollNo,
																	headSha: cars.at(-1)?.headSha ?? "dryrun-head-sha",
																	exitOk,
																	disposition: exitOk
																		? "complete"
																		: actionable
																			? "fix"
																			: "wait",
																	actionable,
																	ci: exitOk ? "green" : "will-be-green",
																	unresolvedThreads: cars.reduce((sum, car) => sum + car.unresolvedThreads, 0),
																	unansweredComments: cars.reduce((sum, car) => sum + car.unansweredComments, 0),
																	reviewersToReRequest: [
																		...new Set(cars.flatMap((car) => car.reviewersToReRequest)),
																	],
																	rebaseRequired: false,
																	reasons: cars.flatMap((car) =>
																		car.reasons.map((reason) => `PR #${car.prNumber}: ${reason}`),
																	),
																	...(stackMode ? { cars } : {}),
																};
															}
															if (pollNo > 0) await sleepSeconds(limits.watchPollSeconds);
															const mainCi = assessCi(await fetchBranchCheckRuns(ghCtx, baseBranch));
															if (mainCi === "red") {
																const cars = effortCars.map((car) => ({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: car.headSha,
																	exitOk: false,
																	actionable: false,
																	ci: "red",
																	unresolvedThreads: 0,
																	unansweredComments: 0,
																	reviewersToReRequest: [],
																	reasons: [`root branch ${baseBranch} has failing checks`],
																	rebaseRequired: false,
																}));
																return {
																	round: k,
																	poll: pollNo,
																	headSha: cars.at(-1)?.headSha ?? pr.headSha,
																	exitOk: false,
																	disposition: "wait" as const,
																	actionable: false,
																	ci: "red",
																	unresolvedThreads: 0,
																	unansweredComments: 0,
																	reviewersToReRequest: [],
																	reasons: [`root branch ${baseBranch} has failing checks; CI watch is paused until it is green.`],
																	rebaseRequired: false,
																	...(stackMode ? { cars } : {}),
																};
															}
															const cars = [];
															for (const car of effortCars) {
																const snapshot = await fetchWatchSnapshot(
																	ghCtx,
																	car.prNumber,
																	github.selfLogins,
																);
																const verdict = evaluateWatchExit(snapshot, {
																	selfLogins: github.selfLogins,
																});
																cars.push({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: snapshot.headSha,
																	exitOk: verdict.exitOk,
																	actionable: verdict.actionable,
																	ci: verdict.ci,
																	unresolvedThreads: verdict.unresolvedThreads,
																	unansweredComments: verdict.unansweredComments,
																	reviewersToReRequest: verdict.reviewersNeedingReRequest,
																	reasons: verdict.reasons,
																	rebaseRequired: verdict.rebaseRequired,
																});
															}
															const exitOk = cars.every((car) => car.exitOk);
															const actionable = cars.some((car) => car.actionable);
															const ci = cars.some((car) => car.ci === "red")
																? "red"
																: cars.some((car) => car.ci === "none")
																	? "none"
																	: cars.some((car) => car.ci === "will-be-green")
																		? "will-be-green"
																		: "green";
															return {
																round: k,
																poll: pollNo,
																headSha: cars.at(-1)?.headSha ?? pr.headSha,
																exitOk,
																disposition: exitOk ? "complete" : actionable ? "fix" : "wait",
																actionable,
																ci,
																unresolvedThreads: cars.reduce((sum, car) => sum + car.unresolvedThreads, 0),
																unansweredComments: cars.reduce((sum, car) => sum + car.unansweredComments, 0),
																reviewersToReRequest: [
																	...new Set(cars.flatMap((car) => car.reviewersToReRequest)),
																],
																reasons: cars.flatMap((car) =>
																	car.reasons.map((reason) => `PR #${car.prNumber}: ${reason}`),
																),
																rebaseRequired: cars.some((car) => car.rebaseRequired),
																...(stackMode ? { cars } : {}),
															};
														})()
													}
												</Task>
												{latestWatch !== undefined &&
												!latestWatch.exitOk &&
												latestWatch.actionable &&
												(latestFix === undefined || latestFix.afterPoll < latestWatch.poll)
													? latestWatch.rebaseRequired
														? (
																<Task
																	id={`r${k}-watch-fix`}
																	output={outputs.watchFix}
																	retries={1}
																>
																	{async () => {
																		if (stackMode) {
																			const watchedCars = latestWatch.cars ?? [];
																			const rebaseCar = watchedCars.find((car) => car.rebaseRequired);
																			if (rebaseCar === undefined || topCar === undefined) {
																				throw new Error("[escalate] stack rebase poll omitted car topology.");
																			}
																			const comparisons = await compareStackHeads(
																				watchedCars.map((car) => ({
																					prNumber: car.prNumber,
																					branch: car.branch,
																					baseBranch: car.baseBranch,
																					headSha: car.headSha,
																				})),
																				(prNumber) => fetchHeadSha(ghCtx, prNumber),
																			);
																			const drifted = comparisons.filter((comparison) => !comparison.ok);
																			if (drifted.length > 0) {
																				return {
																					round: k,
																					afterPoll: latestWatch.poll,
																					actions: [],
																					pushed: false,
																					reRequested: [],
																					commits: [],
																					summary:
																						`Stack changed after poll; pushed nothing and will re-poll: ` +
																						drifted.map((car) => `#${car.prNumber} ${car.headSha} -> ${car.currentHead}`).join("; "),
																				};
																			}
																			const [branch, localHead] = await Promise.all([
																				execOrThrow(
																					bunExec,
																					[github.git, "branch", "--show-current"],
																					{ cwd: input.worktree },
																				).then((value) => value.trim()),
																				execOrThrow(
																					bunExec,
																					[github.git, "rev-parse", "HEAD"],
																					{ cwd: input.worktree },
																				).then((value) => value.trim()),
																			]);
																			const topComparison = comparisons.at(-1);
																			if (
																				branch !== topCar.branch ||
																				topComparison === undefined ||
																				localHead !== topComparison.currentHead
																			) {
																				throw new Error(
																					`[escalate] stack rebase worktree is ${branch || "detached"}@${localHead}, not top car ${topCar.branch}@${topComparison?.currentHead ?? "unknown"}.`,
																				);
																			}
																			const actions = await rebaseStackUpstack(bunExec, {
																				gh: github.gh,
																				worktree: input.worktree,
																				rootBaseBranch: baseBranch,
																				branches: effortCars.map((car) => car.branch),
																				fromBranch: rebaseCar.branch,
																				testCommand: commands.test,
																			});
																			const reRequested: string[] = [];
																			for (const car of watchedCars) {
																				if (car.reviewersToReRequest.length === 0) continue;
																				await requestReviewers(
																					ghCtx,
																					car.prNumber,
																					car.reviewersToReRequest,
																				);
																				reRequested.push(...car.reviewersToReRequest);
																			}
																			return {
																				round: k,
																				afterPoll: latestWatch.poll,
																				actions: [
																					...actions,
																					...reRequested.map((reviewer) => `re-requested ${reviewer}`),
																				],
																				pushed: true,
																				reRequested: [...new Set(reRequested)],
																				commits: [],
																				summary: "Rebased the stale car and every descendant through gh stack, tested, pushed, and re-requested review.",
																			};
																		}
																		const [remoteHead, branch, localHead] =
																			await Promise.all([
																				fetchHeadSha(ghCtx, pr.prNumber),
																				execOrThrow(
																					bunExec,
																					[github.git, "branch", "--show-current"],
																					{ cwd: input.worktree },
																				).then((value) => value.trim()),
																				execOrThrow(
																					bunExec,
																					[github.git, "rev-parse", "HEAD"],
																					{ cwd: input.worktree },
																				).then((value) => value.trim()),
																			]);
																		if (
																			remoteHead !== latestWatch.headSha ||
																			branch !== input.branch ||
																			localHead !== remoteHead
																		) {
																			throw new Error(
																				`[escalate] rebase baseline rejected: poll=${latestWatch.headSha}, remote=${remoteHead}, local=${localHead}, branch=${branch || "detached"}; refusing to rebase or push stale/out-of-band state.`,
																			);
																		}
																		const actions = await rebaseAndPush(bunExec, {
																			git: github.git,
																			worktree: input.worktree,
																			branch: input.branch,
																			baseBranch,
																			expectedRemoteHead: latestWatch.headSha,
																			testCommand: commands.test,
																			runCommitShas: [],
																		});
																		const reviewers = latestWatch.reviewersToReRequest;
																		if (reviewers.length > 0) {
																			await requestReviewers(ghCtx, pr.prNumber, reviewers);
																		}
																		return {
																			round: k,
																			afterPoll: latestWatch.poll,
																			actions: [
																				...actions,
																				...reviewers.map((reviewer) => `re-requested ${reviewer}`),
																			],
																			pushed: true,
																			reRequested: reviewers,
																			commits: [],
																			summary: "Rebased through the bounded helper, tested, pushed, and re-requested review.",
																		};
																	}}
																</Task>
															)
														: latestBaseline === undefined ||
																latestBaseline.afterPoll < latestWatch.poll
															? (
																	<Task
																		id={`r${k}-watch-baseline`}
																		output={outputs.watchBaseline}
																		retries={1}
																	>
																		{() =>
																			dryRun
																				? {
																						round: k,
																						afterPoll: latestWatch.poll,
																						headSha: activeWatchCar?.headSha ?? latestWatch.headSha,
																						valid: true,
																						reason: "dry-run worktree matches polled head",
																					}
																				: (async () => {
																						if (activeWatchCar === undefined) {
																							throw new Error("[escalate] actionable watch poll omitted its car.");
																						}
																						if (stackMode) {
																							const comparisons = await compareStackHeads(
																								(latestWatch.cars ?? []).map((car) => ({
																									prNumber: car.prNumber,
																									branch: car.branch,
																									baseBranch: car.baseBranch,
																									headSha: car.headSha,
																								})),
																								(prNumber) => fetchHeadSha(ghCtx, prNumber),
																							);
																							const drifted = comparisons.filter((comparison) => !comparison.ok);
																							if (drifted.length > 0) {
																								return {
																									round: k,
																									afterPoll: latestWatch.poll,
																									headSha: activeWatchCar.headSha,
																									valid: false,
																									reason:
																										`stack changed after poll; re-poll before running a fixer: ` +
																										drifted.map((car) => `#${car.prNumber} ${car.headSha} -> ${car.currentHead}`).join("; "),
																								};
																							}
																						}
																						if (stackMode) {
																							const current = (
																								await execOrThrow(
																									bunExec,
																									[github.git, "branch", "--show-current"],
																									{ cwd: input.worktree },
																								)
																							).trim();
																							if (current !== activeWatchCar.branch) {
																								await execOrThrow(
																									bunExec,
																									[github.gh, "stack", "checkout", activeWatchCar.branch],
																									{ cwd: input.worktree },
																								);
																							}
																						}
																						const [remoteHead, branch, localHead] =
																							await Promise.all([
																								fetchHeadSha(ghCtx, activeWatchCar.prNumber),
																								execOrThrow(
																									bunExec,
																									[github.git, "branch", "--show-current"],
																									{ cwd: input.worktree },
																								).then((value) => value.trim()),
																								execOrThrow(
																									bunExec,
																									[github.git, "rev-parse", "HEAD"],
																									{ cwd: input.worktree },
																								).then((value) => value.trim()),
																							]);
																						const valid =
																							remoteHead === activeWatchCar.headSha &&
																							branch === activeWatchCar.branch &&
																							localHead === remoteHead;
																						return {
																							round: k,
																							afterPoll: latestWatch.poll,
																							headSha: remoteHead,
																							valid,
																							reason: valid
																								? "worktree and remote PR branch match the polled head"
																								: `publish baseline rejected: poll=${activeWatchCar.headSha}, remote=${remoteHead}, local=${localHead}, branch=${branch || "detached"}`,
																						};
																					})()
																		}
																	</Task>
																)
															: latestBaseline.valid
																? (
																		<Task
																			id={`r${k}-watch-fix`}
																			output={outputs.watchFix}
																			agent={dryRun ? undefined : agents?.watcher}
																			retries={1}
																		>
																			{dryRun
																				? () => ({
																						round: k,
																						afterPoll: latestWatch.poll,
																						actions: ["dry-run: answered thread"],
																						commits: [],
																						pushed: false,
																						reRequested: [],
																						summary: "dry-run: feedback addressed locally",
																					})
																				: watchFixPrompt({
																						worktree: input.worktree,
																						branch: activeWatchCar?.branch ?? input.branch,
																						baseBranch: activeWatchCar?.baseBranch ?? baseBranch,
																						repo: input.repo,
																						project,
																						prNumber: activeWatchCar?.prNumber ?? pr.prNumber,
																						gh: github.gh,
																						pollJson: JSON.stringify({
																							...latestWatch,
																							activeCar: activeWatchCar,
																							captainDecisionAnswers,
																						}, null, 2),
																						round: k,
																						afterPoll: latestWatch.poll,
																					})}
																		</Task>
																	)
																: null
													: null}
												{latestWatch !== undefined &&
												latestFix !== undefined &&
												latestFix.afterPoll === latestWatch.poll &&
												!latestWatch.rebaseRequired &&
												(latestPublish === undefined ||
													latestPublish.afterPoll < latestWatch.poll) ? (
													<Task
														id={`r${k}-watch-publish`}
														output={outputs.watchPublish}
														retries={1}
													>
														{() =>
															dryRun
																? {
																		round: k,
																		afterPoll: latestWatch.poll,
																		actions: ["dry-run: bounded publish completed"],
																		pushed: false,
																		reRequested: [],
																		summary: "dry-run: no local commits to publish",
																	}
																: (async () => {
																		if (
																			latestFix.pushed ||
																			latestFix.reRequested.length > 0
																		) {
																			throw new Error(
																				"[escalate] watch fixer reported a direct push or reviewer re-request; both are forbidden outside the deterministic publish node.",
																			);
																		}
																		if (
																			latestBaseline === undefined ||
																			!latestBaseline.valid ||
																			latestBaseline.afterPoll !== latestWatch.poll
																		) {
																			throw new Error(
																				"[escalate] watch publish has no valid worktree/remote baseline for this poll.",
																			);
																		}
																		if (activeWatchCar === undefined) {
																			throw new Error("[escalate] watch publish has no active car.");
																		}
																		const remoteHead = await fetchHeadSha(
																			ghCtx,
																			activeWatchCar.prNumber,
																		);
																		if (remoteHead !== latestBaseline.headSha) {
																			throw new Error(
																				`[escalate] remote PR head moved from ${latestBaseline.headSha} to ${remoteHead} during watch-fix; refusing to publish or trust an out-of-band push.`,
																			);
																		}
																		const ancestry = await bunExec(
																			[
																				github.git,
																				"merge-base",
																				"--is-ancestor",
																				latestBaseline.headSha,
																				"HEAD",
																			],
																			{ cwd: input.worktree },
																		);
																		if (ancestry.code !== 0) {
																			throw new Error(
																				`[escalate] local HEAD is not descended from the trusted watch baseline ${latestBaseline.headSha}; refusing to publish.`,
																			);
																		}
																		const runCommitShas = latestFix.commits;
																		const actualRunCommits = (
																			await execOrThrow(
																				bunExec,
																				[
																					github.git,
																					"rev-list",
																					"--reverse",
																					`${latestBaseline.headSha}..HEAD`,
																				],
																				{ cwd: input.worktree },
																			)
																		)
																			.split("\n")
																			.map((sha) => sha.trim())
																			.filter(Boolean);
																		if (
																			actualRunCommits.length !== runCommitShas.length ||
																			actualRunCommits.some(
																				(sha, index) => sha !== runCommitShas[index],
																			)
																		) {
																			throw new Error(
																				`[escalate] watch fixer reported commits ${JSON.stringify(runCommitShas)}, but the trusted baseline-to-HEAD range is ${JSON.stringify(actualRunCommits)}; refusing to allowlist or push unreported local commits.`,
																			);
																		}
																		const reviewers = activeWatchCar.reviewersToReRequest;
																		if (runCommitShas.length === 0) {
																			if (reviewers.length > 0) {
																				await requestReviewers(ghCtx, activeWatchCar.prNumber, reviewers);
																			}
																			return {
																				round: k,
																				afterPoll: latestWatch.poll,
																				actions: reviewers.map(
																					(reviewer) => `re-requested ${reviewer}`,
																				),
																				pushed: false,
																				reRequested: reviewers,
																				summary:
																					"Feedback handled without local commits; eligible reviewers re-requested.",
																			};
																		}
																		if (stackMode) {
																			const comparisons = await compareStackHeads(
																				(latestWatch.cars ?? []).map((car) => ({
																					prNumber: car.prNumber,
																					branch: car.branch,
																					baseBranch: car.baseBranch,
																					headSha: car.headSha,
																				})),
																				(prNumber) => fetchHeadSha(ghCtx, prNumber),
																			);
																			const drifted = comparisons.filter((comparison) => !comparison.ok);
																			if (drifted.length > 0) {
																				throw new Error(
																					`[escalate] stack changed while the fixer was working; pushed nothing. ` +
																						drifted.map((car) => `#${car.prNumber} ${car.headSha} -> ${car.currentHead}`).join("; "),
																				);
																			}
																		}
																		const actions = stackMode
																			? await rebaseStackUpstack(bunExec, {
																					gh: github.gh,
																					worktree: input.worktree,
																					rootBaseBranch: baseBranch,
																					branches: effortCars.map((car) => car.branch),
																					fromBranch: activeWatchCar.branch,
																					testCommand: commands.test,
																				})
																			: await rebaseAndPush(bunExec, {
																					git: github.git,
																					worktree: input.worktree,
																					branch: input.branch,
																					baseBranch,
																					expectedRemoteHead: latestBaseline.headSha,
																					testCommand: commands.test,
																					runCommitShas,
																				});
																		if (reviewers.length > 0) {
																			await requestReviewers(ghCtx, activeWatchCar.prNumber, reviewers);
																		}
																		return {
																			round: k,
																			afterPoll: latestWatch.poll,
																			actions: [
																				...actions,
																				...reviewers.map(
																					(reviewer) => `re-requested ${reviewer}`,
																				),
																			],
																			pushed: true,
																			reRequested: reviewers,
																			summary:
																				"Published local fixes through the bounded helper and re-requested eligible reviewers.",
																		};
																	})()
														}
													</Task>
												) : null}
											</Sequence>
										</Loop>

										{watchExhausted && watchEscalation === undefined ? (
											<Gate
												id={`r${k}-watch-escalation`}
												title={`watch-ci-review loop exhausted: ${input.ticket} round ${k}`}
												summary={
													`${watchRows.length} polls without a clean exit.\n` +
													`Last state: ${JSON.stringify(latestWatch?.reasons ?? [])}\n` +
													`Approve to proceed to ready-for-stamp anyway; deny to kill the run.`
												}
											/>
										) : null}

										{/* stage 6: ready-for-stamp (parks here until human approval exists) */}
										{readyGateOpen ? (
											<Loop
												id={`r${k}-ready-loop`}
												until={
													ctx.latest(outputs.readyPoll, readyNode)?.ready === true ||
													ctx.latest(outputs.readyPoll, readyNode)?.regressed === true
												}
												maxIterations={limits.readyPolls}
												onMaxReached="return-last"
											>
												<Task id={readyNode} output={outputs.readyPoll} retries={1}>
													{() =>
														(async () => {
															const pollNo = readyRows.length;
															if (dryRun) {
																const cars = effortCars.map((car) => ({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: car.headSha,
																	ready: true,
																	approvedBy: "operator-dryrun",
																	ci: "green",
																	reasons: [],
																	migrationFiles: migCheck?.files ?? [],
																}));
																return {
																	round: k,
																	poll: pollNo,
																	ready: true,
																	regressed: false,
																	approvedBy: "operator-dryrun",
																	ci: "green",
																	headSha: cars.at(-1)?.headSha ?? "dryrun-head-sha",
																	reasons: [],
																	migrationDetected: migRequired,
																	migrationFiles: migCheck?.files ?? [],
																	at: nowIso(),
																	...(stackMode ? { cars } : {}),
																};
															}
															if (pollNo > 0) await sleepSeconds(limits.readyPollSeconds);
															const cars = [];
															for (const car of effortCars) {
																if (car.landed) {
																	cars.push({
																		prNumber: car.prNumber,
																		branch: car.branch,
																		baseBranch: car.baseBranch,
																		headSha: car.headSha,
																		ready: true,
																		approvedBy: "already-landed",
																		ci: "green",
																		reasons: [],
																		migrationFiles: [],
																	});
																	continue;
																}
																const snapshot = await fetchWatchSnapshot(
																	ghCtx,
																	car.prNumber,
																	github.selfLogins,
																);
																const watchVerdict = evaluateWatchExit(snapshot, {
																	selfLogins: github.selfLogins,
																});
																const files = await fetchChangedFiles(ghCtx, car.prNumber);
																const migrationFiles = detectMigrations(files);
																const { approvals: prApprovals, checkRuns } =
																	await fetchPrApprovalsAndCi(ghCtx, car.prNumber);
																const freshCi = assessCi(checkRuns);
																const readyVerdict = evaluateReadyForStamp(
																	prApprovals,
																	freshCi,
																	{
																		author: github.selfLogins[0] ?? "",
																		excludedApprovers: github.excludedApprovers,
																		yolo,
																	},
																);
																cars.push({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: snapshot.headSha,
																	ready: watchVerdict.exitOk && readyVerdict.ready,
																	approvedBy: readyVerdict.approvedBy,
																	ci: readyVerdict.ci,
																	reasons: [
																		...(!watchVerdict.exitOk
																			? ["watch conditions regressed:", ...watchVerdict.reasons]
																			: []),
																		...readyVerdict.reasons,
																	],
																	migrationFiles,
																});
															}
															const migrationFiles = [...new Set(cars.flatMap((car) => car.migrationFiles))];
															const migrationDetected = migrationFiles.length > 0;
															const migrationRegressed =
																migrationDetected && !migrationEvidenceComplete(migrationRows);
															const regressed =
																cars.some((car) =>
																	car.reasons.some((reason) => reason === "watch conditions regressed:"),
																) || migrationRegressed;
															const ready = !regressed && cars.every((car) => car.ready);
															const ci = cars.some((car) => car.ci === "red")
																? "red"
																: cars.some((car) => car.ci === "none")
																	? "none"
																	: cars.some((car) => car.ci === "will-be-green")
																		? "will-be-green"
																		: "green";
															return {
																round: k,
																poll: pollNo,
																ready,
																regressed,
																approvedBy: ready
																	? cars.map((car) => car.approvedBy).filter(Boolean).join(", ") || null
																	: null,
																ci,
																headSha: cars.at(-1)?.headSha ?? "",
																reasons: [
																	...cars.flatMap((car) =>
																		car.reasons.map((reason) => `PR #${car.prNumber}: ${reason}`),
																	),
																	...(migrationRegressed
																		? ["migration paths detected but stack-wide evidence is incomplete."]
																		: []),
																],
																migrationDetected,
																migrationFiles,
																at: nowIso(),
																...(stackMode ? { cars } : {}),
															};
														})()
													}
												</Task>
											</Loop>
										) : null}

										{readyExhausted ? (
											<Gate
												id={`r${k}-ready-exhaustion-decision`}
												title={`ready-for-stamp loop exhausted: ${input.ticket} round ${k}`}
												summary={`${readyRows.length} polls without human approval.\nApprove to start a fresh watch round; deny to stop and investigate the approval blocker.`}
											/>
										) : null}

										{readyExhausted && ctx.latest(outputs.approvals, `r${k}-ready-exhaustion-decision`)?.approved === true ? (
											<Task id={`r${k}-ready-exhausted`} output={outputs.readyPoll} retries={0}>
												{() => ({
													round: k,
													poll: -1,
													ready: false,
													regressed: true,
													approvedBy: null,
													ci: latestReady?.ci ?? "none",
													headSha: latestReady?.headSha ?? "",
													reasons: [
														`ready loop exhausted after ${readyRows.length} polls without human approval - starting a fresh watch round.`,
													],
													migrationDetected: latestReady?.migrationDetected ?? false,
													migrationFiles: latestReady?.migrationFiles ?? [],
													at: nowIso(),
												})}
											</Task>
										) : null}

										{/* stage 7: stamp + merge word. A yolo profile skips the park: the
										    workflow writes the approved row itself (same node id, so
										    stamp-validity, head re-check and merge run unchanged). */}
										{latestReady?.ready === true && stamp === undefined && yolo ? (
											<Task id={`r${k}-stamp`} output={outputs.approvals} retries={0}>
												{() => ({
													approved: true,
													note: `yolo profile "${profile?.id}": stamp gate skipped; merge fires on green (CI: ${latestReady.ci}).`,
													decidedBy: `profile:${profile?.id}`,
													decidedAt: nowIso(),
												})}
											</Task>
										) : null}
										{latestReady?.ready === true && stamp === undefined && !yolo ? (
											<Gate
												id={`r${k}-stamp`}
												title={
													stackMode
														? `STAMP + merge word: ${input.ticket} stack (${effortCars.length} cars, round ${k})`
														: `STAMP + merge word: ${input.ticket} PR #${pr.prNumber} (round ${k})`
												}
												metadata={buildApprovalStampMetadata({
													headSha: latestReady.headSha,
													prNumber: topCar?.prNumber ?? pr.prNumber,
													headBranch: topCar?.branch ?? input.branch,
													baseBranch,
													...(stackMode
														? {
																cars: (latestReady.cars ?? []).map((car) => ({
																	prNumber: car.prNumber,
																	branch: car.branch,
																	baseBranch: car.baseBranch,
																	headSha: car.headSha,
																})),
															}
														: {}),
												})}
												summary={[
													`Original issue: ${brief?.summary ?? input.ticket}`,
													`Fix: ${implementation?.summary ?? "(see PR)"}`,
													`Danger/blast radius: ${brief?.blastRadius ?? "(not declared in brief)"}`,
													...(stackMode
														? [
																"Ordered stack:",
																...(latestReady.cars ?? []).map(
																	(car) =>
																		`  PR #${car.prNumber} ${car.baseBranch} ← ${car.branch}@${car.headSha} (CI ${car.ci}; approval ${car.approvedBy ?? "n/a"})`,
																),
															]
														: [
																`PR: ${pr.url}`,
																`Head at ready: ${latestReady.headSha}`,
																`Human review approval: ${latestReady.approvedBy ?? "n/a"}`,
															]),
													...(k > 0
														? [
																`Prior stamp invalidation: ${
																	ctx.latest(
																		outputs.mergeHeadCheck,
																		`r${k - 1}-merge-head-check`,
																	)?.diffSummary ?? "head changed after approval"
																}`,
															]
														: []),
												`CI: ${latestReady.ci} (green-or-will-be-green per approval ruling)`,
												`Migration gate: ${migRequired ? `TRIGGERED (evidence ${migEvidenceOk ? "complete" : "INCOMPLETE"})` : "not triggered"}`, 
													``,
													`Approving = one commit-bound stamp + merge word for the entire effort.`,
													`The workflow (not an agent) re-checks every stamped head, then submits`,
													`stack cars to the GitHub merge queue parent first. Any head change`,
													`invalidates the whole stamp and re-enters watch-ci.`,
												].join("\n")}
											/>
										) : null}

										{stamp?.approved === true ? (
											<Task id={`r${k}-stamp-validity`} output={outputs.stampValidity} retries={1}>
												{() =>
													(async () => {
														const stampedHead = latestReady?.headSha ?? "";
														const stampedCars = (latestReady?.cars ?? []).map((car) => ({
															prNumber: car.prNumber,
															branch: car.branch,
															baseBranch: car.baseBranch,
															headSha: car.headSha,
														}));
														if (dryRun) {
															const movedRound = fixtures.headChangeRounds.includes(k);
															const cars = stampedCars.map((car, index) => {
																const moved =
																	movedRound && index === stampedCars.length - 1;
																return {
																	...car,
																	currentHead: moved ? `${car.headSha}-moved` : car.headSha,
																	ok: !moved,
																};
															});
															const valid = stackMode
																? cars.every((car) => car.ok)
																: !movedRound;
															const currentHead = stackMode
																? cars.at(-1)?.currentHead ?? stampedHead
																: movedRound
																	? `${stampedHead}-moved`
																	: stampedHead;
															return {
																round: k,
																stampedHead,
																currentHead,
																valid,
																checkedAt: nowIso(),
																...(stackMode ? { cars } : {}),
															};
														}
														if (stackMode) {
															const cars = await compareStackHeads(
																stampedCars,
																(prNumber) => fetchHeadSha(ghCtx, prNumber),
															);
															return {
																round: k,
																stampedHead,
																currentHead: cars.at(-1)?.currentHead ?? "",
																valid: cars.every((car) => car.ok),
																checkedAt: nowIso(),
																cars,
															};
														}
														const currentHead = await fetchHeadSha(ghCtx, pr.prNumber);
														return {
															round: k,
															stampedHead,
															currentHead,
															valid: currentHead === stampedHead,
															checkedAt: nowIso(),
														};
													})()
												}
											</Task>
										) : null}
									</Sequence>
								);
							})
					: null}

				{/* ---------------------- migration staleness guard (fail closed) */}
				{migStale ? (
					<Task id="migration-stale" output={outputs.migrationCheck} retries={0}>
						{() => {
							throw new Error(
								`[escalate] migration diff changed AFTER migration evidence was recorded ` +
									`(gate saw ${JSON.stringify(migCheck?.files ?? [])}). Recorded stg/prod evidence ` +
									`no longer covers the diff that will land. Human decision required: re-run ` +
									`migrations manually and record evidence, or start a new run.`,
							);
						}}
					</Task>
				) : null}

				{/* The round-scoped merge attempt owns both the last-instant stamp
				    comparison and MQ enqueue. A mismatch persists ok=false so the
				    next render starts a fresh watch/approval round. */}
				{stampedRound !== null && stampedRound.headCheck === undefined && pr !== undefined && !migStale ? (
					<Task
						id={`r${stampedRound.round}-merge-head-check`}
						output={outputs.mergeHeadCheck}
						retries={1}
					>
						{() =>
							(async () => {
								if (stackMode) {
									const stampedCars = stampedRound.cars ?? [];
									const expectedTop = stampedCars.at(-1);
									if (stampedCars.length === 0 || expectedTop === undefined) {
										throw new Error("[escalate] stack merge has no stamped car topology.");
									}
									if (dryRun) {
										const movedCars =
											stampedRound.round === 0
												? new Set(fixtures.stackMovedPrNumbers)
												: new Set<number>();
										const cars = stampedCars.map((car, index) => {
											const moved = movedCars.has(car.prNumber);
											const submitted = movedCars.size === 0 && index === 0;
											return {
												...car,
												currentHead: moved ? `${car.headSha}-moved` : car.headSha,
												ok: !moved,
												submittedAt: submitted ? nowIso() : null,
												receipt: submitted
													? `dry-run: submitted lowest PR #${car.prNumber}`
													: null,
												alreadyLanded: false,
												mergePath: submitted ? "dry-run" as const : null,
											};
										});
										const drift = cars.find((car) => !car.ok);
										return {
											round: stampedRound.round,
											expectedHead: drift?.headSha ?? expectedTop.headSha,
											currentHead: drift?.currentHead ?? expectedTop.headSha,
											ok: drift === undefined,
											diffSummary: drift === undefined
												? "dry-run: every stack head unchanged since approval"
												: `dry-run: PR #${drift.prNumber} moved after stack approval`,
											checkedAt: nowIso(),
											submittedAt: drift === undefined ? nowIso() : null,
											receipt:
												drift === undefined
													? cars.find((car) => car.receipt !== null)?.receipt ?? "dry-run: stack already landed"
													: null,
											alreadyLanded: false,
											mergePath: drift === undefined ? "dry-run" as const : null,
											cars,
										};
									}
									const compareEveryCar = async () =>
										Promise.all(
											stampedCars.map(async (car) => {
												const comparison = await compareApprovalStamp({
													exec: bunExec,
													gh: github.gh,
													repo: input.repo,
													prNumber: car.prNumber,
													expectedHead: car.headSha,
												});
												return { car, comparison };
											}),
										);
									const initial = await compareEveryCar();
									const initialDrift = initial.find(({ comparison }) => !comparison.ok);
									if (initialDrift !== undefined) {
										const cars = initial.map(({ car, comparison }) => ({
											...car,
											currentHead: comparison.currentHead,
											ok: comparison.ok,
											submittedAt: null,
											receipt: null,
											alreadyLanded: false,
											mergePath: null,
										}));
										return {
											round: stampedRound.round,
											expectedHead: initialDrift.car.headSha,
											currentHead: initialDrift.comparison.currentHead,
											ok: false,
											diffSummary: `PR #${initialDrift.car.prNumber}: ${initialDrift.comparison.diffSummary}`,
											checkedAt: nowIso(),
											submittedAt: null,
											receipt: null,
											alreadyLanded: false,
											mergePath: null,
											cars,
										};
									}
									const landedNumbers = new Set<number>();
									for (const car of stampedCars) {
										const overview = await fetchPrOverview(ghCtx, car.prNumber);
										const commits = await fetchBaseCommitSubjects(
											github.git,
											input.worktree,
											overview.baseRefName,
										);
										if (findLandingCommit(commits, car.prNumber) !== null) {
											landedNumbers.add(car.prNumber);
										}
									}
									// This is the merge boundary: every live head is fetched again
									// before the first parent enqueue. One mismatch invalidates all.
									const final = await compareEveryCar();
									const finalDrift = final.find(({ comparison }) => !comparison.ok);
									if (finalDrift !== undefined) {
										const cars = final.map(({ car, comparison }) => ({
											...car,
											currentHead: comparison.currentHead,
											ok: comparison.ok,
											submittedAt: null,
											receipt: null,
											alreadyLanded: landedNumbers.has(car.prNumber),
											mergePath: null,
										}));
										return {
											round: stampedRound.round,
											expectedHead: finalDrift.car.headSha,
											currentHead: finalDrift.comparison.currentHead,
											ok: false,
											diffSummary: `PR #${finalDrift.car.prNumber}: ${finalDrift.comparison.diffSummary}`,
											checkedAt: nowIso(),
											submittedAt: null,
											receipt: null,
											alreadyLanded: false,
											mergePath: null,
											cars,
										};
									}
									const nextCar = nextStackMergeCar(
										stampedCars,
										stampedCars.map((car) => ({
											prNumber: car.prNumber,
											landed: landedNumbers.has(car.prNumber),
											submitted: false,
										})),
									);
									let nextReceipt: string | null = null;
									let nextMergePath: "github-merge-queue" | "dry-run" | "already-landed" | null = null;
									if (nextCar !== undefined) {
										const merge = await runMerge({
											args: ["--auto", "--squash"],
											exec: bunExec,
											gh: github.gh,
											prNumber: nextCar.prNumber,
											cwd: input.worktree,
										});
										nextReceipt = merge.output.slice(-2000);
										nextMergePath = merge.path;
									}
									const submittedAt = nowIso();
									const cars = final.map(({ car, comparison }) => {
										const alreadyLanded = landedNumbers.has(car.prNumber);
										const submittedNow = car.prNumber === nextCar?.prNumber;
										return {
											...car,
											currentHead: comparison.currentHead,
											ok: true,
											submittedAt: alreadyLanded || submittedNow ? submittedAt : null,
											receipt: alreadyLanded
												? `PR #${car.prNumber}: already landed; no enqueue`
												: submittedNow
													? nextReceipt
													: null,
											alreadyLanded,
											mergePath: alreadyLanded
												? "already-landed" as const
												: submittedNow
													? nextMergePath
													: null,
										};
									});
									return {
										round: stampedRound.round,
										expectedHead: expectedTop.headSha,
										currentHead: final.at(-1)?.comparison.currentHead ?? "",
										ok: true,
										diffSummary: nextCar === undefined
											? "every approved stack head unchanged; stack already landed"
											: `every approved stack head unchanged; enqueued lowest unlanded PR #${nextCar.prNumber}`,
										checkedAt: nowIso(),
										submittedAt,
										receipt:
											cars
												.filter((car) => car.receipt !== null)
												.map((car) => `PR #${car.prNumber}: ${car.receipt}`)
												.join("\n") || "stack already landed",
										alreadyLanded: cars.every((car) => car.alreadyLanded),
										mergePath: cars.every((car) => car.alreadyLanded)
											? "already-landed" as const
											: "github-merge-queue" as const,
										cars,
									};
								}
								const expectedHead = stampedRound.headSha;
								if (dryRun) {
									return {
										round: stampedRound.round,
										expectedHead,
										currentHead: expectedHead,
										ok: true,
										diffSummary: "dry-run head unchanged since approval",
										checkedAt: nowIso(),
										submittedAt: nowIso(),
										receipt: `dry-run: submitted PR #${pr.prNumber} to merge queue at head ${expectedHead}`,
										alreadyLanded: false,
										mergePath: "dry-run" as const,
									};
								}
								const initialComparison = await compareApprovalStamp({
									exec: bunExec,
									gh: github.gh,
									repo: input.repo,
									prNumber: pr.prNumber,
									expectedHead,
								});
								if (!initialComparison.ok) {
									return {
										round: stampedRound.round,
										...initialComparison,
										checkedAt: nowIso(),
										submittedAt: null,
										receipt: null,
										alreadyLanded: false,
										mergePath: null,
									};
								}


								// Idempotency after a crash: if this PR's squash is already
								// on its live base, record it without issuing another command.
								const mergeBaseBranch = (await fetchPrOverview(ghCtx, pr.prNumber)).baseRefName;
								const commits = await fetchBaseCommitSubjects(
									github.git,
									input.worktree,
									mergeBaseBranch,
								);
								const landed = findLandingCommit(commits, pr.prNumber);
								if (landed !== null) {
									return {
										round: stampedRound.round,
										...initialComparison,
										diffSummary:
											"approved head unchanged; merge already landed, so no enqueue command was issued",
										checkedAt: nowIso(),
										submittedAt: nowIso(),
										receipt: `already landed as ${landed.sha} ("${landed.subject}") - no resubmit`,
										alreadyLanded: true,
										mergePath: "already-landed" as const,
									};
								}


								// Nothing runs between this live comparison and runMerge:
								// a moved head becomes a durable invalidation, never a failed
								// node that strands the workflow after approval.
								const finalComparison = await compareApprovalStamp({
									exec: bunExec,
									gh: github.gh,
									repo: input.repo,
									prNumber: pr.prNumber,
									expectedHead,
								});
								if (!finalComparison.ok) {
									return {
										round: stampedRound.round,
										...finalComparison,
										checkedAt: nowIso(),
										submittedAt: null,
										receipt: null,
										alreadyLanded: false,
										mergePath: null,
									};
								}
								const [mergeBranch, mergeHead] = await Promise.all([
									execOrThrow(
										bunExec,
										[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
										{ cwd: input.worktree },
									).then((value) => value.trim()),
									execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
										cwd: input.worktree,
									}).then((value) => value.trim()),
								]);
								if (mergeBranch !== input.branch || mergeHead !== finalComparison.currentHead) {
									throw new Error(
										`[escalate] merge worktree is ${mergeBranch || "detached"}@${mergeHead}, ` +
											`not approved PR state ${input.branch}@${finalComparison.currentHead}; refusing to enqueue.`,
									);
								}


								const merge = await runMerge({
									args: ["--auto", "--squash"],
									exec: bunExec,
									gh: github.gh,
									prNumber: pr.prNumber,
									cwd: input.worktree,
								});
								return {
									round: stampedRound.round,
									...finalComparison,
									checkedAt: nowIso(),
									submittedAt: nowIso(),
									receipt: merge.output.slice(-2000),
									alreadyLanded: false,
									mergePath: merge.path,
								};
							})()
						}
					</Task>
				) : null}

				{/* Normalize the successful round-scoped attempt into the stable
				    receipt row consumed by queue and landing verification. */}
				{authorizedRound !== null && pr !== undefined && !migStale ? (
					<Task id="enqueue-merge" output={outputs.mergeReceipt} retries={1}>
						{() => {
							const attempt = authorizedRound.headCheck;
							if (
								attempt.submittedAt === null ||
								attempt.receipt === null ||
								attempt.mergePath === null
							) {
								throw new Error(
									"[escalate] merge attempt was marked valid without a complete enqueue receipt.",
								);
							}
							return {
								round: authorizedRound.round,
								submittedAt: attempt.submittedAt,
								receipt: attempt.receipt,
								alreadyLanded: attempt.alreadyLanded,
								mergePath: attempt.mergePath,
								...(stackMode ? { cars: attempt.cars } : {}),
							};
						}}
					</Task>
				) : null}

				{/* -------------------------------- stage 8b: queue then landing verification */}
				{mergeReceipt !== undefined && pr !== undefined ? (
					<Loop
						id="queue-loop"
						until={ctx.latest(outputs.queuePoll, "queue-poll")?.state === "closed"}
						maxIterations={limits.landingPolls}
						onMaxReached="return-last"
					>
						<Task id="queue-poll" output={outputs.queuePoll} retries={1}>
							{() => (async () => {
								const pollNo = queueRows.length;
								if (!dryRun && pollNo > 0) await sleepSeconds(limits.landingPollSeconds * 2);
								const fixtureLifecycle = fixtures.queueLifecycle[pollNo];
								const prior = queueRows[queueRows.length - 1];
								const lifecycles = [];
								for (const car of effortCars) {
									const lifecycle = dryRun
										? {
												state: fixtureLifecycle?.state ?? "closed" as const,
												merged: false,
												autoMergeRequest: fixtureLifecycle?.autoMergeRequest ?? false,
												baseBranch: car.baseBranch,
											}
										: await fetchPrLifecycle(ghCtx, car.prNumber);
									const priorCar = prior?.cars?.find((candidate) => candidate.prNumber === car.prNumber);
									const ejected =
										lifecycle.state === "open" &&
										(stackMode ? priorCar?.autoMergeRequest === true : prior?.autoMergeRequest === true) &&
										!lifecycle.autoMergeRequest;
									lifecycles.push({
										prNumber: car.prNumber,
										state: lifecycle.state,
										merged: lifecycle.merged,
										baseBranch: lifecycle.baseBranch || car.baseBranch,
										autoMergeRequest: ejected ? true : lifecycle.autoMergeRequest,
										ejected,
									});
								}
								const ejectedCars = lifecycles.filter((lifecycle) => lifecycle.ejected);
								let newlyEligiblePr: number | undefined;
								if (stackMode) {
									const firstOpenIndex = lifecycles.findIndex(
										(lifecycle) => lifecycle.state === "open",
									);
									if (
										firstOpenIndex >= 0 &&
										lifecycles.slice(0, firstOpenIndex).every(
											(lifecycle) =>
												lifecycle.state === "closed" && lifecycle.merged,
										)
									) {
										const candidate = lifecycles[firstOpenIndex];
										const submittedAtBoundary =
											mergeReceipt.cars?.find(
												(car) => car.prNumber === candidate?.prNumber,
											)?.submittedAt !== null;
										const submittedInPriorPoll = queueRows.some(
											(row) =>
												row.cars?.find(
													(car) => car.prNumber === candidate?.prNumber,
												)?.autoMergeRequest === true,
										);
										if (
											candidate !== undefined &&
											!candidate.autoMergeRequest &&
											!submittedAtBoundary &&
											!submittedInPriorPoll
										) {
											newlyEligiblePr = candidate.prNumber;
										}
									}
								}
								const enqueueNumbers = new Set([
									...ejectedCars.map((car) => car.prNumber),
									...(newlyEligiblePr === undefined ? [] : [newlyEligiblePr]),
								]);
								if (enqueueNumbers.size > 0 && !dryRun) {
									const validity = ctx.latest(
										outputs.stampValidity,
										`r${mergeReceipt.round}-stamp-validity`,
									);
									if (stackMode) {
										const stampedCars = validity?.cars ?? [];
										if (stampedCars.length !== effortCars.length) {
											throw new Error(
												"[escalate] stack queue re-submit has no complete commit-bound topology.",
											);
										}
										const comparisons = await compareStackHeads(
											stampedCars,
											(prNumber) => fetchHeadSha(ghCtx, prNumber),
										);
										const drifted = comparisons.filter((comparison) => !comparison.ok);
										if (drifted.length > 0) {
											throw new Error(
												`[escalate] stack queue re-submit invalidated before enqueue; pushed nothing. ` +
													drifted.map((car) => `#${car.prNumber} ${car.headSha} -> ${car.currentHead}`).join("; "),
											);
										}
										await enqueueStackParentFirst(
											stampedCars.filter((car) => enqueueNumbers.has(car.prNumber)),
											async (prNumber) => {
												if (prNumber === newlyEligiblePr) {
													await execOrThrow(
														bunExec,
														[
															github.gh,
															"pr",
															"edit",
															String(prNumber),
															"--repo",
															input.repo,
															"--base",
															baseBranch,
														],
														{ cwd: input.worktree },
													);
												}
												const merge = await runMerge({
													exec: bunExec,
													gh: github.gh,
													prNumber,
													cwd: input.worktree,
													args: ["--auto", "--squash"],
												});
												return merge.output;
											},
										);
										for (const lifecycle of lifecycles) {
											if (!enqueueNumbers.has(lifecycle.prNumber)) continue;
											lifecycle.autoMergeRequest = true;
											if (lifecycle.prNumber === newlyEligiblePr) {
												lifecycle.baseBranch = baseBranch;
											}
										}
									} else {
										const approvedHead = validity?.stampedHead;
										const ejectedCar = ejectedCars[0];
										if (!approvedHead || ejectedCar === undefined) {
											throw new Error(
												"[escalate] merge queue re-submit has no commit-bound stamp.",
											);
										}
										const comparison = await compareApprovalStamp({
											exec: bunExec,
											gh: github.gh,
											repo: input.repo,
											prNumber: ejectedCar.prNumber,
											expectedHead: approvedHead,
										});
										if (!comparison.ok) {
											throw new Error(
												`[escalate] merge queue re-submit invalidated by a moved head; refusing to enqueue. ${comparison.diffSummary}`,
											);
										}
										const [mergeBranch, mergeHead] = await Promise.all([
											execOrThrow(
												bunExec,
												[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
												{ cwd: input.worktree },
											).then((value) => value.trim()),
											execOrThrow(bunExec, [github.git, "rev-parse", "HEAD"], {
												cwd: input.worktree,
											}).then((value) => value.trim()),
										]);
										if (
											mergeBranch !== input.branch ||
											mergeHead !== comparison.currentHead
										) {
											throw new Error(
												`[escalate] merge queue re-submit worktree is ${mergeBranch || "detached"}@${mergeHead}, ` +
													`not approved PR state ${input.branch}@${comparison.currentHead}; refusing to enqueue.`,
											);
										}
										await runMerge({
											exec: bunExec,
											gh: github.gh,
											prNumber: ejectedCar.prNumber,
											cwd: input.worktree,
											args: ["--auto", "--squash"],
										});
									}
								}
								const state = lifecycles.every((lifecycle) => lifecycle.state === "closed")
									? "closed" as const
									: "open" as const;
								const ejected = lifecycles.some((lifecycle) => lifecycle.ejected);
								return {
									poll: pollNo,
									state,
									baseBranch: lifecycles.at(-1)?.baseBranch ?? baseBranch,
									autoMergeRequest: lifecycles.some((lifecycle) => lifecycle.autoMergeRequest),
									ejected,
									reason: ejected
										? "one or more stack cars were ejected; auto-merge re-submitted"
										: state === "closed"
											? "effort closed; verify every squash on its live base"
											: "waiting in merge queue",
									...(stackMode ? { cars: lifecycles } : {}),
								};
							})()}
						</Task>
					</Loop>
				) : null}

				{latestQueue?.state === "closed" && mergeReceipt !== undefined && pr !== undefined ? (
					<Loop
						id="landing-loop"
						until={ctx.latest(outputs.landingPoll, "landing-poll")?.landed === true}
						maxIterations={limits.landingPolls}
						onMaxReached="return-last"
					>
						<Task id="landing-poll" output={outputs.landingPoll} retries={1}>
							{() =>
								(async () => {
									const pollNo = landingRows.length;
									if (!dryRun && pollNo > 0) await sleepSeconds(limits.landingPollSeconds);
									const queueCars = latestQueue?.cars ??
										effortCars.map((car) => ({
											prNumber: car.prNumber,
											baseBranch: latestQueue?.baseBranch || car.baseBranch,
										}));
									const cars = [];
									for (const car of queueCars) {
										if (dryRun) {
											cars.push({
												prNumber: car.prNumber,
												baseBranch: car.baseBranch,
												landed: fixtures.landingPollLanded,
												sha: fixtures.landingPollLanded
													? `dryrun-squash-sha-${car.prNumber}`
													: null,
												subject: `${input.ticket}: dry-run change (#${car.prNumber})`,
											});
											continue;
										}
										const commits = await fetchBaseCommitSubjects(
											github.git,
											input.worktree,
											car.baseBranch,
										);
										const landed = findLandingCommit(commits, car.prNumber);
										cars.push({
											prNumber: car.prNumber,
											baseBranch: car.baseBranch,
											landed: landed !== null,
											sha: landed?.sha ?? null,
											subject: landed?.subject ?? null,
										});
									}
									const top = cars.at(-1);
									return {
										poll: pollNo,
										landed: cars.every((car) => car.landed),
										sha: top?.sha ?? null,
										subject: top?.subject ?? null,
										...(stackMode ? { cars } : {}),
									};
								})()
							}
						</Task>
					</Loop>
				) : null}

				{latestQueue?.state === "open" && queueRows.length >= limits.landingPolls ? (
					<Task id="queue-exhausted" output={outputs.queuePoll} retries={0}>
						{() => { throw new Error(`[escalate] PR #${pr?.prNumber} remained in the merge queue after ${queueRows.length} polls.`); }}
					</Task>
				) : null}

				{latestQueue?.state === "closed" && landingRows.length >= limits.landingPolls && latestLanding?.landed !== true ? (
					<Task id="landing-exhausted" output={outputs.landingPoll} retries={0}>
						{() => {
							throw new Error(
								`[escalate] merge submitted but squash commit (#${pr?.prNumber}) never appeared on ${latestQueue?.baseBranch || baseBranch} after ${landingRows.length} polls. Check the GitHub merge queue; resume when resolved.`,
							);
						}}
					</Task>
				) : null}

				{stackMode && latestLanding?.landed === true && stackSync === undefined ? (
					<Task id="stack-sync-prune" output={outputs.stackSync} retries={1}>
						{() =>
							dryRun
								? {
										synced: true,
										receipt: "dry-run: gh stack sync --prune",
									}
								: syncStackPrune(bunExec, {
										gh: github.gh,
										worktree: input.worktree,
									}).then((receipt) => ({ synced: true, receipt }))
						}
					</Task>
				) : null}

				{/* -------------------------------- stage 9: fallout watch */}
				{latestLanding?.landed === true && (!stackMode || stackSync?.synced === true) ? (
					<Task id="deploy-evidence" output={outputs.deployEvidence} retries={1}>
						{() =>
							(async () => {
								if (dryRun) {
									return { evidence: fixtures.noFalloutProbe ? "PARK: no fallout probe configured" : "dry-run: deploy evidence simulated", deployedAt: nowIso() };
								}
								const probe = profile?.falloutCommand ?? commands.deployEvidence;
								if (probe === undefined) return { evidence: "PARK: no fallout probe configured", deployedAt: nowIso() };
								try {
									const out = await runShell(probe, input.worktree);
									return { evidence: out.slice(-4000), deployedAt: nowIso() };
								} catch (error) {
									return { evidence: `PARK: fallout probe unavailable (CD may be frozen): ${String(error).slice(-2000)}`, deployedAt: nowIso() };
								}
							})()
						}
					</Task>
				) : null}

				{deploy !== undefined ? (
					<Task id="fallout-window" output={outputs.falloutWindow} retries={0}>
						{() => {
							const start = deploy.deployedAt;
							const minutes = dryRun ? 0 : limits.falloutWindowMinutes;
							const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
							return { windowStart: start, windowEnd: end };
						}}
					</Task>
				) : null}

				{falloutWindow !== undefined ? (
					<Task id="fallout-wait" output={outputs.falloutWait} retries={1}>
						{() =>
							(async () => {
								const remainingMs = new Date(falloutWindow.windowEnd).getTime() - Date.now();
								if (remainingMs > 0) await sleepSeconds(remainingMs / 1000);
								return { complete: true, waitedUntil: nowIso() };
							})()
						}
					</Task>
				) : null}

				{falloutWait?.complete === true && brief !== null && pr !== undefined ? (
					<Task
						id="fallout-watch"
						output={outputs.fallout}
						agent={dryRun ? undefined : agents?.fallout}
						maxSchemaRetries={5}
						retries={1}
					>
						{dryRun || deploy?.evidence.startsWith("PARK:")
							? () => ({
									verdict: deploy?.evidence.startsWith("PARK:") ? "parked" as const : "clean" as const,
									breakSignal: brief.breakSignal,
									probeResults: [`fallout probe: ${deploy?.evidence ?? "clean"}`],
									notes: deploy?.evidence ?? "dry-run fallout watch",
								})
							: falloutPrompt({
									breakSignal: brief.breakSignal,
									killSwitch: JSON.stringify(brief.killSwitch),
									repo: input.repo,
									prNumber: pr.prNumber,
									landedSha: latestLanding?.sha ?? "",
									windowStart: falloutWindow?.windowStart ?? "",
									windowEnd: falloutWindow?.windowEnd ?? "",
									probes: commands.falloutProbes,
								})}
					</Task>
				) : null}

				{falloutRow?.verdict === "parked" && falloutEscalation === undefined ? (
					<Gate id="fallout-escalation" title={`FALLOUT probe parked: ${input.ticket}`} summary={falloutRow.notes} />
				) : null}

				{falloutRow?.verdict === "regression" && falloutEscalation === undefined ? (
					<Gate
						id="fallout-escalation"
						title={`FALLOUT detected: ${input.ticket} PR #${pr?.prNumber}`}
						summary={
							`Fallout watch verdict: REGRESSION on break-signal "${falloutRow.breakSignal}".\n` +
							`Probes:\n${falloutRow.probeResults.map((probe) => `  - ${probe}`).join("\n")}\n` +
							`Notes: ${falloutRow.notes}\n` +
							`Approve to record the regression + file follow-ups (run completes with verdict=regression on record). Deny to kill the run for immediate manual response.`
						}
					/>
				) : null}

				{/* -------------------------------- stage 10: evidence-gated done */}
				{falloutRow !== undefined &&
				((falloutRow.verdict === "clean" || falloutEscalation?.approved === true)) &&
				pr !== undefined ? (
					<Task id="done" output={outputs.doneRecord} retries={0}>
						{() => {
							const verdict = evaluateDone({
								landedSha: latestLanding?.sha ?? null,
								deployEvidence: deploy?.evidence ?? null,
								falloutVerdict: falloutRow.verdict,
								migrationRequired: migRequired,
								migrationEvidence: migrationRows,
							});
							if (!verdict.done) {
								throw new Error(
									`done gate refused - missing evidence:\n${verdict.missing.map((item) => `  - ${item}`).join("\n")}`,
								);
							}
							return {
								ticket: input.ticket,
								prNumber: pr.prNumber,
								...(stackMode ? { prNumbers: effortCars.map((car) => car.prNumber) } : {}),
								landedSha: latestLanding?.sha ?? "",
								falloutVerdict: falloutRow.verdict,
								migrationRequired: migRequired,
								completedAt: nowIso(),
							};
						}}
					</Task>
				) : null}
			</Parallel>
		</Workflow>
	);
});
