import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifyCiEvidence, evaluateWatchExit } from "../lib/watch.ts";
import type { WatchSnapshot } from "../lib/types.ts";
import {
	analyzeFixture,
	assertPublicStructuralFixture,
	CAPTAIN_REVIEW_POLICY,
	rehydrateFixture,
	type ActorKind,
	type StructuralFixture,
} from "../scripts/pr-state-dry-run.ts";

const fixtureDir = resolve(import.meta.dir, "fixtures/lindy-prs");
const fixtureNames = readdirSync(fixtureDir).filter((name) => /^case-\d+\.json$/.test(name)).sort();
const fixtures = fixtureNames.map((name) =>
	JSON.parse(readFileSync(resolve(fixtureDir, name), "utf8")) as StructuralFixture
);

function watchOptions(selfLogins: string[], handledTriggerIds: string[] = []) {
	return { selfLogins, handledTriggerIds, reviewPolicy: CAPTAIN_REVIEW_POLICY };
}

function actorKind(fixture: StructuralFixture, actorId: string): ActorKind {
	const actor = fixture.actors.find((candidate) => candidate.id === actorId);
	if (actor === undefined) throw new Error(`${fixture.caseId} has unknown actor ${actorId}`);
	return actor.kind;
}

function expectedRecentCommentKinds(fixture: StructuralFixture): Set<"human_comment" | "bot_comment"> {
	const latestSelf = Math.max(0, ...fixture.comments
		.filter((comment) => actorKind(fixture, comment.authorId) === "self")
		.map((comment) => comment.afterHeadSeconds));
	const expected = new Set<"human_comment" | "bot_comment">();
	for (const comment of fixture.comments) {
		if (!comment.actionable || comment.afterHeadSeconds <= latestSelf) continue;
		const kind = actorKind(fixture, comment.authorId);
		if (kind === "human") expected.add("human_comment");
		if (kind === "claude") expected.add("bot_comment");
	}
	return expected;
}

function cleanForApproval(snapshot: WatchSnapshot): WatchSnapshot {
	return {
		...snapshot,
		mergeable: "MERGEABLE",
		mergeStateStatus: "BLOCKED",
		behindBy: 0,
		threads: snapshot.threads.map((thread) => ({ ...thread, isResolved: true })),
	};
}

