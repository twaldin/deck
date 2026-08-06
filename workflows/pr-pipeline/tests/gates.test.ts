/**
 * Unit tests for the pure gate logic: preflight brief validation, watch-exit
 * machine check, migration detection, ready-for-stamp, landing verification,
 * evidence-gated done, and model family opposition.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateBrief } from "../lib/brief.ts";
import { evaluateDone } from "../lib/done.ts";
import { fetchBranchCheckRuns, parseCheckRuns, parseRequestedReviewers, parseReviews, parseReviewThreads } from "../lib/gh.ts";
import { findLandingCommit } from "../lib/landing.ts";
import { detectMigrations, migrationEvidenceComplete, missingMigrationStages } from "../lib/migrations.ts";
import {
	DECK_AGENT_CATALOG,
	defaultModelPolicy,
	modelFamily,
	modelReasoningPolicy,
	parseModelRef,
	resolveAdversary,
	validateModelPolicy,
} from "../lib/models.ts";
import { watchFixPrompt } from "../lib/prompts.ts";
import { evaluateReadyForStamp, findHumanApproval } from "../lib/ready.ts";
import {
	assessCi,
	assessMergeSafety,
	classifyCiEvidence,
	evaluateWatchExit as evaluateWatchExitRequired,
	reviewersNeedingReRequest,
	unansweredComments,
	isReviewFinding,
	observeHeadAge,
} from "../lib/watch.ts";
import type { MigrationEvidenceEntry, WatchSnapshot } from "../lib/types.ts";
import ciFailureFixtures from "./fixtures/ci-failures.json";

const TEST_REVIEW_POLICY = { requireHuman: true, requiredBots: [] };
function evaluateWatchExit(
	snapshot: WatchSnapshot,
	options: Omit<Parameters<typeof evaluateWatchExitRequired>[1], "reviewPolicy"> & {
		reviewPolicy?: Parameters<typeof evaluateWatchExitRequired>[1]["reviewPolicy"];
	},
) {
	return evaluateWatchExitRequired(snapshot, {
		reviewPolicy: TEST_REVIEW_POLICY,
		...options,
	});
}

// Keep gate tests away from the operator home. Some imported helpers can write
// wake state while evaluating workflow-related fixtures.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gates-home-"));
const originalDeckV2Home = process.env.DECK_V2_HOME;

beforeAll(() => {
	process.env.DECK_V2_HOME = testHome;
});
afterEach(() => {
	fs.rmSync(path.join(testHome, "state"), { recursive: true, force: true });
});
afterAll(() => {
	if (originalDeckV2Home === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = originalDeckV2Home;
	fs.rmSync(testHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Preflight: brief validation
// ---------------------------------------------------------------------------

const validBrief = {
	ticket: "LIN-123",
	title: "Add rate limiting",
	summary: "Rate-limit the /api/foo endpoint",
	acceptanceCriteria: ["429 after 100 req/min", "e2e test proves the limit"],
	decisionLedger: [{ question: "Which store?", decision: "redis", open: false }],
	killSwitch: { kind: "named", name: "RATE_LIMIT_ENABLED flag" },
	breakSignal: "sentry:lindy-api #on-call-issues",
};

describe("validateBrief (preflight gate)", () => {
	test("accepts a complete brief", () => {
		const result = validateBrief(validBrief);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.brief.ticket).toBe("LIN-123");
			expect(result.brief.killSwitch).toEqual({ kind: "named", name: "RATE_LIMIT_ENABLED flag" });
		}
	});

	test("refuses a missing brief with the reason", () => {
		const result = validateBrief(undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.openQuestions[0]).toContain("brief is missing");
	});

	test("refuses empty acceptance criteria", () => {
		const result = validateBrief({ ...validBrief, acceptanceCriteria: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.openQuestions.some((q) => q.includes("acceptanceCriteria"))).toBe(true);
		}
	});

	test("refuses open decision-ledger entries, listing each question", () => {
		const result = validateBrief({
			...validBrief,
			decisionLedger: [
				{ question: "Which store?", decision: "redis", open: false },
				{ question: "What about burst traffic?", decision: null, open: true },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.openQuestions.some((q) => q.includes("What about burst traffic?"))).toBe(true);
		}
	});

	test("entry with a decision but open:true still refuses", () => {
		const result = validateBrief({
			...validBrief,
			decisionLedger: [{ question: "Q", decision: "D", open: true }],
		});
		expect(result.ok).toBe(false);
	});

	test("refuses a missing kill-switch declaration", () => {
		const { killSwitch: _omitted, ...rest } = validBrief;
		const result = validateBrief(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.openQuestions.some((q) => q.includes("killSwitch"))).toBe(true);
		}
	});

	test('accepts explicit killSwitch kind:"none" WITH a break-signal', () => {
		const result = validateBrief({ ...validBrief, killSwitch: { kind: "none" } });
		expect(result.ok).toBe(true);
	});

	test("refuses kind:none without a break-signal", () => {
		const result = validateBrief({
			...validBrief,
			killSwitch: { kind: "none" },
			breakSignal: "",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.openQuestions.some((q) => q.includes("breakSignal"))).toBe(true);
		}
	});

	test("named kill-switch with empty name refuses", () => {
		const result = validateBrief({ ...validBrief, killSwitch: { kind: "named", name: " " } });
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Model policy: catalog + family opposition (captain addendum)
// ---------------------------------------------------------------------------

describe("model policy (deck catalog + family opposition)", () => {
	test("defaults are valid and cross-family", () => {
		expect(validateModelPolicy(defaultModelPolicy())).toEqual([]);
	});

	test("defaults encode the captain's role, model, and reasoning choices", () => {
		expect(defaultModelPolicy()).toMatchObject({
			implementer: "deck/gpt-5.6-sol",
			reviewer: "deck/claude-fable-5",
			mechanical: "deck/gpt-5.6-luna",
			judgmentFallback: "deck/claude-opus-5",
			reasoningImplementer: "xhigh",
			reasoningReviewer: "high",
			reasoningMechanical: "xhigh",
		});
	});

	test("reasoning map normalizes bare Deck selectors for Prime child pinning", () => {
		const policy = { ...defaultModelPolicy(), mechanical: "gpt-5.6-luna" };
		expect(modelReasoningPolicy(policy)["deck/gpt-5.6-luna"]).toBe("xhigh");
	});

	test("parseModelRef splits provider/model", () => {
		expect(parseModelRef("deck/claude-opus-5")).toEqual({ provider: "deck", model: "claude-opus-5" });
		expect(parseModelRef("claude-opus-5")).toEqual({ provider: "deck", model: "claude-opus-5" });
	});

	test("modelFamily classifies both families", () => {
		expect(modelFamily("deck/claude-sonnet-5")).toBe("anthropic");
		expect(modelFamily("deck/gpt-5.6-sol")).toBe("openai");
	});

	test("resolveAdversary picks the OPPOSITE family when reviewer is unset", () => {
		const policy = { ...defaultModelPolicy(), reviewer: undefined };
		expect(modelFamily(resolveAdversary("deck/claude-sonnet-5", policy))).toBe("openai");
		expect(modelFamily(resolveAdversary("deck/gpt-5.6-terra", policy))).toBe("anthropic");
		expect(modelFamily(resolveAdversary("deck/gpt-5.6-luna", policy))).toBe("anthropic");
		expect(resolveAdversary("deck/claude-fable-5", policy)).toBe("deck/gpt-5.6-sol");
	});

	test("same-family reviewer with opposition ON is a violation", () => {
		const policy = { ...defaultModelPolicy(), implementer: "deck/claude-sonnet-5", reviewer: "deck/claude-opus-5" };
		const violations = validateModelPolicy(policy);
		expect(violations.some((v) => v.includes("same family"))).toBe(true);
	});

	test("same-family reviewer with opposition explicitly OFF is allowed", () => {
		const policy = {
			...defaultModelPolicy(),
			implementer: "deck/claude-sonnet-5",
			reviewer: "deck/claude-opus-5",
			familyOpposition: false,
		};
		expect(validateModelPolicy(policy)).toEqual([]);
	});

	test("non-deck provider is a violation", () => {
		const policy = { ...defaultModelPolicy(), implementer: "openai/gpt-5.6-sol" };
		const violations = validateModelPolicy(policy);
		expect(violations.some((v) => v.includes("deck provider"))).toBe(true);
	});

	test("model outside the agent-pickable catalog is a violation", () => {
		const policy = { ...defaultModelPolicy(), watcher: "deck/claude-2" };
		const violations = validateModelPolicy(policy);
		expect(violations.some((v) => v.includes("agent-pickable"))).toBe(true);
	});

	test("catalog only contains deck-qualified base ids", () => {
		for (const model of DECK_AGENT_CATALOG) {
			expect(model.includes("/")).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// watch-ci-review exit (machine-checked)
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
	return {
		headSha: "abc123",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		behindBy: 0,
		lastPushAt: "2026-07-27T10:00:00Z",
		threads: [],
		comments: [],
		reviewers: [
			{ login: "human-reviewer", isBot: false, lastActivityAt: "2026-07-27T11:00:00Z", lastReviewState: "APPROVED" },
			{ login: "claude[bot]", isBot: true, lastActivityAt: "2026-07-27T11:01:00Z", lastReviewState: "APPROVED" },
		],
		requestedReviewers: [],
		checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
		...overrides,
	};
}

describe("evaluateWatchExit", () => {
	test("clean snapshot exits", () => {
		const verdict = evaluateWatchExit(snapshot(), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.actionable).toBe(false);
	});

	test("CONFLICTING blocks exit and requests a rebase fix", () => {
		const verdict = evaluateWatchExit(snapshot({ mergeable: "CONFLICTING" }), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(false);
		expect(verdict.disposition).toBe("fix");
		expect(verdict.actionable).toBe(true);
		expect(verdict.reasons.join(" ")).toContain("needs rebase");
	});

	test("DIRTY blocks exit and requests a rebase fix", () => {
		const verdict = evaluateWatchExit(snapshot({ mergeStateStatus: "DIRTY" }), { selfLogins: ["twaldin"] });
		expect(verdict.disposition).toBe("fix");
		expect(verdict.reasons.join(" ")).toContain("needs rebase");
	});

	test("GitHub BEHIND is not a conflict and does not invent a rebase trigger", () => {
		const verdict = evaluateWatchExit(snapshot({ mergeStateStatus: "BEHIND", behindBy: 21 }), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.rebaseRequired).toBe(false);
		expect(verdict.triggers).toHaveLength(0);
	});

	test("an old unresolved thread is visible but does not invent a new trigger", () => {
		const verdict = evaluateWatchExit(
			snapshot({ threads: [{ id: "t1", isResolved: false, lastCommenter: "rev" }] }),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(true);
		expect(verdict.unresolvedThreads).toBe(1);
		expect(verdict.triggers).toEqual([]);
	});

	test("verified Linear linkbacks do not create watch work", () => {
		const verdict = evaluateWatchExit(snapshot({
			comments: [{ author: "linear[bot]", isBot: true, createdAt: "2026-07-27T11:00:00Z", body: "<!-- linear-linkback -->" }],
		}), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.unansweredComments).toBe(0);
	});

	test("humans and only profile-configured review bots are findings", () => {
		expect(isReviewFinding({ author: "reviewer", isBot: false, createdAt: "", body: "linear scan breaks link handling" })).toBe(true);
		expect(isReviewFinding(
			{ author: "claude[bot]", isBot: true, createdAt: "", body: "Please fix the linear link handling" },
			["claude[bot]"],
		)).toBe(true);
		expect(isReviewFinding({ author: "claude[bot]", isBot: true, createdAt: "", body: "noise" })).toBe(false);
	});

	test("unrelated automation is never promoted into review work", () => {
		expect(isReviewFinding({ author: "linear[bot]", isBot: true, createdAt: "", body: "<!-- linear-linkback -->" })).toBe(false);
		expect(isReviewFinding({ author: "linear[bot]", isBot: true, createdAt: "", body: "the linear scan here breaks the link handling" })).toBe(false);
		expect(isReviewFinding({ author: "unknown[bot]", isBot: true, createdAt: "", body: "automation banner" })).toBe(false);
	});

	test("distance from base alone never wakes a conflict resolver", () => {
		const verdict = evaluateWatchExit(snapshot({ mergeStateStatus: "BLOCKED", behindBy: 21 }), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.rebaseRequired).toBe(false);

		expect(verdict.reasons.join(" ")).not.toContain("commit(s) behind");
	});
	test("merge safety preserves a stamp only while exact-head CI is genuinely pending", () => {
		const pending = assessMergeSafety(snapshot({
			checkRuns: [{
				name: "ci",
				status: "in_progress",
				conclusion: null,
				headSha: "abc123",
				startedAt: "2026-07-27T10:00:00Z",
			}],
		}), "abc123");
		expect(pending.ok).toBe(false);
		expect(pending.retryable).toBe(true);
		expect(["RUNNING", "RUNNER_QUEUED"]).toContain(pending.ciClassification);
	});

	test("merge safety requires fresh terminal-green CI, current head, and MERGEABLE", () => {
		expect(assessMergeSafety(snapshot(), "abc123")).toMatchObject({
			ok: true,
			retryable: false,
			ciClassification: "TERMINAL_SUCCESS",
		});
		const noCi = assessMergeSafety(snapshot({
			checkRuns: [],
			ciEvidence: {
				requiredContexts: [],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 600,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		}), "abc123");
		expect(noCi.ok).toBe(false);
		expect(noCi.retryable).toBe(false);
		expect(noCi.ciClassification).toBe("NO_REQUIRED_CHECKS");
		const failed = assessMergeSafety(snapshot({
			checkRuns: [{
				name: "ci",
				status: "completed",
				conclusion: "failure",
				headSha: "abc123",
			}],
		}), "abc123");
		expect(failed).toMatchObject({
			ok: false,
			retryable: false,
			ciClassification: "TERMINAL_FAILURE",
		});
		expect(assessMergeSafety(snapshot(), "different-head").ok).toBe(false);
		expect(assessMergeSafety(snapshot({ mergeable: "UNKNOWN" }), "abc123")).toMatchObject({
			ok: false,
			retryable: true,
			ciClassification: "MERGEABILITY_STALE",
		});
		expect(assessMergeSafety(snapshot({ mergeable: "CONFLICTING" }), "abc123").ok).toBe(false);
	});
	test("UNKNOWN GitHub mergeability is stale metadata, not a rebase trigger", () => {
		const verdict = evaluateWatchExit(snapshot({
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			behindBy: 0,
		}), { selfLogins: ["twaldin"] });
		expect(verdict.rebaseRequired).toBe(false);
		expect(verdict.triggers).toHaveLength(0);
		expect(verdict.ciClassification).toBe("MERGEABILITY_STALE");
	});

	test("conflicting and dirty states require rebase regardless of behind distance", () => {
		for (const state of [
			snapshot({ mergeable: "CONFLICTING", behindBy: 2 }),
			snapshot({ mergeStateStatus: "DIRTY", behindBy: 2 }),
		]) {
			const verdict = evaluateWatchExit(state, { selfLogins: ["twaldin"] });
			expect(verdict.actionable).toBe(true);
			expect(verdict.disposition).toBe("fix");
		}
	});

	test("unanswered comment newer than our last activity blocks exit", () => {
		const verdict = evaluateWatchExit(
			snapshot({
				comments: [{ author: "reviewer", isBot: false, createdAt: "2026-07-27T11:00:00Z" }],
			}),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(false);
		expect(verdict.unansweredComments).toBe(1);
	});

	test("comment we answered afterwards does not block", () => {
		const verdict = evaluateWatchExit(
			snapshot({
				comments: [
					{ author: "reviewer", isBot: false, createdAt: "2026-07-27T11:00:00Z" },
					{ author: "twaldin", isBot: false, createdAt: "2026-07-27T11:05:00Z" },
				],
			}),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(true);
	});

	test("reviewer active before last push and not re-requested blocks exit (silent no-op catch)", () => {
		const verdict = evaluateWatchExit(
			snapshot({
				reviewers: [
					{ login: "rev", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "CHANGES_REQUESTED" },
				],
				requestedReviewers: [],
			}),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(false);
		expect(verdict.reviewersNeedingReRequest).toEqual(["rev"]);
	});

	test("stale CHANGES_REQUESTED enters the response loop even when re-requested", () => {
		const verdict = evaluateWatchExit(snapshot({
			reviewers: [{ login: "rev", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "CHANGES_REQUESTED" }],
			requestedReviewers: ["rev"],
		}), { selfLogins: ["twaldin"] });
		expect(verdict.reviewersNeedingReRequest).toEqual(["rev"]);
		expect(verdict.exitOk).toBe(false);
		expect(verdict.disposition).toBe("wait");
	});

	test("current-head CHANGES_REQUESTED wakes a review-routing seat even without a body", () => {
		const verdict = evaluateWatchExit(snapshot({
			comments: [],
			reviewers: [{
				login: "reviewer",
				isBot: false,
				lastActivityAt: "2026-07-27T11:00:00Z",
				lastReviewState: "CHANGES_REQUESTED",
				headSha: "abc123",
			}],
		}), { selfLogins: ["twaldin"] });
		expect(verdict.disposition).toBe("fix");
		expect(verdict.triggers).toEqual([
			expect.objectContaining({
				kind: "human_comment",
				headSha: "abc123",
				payload: expect.objectContaining({
					author: "reviewer",
					source: "review_state",
					reviewState: "CHANGES_REQUESTED",
				}),
			}),
		]);
	});

	test("a re-requested reviewer still needs every profile-resolved approval", () => {
		const verdict = evaluateWatchExit(
			snapshot({
				reviewers: [
					{ login: "rev", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
				],
				requestedReviewers: ["rev"],
			}),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(false);
		expect(verdict.disposition).toBe("wait");
	});

	test("hard red CI starts a bounded fix; pending CI stays with Smithers", () => {
		const red = evaluateWatchExit(
			snapshot({ checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }] }),
			{ selfLogins: ["twaldin"] },
		);
		expect(red.exitOk).toBe(false);
		expect(red.disposition).toBe("fix");
		expect(red.actionable).toBe(true);
		const pending = evaluateWatchExit(
			snapshot({ checkRuns: [{ name: "ci", status: "in_progress", conclusion: null }] }),
			{ selfLogins: ["twaldin"] },
		);
		expect(pending.exitOk).toBe(true);
		expect(pending.ci).toBe("will-be-green");
		expect(pending.disposition).toBe("complete");
		expect(pending.actionable).toBe(false);
	});

	test("aggregate CHANGES_REQUESTED blocks completion even when historical rows look approved", () => {
		const verdict = evaluateWatchExit(snapshot({
			reviewDecision: "CHANGES_REQUESTED",
			reviewers: [{
				login: "reviewer",
				isBot: false,
				lastActivityAt: "2026-07-27T11:00:00Z",
				lastReviewState: "APPROVED",
				headSha: "abc123",
			}],
		}), { selfLogins: ["twaldin"] });
		expect(verdict.humanApprovedBy).toBe("reviewer");
		expect(verdict.exitOk).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("aggregate review decision is CHANGES_REQUESTED");
		expect(verdict.disposition).toBe("fix");
		expect(verdict.triggers).toEqual([
			expect.objectContaining({
				kind: "human_comment",
				payload: expect.objectContaining({
					source: "aggregate_review_decision",
					reviewState: "CHANGES_REQUESTED",
				}),
			}),
		]);
	});

	test("wake kinds are generic while configured bot identity is profile-resolved", () => {
		const claudePolicy = {
			requireHuman: true,
			requiredBots: [{ login: "claude[bot]" }],
		};
		const codeRabbitPolicy = {
			requireHuman: false,
			requiredBots: [{ login: "coderabbitai[bot]" }],
		};
		const conflict = evaluateWatchExit(snapshot({ mergeable: "CONFLICTING" }), {
			selfLogins: ["twaldin"],
			reviewPolicy: claudePolicy,
		});
		const red = evaluateWatchExit(
			snapshot({ checkRuns: [{ id: 7, name: "ci", status: "completed", conclusion: "failure" }] }),
			{ selfLogins: ["twaldin"], reviewPolicy: claudePolicy },
		);
		const human = evaluateWatchExit(snapshot({
			comments: [{ id: "human-1", author: "reviewer", isBot: false, createdAt: "2026-07-27T12:00:00Z", body: "Please change this." }],
		}), { selfLogins: ["twaldin"], reviewPolicy: claudePolicy });
		const claude = evaluateWatchExit(snapshot({
			comments: [{ id: "claude-1", author: "claude[bot]", isBot: true, createdAt: "2026-07-27T12:00:00Z", body: "Please change this." }],
		}), { selfLogins: ["twaldin"], reviewPolicy: claudePolicy });
		const codeRabbit = evaluateWatchExit(snapshot({
			comments: [{ id: "rabbit-1", author: "coderabbitai[bot]", isBot: true, createdAt: "2026-07-27T12:00:00Z", body: "Please change this." }],
		}), { selfLogins: ["twaldin"], reviewPolicy: codeRabbitPolicy });
		expect([conflict, red, human, claude].map((value) => value.triggers[0]?.kind))
			.toEqual(["merge_conflict", "failed_ci", "human_comment", "bot_comment"]);
		expect(codeRabbit.triggers[0]?.kind).toBe("bot_comment");
		for (const automation of ["dependabot[bot]", "github-actions[bot]", "twaldin"]) {
			const verdict = evaluateWatchExit(snapshot({
				comments: [{ id: automation, author: automation, isBot: true, createdAt: "2026-07-27T12:00:00Z", body: "noise" }],
			}), { selfLogins: ["twaldin"], reviewPolicy: claudePolicy });
			expect(verdict.triggers).toHaveLength(0);
		}
	});

	test("CodeRabbit COMMENTED plus its profile-declared current-head check satisfies the bot gate", () => {
		const reviewPolicy = {
			requireHuman: false,
			requiredBots: [{ login: "coderabbitai[bot]", approvalCheckPattern: "^CodeRabbit(?:$| /)" }],
		};
		const value = snapshot({
			reviewers: [{
				login: "coderabbitai[bot]",
				isBot: true,
				lastActivityAt: "2026-07-27T11:00:00Z",
				lastReviewState: "COMMENTED",
				headSha: "abc123",
			}],
			checkRuns: [{
				name: "CodeRabbit",
				status: "completed",
				conclusion: "success",
				headSha: "abc123",
			}],
		});
		const current = evaluateWatchExit(value, { selfLogins: ["twaldin"], reviewPolicy });
		expect(current.botApprovedBy).toEqual(["coderabbitai[bot]"]);
		expect(current.exitOk).toBe(true);
		const stale = evaluateWatchExit({
			...value,
			checkRuns: [{ ...value.checkRuns[0]!, headSha: "obsolete" }],
		}, { selfLogins: ["twaldin"], reviewPolicy });
		expect(stale.botApprovedBy).toEqual([]);
		expect(stale.exitOk).toBe(false);
	});

	test("handled DECISION review item does not wake repeatedly or block other work", () => {
		const value = snapshot({
			comments: [{
				id: "human-decision",
				source: "review_comment",
				threadId: "thread-1",
				author: "reviewer",
				isBot: false,
				createdAt: "2026-07-27T12:00:00Z",
				body: "Which product behavior should win?",
			}],
		});
		const first = evaluateWatchExit(value, { selfLogins: ["twaldin"] });
		expect(first.triggers[0]?.kind).toBe("human_comment");
		const afterRouting = evaluateWatchExit(value, {
			selfLogins: ["twaldin"],
			handledTriggerIds: [first.triggers[0]!.id],
		});
		expect(afterRouting.actionable).toBe(false);
		expect(afterRouting.exitOk).toBe(true);
	});

	test("a configured bot's approval marker is evidence but its comment is classified first", () => {
		const reviewPolicy = {
			requireHuman: true,
			requiredBots: [{
				login: "claude[bot]",
				approvalCommentPattern: "^\\*\\*Claude finished .+ task in .+\\*\\*",
			}],
		};
		const value = snapshot({
			reviewers: [
				{ login: "human-reviewer", isBot: false, lastActivityAt: "2026-07-27T11:00:00Z", lastReviewState: "APPROVED" },
			],
			comments: [{
				id: "claude-finished",
				source: "issue_comment",
				author: "claude[bot]",
				isBot: true,
				createdAt: "2026-07-27T12:00:00Z",
				body: "**Claude finished review task in 2m**",
			}],
		});
		const first = evaluateWatchExit(value, { selfLogins: ["twaldin"], reviewPolicy });
		expect(first.botApprovedBy).toEqual(["claude[bot]"]);
		expect(first.exitOk).toBe(false);
		const handled = evaluateWatchExit(value, {
			selfLogins: ["twaldin"],
			reviewPolicy,
			handledTriggerIds: [first.triggers[0]!.id],
		});
		expect(handled.exitOk).toBe(true);
	});

	test("the latest configured-bot comment controls marker approval, so a later error revokes it", () => {
		const value = snapshot({
			reviewers: [{
				login: "human-reviewer",
				isBot: false,
				lastActivityAt: "2026-07-27T10:30:00Z",
				lastReviewState: "APPROVED",
			}],
			comments: [
				{

					id: "claude-finished",
					author: "claude[bot]",
					isBot: true,
					createdAt: "2026-07-27T11:00:00Z",
					body: "**Claude finished review task in 1m**",
				},
				{
					id: "claude-error",
					author: "claude[bot]",
					isBot: true,
					createdAt: "2026-07-27T12:00:00Z",
					body: "Claude encountered an error",
				},
			],
		});
		const verdict = evaluateWatchExit(value, {
			selfLogins: ["twaldin"],
			reviewPolicy: {
				requireHuman: true,
				requiredBots: [{
					login: "claude[bot]",
					approvalCommentPattern: "^\\*\\*Claude finished .+ task in .+\\*\\*",
				}],
			},
		});
		expect(verdict.botApprovedBy).toEqual([]);
	});

	test("CI grace starts when this durable watcher first observes a head, not at commit author time", () => {
		const first = observeHeadAge("head-a", undefined, "2026-08-06T16:00:00Z");
		expect(first).toEqual({
			headObservedAt: "2026-08-06T16:00:00Z",
			ageSeconds: 0,
		});
		expect(observeHeadAge("head-a", {
			headSha: "head-a",
			headObservedAt: first.headObservedAt,
		}, "2026-08-06T16:02:31Z").ageSeconds).toBe(151);
		expect(observeHeadAge("head-b", {
			headSha: "head-a",
			headObservedAt: first.headObservedAt,
		}, "2026-08-06T17:00:00Z")).toEqual({
			headObservedAt: "2026-08-06T17:00:00Z",
			ageSeconds: 0,
		});
	});
	test("zero checks with no required contexts terminates as no CI configured, never success", () => {
		const verdict = evaluateWatchExit(snapshot({
			checkRuns: [],
			ciEvidence: {
				requiredContexts: [],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 600,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		}), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.ci).toBe("not-configured");
		expect(verdict.ciClassification).toBe("NO_REQUIRED_CHECKS");
		expect(verdict.reasons.join(" ")).toContain("not as terminal success");
	});

	test("zero checks with required CI inside grace waits for reporting", () => {
		const verdict = evaluateWatchExit(snapshot({
			checkRuns: [],
			ciEvidence: {
				requiredContexts: [{ context: "required / ci", integrationId: 1 }],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 30,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		}), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.ciClassification).toBe("STARTING");
		expect(verdict.ci).toBe("will-be-green");
	});

	test("zero checks with overdue required CI terminates into an explicit escalation", () => {
		const verdict = evaluateWatchExit(snapshot({
			checkRuns: [],
			ciEvidence: {
				requiredContexts: [{ context: "required / ci", integrationId: 1 }],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 600,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		}), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(false);
		expect(verdict.ciClassification).toBe("NOT_TRIGGERED");
		expect(verdict.disposition).toBe("escalate");
		expect(verdict.terminalEscalation).toBe(true);
		expect(verdict.actionable).toBe(false);
	});
	test("required success must match exact current suite and App integration", () => {
		const currentRun = {
			id: 11,
			checkSuiteId: 22,
			headSha: "abc123",
			status: "completed",
			conclusion: "success",
			createdAt: "2026-07-27T10:00:00Z",
			updatedAt: "2026-07-27T10:05:00Z",
			startedAt: "2026-07-27T10:01:00Z",
			url: "https://example.invalid/run/11",
			jobs: [],
		};
		const exact = snapshot({
			checkRuns: [{
				id: 33,
				name: "required / ci",
				status: "completed",
				conclusion: "success",
				completedAt: "2026-07-27T10:05:00Z",
				checkSuiteId: 22,
				appId: 44,
			}],
			ciEvidence: {
				requiredContexts: [{ context: "required / ci", integrationId: 44 }],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 600,
				currentRuns: [currentRun],
				staleActiveRuns: [],
				statuses: [],
			},
		});
		expect(classifyCiEvidence(exact).classification).toBe("TERMINAL_SUCCESS");
		expect(classifyCiEvidence({
			...exact,
			checkRuns: [{
				...exact.checkRuns[0]!,
				id: 32,
				conclusion: "cancelled",
				completedAt: "2026-07-27T10:00:00Z",
			}, ...exact.checkRuns],
		}).classification).toBe("TERMINAL_SUCCESS");
		expect(classifyCiEvidence({
			...exact,
			checkRuns: [
				...exact.checkRuns,
				{
					id: 34,
					name: "optional obsolete check",
					status: "completed",
					conclusion: "failure",
					checkSuiteId: 999,
					appId: 44,
				},
			],
		}).classification).toBe("TERMINAL_SUCCESS");
		expect(classifyCiEvidence({
			...exact,
			ciEvidence: {
				...exact.ciEvidence!,
				requiredContexts: [{ context: "required / ci", integrationId: 99 }],
			},
		}).classification).toBe("WORKFLOW_BROKEN");
		expect(classifyCiEvidence({
			...exact,
			checkRuns: [{ ...exact.checkRuns[0]!, checkSuiteId: 999 }],
		}).classification).toBe("WORKFLOW_BROKEN");
	});
	test("setup provider outage retries with backoff while executed test failure wakes a fix seat", () => {
		const ciSnapshot = (fixture: typeof ciFailureFixtures.infra): WatchSnapshot => snapshot({
			checkRuns: [{
				id: 91,
				name: "test",
				status: "completed",
				conclusion: "failure",
				checkSuiteId: 22,
				appId: 44,
			}],
			ciEvidence: {
				requiredContexts: [{ context: "test", integrationId: 44 }],
				rulesBranch: "main",
				graceSeconds: 150,
				currentHeadAgeSeconds: 600,
				currentRuns: [{
					id: 11,
					checkSuiteId: 22,
					headSha: "abc123",
					status: "completed",
					conclusion: "failure",
					createdAt: "2026-07-27T10:00:00Z",
					updatedAt: "2026-07-27T10:05:00Z",
					startedAt: "2026-07-27T10:01:00Z",
					url: "https://example.invalid/run/11",
					jobs: [{
						id: 12,
						name: fixture.jobName,
						status: "completed",
						conclusion: "failure",
						startedAt: "2026-07-27T10:01:00Z",
						completedAt: "2026-07-27T10:02:00Z",
						url: "https://example.invalid/job/12",
						steps: fixture.steps,
						logExcerpt: fixture.log,
					}],
				}],
				staleActiveRuns: [],
				statuses: [],
			},
		});
		const infra = evaluateWatchExit(ciSnapshot(ciFailureFixtures.infra), { selfLogins: ["twaldin"] });
		expect(infra.ciClassification).toBe("INFRA_RETRY");
		expect(infra.disposition).toBe("wait");
		expect(infra.actionable).toBe(false);
		expect(infra.triggers).toHaveLength(0);
		expect(infra.infraRetryJobs).toEqual([{ runId: 11, jobId: 12, reason: "setup/provider failure: Failed to resolve action download info" }]);
		expect(infra.reasons.join(" ")).toContain("Infrastructure retry 1/3");

		const exhausted = evaluateWatchExit(ciSnapshot(ciFailureFixtures.infra), {
			selfLogins: ["twaldin"],
			infraRetryAttempts: { "11": 3 },
		});
		expect(exhausted.disposition).toBe("escalate");
		expect(exhausted.terminalEscalation).toBe(true);
		expect(exhausted.infraRetryJobs).toHaveLength(0);

		const code = evaluateWatchExit(ciSnapshot(ciFailureFixtures.code), { selfLogins: ["twaldin"] });
		expect(code.ciClassification).toBe("TERMINAL_FAILURE");
		expect(code.triggers[0]?.kind).toBe("failed_ci");
		expect(code.disposition).toBe("fix");
	});

	test("real queued jobs and obsolete-SHA blockage are distinguished", () => {
		const activeRun = {
			id: 11,
			checkSuiteId: 22,
			headSha: "abc123",
			status: "in_progress",
			conclusion: null,
			createdAt: "2026-07-27T10:00:00Z",
			updatedAt: "2026-07-27T10:05:00Z",
			startedAt: "2026-07-27T10:01:00Z",
			url: "https://example.invalid/run/11",
			jobs: [{
				id: 1,
				name: "test",
				status: "queued",
				conclusion: null,
				startedAt: null,
				completedAt: null,
				url: "https://example.invalid/job/1",
			}],
		};
		const baseEvidence = {
			requiredContexts: [{ context: "required / ci", integrationId: 44 }],
			rulesBranch: "main",
			graceSeconds: 150,
			currentHeadAgeSeconds: 600,
			currentRuns: [activeRun],
			staleActiveRuns: [],
			statuses: [],
		};
		expect(classifyCiEvidence(snapshot({ checkRuns: [], ciEvidence: baseEvidence })).classification)
			.toBe("RUNNER_QUEUED");
		expect(classifyCiEvidence(snapshot({
			checkRuns: [{
				id: 77,
				name: "required / ci",
				status: "requested",
				conclusion: null,
				headSha: "abc123",
				appId: 44,
				checkSuiteId: 22,
			}],
			ciEvidence: baseEvidence,
		})).classification).toBe("RUNNER_QUEUED");
		expect(classifyCiEvidence(snapshot({
			checkRuns: [],
			ciEvidence: {
				...baseEvidence,
				currentRuns: [{ ...activeRun, jobs: [] }],
				staleActiveRuns: [{ ...activeRun, id: 10, headSha: "obsolete", jobs: [] }],
			},
		})).classification).toBe("STALE_RUN_BLOCKED");
		expect(classifyCiEvidence(snapshot({
			checkRuns: [],
			ciEvidence: {
				...baseEvidence,
				currentRuns: [{
					...activeRun,
					jobs: [{
						...activeRun.jobs[0]!,
						status: "in_progress",
						startedAt: "2026-07-27T10:01:00Z",
					}],
				}],
			},
		})).classification).toBe("RUNNING");
		expect(classifyCiEvidence(snapshot({
			checkRuns: [
				{
					id: 77,
					name: "required / ci",
					workflowName: "CI",
					status: "completed",
					conclusion: "cancelled",
					completedAt: "2026-07-27T10:03:00Z",
					headSha: "abc123",
					appId: 44,
					checkSuiteId: 22,
				},
				{
					id: 78,
					name: "optional",
					workflowName: "CI",
					status: "completed",
					conclusion: "success",
					completedAt: "2026-07-27T10:04:00Z",
					headSha: "abc123",
					appId: 55,
					checkSuiteId: 99,
				},
			],
			ciEvidence: baseEvidence,
		})).classification).toBe("TERMINAL_FAILURE");
	});
});

describe("watch helpers", () => {
	test("assessCi maps conclusions", () => {
		expect(assessCi([])).toBe("none");
		expect(assessCi([{ name: "a", status: "completed", conclusion: "success" }])).toBe("green");
		expect(assessCi([{ name: "a", status: "queued", conclusion: null }])).toBe("will-be-green");
		expect(assessCi([{ name: "a", status: "completed", conclusion: "timed_out" }])).toBe("red");
		expect(
			assessCi([
				{ name: "claude", workflowName: "Claude Code", status: "completed", conclusion: "skipped", completedAt: "2026-07-30T10:00:00Z" },
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "cancelled", completedAt: "2026-07-30T11:00:00Z" },
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "success", completedAt: "2026-07-30T12:00:00Z" },
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "cancelled", completedAt: "2026-07-30T11:00:00Z" },
			]),
		).toBe("green");
		expect(
			assessCi([
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "cancelled", completedAt: "2026-07-30T11:00:00Z" },
				{ name: "ci", workflowName: "CI", status: "in_progress", conclusion: null },
			]),
		).toBe("will-be-green");
		expect(
			assessCi([
				{
					name: "lint",
					workflowName: "CI",
					status: "completed",
					conclusion: "cancelled",
					completedAt: "2026-07-30T11:00:00Z",
					appId: 1,
					headSha: "abc123",
				},
				{
					name: "test",
					workflowName: "CI",
					status: "completed",
					conclusion: "success",
					completedAt: "2026-07-30T12:00:00Z",
					appId: 1,
					headSha: "abc123",
				},
			]),
		).toBe("red");
		expect(
			assessCi([
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "cancelled", completedAt: "2026-07-30T11:00:00Z" },
				{ name: "ci", workflowName: "CI", status: "completed", conclusion: "failure", completedAt: "2026-07-30T12:00:00Z" },
			]),
		).toBe("red");
		expect(
			assessCi([
				{ name: "a", status: "completed", conclusion: "success" },
				{ name: "b", status: "completed", conclusion: "failure" },
			]),
		).toBe("red");
	});

	test("reviewersNeedingReRequest skips bots, self, active-after-push, and already-requested", () => {
		const lastPush = "2026-07-27T10:00:00Z";
		const reviewers = [
			{ login: "stale", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: null },
			{ login: "fresh", isBot: false, lastActivityAt: "2026-07-27T11:00:00Z", lastReviewState: "APPROVED" },
			{ login: "bot[bot]", isBot: true, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "requested", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "me", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: null },
		];
		expect(reviewersNeedingReRequest(reviewers, ["requested"], lastPush, ["me"])).toEqual(["stale"]);
	});

	test("never re-requests reviewers with an existing decision", () => {
		const lastPush = "2026-07-27T10:00:00Z";
		const reviewers = [
			{ login: "approved", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "APPROVED" },
			{ login: "commented", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "changes", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "CHANGES_REQUESTED" },
			{ login: "silent", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: null },
		];
		expect(reviewersNeedingReRequest(reviewers, [], lastPush)).toEqual(["changes", "silent"]);
	});

	test("unansweredComments counts only others' comments newer than our latest activity", () => {
		const comments = [
			{ author: "rev", isBot: false, createdAt: "2026-07-27T11:00:00Z" },
			{ author: "rev", isBot: false, createdAt: "2026-07-27T12:00:00Z" },
		];
		expect(unansweredComments(comments, ["twaldin"], "2026-07-27T10:00:00Z")).toBe(2);
		expect(
			unansweredComments(
				[...comments, { author: "twaldin", isBot: false, createdAt: "2026-07-27T12:30:00Z" }],
				["twaldin"],
				"2026-07-27T10:00:00Z",
			),
		).toBe(0);
	});
});

describe("watch fix worker boundary", () => {
	test("a fix worker commits locally while the deterministic publisher owns push and wait", () => {
		const prompt = watchFixPrompt({
			worktree: "/tmp/wt",
			branch: "fix/ci",
			repo: "owner/repo",
			prNumber: 42,
			gh: "gh",
			baseBranch: "main",
			pollJson: "{}",
			briefJson: JSON.stringify(validBrief),
			triggerJson: JSON.stringify([{ id: "comment:1", kind: "human_comment" }]),
			round: 0,
			afterPoll: 1,
		});
		expect(prompt).toContain("Return pushed=false and reRequested=[]");
		expect(prompt).toContain("deterministic publisher owns rebase, tests, force-with-lease push");
		expect(prompt).toContain("Never rebase, push, approve, stamp, merge");
		expect(prompt).toContain("Never sleep-poll CI or reviews");
		expect(prompt).toContain("FIX_NOW");
		expect(prompt).toContain("NOT_VALID");
		expect(prompt).toContain("DECISION");
		expect(prompt).toContain("comment:1");
		expect(prompt).toContain(validBrief.summary);
	});

	test("review routes return reply text instead of giving the seat GitHub authority", () => {
		const prompt = watchFixPrompt({
			worktree: "/tmp/wt", branch: "fix/ci", repo: "owner/repo", prNumber: 42,
			project: "lindy-ai/lindy", gh: "gh", baseBranch: "main", pollJson: "{}", round: 0, afterPoll: 1,
		});
		expect(prompt).toContain("Never post a raw GitHub comment");
		expect(prompt).toContain("Return replyBody");
		expect(prompt).toContain("publisher signs and posts");
		expect(prompt).toContain("This route does not block unrelated work");
		expect(prompt).toContain('"FIX_NOW"|"NOT_VALID"|"DECISION"');
	});
});

// ---------------------------------------------------------------------------
// Migration gate
// ---------------------------------------------------------------------------

describe("detectMigrations", () => {
	test("detects top-level migrations/ and packages/database-migrations/", () => {
		expect(
			detectMigrations([
				"src/app.ts",
				"migrations/0001_init.sql",
				"packages/database-migrations/0042_add_flag.sql",
			]),
		).toEqual(["migrations/0001_init.sql", "packages/database-migrations/0042_add_flag.sql"]);
	});

	test("detects nested migration dirs via /pattern match", () => {
		expect(detectMigrations(["services/api/migrations/0002.sql"])).toEqual([
			"services/api/migrations/0002.sql",
		]);
	});

	test("no migrations -> empty", () => {
		expect(detectMigrations(["src/a.ts", "README.md"])).toEqual([]);
	});

	test("does not match files merely containing the word", () => {
		expect(detectMigrations(["docs/migrations-guide.md"])).toEqual([]);
	});
});

describe("migration evidence", () => {
	const entry = (stage: MigrationEvidenceEntry["stage"], ok = true): MigrationEvidenceEntry => ({
		stage,
		ok,
		detail: "",
		at: "2026-07-27T10:00:00Z",
	});

	test("complete requires all four stages ok", () => {
		expect(
			migrationEvidenceComplete([
				entry("stg-run"),
				entry("stg-verify"),
				entry("prod-run"),
				entry("prod-verify"),
			]),
		).toBe(true);
		expect(migrationEvidenceComplete([entry("stg-run"), entry("stg-verify")])).toBe(false);
		expect(
			migrationEvidenceComplete([
				entry("stg-run"),
				entry("stg-verify"),
				entry("prod-run"),
				entry("prod-verify", false),
			]),
		).toBe(false);
	});

	test("missing stages listed in order", () => {
		expect(missingMigrationStages([entry("stg-run")])).toEqual(["stg-verify", "prod-run", "prod-verify"]);
	});
});

// ---------------------------------------------------------------------------
// Ready-for-stamp
// ---------------------------------------------------------------------------

describe("evaluateReadyForStamp", () => {
	const options = { author: "twaldin", excludedApprovers: ["ali"] };
	const approval = (login: string, state = "APPROVED", isBot = false, submittedAt = "2026-07-27T10:00:00Z") => ({
		login,
		isBot,
		state,
		submittedAt,
	});

	test("human approval + green CI is ready", () => {
		const verdict = evaluateReadyForStamp([approval("rev")], "green", options);
		expect(verdict.ready).toBe(true);
		expect(verdict.approvedBy).toBe("rev");
	});

	test("will-be-green CI is READY (captain ruling: never gate the stamp on CI green)", () => {
		expect(evaluateReadyForStamp([approval("rev")], "will-be-green", options).ready).toBe(true);
	});

	test("hard red CI is surfaced but does not hide the captain's stamp", () => {
		const verdict = evaluateReadyForStamp([approval("rev")], "red", options);
		expect(verdict.ready).toBe(true);
		expect(verdict.reasons.join(" ")).toContain("live step-5 watch");
	});

	test("bot approval never counts", () => {
		expect(evaluateReadyForStamp([approval("claude[bot]", "APPROVED", true)], "green", options).ready).toBe(false);
	});

	test("excluded approver (ali) never counts", () => {
		expect(evaluateReadyForStamp([approval("Ali")], "green", options).ready).toBe(false);
	});

	test("author self-approval never counts", () => {
		expect(evaluateReadyForStamp([approval("twaldin")], "green", options).ready).toBe(false);
	});

	test("later CHANGES_REQUESTED overrides an earlier approval from the same login", () => {
		const verdict = evaluateReadyForStamp(
			[
				approval("rev", "APPROVED", false, "2026-07-27T10:00:00Z"),
				approval("rev", "CHANGES_REQUESTED", false, "2026-07-27T11:00:00Z"),
			],
			"green",
			options,
		);
		expect(verdict.ready).toBe(false);
	});

	test("findHumanApproval picks the latest state per login", () => {
		expect(
			findHumanApproval(
				[
					approval("rev", "CHANGES_REQUESTED", false, "2026-07-27T10:00:00Z"),
					approval("rev", "APPROVED", false, "2026-07-27T11:00:00Z"),
				],
				options,
			),
		).toBe("rev");
	});

	// yolo profile (e.g. deck): green merges without a human approval; a
	// still-running CI is NOT green enough (yolo fires on green, not on hope).
	describe("yolo", () => {
		const yoloOptions = { ...options, yolo: true };

		test("green CI with NO approval is ready", () => {
			const verdict = evaluateReadyForStamp([], "green", yoloOptions);
			expect(verdict.ready).toBe(true);
			expect(verdict.approvedBy).toBeNull();
		});

		test("no checks configured is ready", () => {
			expect(evaluateReadyForStamp([], "none", yoloOptions).ready).toBe(true);
		});

		test("REGRESSION: will-be-green is NOT ready under yolo (stamp ruling does not carry over)", () => {
			// Under stamp, will-be-green passes (a human decided). Under yolo
			// nobody decides, so the loop must wait for checks to finish.
			const verdict = evaluateReadyForStamp([], "will-be-green", yoloOptions);
			expect(verdict.ready).toBe(false);
			expect(verdict.reasons[0]).toContain("yolo merge fires on green");
		});

		test("red is not ready", () => {
			expect(evaluateReadyForStamp([], "red", yoloOptions).ready).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// Landing verification (never the merged flag)
// ---------------------------------------------------------------------------

describe("findLandingCommit", () => {
	const commits = [
		{ sha: "aaa", subject: "feat: something else (#1234)" },
		{ sha: "bbb", subject: "LIN-123: add rate limiting (#123)" },
	];

	test("finds the squash commit by (#N)", () => {
		expect(findLandingCommit(commits, 123)?.sha).toBe("bbb");
	});

	test("(#123) does not match a search for (#12) [boundary safety]", () => {
		expect(findLandingCommit(commits, 12)).toBeNull();
	});

	test("missing -> null (merged flag is NEVER consulted)", () => {
		expect(findLandingCommit(commits, 999)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Evidence-gated done
// ---------------------------------------------------------------------------

describe("evaluateDone", () => {
	const fullEvidence = {
		landedSha: "abc",
		deployEvidence: "deployed v1.2.3",
		falloutVerdict: "clean" as const,
		migrationRequired: false,
		migrationEvidence: [],
	};

	test("all evidence present -> done", () => {
		expect(evaluateDone(fullEvidence)).toEqual({ done: true });
	});

	test("merged != done: missing deploy evidence blocks", () => {
		const verdict = evaluateDone({ ...fullEvidence, deployEvidence: null });
		expect(verdict.done).toBe(false);
		if (!verdict.done) expect(verdict.missing.some((m) => m.includes("deploy evidence"))).toBe(true);
	});

	test("missing fallout verdict blocks", () => {
		expect(evaluateDone({ ...fullEvidence, falloutVerdict: null }).done).toBe(false);
	});

	test("missing landing blocks", () => {
		expect(evaluateDone({ ...fullEvidence, landedSha: null }).done).toBe(false);
	});

	test("migration required but evidence incomplete blocks", () => {
		const verdict = evaluateDone({
			...fullEvidence,
			migrationRequired: true,
			migrationEvidence: [{ stage: "stg-run", ok: true, detail: "", at: "" }],
		});
		expect(verdict.done).toBe(false);
		if (!verdict.done) expect(verdict.missing.some((m) => m.includes("migration"))).toBe(true);
	});

	test("regression verdict still records as done-eligible (escalation gate handles it upstream)", () => {
		expect(evaluateDone({ ...fullEvidence, falloutVerdict: "regression" }).done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// GH payload parsers
// ---------------------------------------------------------------------------

describe("gh parsers", () => {
	test("parseReviewThreads", () => {
		const threads = parseReviewThreads([
			{
				id: "T1",
				isResolved: false,
				comments: { nodes: [{ author: { login: "rev", __typename: "User" } }] },
			},
			{ id: "T2", isResolved: true, comments: { nodes: [] } },
		]);
		expect(threads).toEqual([
			{ id: "T1", isResolved: false, lastCommenter: "rev" },
			{ id: "T2", isResolved: true, lastCommenter: null },
		]);
	});

	test("parseCheckRuns", () => {
		expect(
			parseCheckRuns({
				check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
			}),
		).toEqual([{ name: "ci", status: "completed", conclusion: "success" }]);
		expect(parseCheckRuns({})).toEqual([]);
	});

	test("fetchBranchCheckRuns follows a full 100-result page instead of truncating CI truth", async () => {
		let calls = 0;
		const result = await fetchBranchCheckRuns({
			gh: "gh",
			repo: "owner/repo",
			exec: async (args) => {
				calls += 1;
				const count = calls === 1 ? 100 : 1;
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						check_runs: Array.from({ length: count }, (_, index) => ({
							id: (calls - 1) * 100 + index + 1,
							name: `ci-${(calls - 1) * 100 + index + 1}`,
							status: "completed",
							conclusion: "success",
						})),
					}),
				};
			},
		}, "abc123");
		expect(result).toHaveLength(101);
		expect(calls).toBe(2);
	});

	test("parseReviews flags bots via __typename and [bot] suffix", () => {
		const reviews = parseReviews([
			{ author: { login: "human", __typename: "User" }, state: "APPROVED", submittedAt: "t1" },
			{ author: { login: "claude[bot]", __typename: "User" }, state: "APPROVED", submittedAt: "t2" },
			{ author: { login: "botuser", __typename: "Bot" }, state: "APPROVED", submittedAt: "t3" },
		]);
		expect(reviews.map((r) => r.isBot)).toEqual([false, true, true]);
	});

	test("parseRequestedReviewers", () => {
		expect(parseRequestedReviewers({ users: [{ login: "a" }, { login: "b" }] })).toEqual(["a", "b"]);
		expect(parseRequestedReviewers({})).toEqual([]);
	});
});
