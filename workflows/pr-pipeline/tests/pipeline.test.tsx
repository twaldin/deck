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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Smithers testing is optional in minimal checkouts; workflow tests run when the pinned package is installed.
import { renderWorkflow, simulate } from "smithers-orchestrator/testing";

import pipeline, { buildModelPolicy, DEFAULT_GITHUB, schemas } from "../pipeline.tsx";
import { loadProfiles, type ProjectProfile } from "../lib/profiles.ts";
import { falloutPrompt, localFixPrompt, localReviewPrompt, reviewersDecisionPrompt } from "../lib/prompts.ts";
import { resolveAdversary } from "../lib/models.ts";
import { isSchemaEcho, schemaEchoCorrection } from "../lib/schema-echo.ts";

const validBrief = {
	ticket: "LIN-123",
	title: "Add rate limiting",
	summary: "Rate-limit the /api/foo endpoint",
	acceptanceCriteria: ["429 after 100 req/min", "e2e test proves the limit"],
	decisionLedger: [{ question: "Which store?", decision: "redis", open: false }],
	killSwitch: { kind: "named", name: "RATE_LIMIT_ENABLED flag" },
	breakSignal: "sentry:lindy-api #on-call-issues",
};

const seatModels = {
	implementer: "deck/claude-fable-5",
	watcher: "deck/gpt-5.6-luna",
	fallout: "deck/gpt-5.6-sol",
	familyOpposition: true,
	oppositionDefaults: { anthropic: "deck/gpt-5.6-luna" },
};

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pipeline-home-"));

const baseInput = {
	watchSetPath: path.join(testHome, "watch-set.jsonl"),
	ticket: "LIN-123",
	repo: "lindy-ai/lindy",
	worktree: "/tmp/lindy-wt",
	branch: "fm/lin-123",
	brief: validBrief,
	dryRun: true,
};

const fixtureProfiles: ProjectProfile[] = [
	{
		id: "deck",
		repo: "twaldin/deck",
		primary: "/tmp/deck",
		pipeline: "yolo-ship",
		yolo: true,
		stamp: false,
		knowledge: [],
		depsWarm: true,
	},
	{
		id: "lindy",
		repo: "lindy-ai/lindy",
		primary: "/tmp/lindy",
		pipeline: "lindy-full",
		yolo: false,
		stamp: true,
		knowledge: [],
		depsWarm: true,
	},
];

