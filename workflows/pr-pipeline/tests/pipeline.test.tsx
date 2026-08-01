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
import { renderWorkflow, simulate } from "smithers-orchestrator/testing";

import pipeline, { buildModelPolicy, DEFAULT_GITHUB } from "../pipeline.tsx";
import type { ProjectProfile } from "../lib/profiles.ts";
import { falloutPrompt, localFixPrompt, localReviewPrompt, reviewersDecisionPrompt } from "../lib/prompts.ts";
import { resolveAdversary } from "../lib/models.ts";

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

describe("workflow rendering contracts", () => {
	const profileBase: ProjectProfile = {
		id: "test",
		repo: "example/test",
		primary: "/tmp/test",
		pipeline: "lindy-full",
		yolo: false,
		stamp: true,
		knowledge: [],
		depsWarm: true,
	};
	const fullModels = {
		implementer: "deck/claude-fable-5",
		watcher: "deck/gpt-5.6-luna",
		fallout: "deck/gpt-5.6-sol",
		familyOpposition: true,
		oppositionDefaults: { anthropic: "deck/gpt-5.6-luna" },
	};

	async function renderWithProfile(
		profile: Record<string, unknown>,
		inputModels: Record<string, unknown> | null | undefined,
		repo: string,
	): Promise<{ seats: Record<string, { model: string; thinking: string }>; model: string; thinking: string }> {
		const savedHome = process.env.DECK_V2_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pipeline-models-"));
		try {
			process.env.DECK_V2_HOME = home;
			fs.mkdirSync(path.join(home, "config"), { recursive: true });
			fs.writeFileSync(path.join(home, "config", "projects.json"), JSON.stringify([profile]));
			const rendered = await renderWorkflow(pipeline, {
				input: { ...baseInput, repo, profile: "test", models: inputModels, dryRun: false },
				outputs: {
					preflight: [
						{
							nodeId: "preflight",
							ok: true,
							openQuestions: [],
							briefDigest: "",
							resolvedReviewerModel: "deck/claude-fable-5",
						},
					],
				},
				workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
			});
			const seats: Record<string, { model: string; thinking: string }> = {};
			for (const task of rendered.tasks) {
				const agent = task.agent;
				if (agent !== undefined) {
					expect(Array.isArray(agent)).toBe(false);
					seats[task.nodeId] = {
						model: String((agent as unknown as { model: string }).model),
						thinking: String((agent as { opts?: { thinking?: string }; thinking?: string }).opts?.thinking ?? (agent as { thinking?: string }).thinking ?? ""),
					};
				}
			}
			const implementer = seats.implement;
			return { seats, model: implementer.model, thinking: implementer.thinking };
		} finally {
			if (savedHome === undefined) delete process.env.DECK_V2_HOME;
			else process.env.DECK_V2_HOME = savedHome;
			fs.rmSync(home, { recursive: true, force: true });
		}
	}

	test("input schema accepts null models", () => {
		expect((pipeline as typeof pipeline & { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }).inputSchema.safeParse({ ...baseInput, models: null }).success).toBe(true);
	});

	test("profile reasoning flows to each seat, with explicit seat overrides", () => {
		const policy = buildModelPolicy({
			...profileBase,
			pipeline: "lindy-full",
			models: { reasoning: "high", reasoningReviewer: "xhigh" },
		} as ProjectProfile, false, undefined);
		expect(policy.reasoningImplementer).toBe("high");
		expect(policy.reasoningReviewer).toBe("xhigh");
		expect(policy.reasoningWatcher).toBe("high");
		expect(policy.reasoningFallout).toBe("high");
	});

	test("profile reasoning reaches the rendered PiAgent seat", async () => {
		const rendered = await renderWithProfile({ ...profileBase, models: { ...fullModels, reasoning: "max" } }, undefined, "example/test");
		expect(rendered.model).toBe("claude-fable-5");
		expect(rendered.thinking).toBe("max");
		expect(rendered.seats["local-review"]?.thinking ?? rendered.thinking).toBe("max");
		expect(rendered.seats["r0-watch-poll"]?.thinking ?? rendered.thinking).toBe("max");
		expect(rendered.seats["fallout-watch"]?.thinking ?? rendered.thinking).toBe("max");
	});

	test.each([
		["full profile models", { ...profileBase, models: fullModels }, undefined, "example/test", "claude-fable-5"],
		["missing profile models", profileBase, undefined, "example/test", "gpt-5.6-luna"],
		["null profile models", { ...profileBase, models: null }, null, "example/test", "gpt-5.6-luna"],
		["partial profile models with input models", { ...profileBase, models: { implementer: "deck/claude-fable-5" } }, { watcher: "deck/gpt-5.6-sol" }, "example/test", "claude-fable-5"],
		["repo-mismatched profile", { ...profileBase, models: fullModels }, { implementer: "deck/claude-sonnet-5" }, "other/repo", "gpt-5.6-luna"],
	] as const)("renders with %s", async (_name, profile, inputModels, repo, expectedImplementer) => {
		expect((await renderWithProfile(profile, inputModels, repo)).model).toBe(expectedImplementer);
	});
});

