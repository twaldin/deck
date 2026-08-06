import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

import {
	answer,
	openQuestions,
	readQuestions,
	workflowQuestions,
	workflowQuestionId,
} from "../../../v2/src/questions-store.ts";
import pipeline from "../pipeline.tsx";
import { parseDecisionClassBlocker } from "../lib/watch.ts";
import type { PipelineOutputFixtures } from "./output-fixtures.ts";

const validBrief = {
	ticket: "LIN-ASK",
	title: "Surface pipeline decisions",
	summary: "Every human wait must reach the captain's durable queue.",
	acceptanceCriteria: ["No approval wait is invisible", "No resolved wait remains open"],
	decisionLedger: [],
	killSwitch: { kind: "named" as const, name: "disable ask bridge" },
	breakSignal: "a parked node has no matching queue entry",
};

const baseInput = {
	ticket: "LIN-ASK",
	repo: "lindy-ai/lindy",
	worktree: "/tmp/lindy-ask-wt",
	branch: "fm/lin-ask",
	brief: validBrief,
	dryRun: false,
	wakeDryRun: true,
};

const originalQueueFile = process.env.DECK_QUESTIONS_FILE;
const originalDevWorkspaceOverride = process.env.DECK_DEV_WORKSPACE_OK;
beforeEach(() => {
	process.env.DECK_DEV_WORKSPACE_OK = "1";
});
const roots: string[] = [];
afterEach(() => {
	if (originalQueueFile === undefined) delete process.env.DECK_QUESTIONS_FILE;
	else process.env.DECK_QUESTIONS_FILE = originalQueueFile;
	if (originalDevWorkspaceOverride === undefined) delete process.env.DECK_DEV_WORKSPACE_OK;
	else process.env.DECK_DEV_WORKSPACE_OK = originalDevWorkspaceOverride;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function freshQueue(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pipeline-questions-"));
	roots.push(root);
	const file = path.join(root, "questions", "queue.jsonl");
	process.env.DECK_QUESTIONS_FILE = file;
	return file;
}

function approvalReadyOutputs(round = 0): PipelineOutputFixtures {
	return {
		preflight: [{ nodeId: "preflight", ok: true, openQuestions: [], briefDigest: "", resolvedReviewerModel: "deck/claude-fable-5" }],
		implementation: [{ nodeId: "implement", commits: ["abc"], summary: "implemented the brief", testEvidence: "green" }],
		localReview: [{ nodeId: "local-review", round: 0, approved: true, blockingFindings: [], nits: [], summary: "approved" }],
		prRecord: [{
			nodeId: "push-pr",
			prNumber: 42,
			url: "https://github.com/lindy-ai/lindy/pull/42",
			headSha: "abc123",
			baseBranch: "main",
			watchSetRegistered: true,
			watchSetPath: "",
			receipt: "",
			createdAt: "2026-08-01T00:00:00.000Z",
		}],
		reviewerRequest: [{
			nodeId: "request-reviewers",
			skipped: false,
			requested: ["reviewer"],
			verified: ["reviewer"],
			source: "test",
			at: "2026-08-01T00:00:00.000Z",
			reviewerPrompt: "",
		}],
		watchPoll: [{
			nodeId: `r${round}-watch-poll`,
			round,
			poll: 0,
			headSha: "abc123",
			exitOk: true,
			disposition: "complete",
			actionable: false,
			ci: "green",
			unresolvedThreads: 0,
			unansweredComments: 0,
			reviewersToReRequest: [],
			reasons: [],
			rebaseRequired: false,
		}],
		readyPoll: [{
			nodeId: `r${round}-ready-poll`,
			round,
			poll: 0,
			ready: true,
			regressed: false,
			approvedBy: "reviewer",
			ci: "green",
			headSha: "abc123",
			reasons: [],
			migrationDetected: false,
			migrationFiles: [],
			at: "2026-08-01T00:00:00.000Z",
		}],
	};
}

const workflowPath = path.join(import.meta.dir, "..", "pipeline.tsx");

async function render(runId: string, outputs: PipelineOutputFixtures) {
	return renderWorkflow(pipeline, {
		input: baseInput,
		runId,
		outputs,
		workflowPath,
	});
}

describe("pipeline question bridge", () => {
	test("appends stamp wait once and folds it closed when Smithers records approval", async () => {
		const file = freshQueue();
		const outputs = approvalReadyOutputs();
		const first = await render("run-stamp", outputs);
		expect(first.tasks.find((task) => task.nodeId === "r0-stamp")?.needsApproval).toBe(true);
		expect(openQuestions(file)).toMatchObject([{
			id: workflowQuestionId("run-stamp", "r0-stamp"),
			questionKind: "stamp",
			workflow: {
				runId: "run-stamp",
				nodeId: "r0-stamp",
				answerLane: "smithers-approval",
				prNumber: 42,
				approvalValue: { headSha: "abc123", prNumber: 42 },
			},
			prContext: { prNumber: 42, headSha: "abc123" },
		}]);

		await render("run-stamp", outputs);
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);

		await render("run-stamp", {
			...outputs,
			approvals: [{
				nodeId: "r0-stamp",
				approved: true,
				note: "ship it",
				decidedBy: "captain",
				decidedAt: "2026-08-01T00:01:00.000Z",
			}],
		});
		expect(openQuestions(file)).toEqual([]);
		expect(readQuestions(file)[0]).toMatchObject({ status: "answered", answer: "Approved by captain — ship it" });
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
	});

	test("invalidation then re-approval leaves no ghost from either stamp round", async () => {
		const file = freshQueue();
		const round0 = approvalReadyOutputs(0);
		await render("run-restamp", round0);

		const round1 = approvalReadyOutputs(1);
		round1.readyPoll![0]!.headSha = "def456";
		const afterInvalidation: PipelineOutputFixtures = {
			...round1,
			approvals: [{
				nodeId: "r0-stamp",
				approved: true,
				note: "first head",
				decidedBy: "captain",
				decidedAt: "2026-08-01T00:01:00.000Z",
			}],
			stampValidity: [{
				nodeId: "r0-stamp-validity",
				round: 0,
				stampedHead: "abc123",
				currentHead: "def456",
				valid: false,
				checkedAt: "2026-08-01T00:02:00.000Z",
			}],
		};
		await render("run-restamp", afterInvalidation);
		expect(workflowQuestions(file, "run-restamp")).toMatchObject([
			{ id: workflowQuestionId("run-restamp", "r0-stamp"), status: "answered" },
			{
				id: workflowQuestionId("run-restamp", "r1-stamp"),
				status: "open",
				workflow: { approvalValue: { headSha: "def456", prNumber: 42 } },
			},
		]);

		await render("run-restamp", {
			...afterInvalidation,
			approvals: [
				...afterInvalidation.approvals!,
				{
					nodeId: "r1-stamp",
					approved: true,
					note: "replacement head",
					decidedBy: "captain",
					decidedAt: "2026-08-01T00:03:00.000Z",
				},
			],
		});
		expect(openQuestions(file)).toEqual([]);
		expect(workflowQuestions(file, "run-restamp").map((question) => question.status)).toEqual([
			"answered",
			"answered",
		]);
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(4);
	});

	test("fallout holds surface and clear through the same Approval bridge", async () => {
		const file = freshQueue();
		const outputs = approvalReadyOutputs();
		outputs.approvals = [{
			nodeId: "r0-stamp",
			approved: true,
			note: "already stamped",
			decidedBy: "captain",
			decidedAt: "2026-08-01T00:01:00.000Z",
		}];
		outputs.fallout = [{
			nodeId: "fallout-watch",
			verdict: "parked",
			breakSignal: "deploy probe unavailable",
			probeResults: ["PARK: no probe configured"],
			notes: "Choose whether to hold or close the run.",
		}];
		await render("run-fallout", outputs);
		expect(openQuestions(file)).toMatchObject([{
			id: workflowQuestionId("run-fallout", "fallout-escalation"),
			workflow: {
				nodeId: "fallout-escalation",
				answerLane: "smithers-approval",
				prNumber: 42,
			},
		}]);

		outputs.approvals.push({
			nodeId: "fallout-escalation",
			approved: true,
			note: "record the parked probe",
			decidedBy: "captain",
			decidedAt: "2026-08-01T00:02:00.000Z",
		});
		await render("run-fallout", outputs);
		expect(openQuestions(file)).toEqual([]);
		expect(workflowQuestions(file, "run-fallout", "fallout-escalation")[0]?.status).toBe("answered");
	});

	test("watch decision blockers are keyed by thread and hydrate the next fixer", async () => {
		const file = freshQueue();
		const outputs = approvalReadyOutputs();
		outputs.readyPoll = [];
		outputs.watchPoll = [{
			nodeId: "r0-watch-poll",
			round: 0,
			poll: 0,
			headSha: "abc123",
			exitOk: false,
			disposition: "fix",
			actionable: true,
			ci: "green",
			unresolvedThreads: 1,
			unansweredComments: 0,
			reviewersToReRequest: [],
			reasons: ["one unresolved review thread"],
			rebaseRequired: false,
		}];
		outputs.watchFix = [{
			nodeId: "r0-watch-fix",
			round: 0,
			afterPoll: 0,
			actions: [
				"DECISION-CLASS BLOCKER: thread=https://github.com/lindy-ai/lindy/pull/42#discussion_r9 | decision=Should the API preserve the old default?",
			],
			commits: [],
			pushed: false,
			reRequested: [],
			summary: "captain decision required",
		}];
		await render("run-watch", outputs);
		await render("run-watch", outputs);
		const [question] = openQuestions(file);
		expect(question).toMatchObject({
			workflow: {
				runId: "run-watch",
				nodeId: "r0-watch-fix",
				decisionKey: "https://github.com/lindy-ai/lindy/pull/42#discussion_r9",
				answerLane: "store",
			},
		});
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
		answer(file, question!.id, "Preserve the old default for existing callers.");

		outputs.watchPoll = [{ ...outputs.watchPoll[0]!, poll: 1 }];
		outputs.watchBaseline = [{
			nodeId: "r0-watch-baseline",
			round: 0,
			afterPoll: 1,
			headSha: "abc123",
			valid: true,
			reason: "test baseline",
		}];
		const hydrated = await render("run-watch", outputs);
		const fixer = hydrated.tasks.find((task) => task.nodeId === "r0-watch-fix");
		expect(fixer?.prompt).toContain('"captainDecisionAnswers"');
		expect(fixer?.prompt).toContain("Preserve the old default for existing callers.");
	});

	test("watch questions are dismissed when the fixer no longer reports the blocker", async () => {
		const file = freshQueue();
		const outputs = approvalReadyOutputs();
		outputs.readyPoll = [];
		outputs.watchPoll = [{
			nodeId: "r0-watch-poll",
			round: 0,
			poll: 0,
			headSha: "abc123",
			exitOk: false,
			disposition: "fix",
			actionable: true,
			ci: "green",
			unresolvedThreads: 1,
			unansweredComments: 0,
			reviewersToReRequest: [],
			reasons: ["one unresolved review thread"],
			rebaseRequired: false,
		}];
		outputs.watchFix = [{
			nodeId: "r0-watch-fix",
			round: 0,
			afterPoll: 0,
			actions: ["DECISION-CLASS BLOCKER: thread=thread-1 | decision=Choose compatibility behavior"],
			commits: [],
			pushed: false,
			reRequested: [],
			summary: "captain decision required",
		}];
		await render("run-watch-cleared", outputs);
		expect(openQuestions(file)).toHaveLength(1);

		outputs.watchPoll = [{ ...outputs.watchPoll[0]!, poll: 1 }];
		outputs.watchFix = [{
			...outputs.watchFix[0]!,
			afterPoll: 1,
			actions: ["review thread resolved without a product decision"],
			summary: "blocker no longer present",
		}];
		await render("run-watch-cleared", outputs);
		expect(openQuestions(file)).toEqual([]);
		expect(workflowQuestions(file, "run-watch-cleared", "r0-watch-fix")[0]).toMatchObject({
			status: "dismissed",
			answer: "The watch fixer no longer reports this decision-class blocker.",
		});
	});

	test("parses only the exact decision-class blocker contract", () => {
		expect(parseDecisionClassBlocker(
			"DECISION-CLASS BLOCKER: thread=thread-1 | decision=Choose A or B",
		)).toEqual({ threadRef: "thread-1", decision: "Choose A or B" });
		expect(parseDecisionClassBlocker("DECISION-CLASS BLOCKER: choose A or B")).toBeNull();
	});
});