let savedDeckHome: string | undefined;
let savedProcessHome: string | undefined;
beforeAll(() => {
	savedDeckHome = process.env.DECK_V2_HOME;
	savedProcessHome = process.env.HOME;
	process.env.DECK_V2_HOME = testHome;
	process.env.HOME = testHome;
	fs.mkdirSync(path.join(testHome, "config"), { recursive: true });
	fs.writeFileSync(path.join(testHome, "config", "projects.json"), JSON.stringify(fixtureProfiles));
});
afterAll(() => {
	if (savedDeckHome === undefined) delete process.env.DECK_V2_HOME;
	else process.env.DECK_V2_HOME = savedDeckHome;
	if (savedProcessHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedProcessHome;
	fs.rmSync(testHome, { recursive: true, force: true });
});

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

describe("schema-echo recovery", () => {
	test("recognizes a schema echo and produces a corrective result instruction", () => {
		const echo = { $schema: "https://json-schema.org", type: "object", properties: {}, required: [] };
		expect(isSchemaEcho(echo)).toBe(true);
		expect(isSchemaEcho({ round: 1, approved: true, blockingFindings: [], nits: [], summary: "ok" })).toBe(false);
		expect(schemaEchoCorrection("round, approved, blockingFindings, nits, summary")).toContain("Return only one filled result object");
	});
});

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
	const fullModels = seatModels;

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
		expect(rendered.seats["local-review"]?.thinking).toBeUndefined();
		expect(rendered.seats["r0-watch-poll"]).toBeUndefined();
		expect(rendered.seats["fallout-watch"]).toBeUndefined();
		expect(rendered.seats["implement"]?.model).toBe("claude-fable-5");
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

	test("renders every configured PiAgent seat with its profile reasoning", async () => {
		const rendered = await renderWorkflow(pipeline, {
			input: {
				...baseInput,
				dryRun: false,
				profile: "test",
				models: { implementer: "deck/claude-fable-5", watcher: "deck/gpt-5.6-luna", fallout: "deck/gpt-5.6-sol", familyOpposition: true, oppositionDefaults: { anthropic: "deck/gpt-5.6-luna" }, reasoning: "high", reasoningReviewer: "xhigh", reasoningWatcher: "low", reasoningFallout: "max" },
			},
			outputs: {
				preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
				implementation: [{ nodeId: "implement", commits: ["fix"], summary: "fixed", testEvidence: "green" }],
				localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [] }],
				prRecord: [{ nodeId: "push-pr", prNumber: 80, url: "https://github.com/lindy-ai/lindy/pull/80", headSha: "abc123", baseBranch: "main", watchSetRegistered: true, watchSetPath: "", receipt: "", createdAt: "2026-08-01T00:00:00.000Z" }],
				reviewerRequest: [{ nodeId: "request-reviewers", skipped: false, requested: ["reviewer"], verified: ["reviewer"], source: "test", at: "2026-08-01T00:00:00.000Z", reviewerPrompt: "" }],
				watchPoll: [{ nodeId: "r0-watch-poll", round: 0, poll: 0, headSha: "abc123", exitOk: false, disposition: "fix", actionable: true, ci: "red", unresolvedThreads: 1, unansweredComments: 1, reviewersToReRequest: ["reviewer"], reasons: ["unresolved thread"] }],
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
		const agentsByNode = new Map(
			rendered.tasks
				.filter((task) => task.agent !== undefined)
				.map((task) => [task.nodeId, task.agent as { opts?: { model?: string; thinking?: string } }]),
		);
		expect(agentsByNode.get("implement")?.opts).toMatchObject({ model: "claude-fable-5", thinking: "high" });
		expect(agentsByNode.get("local-review")?.opts).toMatchObject({ model: "claude-fable-5", thinking: "xhigh" });
		expect(agentsByNode.get("r0-watch-fix")?.opts).toMatchObject({ model: "gpt-5.6-luna", thinking: "low" });
		expect(agentsByNode.get("fallout-watch")?.opts).toMatchObject({ model: "gpt-5.6-sol", thinking: "max" });
		expect(agentsByNode.size).toBeGreaterThanOrEqual(4);
		// Seat-level reasoning threading is a pipeline concern: prove each seat carries
		// --provider/--model/--thinking into the pi args. The wire mapping of reasoning_effort
		// to each provider's native field is broker's own concern, proven in
		// broker/test/validated-gateway.test.ts — do not import broker src here (CI has no broker deps).
		const expectedThinking: Record<string, string> = { implement: "high", "local-review": "xhigh", "r0-watch-fix": "low", "fallout-watch": "max" };
		for (const nodeId of ["implement", "local-review", "r0-watch-fix", "fallout-watch"]) {
			const agent = agentsByNode.get(nodeId) as { opts: { provider: string; model: string; thinking: string }; buildArgs: (input: { prompt: string; cwd: string; mode: string }) => string[] };
			const args = agent.buildArgs({ prompt: "broker-seat-probe", cwd: "/tmp/lindy-wt", mode: "text" });
			expect(agent.opts.provider).toBe("deck");
			expect(agent.opts.thinking).toBe(expectedThinking[nodeId]);
			expect(args).toEqual(expect.arrayContaining(["--provider", "deck", "--model", agent.opts.model, "--thinking", agent.opts.thinking]));
		}
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

	test("pipeline prompts name the valid subagent ids and stack fan-out pattern", () => {
		const review = localReviewPrompt(validBrief, "/tmp/wt", "main", 1);
		expect(review).toContain("worker, worker-gpt, reviewer, reviewer-claude, and scout");
		expect(review).toContain("land the schema/base PR first");
		expect(review).not.toContain("do not use subagents");
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
	test("uses the isolated fixture instead of the operator home", () => {
		expect(loadProfiles().map((profile) => profile.id)).toEqual(["deck", "lindy"]);
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
	test("REGRESSION: adopt push-pr output includes its run id and satisfies its schema", async () => {
		const runId = "adopt-schema-test";
		const rendered = await renderWorkflow(pipeline, {
			input: {
				...baseInput,
				existingPr: 777,
			},
			runId,
			outputs: {
				preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
				implementation: [{ nodeId: "implement", commits: [], summary: "adopted existing PR #777", testEvidence: "dry-run" }],
				localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [], summary: "approved" }],
			},
		});
		const pushTask = rendered.tasks.find((task) => task.nodeId === "push-pr");
		expect(pushTask).toBeDefined();
		const output = await pushTask!.computeFn!();
		expect(output).toMatchObject({ runId });
		const schema = pushTask!.outputSchema!;
		expect(schema.safeParse(output).success).toBe(true);
		const missingRequiredField = { ...(output as Record<string, unknown>) };
		delete missingRequiredField.createdAt;
		expect(schema.safeParse(missingRequiredField).success).toBe(false);
	});

	test("REGRESSION: omitted base adopts the existing stacked PR base before push-pr", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-adopt-base-"));
		const log = path.join(dir, "git.log");
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		const watchSetPath = path.join(dir, "watch-set.jsonl");
		fs.writeFileSync(git, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  ls-remote|status) ;;
  rev-parse) if [ "$2" = "--abbrev-ref" ]; then printf 'fm/lin-123\\n'; else printf 'abc123\\n'; fi ;;
  remote) printf 'git@github.com:lindy-ai/lindy.git\\n' ;;
esac
`);
		fs.writeFileSync(gh, `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ number: 777, html_url: "https://github.com/lindy-ai/lindy/pull/777", state: "open", draft: false, head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } }, base: { ref: "fm/stack-parent" } })}'
