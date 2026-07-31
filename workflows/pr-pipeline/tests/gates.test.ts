/**
 * Unit tests for the pure gate logic: preflight brief validation, watch-exit
 * machine check, migration detection, ready-for-stamp, landing verification,
 * evidence-gated done, and model family opposition.
 */

import { describe, expect, test } from "bun:test";

import { validateBrief } from "../lib/brief.ts";
import { evaluateDone } from "../lib/done.ts";
import { parseActivity, parseCheckRuns, parseRequestedReviewers, parseReviews, parseReviewThreads } from "../lib/gh.ts";
import { findLandingCommit } from "../lib/landing.ts";
import { detectMigrations, migrationEvidenceComplete, missingMigrationStages } from "../lib/migrations.ts";
import {
	DECK_AGENT_CATALOG,
	defaultModelPolicy,
	modelFamily,
	parseModelRef,
	resolveAdversary,
	validateModelPolicy,
} from "../lib/models.ts";
import { watchFixPrompt } from "../lib/prompts.ts";
import { evaluateReadyForStamp, findHumanApproval } from "../lib/ready.ts";
import {
	assessCi,
	evaluateWatchExit,
	reviewersNeedingReRequest,
	unansweredComments,
} from "../lib/watch.ts";
import type { MigrationEvidenceEntry, WatchSnapshot } from "../lib/types.ts";

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
		lastPushAt: "2026-07-27T10:00:00Z",
		threads: [],
		comments: [],
		reviewers: [],
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

	test("BEHIND alone waits for the merge boundary", () => {
		const verdict = evaluateWatchExit(snapshot({ mergeStateStatus: "BEHIND" }), { selfLogins: ["twaldin"] });
		expect(verdict.exitOk).toBe(true);
		expect(verdict.disposition).toBe("complete");
	});

	test("unresolved thread blocks exit", () => {
		const verdict = evaluateWatchExit(
			snapshot({ threads: [{ id: "t1", isResolved: false, lastCommenter: "rev" }] }),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(false);
		expect(verdict.unresolvedThreads).toBe(1);
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

	test("re-requested reviewer (verified via requested_reviewers) passes", () => {
		const verdict = evaluateWatchExit(
			snapshot({
				reviewers: [
					{ login: "rev", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
				],
				requestedReviewers: ["rev"],
			}),
			{ selfLogins: ["twaldin"] },
		);
		expect(verdict.exitOk).toBe(true);
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
		expect(pending.exitOk).toBe(false);
		expect(pending.ci).toBe("will-be-green");
		expect(pending.disposition).toBe("wait");
		expect(pending.actionable).toBe(false);
	});

	test("zero checks is a durable wait, never terminal success or agent work", () => {
		const verdict = evaluateWatchExit(snapshot({ checkRuns: [] }), {
			selfLogins: ["twaldin"],
		});
		expect(verdict.exitOk).toBe(false);
		expect(verdict.ci).toBe("none");
		expect(verdict.disposition).toBe("wait");
		expect(verdict.actionable).toBe(false);
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
				{ name: "a", status: "completed", conclusion: "success" },
				{ name: "b", status: "completed", conclusion: "failure" },
			]),
		).toBe("red");
	});

	test("reviewersNeedingReRequest skips bots, self, active-after-push, and already-requested", () => {
		const lastPush = "2026-07-27T10:00:00Z";
		const reviewers = [
			{ login: "stale", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "fresh", isBot: false, lastActivityAt: "2026-07-27T11:00:00Z", lastReviewState: "APPROVED" },
			{ login: "bot[bot]", isBot: true, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "requested", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "COMMENTED" },
			{ login: "me", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: null },
		];
		expect(reviewersNeedingReRequest(reviewers, ["requested"], lastPush, ["me"])).toEqual(["stale"]);
	});

	test("parseActivity preserves an approval across a later push", () => {
		const { reviewers } = parseActivity(
			[
				{
					author: { login: "approved", __typename: "User" },
					state: "APPROVED",
					submittedAt: "2026-07-27T09:00:00Z",
					body: "",
				},
			],
			[],
		);
		expect(reviewers).toEqual([
			{
				login: "approved",
				isBot: false,
				lastActivityAt: "2026-07-27T09:00:00Z",
				lastReviewState: "APPROVED",
				hasActiveApproval: true,
			},
		]);
	});

	test("parseActivity marks the latest approval as inactive after dismissal", () => {
		const { reviewers } = parseActivity(
			[
				{
					author: { login: "dismissed", __typename: "User" },
					state: "APPROVED",
					submittedAt: "2026-07-27T09:00:00Z",
					body: "",
				},
				{
					author: { login: "dismissed", __typename: "User" },
					state: "DISMISSED",
					submittedAt: "2026-07-27T11:00:00Z",
					body: "",
				},
			],
			[],
		);
		expect(reviewers).toEqual([
			{
				login: "dismissed",
				isBot: false,
				lastActivityAt: "2026-07-27T11:00:00Z",
				lastReviewState: "DISMISSED",
				hasActiveApproval: false,
			},
		]);
	});

	test("does not re-request an approval that predates the push", () => {
		expect(
			reviewersNeedingReRequest(
				[{ login: "approved", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "APPROVED" }],
				[],
				"2026-07-27T10:00:00Z",
			),
		).toEqual([]);
	});

	test("re-requests changes requested before the push", () => {
		expect(
			reviewersNeedingReRequest(
				[{ login: "changes", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "CHANGES_REQUESTED" }],
				[],
				"2026-07-27T10:00:00Z",
			),
		).toEqual(["changes"]);
	});

	test("does not re-request an approval after the push", () => {
		expect(
			reviewersNeedingReRequest(
				[{ login: "approved", isBot: false, lastActivityAt: "2026-07-27T11:00:00Z", lastReviewState: "APPROVED" }],
				[],
				"2026-07-27T10:00:00Z",
			),
		).toEqual([]);
	});

	test("re-requests an approval dismissed after the push", () => {
		expect(
			reviewersNeedingReRequest(
				[{ login: "dismissed", isBot: false, lastActivityAt: "2026-07-27T09:00:00Z", lastReviewState: "DISMISSED" }],
				[],
				"2026-07-27T10:00:00Z",
			),
		).toEqual(["dismissed"]);
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
	test("a fix worker returns after push and never owns the wait", () => {
		const prompt = watchFixPrompt({
			worktree: "/tmp/wt",
			branch: "fix/ci",
			repo: "owner/repo",
			prNumber: 42,
			gh: "gh",
			baseBranch: "main",
			pollJson: "{}",
			round: 0,
			afterPoll: 1,
		});
		expect(prompt).toContain("return the receipt and exit immediately");
		expect(prompt).toContain("rebase THIS PR branch");
		expect(prompt).toContain("fetch origin/main");
		expect(prompt).toContain("force-with-lease");
		expect(prompt).toContain("Never sleep-poll CI or review state");
		expect(prompt).toContain("persisted Smithers poll owns the wait");
		expect(prompt).toContain("reviewersToReRequest");
		expect(prompt).toContain("-- tim's agent");
		expect(prompt).not.toContain("re-request every prior human reviewer");
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

	test("hard red CI blocks", () => {
		expect(evaluateReadyForStamp([approval("rev")], "red", options).ready).toBe(false);
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