describe("fallout prompt rendering contracts", () => {
	test("serializes the result fixture as JSON text", () => {
		const result = { verdict: "clean", breakSignal: "sentry:lindy-api", probeResults: ["no errors"], notes: "No fallout detected." };
		const prompt = falloutPrompt({
			breakSignal: result.breakSignal,
			killSwitch: JSON.stringify({ kind: "named", name: "FLAG" }),
			repo: "lindy-ai/lindy",
			prNumber: 80,
			landedSha: "abc123",
			windowStart: "2026-08-01T00:00:00.000Z",
			windowEnd: "2026-08-01T01:00:00.000Z",
			probes: [],
		});
		expect(prompt).toContain(JSON.stringify({ verdict: "clean|regression", breakSignal: "string", probeResults: ["string"], notes: "string" }));
		expect(prompt).toContain(JSON.stringify({ verdict: result.verdict, breakSignal: result.breakSignal, probeResults: [], notes: result.notes }));
		expect(prompt).not.toContain("[object Object]");
	});

	test("renders the production fallout task with object-valued inputs", async () => {
		const rendered = await renderWorkflow(pipeline, {
			input: {
				...baseInput,
				dryRun: false,
				profile: "test",
				models: { implementer: "deck/claude-fable-5", watcher: "deck/gpt-5.6-luna", fallout: "deck/gpt-5.6-sol", familyOpposition: true, oppositionDefaults: { anthropic: "deck/gpt-5.6-luna" } },
			},
			outputs: {
				preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
				implementation: [{ nodeId: "implement", commits: ["fix"], summary: "fixed", testEvidence: "green" }],
				localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [] }],
				prRecord: [{ nodeId: "push-pr", prNumber: 80, url: "https://github.com/lindy-ai/lindy/pull/80", headSha: "abc123", watchSetRegistered: true, watchSetPath: "", receipt: "", createdAt: "2026-08-01T00:00:00.000Z" }],
				watchPoll: [{ nodeId: "r0-watch-poll", round: 0, poll: 0, headSha: "abc123", exitOk: true, disposition: "complete", actionable: false, ci: "green", unresolvedThreads: 0, unansweredComments: 0, reviewersToReRequest: [], reasons: [] }],
				readyPoll: [{ nodeId: "r0-ready-poll", round: 0, poll: 0, ready: true, regressed: false, approvedBy: "reviewer", ci: "green", headSha: "abc123", reasons: [], migrationDetected: false, migrationFiles: [], at: "2026-08-01T00:00:00.000Z" }],
				approvals: [{ nodeId: "r0-stamp", approved: true, note: "ok", decidedBy: "test", decidedAt: "2026-08-01T00:00:00.000Z" }],
				stampValidity: [{ nodeId: "r0-stamp-validity", round: 0, stampedHead: "abc123", currentHead: "abc123", valid: true, checkedAt: "2026-08-01T00:00:00.000Z" }],
				mergeHeadCheck: [{ nodeId: "r0-merge-head-check", round: 0, expectedHead: "abc123", currentHead: "abc123", ok: true, checkedAt: "2026-08-01T00:00:00.000Z" }],
				mergeReceipt: [{ nodeId: "enqueue-merge", round: 0, submittedAt: "2026-08-01T00:00:00.000Z", receipt: "queued", alreadyLanded: false, mergePath: "dry-run" }],
				queuePoll: [{ nodeId: "queue-poll", poll: 0, state: "closed", autoMergeRequest: true, ejected: false, reason: "landed" }],
				landingPoll: [{ nodeId: "landing-poll", poll: 0, landed: true, sha: "squash-sha", subject: "landed" }],
				deployEvidence: [{ nodeId: "deploy-evidence", evidence: "deployed", deployedAt: "2026-08-01T00:00:00.000Z" }],
				falloutWindow: [{ nodeId: "fallout-window", windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-01T01:00:00.000Z" }],
				falloutWait: [{ nodeId: "fallout-wait", complete: true, waitedUntil: "2026-08-01T01:00:00.000Z" }],
			},
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		const falloutTask = rendered.tasks.find((task) => task.nodeId === "fallout-watch");
		expect(falloutTask).toBeDefined();
		expect(rendered.toXml()).toContain("RATE_LIMIT_ENABLED flag");
		expect(rendered.toXml()).toContain('{\\"verdict\\":\\"clean|regression\\"');
		expect(rendered.toXml()).not.toContain("[object Object]");
	});
});

describe("reviewer selection contracts", () => {
	test("reviewer prompt uses the lookup skill and real line breaks", () => {
		const prompt = reviewersDecisionPrompt(["mackcooper1408"]);
		expect(prompt).toContain("gh-reviewer-lookup");
		expect(prompt).toContain("\n");
		expect(prompt).not.toContain("\\n");
	});

	test("default ex-employee denylist is configured", () => {
		expect(DEFAULT_GITHUB.reviewerDenylist).toEqual([
			"mackcooper1408",
			"spencer-negri",
			"daniel-covelli",
			"akshat-lindy",
		]);
	});
});

describe("model policy wiring", () => {
	test("profile opposition mapping resolves the reviewer when reviewer is absent", () => {
		const policy = buildModelPolicy(
			{
				models: {
					implementer: "deck/claude-sonnet-5",
					watcher: "deck/gpt-5.6-luna",
					fallout: "deck/gpt-5.6-sol",
					familyOpposition: true,
					oppositionDefaults: { anthropic: "deck/gpt-5.6-luna", openai: "deck/claude-fable-5" },
				},
			} as never,
			false,
			undefined,
		);
		expect(policy.reviewer).toBeUndefined();
		expect(resolveAdversary(policy.implementer, policy)).toBe("deck/gpt-5.6-luna");
	});
});

describe("local review contracts", () => {
	test("local fixes receive blockers but not nits", () => {
		const prompt = localFixPrompt(["broken behavior"], "/tmp/wt", 2);
		expect(prompt).toContain("broken behavior");
		expect(prompt).not.toContain("optional polish");
	});

	test("review prompt requires approval iff blockers are empty", () => {
		const prompt = localReviewPrompt(validBrief, "/tmp/wt", "main", 3);
		expect(prompt).toContain('"approved": boolean');
		expect(prompt).toContain('"blockingFindings": string[]');
		expect(prompt).toContain('"nits": string[]');
		expect(prompt).toContain("Set approved=true IFF");
		expect(prompt).toContain('Concrete valid result example: {"round":3,"approved":true,"blockingFindings":[],"nits":[],"summary":"No blocking findings."}');
		expect(prompt).toContain("NOT the schema");
		expect(prompt).toContain("do not include $schema");
	});

	test("schema-validated fixer prompts show result objects, not schemas", () => {
		const prompt = localFixPrompt(["broken behavior"], "/tmp/wt", 2);
		expect(prompt).toContain('Concrete valid result example: {"afterRound":2,"addressed":[],"summary":"All blocking findings addressed."}');
		expect(prompt).toContain("Reply with ONLY the result object");
	});
});

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

	test("default local review limit is eight rounds before blocker escalation", async () => {
		const { sim } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			fixtures: { changedFiles: ["src/feature.ts"], localReviewRounds: 99 },
		});
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed.filter((id) => id === "local-review")).toHaveLength(8);
		expect(sim.executed).not.toContain("push-pr");
	});

	test("nits-only review approves without local fix or escalation", async () => {
		const { sim, error } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			fixtures: {
				changedFiles: ["src/feature.ts"],
				localReviewNitsOnly: true,
				localReviewRounds: 99,
			},
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");
		expect(sim.executed.filter((id) => id === "local-review")).toHaveLength(1);
		expect(sim.executed).not.toContain("local-fix");
		expect(sim.executed).not.toContain("review-escalation");
		expect(sim.executed).toContain("push-pr");
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

describe("adopt existing PR (input.existingPr)", () => {
	test("implement is stubbed, local adversarial review runs, prRecord seeded, and the SAME watch loop reaches done", async () => {
		const { sim, error } = await run({
			...baseInput,
			bypassApprovals: true,
			existingPr: 777,
			fixtures: { changedFiles: ["src/feature.ts"], watchPollsToExit: 3 },
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");

		// Implement ran as a stub, not an agent round:
		const impl = (sim.outputs.implementation as Array<Record<string, unknown>>)[0];
		expect(impl.commits).toEqual([]);
		expect(String(impl.summary)).toContain("adopted existing PR #777");

		// Adopt skips implementation only; adversarial review still runs:
		expect(sim.executed).toContain("local-review");

		// prRecord seeded from the existing PR, not fixtures.prNumber:
		const pr = (sim.outputs.prRecord as Array<Record<string, unknown>>)[0];
		expect(pr.prNumber).toBe(777);
		expect(String(pr.receipt)).toContain("adopted existing PR #777");

		// The SAME continuous watch loop ran (multiple polls + a fix arm),
		// then ready/stamp/merge \u2014 not a one-shot check:
		expect(sim.executed.filter((id) => id === "r0-watch-poll").length).toBe(3);
		expect(sim.executed).toContain("r0-watch-fix");
		expect(sim.executed).toContain("r0-ready-poll");
		expect(sim.executed).toContain("enqueue-merge");
		expect(sim.executed).toContain("done");
	});

	test("an adopted run on a stamp profile still parks at the stamp (watch/ready ran; merge never fired)", async () => {
		const { sim } = await run({
			...baseInput,
			existingPr: 777,
			fixtures: { changedFiles: ["src/feature.ts"] },
		});
		expect(sim.status).toBe("waiting-approval");
		expect(sim.executed).toContain("push-pr");
		expect(sim.executed).toContain("r0-watch-poll");
		expect(sim.executed).toContain("r0-ready-poll");
		expect(sim.executed).toContain("local-review");
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

describe("merge queue lifecycle transitions", () => {
	test("queued -> ejected -> re-submitted -> closed reaches landing", async () => {
		const { sim, error } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			bypassApprovals: true,
			fixtures: {
				changedFiles: ["src/feature.ts"],
				queueLifecycle: [
					{ state: "open", autoMergeRequest: true },
					{ state: "open", autoMergeRequest: false },
					{ state: "closed", autoMergeRequest: false },
				],
			},
		});
		expect(error).toBeUndefined();
		expect(sim.status).toBe("finished");
		expect((sim.outputs.queuePoll as Array<Record<string, unknown>>).some((row) => row.ejected === true)).toBe(true);
		expect(sim.executed).toContain("landing-poll");
	});

	test("closed without a squash stays incomplete and escalates", async () => {
		const { sim, error } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			bypassApprovals: true,
			limits: { landingPolls: 1 },
			fixtures: { changedFiles: ["src/feature.ts"], queueLifecycle: [{ state: "closed", autoMergeRequest: false }], landingPollLanded: false },
		});
		expect(sim.status).toBe("failed");
		expect(String(error)).toContain("squash commit");
	});

	test("no fallout probe parks the run instead of creating deploy evidence", async () => {
		const { sim } = await run({
			...baseInput,
			repo: "twaldin/deck",
			profile: "deck",
			fixtures: { changedFiles: ["src/feature.ts"], noFalloutProbe: true },
		});
		expect(sim.status).toBe("waiting-approval");
		expect((sim.outputs.deployEvidence as Array<{ evidence: string }>)[0]?.evidence).toContain("PARK:");
		expect((sim.outputs.fallout as Array<{ verdict: string }>)[0]?.verdict).toBe("parked");
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