`);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		try {
			const rendered = await renderWorkflow(pipeline, {
				input: {
					...baseInput,
					dryRun: false,
					existingPr: 777,
					worktree: dir,
					watchSetPath,
					github: { git, gh },
				},
				outputs: {
					preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
					adoptBase: [{ nodeId: "adopt-base", baseBranch: "fm/stack-parent" }],
					implementation: [{ nodeId: "implement", commits: [], summary: "adopted existing PR #777", testEvidence: "CI on the PR" }],
					localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [], summary: "approved" }],
				},
				workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
			});
			const pushTask = rendered.tasks.find((task) => task.nodeId === "push-pr");
			const output = await pushTask!.computeFn!();
			expect(output).toMatchObject({ baseBranch: "fm/stack-parent" });
			expect(fs.readFileSync(log, "utf8")).toContain("ls-remote --exit-code --heads origin fm/stack-parent");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects an adopted PR retargeted to a different non-main base", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-adopt-retarget-"));
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		fs.writeFileSync(git, "#!/bin/sh\ncase \"$1\" in rev-parse) if [ \"$2\" = \"--abbrev-ref\" ]; then printf 'fm/lin-123\\n'; else printf 'abc123\\n'; fi ;; remote) printf 'git@github.com:lindy-ai/lindy.git\\n' ;; esac\n");
		fs.writeFileSync(gh, `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ number: 777, html_url: "https://github.com/lindy-ai/lindy/pull/777", state: "open", draft: false, head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } }, base: { ref: "release-branch" } })}'
