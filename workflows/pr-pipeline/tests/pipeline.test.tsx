/** @jsxImportSource smithers-orchestrator */
/**
 * Workflow-level tests: drive the REAL pipeline module (per the
 * renderWorkflow/simulate contract - never a hand-built stand-in graph)
 * through smithers-orchestrator/testing in dry-run mode.
 *
 * <Approval> nodes park a simulated run in "waiting-approval" (verified
 * empirically; simulate does not consult mocks for approvals). Full-graph
 * traversal therefore uses input.bypassApprovals=true, which swaps each
 * Approval for a compute task writing an approved row under the SAME node id.
 * Preflight refuses bypassApprovals without dryRun, so no real run can
 * self-approve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { simulate } from "smithers-orchestrator/testing";

import pipeline from "../pipeline.tsx";

const validBrief = {
	ticket: "LIN-123",
	title: "Add rate limiting",
	summary: "Rate-limit the /api/foo endpoint",
	acceptanceCriteria: ["429 after 100 req/min", "e2e test proves the limit"],
	decisionLedger: [{ question: "Which store?", decision: "redis", open: false }],
	killSwitch: { kind: "named", name: "RATE_LIMIT_ENABLED flag" },
	breakSignal: "sentry:lindy-api #on-call-issues",
};

const baseInput = {
	ticket: "LIN-123",
	repo: "lindy-ai/lindy",
	worktree: "/tmp/lindy-wt",
	branch: "fm/lin-123",
	brief: validBrief,
	dryRun: true,
};

async function run(input: Record<string, unknown>) {
	const sim = simulate(pipeline, { input });
	let error: unknown;
	try {
		await sim.run();
	} catch (err) {
		error = err;
	}
	return { sim, error };
}

describe("preflight gate", () => {
	test("refuses a missing brief with the open-question list; nothing downstream runs", async () => {
		const { sim, error } = await run({ ...baseInput, brief: undefined });
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain("PREFLIGHT REFUSED");
		expect(String(error)).toContain("brief is missing");
		expect(sim.executed).toContain("preflight");
		expect(sim.executed).toContain("preflight-refusal");
		expect(sim.executed).not.toContain("implement");
		expect(sim.executed).not.toContain("push-pr");
	});

	test("refuses open decision-ledger entries", async () => {
		const { sim, error } = await run({
			...baseInput,
			brief: {
				...validBrief,
				decisionLedger: [{ question: "unsettled?", decision: null, open: true }],
			},
		});
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain("unsettled?");
		expect(sim.executed).not.toContain("implement");
	});

	test("refuses bypassApprovals without dryRun (no real run can self-approve)", async () => {
		const { sim, error } = await run({ ...baseInput, dryRun: false, bypassApprovals: true });
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain("bypassApprovals");
	});

	test("refuses same-family reviewer when familyOpposition is on", async () => {
		const { sim, error } = await run({
			...baseInput,
			models: { implementer: "deck/claude-sonnet-5", reviewer: "deck/claude-opus-5" },
		});
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain("same family");
	});
});

describe("project profiles (yolo vs stamp is data, not a fork)", () => {
	// Pin the profile source to a fresh temp home so the machine's live
	// ~/.deck/config never leaks into these assertions (seeds answer).
	let home: string;
	let savedHome: string | undefined;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pipeline-profiles-"));
		savedHome = process.env.DECK_V2_HOME;
		process.env.DECK_V2_HOME = home;
	});
	afterEach(() => {
		if (savedHome === undefined) delete process.env.DECK_V2_HOME;
		else process.env.DECK_V2_HOME = savedHome;
		fs.rmSync(home, { recursive: true, force: true });
	});

	test("a yolo profile (deck) traverses to done with NO approval bypass: the stamp park is skipped", async () => {
		const { sim, error } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			fixtures: { changedFiles: ["src/feature.ts"] }, // no migration gate
		});
		expect(error).toBeUndefined();
		// Not waiting-approval: the run FINISHED without any human park.
		expect(sim.status).toBe("finished");
		// The stamp row exists (same node id), written by the workflow itself.
		const stamps = sim.outputs.approvals as Array<Record<string, unknown>>;
		expect(stamps.some((row) => String(row.decidedBy).startsWith("profile:deck"))).toBe(true);
		// The TOCTOU guards still ran: yolo skips the PARK, never the checks.
		expect(sim.executed).toContain("r0-stamp-validity");
		expect(sim.executed).toContain("r0-merge-head-check");
		expect(sim.executed).toContain("enqueue-merge");
		expect(sim.executed).toContain("done");
		// yolo skips the stamp PARK only — the adversarial review still gates the PR open:
		expect(sim.executed.indexOf("local-review")).toBeLessThan(sim.executed.indexOf("push-pr"));
	});

	test("REGRESSION: the adversarial review gate holds under a yolo profile — an unapproved review parks at review-escalation and push-pr never runs", async () => {
		const { sim } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			limits: { localReviewRounds: 2 },
			fixtures: { changedFiles: ["src/feature.ts"], localReviewRounds: 99 },
		});
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed).toContain("local-review");
		expect(sim.executed).not.toContain("push-pr");
		expect(sim.executed).not.toContain("enqueue-merge");
	});

	test("REGRESSION: a stamp profile (lindy) still parks at the stamp approval", async () => {
		const { sim } = await run({
			...baseInput,
			profile: "lindy",
			fixtures: { changedFiles: ["src/feature.ts"] },
		});
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed).not.toContain("enqueue-merge");
	});

	test("an unknown profile is refused at preflight", async () => {
		const { sim, error } = await run({ ...baseInput, profile: "nope" });
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain('unknown project profile "nope"');
	});

	test("REGRESSION: a yolo profile attached to another repo is refused, never a skipped stamp", async () => {
		// Without the repo binding, any caller could pass the deck profile on a
		// lindy run and merge without the captain's stamp.
		const { sim, error } = await run({ ...baseInput, profile: "deck" }); // repo stays lindy-ai/lindy
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain('profile "deck" belongs to repo twaldin/deck');
		expect(sim.executed).not.toContain("enqueue-merge");
	});
});

describe("approval parks (no bypass)", () => {
	test("an unapproved adversarial review parks at review-escalation; push-pr never runs (stamp profile)", async () => {
		const { sim } = await run({
			...baseInput,
			limits: { localReviewRounds: 2 },
			fixtures: { changedFiles: ["src/feature.ts"], localReviewRounds: 99 },
		});
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed).toContain("local-review");
		expect(sim.executed).not.toContain("push-pr");
	});

	test("dry run with real approvals parks at the stamp; merge never runs", async () => {
		const { sim } = await run({
			...baseInput,
			fixtures: { changedFiles: ["src/feature.ts"] }, // no migration -> first park is the stamp
		});
		expect(sim.status).toBe("waiting-approval");
		// Everything up to ready ran:
		expect(sim.executed).toContain("implement");
		expect(sim.executed).toContain("local-review");
		expect(sim.executed).toContain("push-pr");
		expect(sim.executed).toContain("request-reviewers");
		expect(sim.executed).toContain("r0-watch-poll");
		expect(sim.executed).toContain("r0-ready-poll");
		// Parked: the stamp approval never executed, so nothing merge-ward ran.
		expect(sim.executed).not.toContain("enqueue-merge");
		expect(sim.executed).not.toContain("landing-poll");
		expect(sim.executed).not.toContain("done");
	});

	test("migration path parks at the migration gate before any migration runs", async () => {
		const { sim } = await run(baseInput); // default fixtures include a migration file
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed).toContain("migration-check");
		expect(sim.executed).not.toContain("migration-stg-run");
		expect(sim.executed).not.toContain("enqueue-merge");
	});
});

describe("full graph traversal (bypassApprovals, dry-run only)", () => {
	test("clean path: all 11 stages execute in order; done record present", async () => {
		const { sim, error } = await run({
			...baseInput,
			bypassApprovals: true,
			fixtures: { changedFiles: ["src/feature.ts"] },
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");

		// Stage coverage (order-checked for the load-bearing chain):
		const order = [
			"preflight",
			"implement",
			"local-review",
			"push-pr",
			"request-reviewers",
			"r0-watch-poll",
			"r0-ready-poll",
			"r0-stamp",
			"r0-stamp-validity",
			"r0-merge-head-check",
			"enqueue-merge",
			"landing-poll",
			"deploy-evidence",
			"fallout-window",
			"fallout-wait",
			"fallout-watch",
			"done",
		];
		let cursor = -1;
		for (const nodeId of order) {
			const idx = sim.executed.indexOf(nodeId);
			expect(idx).toBeGreaterThan(cursor);
			cursor = idx;
		}

		// The watch loop exercised its fix arm before exiting:
		expect(sim.executed).toContain("r0-watch-fix");
		// Local review looped: review -> fix -> review.
		expect(sim.executed.filter((id) => id === "local-review").length).toBeGreaterThanOrEqual(2);
		expect(sim.executed).toContain("local-fix");

		// Evidence-gated done:
		const done = sim.outputs.doneRecord as Array<Record<string, unknown>>;
		expect(done).toHaveLength(1);
		expect(done[0].ticket).toBe("LIN-123");
		expect(done[0].falloutVerdict).toBe("clean");
		expect(done[0].migrationRequired).toBe(false);

		// PR was registered in the watch-set as a side effect of push-pr:
		const pr = (sim.outputs.prRecord as Array<Record<string, unknown>>)[0];
		expect(pr.watchSetRegistered).toBe(true);

		// Reviewers were requested and verified before any watch round ran:
		const request = (sim.outputs.reviewerRequest as Array<Record<string, unknown>>)[0];
		expect(request.skipped).toBe(false);
		expect(request.requested).toEqual(["dry-reviewer"]);
		expect(request.verified).toEqual(["dry-reviewer"]);
	});

	test("skipReviewerRequest is the only empty-reviewer path, and it is recorded as explicit", async () => {
		const { sim, error } = await run({
			...baseInput,
			bypassApprovals: true,
			github: { skipReviewerRequest: true },
			fixtures: { changedFiles: ["src/feature.ts"] },
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");
		const request = (sim.outputs.reviewerRequest as Array<Record<string, unknown>>)[0];
		expect(request.skipped).toBe(true);
		expect(request.requested).toEqual([]);
		expect(request.source).toBe("explicit-skip");
	});

	test("migration path: gate + all four stg/prod stages run before done", async () => {
		const { sim, error } = await run({ ...baseInput, bypassApprovals: true });
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");

		// Migration check found the default fixture migration file:
		const check = (sim.outputs.migrationCheck as Array<Record<string, unknown>>)[0];
		expect(check.required).toBe(true);

		// All four stages ran, in order, and BEFORE the merge:
		const stages = ["migration-stg-run", "migration-stg-verify", "migration-prod-run", "migration-prod-verify"];
		let cursor = -1;
		for (const stage of stages) {
			const idx = sim.executed.indexOf(stage);
			expect(idx).toBeGreaterThan(cursor);
			cursor = idx;
		}
		expect(sim.executed.indexOf("migration-prod-verify")).toBeLessThan(sim.executed.indexOf("enqueue-merge"));

		// Done records the migration requirement:
		const done = (sim.outputs.doneRecord as Array<Record<string, unknown>>)[0];
		expect(done.migrationRequired).toBe(true);

		// Evidence rows all recorded:
		const runs = sim.outputs.migrationRun as Array<Record<string, unknown>>;
		expect(runs.map((r) => r.stage).sort()).toEqual(["prod-run", "prod-verify", "stg-run", "stg-verify"]);
	});

	test("head change after stamp invalidates it and re-enters watch-ci as round 1 (no silent re-stamp)", async () => {
		const { sim, error } = await run({
			...baseInput,
			bypassApprovals: true,
			fixtures: { changedFiles: ["src/feature.ts"], headChangeRounds: [0] },
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");

		// Round 0 stamped, validity failed:
		const validity = sim.outputs.stampValidity as Array<Record<string, unknown>>;
		const r0 = validity.find((v) => v.round === 0);
		expect(r0?.valid).toBe(false);

		// Round 1 re-entered the WATCH loop (not a silent re-stamp):
		expect(sim.executed).toContain("r1-watch-poll");
		expect(sim.executed).toContain("r1-ready-poll");
		expect(sim.executed).toContain("r1-stamp");
		const r1 = validity.find((v) => v.round === 1);
		expect(r1?.valid).toBe(true);

		// Merge used round 1's authorization, after a fresh pre-merge head check:
		expect(sim.executed).toContain("r1-merge-head-check");
		expect(sim.executed).not.toContain("r0-merge-head-check"); // round 0 never authorized
		const receipt = (sim.outputs.mergeReceipt as Array<Record<string, unknown>>)[0];
		expect(receipt.round).toBe(1);
	});

	test("watch loop iterates until the machine-checked exit passes", async () => {
		const { sim } = await run({
			...baseInput,
			bypassApprovals: true,
			fixtures: { changedFiles: ["src/feature.ts"], watchPollsToExit: 3 },
		});
		expect(sim.status).toBe("finished");
		const polls = sim.outputs.watchPoll as Array<Record<string, unknown>>;
		expect(polls.length).toBe(3);
		expect(polls[polls.length - 1].exitOk).toBe(true);
		// The fixer ran after each failing poll:
		expect(sim.executed.filter((id) => id === "r0-watch-fix").length).toBe(2);
	});

	test("pending CI persists poll receipts without starting a worker", async () => {
		const { sim, error } = await run({
			...baseInput,
			bypassApprovals: true,
			fixtures: {
				changedFiles: ["src/feature.ts"],
				watchPollsToExit: 3,
				watchWaitPolls: 2,
			},
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");

		const polls = sim.outputs.watchPoll as Array<Record<string, unknown>>;
		expect(polls.map((poll) => poll.disposition)).toEqual(["wait", "wait", "complete"]);
		expect(sim.executed.filter((id) => id === "r0-watch-poll")).toHaveLength(3);
		expect(sim.executed).not.toContain("r0-watch-fix");
	});
});
