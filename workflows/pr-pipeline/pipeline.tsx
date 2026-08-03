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
} from "smithers-orchestrator";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

import { assertAdoptable, decideAdoptPush } from "./lib/adopt.ts";
import { validateBrief } from "./lib/brief.ts";
import { evaluateDone } from "./lib/done.ts";
import {
	bunExec,
	execOrThrow,
	fetchChangedFiles,
	fetchCodeowners,
	fetchHeadSha,
	fetchMainCommitSubjects,
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
import { runMerge, runMergeWithFallback } from "./lib/merge.ts";
import { detectMigrations, MIGRATION_STAGES, migrationEvidenceComplete } from "./lib/migrations.ts";
import { generatePullRequestDescription } from "./lib/description.ts";
import {
	defaultModelPolicy,
	parseModelRef,
	resolveAdversary,
	validateModelPolicy,
	type ModelPolicy,
} from "./lib/models.ts";
import { findProfile, type ModelSeat, type ProjectProfile } from "./lib/profiles.ts";
import {
	falloutPrompt,
	implementPrompt,
	reviewersDecisionPrompt,
	localFixPrompt,
	localReviewPrompt,
	watchFixPrompt,
} from "./lib/prompts.ts";
import { evaluateReadyForStamp } from "./lib/ready.ts";
import { executeReviewerRequest } from "./lib/reviewers.ts";
import { assessCi, evaluateWatchExit } from "./lib/watch.ts";
import { rebaseAndPush } from "./lib/rebase.ts";
import type { Brief, MigrationEvidenceEntry } from "./lib/types.ts";
import { claimMainFailure, produceWakeConditions, releaseMainFailure } from "../../v2/src/wake-producers.ts";
import { smithersWorkspaceCwd } from "../../v2/src/workspace.ts";
import { runTestCommand } from "./lib/test-lane.ts";

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
	queueLifecycle: [] as Array<{ state: "open" | "closed"; autoMergeRequest: boolean }>,
	landingPollLanded: true,
	noFalloutProbe: false,
	headChangeRounds: [] as number[],
};

export const DEFAULT_GITHUB = {
	gh: "gh",
	git: "git",
	selfLogins: ["twaldin"],
	excludedApprovers: ["ali"],
	reviewerDenylist: ["mackcooper1408", "spencer-negri", "daniel-covelli", "akshat-lindy"],
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
	brief: z.unknown().optional(),
	/** Default TRUE: real GH writes require explicit dryRun:false. */
	dryRun: z.boolean().optional(),
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
			queueLifecycle: z.array(z.object({ state: z.enum(["open", "closed"]), autoMergeRequest: z.boolean() })).optional(),
			landingPollLanded: z.boolean().optional(),
			noFalloutProbe: z.boolean().optional(),
			headChangeRounds: z.array(z.number().int().nonnegative()).optional(),
		})
		.optional(),
});

export const localReviewSchema = z.object({
	round: z.number().int(),
	approved: z.boolean(),
	blockingFindings: z.array(z.string()),
	nits: z.array(z.string()),
	summary: z.string(),
});