`);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		try {
			const rendered = await renderWorkflow(pipeline, {
				input: { ...baseInput, baseBranch: "main", dryRun: false, existingPr: 777, worktree: dir, github: { git, gh } },
				outputs: {
					preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
					adoptBase: [{ nodeId: "adopt-base", baseBranch: "fm/stack-parent" }],
					implementation: [{ nodeId: "implement", commits: [], summary: "adopted existing PR #777", testEvidence: "CI on the PR" }],
					localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [], summary: "approved" }],
				},
				workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
			});
			const pushTask = rendered.tasks.find((task) => task.nodeId === "push-pr");
			await expect(pushTask!.computeFn!()).rejects.toThrow('declared baseBranch "fm/stack-parent"');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

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

describe("enqueue-merge regressions", () => {
	function mergeTaskOutputs(baseBranch: string, prNumber = 42) {
		return {
			preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
			implementation: [{ nodeId: "implement", commits: ["abc"], summary: "done", testEvidence: "green" }],
			localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [], summary: "approved" }],
			prRecord: [{ nodeId: "push-pr", prNumber, url: `https://github.com/lindy-ai/lindy/pull/${prNumber}`, headSha: "abc123", baseBranch, watchSetRegistered: true, watchSetPath: "", receipt: "", createdAt: "2026-08-01T00:00:00.000Z" }],
			approvals: [{ nodeId: "r0-stamp", approved: true, note: "ok", decidedBy: "test", decidedAt: "2026-08-01T00:00:00.000Z" }],
			stampValidity: [{ nodeId: "r0-stamp-validity", round: 0, stampedHead: "abc123", currentHead: "abc123", valid: true, checkedAt: "2026-08-01T00:00:00.000Z" }],
			mergeHeadCheck: [{ nodeId: "r0-merge-head-check", round: 0, expectedHead: "abc123", currentHead: "abc123", ok: true, checkedAt: "2026-08-01T00:00:00.000Z" }],
		};
	}

	async function renderMergeTask(baseBranch: string, log: string, landed = false) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-merge-task-"));
		const git = path.join(dir, "git");
		const gh = path.join(dir, "gh");
		fs.writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' \"$*\" >> ${JSON.stringify(log)}\ncase \"$1\" in log) ${landed ? "printf 'squash\\tfix: landed (#42)\\n'" : ":"};; rev-parse) printf 'fm/lin-123\\n';; esac\n`);
		fs.writeFileSync(gh, `#!/bin/sh
if [ "$1" = api ] && [ "$3" = --jq ]; then printf 'abc123\\n'
elif [ "$1" = api ]; then printf '%s\\n' '${JSON.stringify({ number: 42, html_url: "https://github.com/lindy-ai/lindy/pull/42", state: "open", draft: false, head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } }, base: { ref: baseBranch } })}'
else printf 'queued\\n'; fi
`);
		fs.chmodSync(git, 0o755);
		fs.chmodSync(gh, 0o755);
		const rendered = await renderWorkflow(pipeline, {
			input: { ...baseInput, worktree: dir, dryRun: false, github: { git, gh } },
			outputs: mergeTaskOutputs(baseBranch),
			workflowPath: path.join(import.meta.dir, "..", "pipeline.tsx"),
		});
		return { dir, task: rendered.tasks.find((task) => task.nodeId === "enqueue-merge")! };
	}

	test("accepts the native GitHub merge queue receipt", () => {
		const receipt = { round: 0, submittedAt: "2026-08-01T00:00:00.000Z", receipt: "queued", alreadyLanded: false, mergePath: "github-merge-queue" };
		expect(schemas.mergeReceipt.safeParse(receipt).success).toBe(true);
	});

	test("runs the bound native merge helper and emits its valid receipt", async () => {
		const log = path.join(os.tmpdir(), `deck-merge-${crypto.randomUUID()}.log`);
		const { dir, task } = await renderMergeTask("main", log);
		try {
			expect(fs.existsSync(path.join(dir, "git"))).toBe(true);
			const receipt = await task.computeFn!();
			expect(receipt).toMatchObject({ mergePath: "github-merge-queue", alreadyLanded: false });
			expect(task.outputSchema!.safeParse(receipt).success).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(log, { force: true });
		}
	});

	test("detects an already landed stack PR by its squash commit on its actual base", async () => {
		const log = path.join(os.tmpdir(), `deck-landing-${crypto.randomUUID()}.log`);
		const { dir, task } = await renderMergeTask("fm/stack-parent", log, true);
		try {
			expect(fs.existsSync(path.join(dir, "git"))).toBe(true);
			const receipt = await task.computeFn!();
			expect(receipt).toMatchObject({ mergePath: "already-landed", alreadyLanded: true });
			expect(fs.readFileSync(log, "utf8")).toContain("log origin/fm/stack-parent");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(log, { force: true });
		}
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