describe("sanitized captain corpus", () => {
	test("contains exactly 25 anonymous structural cases", () => {
		expect(fixtures).toHaveLength(25);
		expect(new Set(fixtures.map((fixture) => fixture.caseId)).size).toBe(25);
	});

	test("capture refuses to place raw private state anywhere inside the public repository", () => {
		const forbidden = resolve(import.meta.dir, "fixtures/raw-private.json");
		const result = Bun.spawnSync([
			process.execPath,
			resolve(import.meta.dir, "../scripts/pr-state-dry-run.ts"),
			"capture",
			"--repo", "example/repository",
			"--self", "author",
			"--out", forbidden,
			"1",
		], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("MUST be written outside the repository");
		expect(Bun.file(forbidden).size).toBe(0);
	});

	test("contains no raw Lindy identifiers, prose, URLs, SHAs, branches, or timestamps", () => {
		const forbiddenKey = /^(?:body|url|title|login|repository|prNumber|headSha|baseRefName|lastPushAt|workflowName|name)$/i;
		const forbiddenValue = /https?:|github|lindy|twaldin|\b[0-9a-f]{40}\b|\bLIN-\d+\b|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i;
		for (const name of fixtureNames) {
			const text = readFileSync(resolve(fixtureDir, name), "utf8");
			expect(text).not.toMatch(forbiddenValue);
			const fixture = JSON.parse(text) as unknown;
			assertPublicStructuralFixture(fixture);
			const visit = (value: unknown): void => {
				if (Array.isArray(value)) {
					for (const child of value) visit(child);
					return;
				}
				if (typeof value !== "object" || value === null) return;
				for (const [key, child] of Object.entries(value)) {
					expect(key).not.toMatch(forbiddenKey);
					visit(child);
				}
			};
			visit(fixture);
		}
	});

	test("rehydrates and evaluates every captured shape without crashing", () => {
		for (const fixture of fixtures) {
			const row = analyzeFixture(fixture);
			expect(row.verdict, `${fixture.caseId}: ${row.action}`).not.toBe("crashes");
			expect(row.classification).not.toBe("");
		}
	});

	test("preserves all named messy situations from the real corpus", () => {
		const tags = new Set(fixtures.flatMap((fixture) => fixture.situationTags));
		for (const required of [
			"merge-conflict",
			"transient-unknown-observed",
			"empty-review-decision",
			"changes-requested-with-approval",
			"unresolved-thread",
		]) expect(tags).toContain(required);
	});
});

describe("SPEC.md step 4 — every real trigger wakes a seat", () => {
	test("every conflict emits a merge-conflict trigger and requires a rebase", () => {
		for (const fixture of fixtures.filter((candidate) => candidate.situationTags.includes("merge-conflict"))) {
			const hydrated = rehydrateFixture(fixture);
			const verdict = evaluateWatchExit(hydrated.watchSnapshot, watchOptions(hydrated.selfLogins));
			expect(verdict.rebaseRequired, fixture.caseId).toBe(true);
			expect(verdict.triggers.map((trigger) => trigger.kind), fixture.caseId).toContain("merge_conflict");
			expect(verdict.actionable, fixture.caseId).toBe(true);
		}
	});

	test("the newest unhandled human and Claude comments emit their own trigger kinds", () => {
		for (const fixture of fixtures) {
			const expected = expectedRecentCommentKinds(fixture);
			if (expected.size === 0) continue;
			const hydrated = rehydrateFixture(fixture);
			const verdict = evaluateWatchExit(hydrated.watchSnapshot, watchOptions(hydrated.selfLogins));
			const actual = new Set(verdict.triggers.map((trigger) => trigger.kind));
			for (const kind of expected) expect(actual, `${fixture.caseId}: ${kind}`).toContain(kind);
		}
	});

	test("a terminal required-check failure emits failed_ci", () => {
		for (const fixture of fixtures) {
			const hydrated = rehydrateFixture(fixture);
			const ci = classifyCiEvidence(hydrated.watchSnapshot);
			if (ci.classification !== "TERMINAL_FAILURE") continue;
			const verdict = evaluateWatchExit(hydrated.watchSnapshot, watchOptions(hydrated.selfLogins));
			expect(verdict.triggers.map((trigger) => trigger.kind), fixture.caseId).toContain("failed_ci");
		}
	});

	// Locked SPEC.md lines 53-76 names merge conflict—not mere distance from
	// base—as the continuous rebase trigger.
	test("a mergeable PR that is merely behind does not blind-rebase", () => {
		for (const fixture of fixtures.filter((candidate) =>
			candidate.real.mergeable === "MERGEABLE" && candidate.real.behindBy > 0 && candidate.real.mergeStateStatus !== "BEHIND"
		)) {
			const hydrated = rehydrateFixture(fixture);
			const verdict = evaluateWatchExit(hydrated.watchSnapshot, watchOptions(hydrated.selfLogins));
			expect(verdict.rebaseRequired, fixture.caseId).toBe(false);
			expect(verdict.triggers.map((trigger) => trigger.kind), fixture.caseId).not.toContain("merge_conflict");
		}
	});
});

describe("exact-head CI evidence", () => {
	test("required CI that never reports reaches a terminal escalation instead of hanging", () => {
		const hydrated = rehydrateFixture(fixtures[0]!);
		const snapshot: WatchSnapshot = {
			...cleanForApproval(hydrated.watchSnapshot),
			checkRuns: [],
			ciEvidence: {
				...hydrated.watchSnapshot.ciEvidence!,
				requiredContexts: [{ context: "required-a", integrationId: null }],
				currentHeadAgeSeconds: 151,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		};
		const verdict = evaluateWatchExit(snapshot, watchOptions(hydrated.selfLogins, []));
		expect(verdict.ciClassification).toBe("NOT_TRIGGERED");
		expect(verdict.terminalEscalation).toBe(true);
		expect(verdict.disposition).toBe("escalate");
	});

	test("no CI configured is distinct from both success and non-reporting", () => {
		const hydrated = rehydrateFixture(fixtures[0]!);
		const snapshot: WatchSnapshot = {
			...cleanForApproval(hydrated.watchSnapshot),
			checkRuns: [],
			ciEvidence: {
				...hydrated.watchSnapshot.ciEvidence!,
				requiredContexts: [],
				currentHeadAgeSeconds: 10_000,
				currentRuns: [],
				staleActiveRuns: [],
				statuses: [],
			},
		};
		const ci = classifyCiEvidence(snapshot);
		expect(ci.classification).toBe("NO_REQUIRED_CHECKS");
		expect(ci.classification).not.toBe("TERMINAL_SUCCESS");
		expect(ci.terminalEscalation).toBe(false);
	});

	// Several structural cases contain successful current required contexts plus
	// older/optional failed runs. SPEC.md lines 73-76 require exact-head CI truth.
	test("stale or optional failed checks cannot override successful required current-head CI", () => {
		for (const fixture of fixtures) {
			const hydrated = rehydrateFixture(fixture);
			const evidence = hydrated.watchSnapshot.ciEvidence!;
			const currentSuites = new Set(evidence.currentRuns.map((run) => run.checkSuiteId));
			const requiredSucceeded = evidence.requiredContexts.length > 0 && evidence.requiredContexts.every((required) => {
				const check = hydrated.watchSnapshot.checkRuns.find((candidate) =>
					candidate.name === required.context &&
					(required.integrationId === null || candidate.appId === required.integrationId) &&
					candidate.checkSuiteId !== null && candidate.checkSuiteId !== undefined && currentSuites.has(candidate.checkSuiteId));
				if (check !== undefined) return check.status === "completed" && ["neutral", "skipped", "success"].includes(check.conclusion ?? "");
				return required.integrationId === null && evidence.statuses.some((status) => status.context === required.context && status.state === "success");
			});
			if (!requiredSucceeded) continue;
			expect(classifyCiEvidence(hydrated.watchSnapshot).classification, fixture.caseId).toBe("TERMINAL_SUCCESS");
		}
	});
});

describe("SPEC.md step 4/5 — approval and stamp contract", () => {
	test.skip("desired: GitHub CHANGES_REQUESTED remains blocking even when historical review rows look resolved", () => {
		const cases = fixtures.filter((fixture) => fixture.real.reviewDecision === "CHANGES_REQUESTED");
		expect(cases.length).toBeGreaterThan(0);
		for (const fixture of cases) {
			const hydrated = rehydrateFixture(fixture);
			const first = evaluateWatchExit(hydrated.watchSnapshot, watchOptions(hydrated.selfLogins));
			const handled = evaluateWatchExit(
				hydrated.watchSnapshot,
				watchOptions(hydrated.selfLogins, first.triggers.map((trigger) => trigger.id)),
			);
			expect(handled.exitOk, fixture.caseId).toBe(false);
		}
	});

	test("empty reviewDecision never crashes or invents a human approval", () => {
		const fixture = fixtures.find((candidate) => candidate.situationTags.includes("empty-review-decision"));
		expect(fixture).toBeDefined();
		const hydrated = rehydrateFixture(fixture!);
		const verdict = evaluateWatchExit(cleanForApproval(hydrated.watchSnapshot), watchOptions(hydrated.selfLogins, []));
		expect(verdict.humanApprovedBy).toBeNull();
		expect(verdict.exitOk).toBe(false);
	});

	test("a human approval on an obsolete head cannot satisfy the gate", () => {
		const fixture = fixtures.find((candidate) =>
			candidate.real.reviewDecision === "APPROVED"
			&& candidate.reviews.some((review) =>
				actorKind(candidate, review.actorId) === "human"
				&& review.state === "APPROVED"
				&& !review.onCurrentHead
			)
			&& !candidate.reviews.some((review) =>
				actorKind(candidate, review.actorId) === "human"
				&& review.state === "APPROVED"
				&& review.onCurrentHead
			)
		);
		expect(fixture).toBeDefined();
		const hydrated = rehydrateFixture(fixture!);
		const snapshot = cleanForApproval(hydrated.watchSnapshot);
		const first = evaluateWatchExit(snapshot, watchOptions(hydrated.selfLogins));
		const handled = evaluateWatchExit(
			snapshot,
			watchOptions(hydrated.selfLogins, first.triggers.map((trigger) => trigger.id)),
		);
		expect(handled.humanApprovedBy).toBeNull();
		expect(handled.exitOk).toBe(false);
	});

	test("human + Claude approval offers stamp before CI becomes green", () => {
		const fixture = fixtures.find((candidate) =>
			candidate.situationTags.includes("approved") &&
			candidate.comments.some((comment) => comment.signal === "claude-approved")
		);
		expect(fixture).toBeDefined();
		const hydrated = rehydrateFixture(fixture!);
		const pending: WatchSnapshot = {
			...cleanForApproval(hydrated.watchSnapshot),
			checkRuns: [],
			ciEvidence: {
				...hydrated.watchSnapshot.ciEvidence!,
				requiredContexts: [{ context: "required-a", integrationId: null }],
				currentHeadAgeSeconds: 10,
				currentRuns: [{
					id: 1, checkSuiteId: 1, headSha: "current-head", status: "in_progress", conclusion: null,
					createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
					startedAt: "2026-01-01T00:00:01.000Z", url: "https://example.invalid/run", jobs: [],
				}],
				staleActiveRuns: [], statuses: [],
			},
		};
		const first = evaluateWatchExit(pending, watchOptions(hydrated.selfLogins));
		const handled = evaluateWatchExit(pending, watchOptions(hydrated.selfLogins, first.triggers.map((trigger) => trigger.id)));
		expect(handled.ciClassification).toBe("STARTING");
		expect(handled.humanApprovedBy).not.toBeNull();
		expect(handled.botApprovedBy).toContain("claude");
		expect(handled.exitOk).toBe(true);
	});

	// The locked classifier ruling is latest exact-head Claude evidence wins.
	test("a latest Claude error revokes an earlier finished signal", () => {
		const fixture = fixtures.find((candidate) =>
			candidate.situationTags.includes("approved") &&
			candidate.comments.some((comment) => comment.signal === "claude-error")
		);
		expect(fixture).toBeDefined();
		const hydrated = rehydrateFixture(fixture!);
		const snapshot = cleanForApproval(hydrated.watchSnapshot);
		const first = evaluateWatchExit(snapshot, watchOptions(hydrated.selfLogins));
		const handled = evaluateWatchExit(snapshot, watchOptions(hydrated.selfLogins, first.triggers.map((trigger) => trigger.id)));
		expect(handled.humanApprovedBy).not.toBeNull();
		expect(handled.botApprovedBy).not.toContain("claude");
		expect(handled.exitOk).toBe(false);
	});

	// The captain's surveyed UNKNOWN states are transient GitHub evidence, not a
	// license to blind-rebase. The mature taxonomy calls this MERGEABILITY_STALE.
	test("transient UNKNOWN mergeability is classified stale, not conflicting", () => {
		for (const fixture of fixtures.filter((candidate) => candidate.real.transientMergeableObservation === "UNKNOWN")) {
			const hydrated = rehydrateFixture(fixture);
			const snapshot = { ...hydrated.watchSnapshot, mergeable: "UNKNOWN" as const, mergeStateStatus: "UNKNOWN", behindBy: 0 };
			const verdict = evaluateWatchExit(snapshot, watchOptions(hydrated.selfLogins));
			expect(verdict.rebaseRequired, fixture.caseId).toBe(false);
			expect(verdict.ciClassification, fixture.caseId).toBe("MERGEABILITY_STALE");
		}
	});
});