const schemas = {
	input: inputSchema,
	preflight: z.object({
		ok: z.boolean(),
		openQuestions: z.array(z.string()),
		briefDigest: z.string(),
		resolvedReviewerModel: z.string(),
	}),
	implementation: z.object({
		commits: z.array(z.string()),
		summary: z.string(),
		testEvidence: z.string(),
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
	}),
	prRecord: z.object({
		prNumber: z.number().int(),
		url: z.string(),
		headSha: z.string(),
		watchSetRegistered: z.boolean(),
		watchSetPath: z.string(),
		receipt: z.string(),
		createdAt: z.string(),
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
	}),
	watchFix: z.object({
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
	}),
	stampValidity: z.object({
		round: z.number().int(),
		stampedHead: z.string(),
		currentHead: z.string(),
		valid: z.boolean(),
		checkedAt: z.string(),
	}),
	mergeHeadCheck: z.object({
		round: z.number().int(),
		expectedHead: z.string(),
		currentHead: z.string(),
		ok: z.boolean(),
		checkedAt: z.string(),
	}),
	mergeReceipt: z.object({
		round: z.number().int(),
		submittedAt: z.string(),
		receipt: z.string(),
		alreadyLanded: z.boolean(),
		mergePath: z.enum(["graphite", "gh-fallback", "dry-run", "already-landed"]),
	}),
	queuePoll: z.object({
		poll: z.number().int(),
		state: z.enum(["open", "closed"]),
		autoMergeRequest: z.boolean(),
		ejected: z.boolean(),
		reason: z.string(),
	}),
	landingPoll: z.object({
		poll: z.number().int(),
		landed: z.boolean(),
		sha: z.string().nullable(),
		subject: z.string().nullable(),
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

/** Publish durable wake inputs for the deck extension. The extension reads this
 * record from the canonical Smithers workspace even without a TUI session. */
export function publishWakeProducer(input: { taskId: string; maxAdversarial?: boolean; reviewerSilent?: boolean; mainRed?: boolean; migrationBlocked?: boolean; brokerNoQuota?: boolean }): void {
	if (input.taskId.length === 0) return;
	const file = path.join(smithersWorkspaceCwd(), "wake-producers.json");
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { return; }
	try {
		let records: Array<typeof input> = [];
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof input | Array<typeof input>;
			records = Array.isArray(parsed) ? parsed : [parsed];
		} catch { /* create the producer log on first publish */ }
		records = records.filter((record) => record.taskId !== input.taskId);
		records.push(input);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
		produceWakeConditions({
			taskId: input.taskId,
			maxAdversarial: input.maxAdversarial,
			reviewerSilent: input.reviewerSilent,
			mainRed: input.mainRed,
			migrationBlocked: input.migrationBlocked,
			brokerNoQuota: input.brokerNoQuota,
		});
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

function seat(ref: ModelSeat): { ref: string; reasoning?: string } {
	return typeof ref === "string" ? { ref } : { ref: ref.model, reasoning: ref.reasoning };
}

function makeAgent(ref: ModelSeat, cwd: string, timeoutMs: number, reasoning = "medium"): PiAgent {
	const selected = seat(ref);
	const { provider, model } = parseModelRef(selected.ref);
	const thinking = selected.reasoning ?? reasoning;
	// Preserve the provider-native selector. If an older Smithers type does not
	// yet include `max`, the compatibility cast is local and does not rewrite the
	// value sent to Pi.

	return new PiAgent({
		provider,
		model,
		cwd,
		timeoutMs,
		thinking: thinking as never,
		noSession: true,
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
	const dryRun = input.dryRun !== false;
	const bypass = input.bypassApprovals === true;
	const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
	const fixtures = { ...DEFAULT_FIXTURES, ...(input.fixtures ?? {}) };
	const github = { ...DEFAULT_GITHUB, ...(input.github ?? {}) };
	const commands = { ...DEFAULT_COMMANDS, ...(input.commands ?? {}) };
	const baseBranch = input.baseBranch ?? "main";
	const adopt = input.existingPr != null;
	// Resolved once per render; yolo=false (stamp behavior) when omitted.
	const profile: ProjectProfile | null =
		input.profile === undefined ? null : findProfile(input.profile);
	const profileUnknown = input.profile !== undefined && profile === null;
	// The profile must be THIS repo's profile: without the binding, any caller
	// could attach the deck yolo profile to a lindy run and skip the stamp.
	const profileRepoMismatch =
		profile !== null && profile.repo.toLowerCase() !== input.repo.toLowerCase();
	const yolo = profile !== null && !profileRepoMismatch && profile.yolo;
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
	const localReviewRows = (ctx.outputs.localReview ?? []) as Array<{ round: number }>;
	const reviewEscalation = ctx.latest(outputs.approvals, "review-escalation");
	const pr = ctx.latest(outputs.prRecord, "push-pr");
	const reviewerRequest = ctx.latest(outputs.reviewerRequest, "request-reviewers");
	const migCheck = ctx.latest(outputs.migrationCheck, "migration-check");
	const migGate = ctx.latest(outputs.approvals, "migration-gate");
	const migScope = ctx.latest(outputs.migrationScope, "migration-scope");
	const migrationRows = (ctx.outputs.migrationRun ?? []) as MigrationEvidenceEntry[];
	const falloutRow = ctx.latest(outputs.fallout, "fallout-watch");
	const falloutEscalation = ctx.latest(outputs.approvals, "fallout-escalation");

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
	// A round authorizes the merge only with: approved stamp + valid post-stamp
	// validity + passing PRE-MERGE head re-check (closes the stamp->merge TOCTOU
	// window). A failed head check ends the round instead.
	const stampedRound = (() => {
		for (let k = 0; k <= currentRound && k < limits.stampRounds; k++) {
			const stamp = ctx.latest(outputs.approvals, `r${k}-stamp`);
			const validity = ctx.latest(outputs.stampValidity, `r${k}-stamp-validity`);
			const headCheck = ctx.latest(outputs.mergeHeadCheck, `r${k}-merge-head-check`);
			if (stamp?.approved === true && validity?.valid === true && headCheck?.ok !== false) {
				return { round: k, headSha: validity.stampedHead, headCheck };
			}
		}
		return null;
	})();
	const authorizedRound =
		stampedRound !== null && stampedRound.headCheck?.ok === true
			? { round: stampedRound.round, headSha: stampedRound.headSha }
			: null;

	const mergeReceipt = ctx.latest(outputs.mergeReceipt, "enqueue-merge");
	const latestQueue = ctx.latest(outputs.queuePoll, "queue-poll");
	const queueRows = (ctx.outputs.queuePoll ?? []) as Array<{
		poll: number;
		state: string;
		autoMergeRequest: boolean;
		ejected: boolean;
	}>;
	const latestLanding = ctx.latest(outputs.landingPoll, "landing-poll");
	const landingRows = (ctx.outputs.landingPoll ?? []) as Array<{ poll: number; landed: boolean }>;
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
	const agents = dryRun
		? null
		: {
				implementer: makeAgent(policy.implementer, input.worktree, 45 * 60_000, policy.reasoningImplementer),
				reviewer: makeAgent({ model: reviewerModel, reasoning: seat(policy.reviewer ?? reviewerModel).reasoning }, input.worktree, 20 * 60_000, policy.reasoningReviewer),
				watcher: makeAgent(policy.watcher, input.worktree, 30 * 60_000, policy.reasoningWatcher),
				fallout: makeAgent(policy.fallout, input.worktree, 15 * 60_000, policy.reasoningFallout),
			};

	// -- approval gate helper (bypass only allowed with dryRun; preflight enforces) --
	const Gate = (props: { id: string; title: string; summary: string }) => {
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
		return (
			<Approval
				id={props.id}
				output={outputs.approvals}
				request={{ title: props.title, summary: props.summary }}
				onDeny="fail"
			/>
		);
	};

	// -- reviewApproved gate for push -----------------------------------------------
	const reviewApproved = latestLocalReview?.approved === true;
	const reviewExhausted =
		localReviewRows.length >= limits.localReviewRounds && !reviewApproved;
	const pushAllowed = reviewApproved || reviewEscalation?.approved === true;
	const producerWatch = ctx.latest(outputs.watchPoll, `r${currentRound}-watch-poll`);
	const coordinationRoot = path.join(smithersWorkspaceCwd(), ".deck-coordination");
	const mainFingerprint = `${input.repo}:${baseBranch}`;
	const mainFailureClaimed = producerWatch?.ci === "red"
		? claimMainFailure(coordinationRoot, mainFingerprint, input.ticket)
		: (releaseMainFailure(coordinationRoot, mainFingerprint), false);
	publishWakeProducer({
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
							throw new Error(
								`PREFLIGHT REFUSED - the brief is not dispatchable. Open questions:\n` +
									preflight.openQuestions.map((question) => `  - ${question}`).join("\n") +
									`\nResolve every item and start a NEW run (input is immutable).`,
							);
						}}
					</Task>
				) : null}

				{/* ------------------------------------------------ stage 1: implement */}
				{/* Adopt path: the code already lives on the PR. The implement node
				    still runs (downstream gates key off its row) but as a stub compute
				    task — no agent, no greenfield work. */}
				{preflight?.ok === true && brief !== null && adopt ? (
					<Task id="implement" output={outputs.implementation} retries={0}>
						{() => ({
							commits: [],
							summary: `adopted existing PR #${input.existingPr}: implementation lives on the PR`,
							testEvidence: `adopted existing PR #${input.existingPr}: CI on the PR is the evidence`,
						})}
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
							? () => ({
									commits: ["dryrun-commit-1"],
									summary: `dry-run: implemented "${brief.title}"`,
									testEvidence: "dry-run: tests simulated green",
								})
							: implementPrompt(brief, input.worktree, input.branch)}
					</Task>
				) : null}

				{/* ---------------------------------- stage 2: local adversarial review */}
				{/* Adopt skips implementation only; local adversarial review remains mandatory. */}
				{implementation !== undefined && brief !== null ? (
					<Loop
						id="local-review-loop"
						until={latestLocalReview?.approved === true}
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
									const prNumber = input.existingPr as number;
									if (dryRun) {
										return {
											prNumber,
											url: `https://github.com/${input.repo}/pull/${prNumber}`,
											headSha: "dryrun-head-sha",
											watchSetRegistered: true,
											watchSetPath: "(dry-run: not written)",
											receipt: `dry-run: adopted existing PR #${prNumber}`,
											createdAt: nowIso(),
											runId: ctx.runId,
										};
									}
									let overview = await fetchPrOverview(ghCtx, prNumber);
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
										baseBranch,
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
										watchSetRegistered: true,
										watchSetPath,
										receipt: `adopted existing PR #${prNumber} (head ${overview.headSha})`,
										createdAt: nowIso(),
										runId: ctx.runId,
									};
								}
								if (dryRun) {
									return {
										prNumber: fixtures.prNumber,
										url: `https://github.com/${input.repo}/pull/${fixtures.prNumber}`,
										headSha: "dryrun-head-sha",
										watchSetRegistered: true,
										watchSetPath: "(dry-run: not written)",
										receipt: "dry-run push receipt",
										createdAt: nowIso(),
									};
								}
								// 1. push the branch (idempotent).
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
									const createOut = await execOrThrow(bunExec, [
										github.gh, "pr", "create",
										"--repo", input.repo,
										"--head", input.branch,
										"--base", baseBranch,
										"--title", `${input.ticket}: ${brief?.title ?? input.ticket}`,
										"--body",
										generatePullRequestDescription({
											brief: brief ?? { summary: "", acceptanceCriteria: [] },
											testing: implementation.testEvidence,
											reviewOutcome: latestLocalReview?.summary,
										}),
									]);
									url = createOut.trim().split("\n").pop() ?? "";
									const match = url.match(/\/pull\/(\d+)/);
									if (match === null) throw new Error(`could not parse PR number from: ${url}`);
									prNumber = Number(match[1]);
								}
								const headSha = await fetchHeadSha(ghCtx, prNumber);
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
									// The ONLY way this stage ends with no reviewers: an
									// explicit input opt-out, recorded as such.
									return {
										skipped: true,
										requested: [],
										verified: [],
										source: "explicit-skip",
										at: nowIso(),
										reviewerPrompt: reviewersDecisionPrompt(github.reviewerDenylist),
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
									};
								}
								// Selection + request + silent-no-op verification live in
								// lib/reviewers.ts (unit-tested against mocked adapters).
								// Explicit sources MERGE (brief + input config, deduped in
								// selection); entries may be display names (name->login
								// lookup; unresolvable entries escalate, never dropped).
								const result = await executeReviewerRequest(
									{
										explicit: [...(brief?.suggestedReviewers ?? []), ...github.reviewers],
										exclude: [...github.selfLogins, ...github.excludedApprovers],
										denylist: github.reviewerDenylist,
										max: github.maxReviewers,
									},
									{
										fetchChangedFiles: () => fetchChangedFiles(ghCtx, pr.prNumber),
										fetchCodeowners: () => fetchCodeowners(ghCtx),
										fetchRecentAuthors: (files) => fetchRecentAuthors(ghCtx, files),
										resolveLogin: (entry) => resolveReviewerLogin(ghCtx, entry),
										isCollaborator: (login) => isCollaborator(ghCtx, login),
										logSkip: (login, reason) => console.warn(`[reviewer-skip] ${login}: ${reason}`),
										requestReviewers: (logins) => requestReviewers(ghCtx, pr.prNumber, logins),
										fetchRequestedReviewers: () => fetchRequestedReviewers(ghCtx, pr.prNumber),
									},
								);
								return { ...result, reviewerPrompt: reviewersDecisionPrompt(github.reviewerDenylist) };
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
									: await fetchChangedFiles(ghCtx, pr.prNumber);
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
									: await fetchChangedFiles(ghCtx, pr.prNumber);
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
								const watchRows = watchPollRows.filter((row) => row.round === k);
								const watchExhausted =
									watchRows.length >= limits.watchPolls && latestWatch?.exitOk !== true;
								const watchEscalation = ctx.latest(outputs.approvals, `r${k}-watch-escalation`);
								const watchSettled =
									latestWatch?.exitOk === true || watchEscalation?.approved === true;
								const latestFix = ctx.latest(outputs.watchFix, `r${k}-watch-fix`);

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
																return {
																	round: k,
																	poll: pollNo,
																	headSha: "dryrun-head-sha",
																	exitOk,
																	disposition: exitOk
																		? "complete"
																		: actionable
																			? "fix"
																			: "wait",
																	actionable,
																	ci: exitOk ? "green" : "will-be-green",
																	unresolvedThreads: actionable ? 1 : 0,
																	unansweredComments: actionable ? 1 : 0,
																	reviewersToReRequest: actionable ? ["dry-reviewer"] : [],
														rebaseRequired: false,
																	reasons: exitOk
																		? []
																		: waiting
																			? ["dry-run: CI is pending; Smithers owns the next poll"]
																			: ["dry-run: 1 unresolved thread"],
																};
															}
															if (pollNo > 0) await sleepSeconds(limits.watchPollSeconds);
															const snapshot = await fetchWatchSnapshot(
																ghCtx,
																pr.prNumber,
																github.selfLogins,
															);
															const mainCi = assessCi(await fetchBranchCheckRuns(ghCtx, baseBranch));
										if (mainCi === "red") {
											return {
												round: k, poll: pollNo, headSha: snapshot.headSha,
												exitOk: false, disposition: "wait", actionable: false, ci: "red",
												unresolvedThreads: 0, unansweredComments: 0, reviewersToReRequest: [],
												reasons: [`base branch ${baseBranch} has failing checks; CI watch is paused until it is green.`],
												rebaseRequired: false,
											};
										}
										const verdict = evaluateWatchExit(snapshot, {
																selfLogins: github.selfLogins,
															});
															return {
																round: k,
																poll: pollNo,
																headSha: snapshot.headSha,
																exitOk: verdict.exitOk,
																disposition: verdict.disposition,
																actionable: verdict.actionable,
																ci: verdict.ci,
																unresolvedThreads: verdict.unresolvedThreads,
																unansweredComments: verdict.unansweredComments,
																reviewersToReRequest: verdict.reviewersNeedingReRequest,
																reasons: verdict.reasons,
																		rebaseRequired: verdict.rebaseRequired,
															};
														})()
													}
												</Task>
												{latestWatch !== undefined &&
												!latestWatch.exitOk &&
												latestWatch.actionable &&
												(latestFix === undefined || latestFix.afterPoll < latestWatch.poll) ? (
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
																	actions: [
																		"dry-run: answered thread",
																		"dry-run: re-requested dry-reviewer",
																	],
																	pushed: false,
																	reRequested: ["dry-reviewer"],
																	summary: "dry-run: feedback addressed",
																})
															: latestWatch.rebaseRequired
															? async () => {
																	const actions = await rebaseAndPush(bunExec, { git: github.git, worktree: input.worktree, branch: input.branch, baseBranch, testCommand: commands.test });
																	const reviewers = latestWatch.reviewersToReRequest;
																			if (reviewers.length > 0) await requestReviewers(ghCtx, pr.prNumber, reviewers);
																			return { round: k, afterPoll: latestWatch.poll, actions: [...actions, "answered review feedback", ...reviewers.map((reviewer) => `re-requested ${reviewer}`)], pushed: true, reRequested: reviewers, summary: "Rebased, addressed review feedback, tested, pushed, and re-requested review." };
																}
															: watchFixPrompt({
																	worktree: input.worktree,
																	branch: input.branch,
																	baseBranch,
																	repo: input.repo,
																	project,
prNumber: pr.prNumber,
																	gh: github.gh,
																	pollJson: JSON.stringify(latestWatch, null, 2),
																	round: k,
																	afterPoll: latestWatch.poll,
																})}
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
																return {
																	round: k,
																	poll: pollNo,
																	ready: true,
																	regressed: false,
																	approvedBy: "tim-dryrun",
																	ci: "green",
																	headSha: "dryrun-head-sha",
																	reasons: [],
																	migrationDetected: migRequired,
																	migrationFiles: migCheck?.files ?? [],
																	at: nowIso(),
																};
															}
															if (pollNo > 0) await sleepSeconds(limits.readyPollSeconds);
															// Re-check watch conditions: regressions send us
															// back to a fresh watch round, not a silent stamp.
															const snapshot = await fetchWatchSnapshot(
																ghCtx,
																pr.prNumber,
																github.selfLogins,
															);
															const watchVerdict = evaluateWatchExit(snapshot, {
																selfLogins: github.selfLogins,
															});
															const files = await fetchChangedFiles(ghCtx, pr.prNumber);
															const migrationFiles = detectMigrations(files);
															const migrationDetected = migrationFiles.length > 0;
															if (!watchVerdict.exitOk) {
																return {
																	round: k,
																	poll: pollNo,
																	ready: false,
																	regressed: true,
																	approvedBy: null,
																	ci: watchVerdict.ci,
																	headSha: snapshot.headSha,
																	reasons: [
																		"watch conditions regressed:",
																		...watchVerdict.reasons,
																	],
																	migrationDetected,
																	migrationFiles,
																	at: nowIso(),
																};
															}
															if (migrationDetected && !migrationEvidenceComplete(migrationRows)) {
																return {
																	round: k,
																	poll: pollNo,
																	ready: false,
																	regressed: true,
																	approvedBy: null,
																	ci: watchVerdict.ci,
																	headSha: snapshot.headSha,
																	reasons: [
																		"migration paths detected in diff but evidence incomplete - migration gate must run before stamp.",
																	],
																	migrationDetected,
																	migrationFiles,
																	at: nowIso(),
																};
															}
															const { approvals: prApprovals, checkRuns } =
																await fetchPrApprovalsAndCi(ghCtx, pr.prNumber);
															// Use the FRESH check runs, not the earlier watch
															// snapshot's: CI may have gone hard-red in between.
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
															return {
																round: k,
																poll: pollNo,
																ready: readyVerdict.ready,
																regressed: false,
																approvedBy: readyVerdict.approvedBy,
																ci: readyVerdict.ci,
																headSha: snapshot.headSha,
																reasons: readyVerdict.reasons,
																migrationDetected,
																migrationFiles,
																at: nowIso(),
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
												title={`STAMP + merge word: ${input.ticket} PR #${pr.prNumber} (round ${k})`}
												summary={[
													`Original issue: ${brief?.summary ?? input.ticket}`,
													`Fix: ${implementation?.summary ?? "(see PR)"}`,
													`Danger/blast radius: ${brief?.blastRadius ?? "(not declared in brief)"}`,
													`PR: ${pr.url}`,
													`Head at ready: ${latestReady.headSha}`,
													`Human review approval: ${latestReady.approvedBy ?? "n/a"}`,
													`CI: ${latestReady.ci} (green-or-will-be-green per captain ruling)`,
													`Migration gate: ${migRequired ? `TRIGGERED (evidence ${migEvidenceOk ? "complete" : "INCOMPLETE"})` : "not triggered"}`,
													``,
													`Approving = stamp + the per-PR merge word. The workflow (not an agent)`,
													`submits to the GitHub merge queue. Head change after this stamp`,
													`invalidates it and re-enters watch-ci (no silent re-stamp).`,
												].join("\n")}
											/>
										) : null}

										{stamp?.approved === true ? (
											<Task id={`r${k}-stamp-validity`} output={outputs.stampValidity} retries={1}>
												{() =>
													(async () => {
														const stampedHead = latestReady?.headSha ?? "";
														if (dryRun) {
															const moved = fixtures.headChangeRounds.includes(k);
															return {
																round: k,
																stampedHead,
																currentHead: moved ? `${stampedHead}-moved` : stampedHead,
																valid: !moved,
																checkedAt: nowIso(),
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

				{/* -------------- pre-merge head re-check (stamp->merge TOCTOU guard) */}
				{stampedRound !== null && stampedRound.headCheck === undefined && pr !== undefined && !migStale ? (
					<Task
						id={`r${stampedRound.round}-merge-head-check`}
						output={outputs.mergeHeadCheck}
						retries={1}
					>
						{() =>
							(async () => {
								const expectedHead = stampedRound.headSha;
								const currentHead = dryRun
									? expectedHead // fixtures move the head via stamp-validity, not here
									: await fetchHeadSha(ghCtx, pr.prNumber);
								return {
									round: stampedRound.round,
									expectedHead,
									currentHead,
									ok: currentHead === expectedHead,
									checkedAt: nowIso(),
								};
							})()
						}
					</Task>
				) : null}

				{/* ------------------------------------------------ stage 8: MQ merge */}
				{authorizedRound !== null && pr !== undefined && !migStale ? (
					<Task id="enqueue-merge" output={outputs.mergeReceipt} retries={1}>
						{() =>
							(async () => {
								if (dryRun) {
									return {
										round: authorizedRound.round,
										submittedAt: nowIso(),
										receipt: `dry-run: submitted PR #${pr.prNumber} to merge queue at head ${authorizedRound.headSha}`,
										alreadyLanded: false,
										mergePath: "dry-run",
									};
								}
								// Idempotency: if the squash commit is already on main
								// (crash after submit), do not submit again.
								const commits = await fetchMainCommitSubjects(github.git, input.worktree);
								const landed = findLandingCommit(commits, pr.prNumber);
								if (landed !== null) {
									return {
										round: authorizedRound.round,
										submittedAt: nowIso(),
										receipt: `already landed as ${landed.sha} ("${landed.subject}") - no resubmit`,
										alreadyLanded: true,
										mergePath: "already-landed",
									};
								}
								// Last-instant head re-check INSIDE the submit node: the
								// r{N}-merge-head-check node closed most of the stamp->merge
								// window; this closes the scheduler gap between that node and
								// this one. Throwing BEFORE submit is safe (nothing was
								// enqueued; retry/resume re-checks).
								const headNow = await fetchHeadSha(ghCtx, pr.prNumber);
								if (headNow !== authorizedRound.headSha) {
									throw new Error(
										`[escalate] PR head moved to ${headNow} after the stamp (stamped ${authorizedRound.headSha}) - refusing to submit to the merge queue. The next render re-enters watch-ci via the head-check round guard.`,
									);
								}
								// The merge command runs against the worktree's CURRENT
								// branch (the merge command is scoped to the PR) - refuse if the worktree
								// drifted off the PR branch, or the wrong PR gets merged.
								const mergeBranch = (
									await execOrThrow(
										bunExec,
										[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
										{ cwd: input.worktree },
									)
								).trim();
								if (mergeBranch !== input.branch) {
									throw new Error(
										`[escalate] worktree is on branch "${mergeBranch}", not "${input.branch}" - refusing to run the merge command there (it acts on the current branch and would merge the wrong PR).`,
									);
								}
								const merge = await runMerge({
									args: ["--auto", "--squash"],
									exec: bunExec,
									gh: github.gh,
									prNumber: pr.prNumber,
									cwd: input.worktree,
									// GitHub's merge queue is the only landing path.
								});
								return {
									round: authorizedRound.round,
									submittedAt: nowIso(),
									receipt: merge.output.slice(-2000),
									alreadyLanded: false,
									mergePath: merge.path,
								};
							})()
						}
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
								const lifecycle = dryRun
									? { state: fixtureLifecycle?.state ?? "closed" as const, merged: false, autoMergeRequest: fixtureLifecycle?.autoMergeRequest ?? false }
									: await fetchPrLifecycle(ghCtx, pr.prNumber);
								const prior = queueRows[queueRows.length - 1];
								const ejected = lifecycle.state === "open" && prior?.autoMergeRequest === true && !lifecycle.autoMergeRequest;
								if (ejected) {
									// GitHub removes auto-merge when a queued PR is ejected. Re-submit it
									// through GitHub's native merge queue.
									if (!dryRun) {
										const mergeBranch = (
											await execOrThrow(
												bunExec,
												[github.git, "rev-parse", "--abbrev-ref", "HEAD"],
												{ cwd: input.worktree },
											)
										).trim();
										if (mergeBranch !== input.branch) {
											throw new Error(
													`[escalate] worktree is on branch "${mergeBranch}", not "${input.branch}" - refusing to re-submit the merge command there (it acts on the current branch and would merge the wrong PR).`,
											);
										}
										await runMerge({ exec: bunExec, gh: github.gh, prNumber: pr.prNumber, cwd: input.worktree, args: ["--auto", "--squash"] });
									}
								}
								return { poll: pollNo, state: lifecycle.state, autoMergeRequest: ejected ? true : lifecycle.autoMergeRequest, ejected, reason: ejected ? "PR ejected; auto-merge re-submitted" : lifecycle.state === "closed" ? "PR closed; verify squash on base" : "waiting in merge queue" };
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
									if (dryRun) {
										return {
											poll: pollNo,
											landed: fixtures.landingPollLanded,
											sha: fixtures.landingPollLanded ? "dryrun-squash-sha" : null,
											subject: `${input.ticket}: dry-run change (#${pr.prNumber})`,
										};
									}
									if (pollNo > 0) await sleepSeconds(limits.landingPollSeconds);
									// NEVER rely on the merged flag. Search main for "(#N)" to
									// confirm the squash landed.
									const commits = await fetchMainCommitSubjects(github.git, input.worktree);
									const landed = findLandingCommit(commits, pr.prNumber);
									return {
										poll: pollNo,
										landed: landed !== null,
										sha: landed?.sha ?? null,
										subject: landed?.subject ?? null,
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
								`[escalate] merge submitted but squash commit (#${pr?.prNumber}) never appeared on main after ${landingRows.length} polls. Check the GitHub merge queue; resume when resolved.`,
							);
						}}
					</Task>
				) : null}

				{/* -------------------------------- stage 9: fallout watch */}
				{latestLanding?.landed === true ? (
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
