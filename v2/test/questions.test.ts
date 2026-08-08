import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	answer,
	ask,
	compact,
	formatAge,
	markDelivered,
	MAX_EVENT_BYTES,
	openQuestions,
	pendingAnswersFor,
	queueFile,
	readQuestionHistory,
	readQuestions,
	retiredRunReason,
	retireRunQuestions,
	retireRunQuestionsSafely,
	setLateAskTestHook,
	STALE_AFTER_MS,
	type Question,
} from "../src/questions-store";
import {
	askWorkflowQuestion,
	resolveWorkflowQuestion,
	workflowQuestionId,
	workflowQuestions,
} from "../src";
import {
	routeWorkflowQuestionAnswer,
	workflowRunIsTerminal,
} from "../src/workflow-questions";
import { answerMessage, describe as describeQuestion, fullDetail, registerQuestions } from "../src/questions";

const dirs: string[] = [];
function freshFile(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "deck-questions-"));
	dirs.push(dir);
	return path.join(dir, "queue.jsonl");
}
function envFor(file: string): Record<string, string> {
	return { DECK_QUESTIONS_FILE: file };
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("questions store", () => {
	test("queue -> list -> answer -> asker reads answer", () => {
		const file = freshFile();
		const asked = ask(file, {
			question: "Ship the migration behind a flag or unguarded?",
			options: ["flag", "unguarded"],
			recommendation: "flag",
			urgency: "high",
			sessionId: "session-a",
			cwd: "/work/deck",
		});

		expect(openQuestions(file).map((entry) => entry.id)).toEqual([asked.id]);
		expect(pendingAnswersFor(file, "session-a")).toEqual([]);

		answer(file, asked.id, "flag");

		expect(openQuestions(file)).toEqual([]);
		const pending = pendingAnswersFor(file, "session-a");
		expect(pending.map((entry) => entry.answer)).toEqual(["flag"]);
		expect(answerMessage(pending[0]!)).toContain("A: flag");

		markDelivered(file, asked.id);
		expect(pendingAnswersFor(file, "session-a")).toEqual([]);
	});

	test("questions are visible from any session and survive a fresh read", () => {
		const file = freshFile();
		ask(file, { question: "Q1", sessionId: "session-a", cwd: "/a" });
		ask(file, { question: "Q2", sessionId: "session-b", cwd: "/b" });
		// A third session (the captain's) sees both without having asked either.
		expect(openQuestions(file).map((entry) => entry.question)).toEqual(["Q1", "Q2"]);
		// And each asker only ever collects its own answers.
		answer(file, readQuestions(file)[1]!.id, "do Q2");
		expect(pendingAnswersFor(file, "session-a")).toEqual([]);
		expect(pendingAnswersFor(file, "session-b").map((e) => e.answer)).toEqual(["do Q2"]);
	});

	test("open questions sort by urgency then age", () => {
		const file = freshFile();
		ask(file, { question: "old normal", sessionId: "s", cwd: "/", now: 1000 });
		ask(file, { question: "low", sessionId: "s", cwd: "/", urgency: "low", now: 500 });
		ask(file, { question: "urgent", sessionId: "s", cwd: "/", urgency: "high", now: 9000 });
		ask(file, { question: "new normal", sessionId: "s", cwd: "/", now: 2000 });
		expect(openQuestions(file).map((entry) => entry.question)).toEqual([
			"urgent",
			"old normal",
			"new normal",
			"low",
		]);
	});

	test("dismissal is delivered as a resolution, not left open", () => {
		const file = freshFile();
		const asked = ask(file, { question: "Q", sessionId: "s", cwd: "/" });
		answer(file, asked.id, "(dismissed)", "dismissed");
		expect(openQuestions(file)).toEqual([]);
		const pending = pendingAnswersFor(file, "s");
		expect(pending[0]?.status).toBe("dismissed");
		expect(answerMessage(pending[0]!)).toContain("dismissed");
	});

	test("re-asking a stable id refreshes the prompt but keeps an existing answer", () => {
		const file = freshFile();
		const first = ask(file, { id: "fixed", question: "first phrasing", sessionId: "s", cwd: "/" });
		answer(file, first.id, "yes");
		ask(file, { id: "fixed", question: "second phrasing", sessionId: "s", cwd: "/" });
		const [entry] = readQuestions(file);
		expect(entry?.question).toBe("second phrasing");
		expect(entry?.status).toBe("answered");
		expect(openQuestions(file)).toEqual([]);
	});

	test("the same stable id from two sessions does not collide", () => {
		// The log is shared by the whole conversation home, so a bare id
		// from two sessions must stay two questions: otherwise the second ask
		// overwrites the first's asker and its answer goes to the wrong agent.
		const file = freshFile();
		const a = ask(file, { id: "shared", question: "A asks", sessionId: "session-a", cwd: "/a" });
		const b = ask(file, { id: "shared", question: "B asks", sessionId: "session-b", cwd: "/b" });
		expect(a.id).not.toBe(b.id);
		expect(openQuestions(file)).toHaveLength(2);

		answer(file, a.id, "for A only");
		expect(pendingAnswersFor(file, "session-a").map((e) => e.answer)).toEqual(["for A only"]);
		expect(pendingAnswersFor(file, "session-b")).toEqual([]);
		expect(openQuestions(file).map((e) => e.question)).toEqual(["B asks"]);
	});

	test("only the winning answer is reported as applied, even when both saw it open", () => {
		// Both captains observe `open` before either writes, so a pre-append read
		// would tell both of them they won. The refold check must not.
		const file = freshFile();
		const asked = ask(file, { question: "Q", sessionId: "s", cwd: "/" });
		const captainA = openQuestions(file)[0];
		const captainB = openQuestions(file)[0];
		expect(captainA?.status).toBe("open");
		expect(captainB?.status).toBe("open");

		expect(answer(file, asked.id, "from A")).toBe(true);
		expect(answer(file, asked.id, "from B")).toBe(false);
		expect(readQuestions(file)[0]?.answer).toBe("from A");
	});

	test("a long free-text answer is bounded by BYTES, including multibyte text", () => {
		const file = freshFile();
		const asked = ask(file, { question: "Q", sessionId: "s", cwd: "/" });
		// Each of these is 4 UTF-8 bytes but 2 UTF-16 code units, so slice() would
		// have let roughly twice MAX_EVENT_BYTES through.
		answer(file, asked.id, "\u{1f680}".repeat(MAX_EVENT_BYTES));
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		for (const line of lines) {
			expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_EVENT_BYTES);
		}
		// Truncation never splits a character.
		expect(readQuestions(file)[0]?.answer).toMatch(/^\u{1f680}+$/u);
	});

	test("a corrupt line does not hide the rest of the queue", () => {
		const file = freshFile();
		ask(file, { question: "good", sessionId: "s", cwd: "/" });
		writeFileSync(file, "{not json\n", { flag: "a" });
		ask(file, { question: "also good", sessionId: "s", cwd: "/" });
		expect(openQuestions(file).map((entry) => entry.question)).toEqual(["good", "also good"]);
	});

	test("unknown urgency degrades to normal instead of dropping the question", () => {
		const file = freshFile();
		ask(file, { question: "Q", sessionId: "s", cwd: "/", urgency: "CRITICAL!!" });
		expect(openQuestions(file)[0]?.urgency).toBe("normal");
	});

	test("empty questions are rejected at the boundary", () => {
		const file = freshFile();
		expect(() => ask(file, { question: "   ", sessionId: "s", cwd: "/" })).toThrow();
		expect(readQuestions(file)).toEqual([]);
	});

	test("resolution is terminal: a stale second captain cannot overwrite a delivered answer", () => {
		// Two captains hold the same /questions dialog. A answers, the asker is
		// told, then B's stale pick lands. The durable record must keep saying what
		// the agent was actually told.
		const file = freshFile();
		const asked = ask(file, { question: "Flag?", sessionId: "s", cwd: "/" });
		expect(answer(file, asked.id, "flag")).toBe(true);
		markDelivered(file, asked.id);

		expect(answer(file, asked.id, "unguarded")).toBe(false);
		const [entry] = readQuestions(file);
		expect(entry?.answer).toBe("flag");
		expect(entry?.delivered).toBe(true);
		// And the stale answer does not resurrect the question as pending.
		expect(pendingAnswersFor(file, "s")).toEqual([]);
		expect(openQuestions(file)).toEqual([]);
	});

	test("a dismissal cannot be overturned by a later answer either", () => {
		const file = freshFile();
		const asked = ask(file, { question: "Q", sessionId: "s", cwd: "/" });
		answer(file, asked.id, "(dismissed)", "dismissed");
		expect(answer(file, asked.id, "actually do it")).toBe(false);
		expect(readQuestions(file)[0]?.status).toBe("dismissed");
	});

	test("an oversized question is rejected instead of degrading every reader", () => {
		const file = freshFile();
		expect(() =>
			ask(file, {
				question: "x".repeat(MAX_EVENT_BYTES + 1),
				sessionId: "s",
				cwd: "/",
			}),
		).toThrow(/too large/);
		// Nothing was appended, so the queue stays readable.
		expect(readQuestions(file)).toEqual([]);
	});

	test("answering an unknown id is inert", () => {
		const file = freshFile();
		answer(file, "never-asked", "hi");
		expect(readQuestions(file)).toEqual([]);
	});

	test("missing queue file reads as empty", () => {
		expect(readQuestions(path.join(tmpdir(), "deck-questions-absent", "queue.jsonl"))).toEqual([]);
	});

	test("queueFile honours the test override and lives under the deck home", () => {
		expect(queueFile({ DECK_QUESTIONS_FILE: "/tmp/q.jsonl" })).toBe("/tmp/q.jsonl");
		const prev = process.env.DECK_V2_HOME;
		process.env.DECK_V2_HOME = "/home/x/.deck";
		try {
			expect(queueFile({})).toBe("/home/x/.deck/questions/queue.jsonl");
		} finally {
			if (prev === undefined) delete process.env.DECK_V2_HOME;
			else process.env.DECK_V2_HOME = prev;
		}
	});

	test("formatAge stays readable across scales", () => {
		expect(formatAge(5_000)).toBe("5s");
		expect(formatAge(180_000)).toBe("3m");
		expect(formatAge(3_600_000)).toBe("1h");
		expect(formatAge(90 * 60_000)).toBe("1h30m");
		expect(formatAge(50 * 3_600_000)).toBe("2d2h");
	});
	test("workflow writer is keyed, decision-shaped, and terminal across retries", () => {
		const file = freshFile();
		const input = {
			runId: "run-42",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval" as const,
			resumeHint: "Gateway approval releases the parked node.",
			originalIssue: "PR #42 is green and waiting for its commit-bound stamp.",
			proposedAction: "Stamp head abc123 and submit this PR to the merge queue.",
			blastRadius: "Only PR #42 at abc123; any new head invalidates the stamp.",
			prNumber: 42,
			approvalValue: { headSha: "abc123", prNumber: 42 },
			cwd: "/workflow",
		};
		const first = askWorkflowQuestion(file, input);
		const retry = askWorkflowQuestion(file, input);
		expect(first.id).toBe(workflowQuestionId("run-42", "r0-stamp"));
		expect(retry.id).toBe(first.id);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
		expect(openQuestions(file)[0]).toMatchObject({
			origin: "workflow",
			workflow: {
				runId: "run-42",
				nodeId: "r0-stamp",
				answerLane: "smithers-approval",
				prNumber: 42,
				originalIssue: input.originalIssue,
				proposedAction: input.proposedAction,
				blastRadius: input.blastRadius,
			},
		});

		expect(resolveWorkflowQuestion(file, {
			runId: "run-42",
			nodeId: "r0-stamp",
			answer: "Approved by Gateway",
		})).toBe(true);
		askWorkflowQuestion(file, input);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
		expect(openQuestions(file)).toEqual([]);
		expect(workflowQuestions(file, "run-42", "r0-stamp")[0]?.status).toBe("answered");
		expect(compact(file, STALE_AFTER_MS * 100)).toEqual({ kept: 1, archived: 0 });
		askWorkflowQuestion(file, input);
		expect(openQuestions(file)).toEqual([]);
		expect(workflowQuestions(file, "run-42", "r0-stamp")[0]?.status).toBe("answered");
	});
	test("LATE-ASK RACE: an ask for a retired run is immediately dismissed with the retirement reason", () => {
		const file = freshFile();
		const base = {
			answerLane: "store" as const,
			resumeHint: "hint",
			originalIssue: "issue",
			proposedAction: "action",
			blastRadius: "radius",
			cwd: "/workflow",
		};
		retireRunQuestions(file, "run-x", "run run-x reached terminal state cancelled");
		expect(retiredRunReason(file, "run-x")).toBe("run run-x reached terminal state cancelled");

		askWorkflowQuestion(file, { ...base, runId: "run-x", nodeId: "late" });

		const entry = workflowQuestions(file, "run-x", "late")[0];
		expect(entry).toBeDefined();
		expect(entry?.status).toBe("dismissed");
		expect(entry?.answer).toBe("run run-x reached terminal state cancelled");
		expect(openQuestions(file)).toEqual([]);

		// A live run's asks are untouched by another run's tombstone.
		askWorkflowQuestion(file, { ...base, runId: "run-live", nodeId: "n1" });
		expect(openQuestions(file)).toHaveLength(1);
	});
	test("REGRESSION: compaction preserves retire-run tombstones (late-ask race stays closed)", () => {
		const file = freshFile();
		const base = {
			answerLane: "store" as const,
			resumeHint: "hint",
			originalIssue: "issue",
			proposedAction: "action",
			blastRadius: "radius",
			cwd: "/workflow",
		};
		retireRunQuestions(file, "run-gone", "run run-gone reached terminal state cancelled");
		// A stale non-workflow question forces a real rewrite in compact().
		ask(file, { id: "q-stale", question: "old", sessionId: "s", cwd: "/", now: 1 });
		expect(compact(file, STALE_AFTER_MS * 100).archived).toBe(1);
		expect(retiredRunReason(file, "run-gone")).toBe(
			"run run-gone reached terminal state cancelled",
		);
		// The preserved tombstone still dismisses a late ask.
		askWorkflowQuestion(file, { ...base, runId: "run-gone", nodeId: "late2" });
		expect(workflowQuestions(file, "run-gone", "late2")[0]?.status).toBe("dismissed");
	});
	test("LATE-ASK TOCTOU: a sweep that retires the run DURING the ask still dismisses it", () => {
		const file = freshFile();
		const base = {
			answerLane: "store" as const,
			resumeHint: "hint",
			originalIssue: "issue",
			proposedAction: "action",
			blastRadius: "radius",
			cwd: "/workflow",
		};
		setLateAskTestHook(() => {
			// The concurrent sweep lands between the ask append and the re-check.
			retireRunQuestions(file, "run-race", "run run-race reached terminal state cancelled");
		});
		try {
			askWorkflowQuestion(file, { ...base, runId: "run-race", nodeId: "n1" });
		} finally {
			setLateAskTestHook(undefined);
		}
		expect(workflowQuestions(file, "run-race", "n1")[0]?.status).toBe("dismissed");
		expect(openQuestions(file)).toEqual([]);
	});
	test("retireRunQuestionsSafely: a missing queue is silent; other failures warn and never throw", () => {
		const fine = freshFile();
		const silentWarnings: string[] = [];
		expect(retireRunQuestionsSafely(fine, "run-1", "reason", (message) => silentWarnings.push(message)).length).toBe(0);

		// An unwritable queue path (a directory where the file should be) is a
		// real failure: the warning fires and nothing throws into the caller.
		const asDir = path.join(path.dirname(freshFile()), "queue-as-dir");
		mkdirSync(asDir, { recursive: true });
		const warnings: string[] = [];
		expect(retireRunQuestionsSafely(asDir, "run-1", "reason", (message) => warnings.push(message))).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("could not retire questions for terminal run run-1");
		expect(silentWarnings).toEqual([]);
	});
	test("retireRunQuestions dismisses only the terminal run's open questions", () => {
		const file = freshFile();
		const base = {
			answerLane: "store" as const,
			resumeHint: "hint",
			originalIssue: "issue",
			proposedAction: "action",
			blastRadius: "radius",
			cwd: "/workflow",
		};
		askWorkflowQuestion(file, { ...base, runId: "run-dead", nodeId: "n1" });
		askWorkflowQuestion(file, { ...base, runId: "run-dead", nodeId: "n2" });
		askWorkflowQuestion(file, { ...base, runId: "run-alive", nodeId: "n1" });

		const retired = retireRunQuestions(file, "run-dead", "run cancelled");
		expect(retired.sort()).toEqual([
			workflowQuestionId("run-dead", "n1"),
			workflowQuestionId("run-dead", "n2"),
		].sort());
		expect(openQuestions(file)).toHaveLength(1);
		expect(openQuestions(file)[0]?.workflow?.runId).toBe("run-alive");
		expect(workflowQuestions(file, "run-dead", "n1")[0]?.status).toBe("dismissed");
		// Idempotent: nothing left to retire.
		expect(retireRunQuestions(file, "run-dead", "again")).toEqual([]);
	});
	test("workflow identity cannot alias delimiter-bearing run, node, or decision keys", () => {
		expect(workflowQuestionId("run:a", "b", "c")).not.toBe(
			workflowQuestionId("run", "a:b", "c"),
		);
		expect(workflowQuestionId("run:a", "b", "c")).not.toBe(
			workflowQuestionId("run:a", "b:c"),
		);
		expect(() => workflowQuestionId("run\nother", "node")).toThrow(
			"workflow runId must be one line",
		);
		expect(() => workflowQuestionId("run", "x".repeat(201))).toThrow(
			"workflow nodeId exceeds 200 UTF-8 bytes",
		);
	});


	test("workflow waits do not age into unresolvable archive ghosts", () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-old",
			nodeId: "fallout-escalation",
			answerLane: "smithers-approval",
			resumeHint: "Answer the approval.",
			originalIssue: "The fallout probe is parked.",
			proposedAction: "Choose whether the run may close.",
			blastRadius: "Only the recorded fallout verdict.",
			cwd: "/workflow",
			now: 1,
		});
		expect(compact(file, STALE_AFTER_MS * 2)).toEqual({ kept: 1, archived: 0 });
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("workflow answer router submits approval metadata before closing the queue", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-gateway",
			nodeId: "r1-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Gateway releases the stamp node.",
			originalIssue: "The replacement head needs a fresh stamp.",
			proposedAction: "Approve the replacement head.",
			blastRadius: "Only PR #9 at the replacement head.",
			prNumber: 9,
			approvalValue: { headSha: "def456", prNumber: 9 },
			cwd: "/workflow",
		});
		const question = openQuestions(file)[0]!;
		let requestBody: unknown;
		const result = await routeWorkflowQuestionAnswer(file, question, "Stamp", {
			env: {
				SMITHERS_GATEWAY_TOKEN: "smithers-test",
				SMITHERS_GATEWAY_URL: "http://gateway.test/",
			},
			fetch: async (url, init) => {
				expect(String(url)).toBe("http://gateway.test/v1/rpc/submitApproval");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer smithers-test");
				requestBody = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						runId: "run-gateway",
						nodeId: "r1-stamp",
						iteration: 0,
						approved: true,
					},
				}), { status: 200 });
			},
		});
		expect(result).toEqual({ lane: "smithers-approval", choice: "approve", applied: true });
		expect(requestBody).toMatchObject({
			runId: "run-gateway",
			nodeId: "r1-stamp",
			iteration: 0,
			approved: true,
			decision: {
				approved: true,
				value: { headSha: "def456", prNumber: 9 },
			},
		});
		expect(readQuestions(file)[0]).toMatchObject({ status: "answered", answer: "Stamp" });
	});

	test("workflow approval preserves an explicit null decision value", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-null-value",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Gateway releases the stamp.",
			originalIssue: "The workflow contract uses JSON null.",
			proposedAction: "Approve the exact null value.",
			blastRadius: "Only this approval.",
			approvalValue: null,
			cwd: "/workflow",
		});
		let submitted: unknown;
		await routeWorkflowQuestionAnswer(file, openQuestions(file)[0]!, "Stamp", {
			env: { SMITHERS_GATEWAY_TOKEN: "smithers-test" },
			fetch: async (_input, init) => {
				submitted = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						runId: "run-null-value",
						nodeId: "r0-stamp",
						iteration: 0,
						approved: true,
					},
				}), { status: 200 });
			},
		});
		expect(submitted).toMatchObject({ decision: { value: null } });
	});
	test("continued Smithers runs are terminal for workflow cleanup", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-continued",
			nodeId: "r0-watch-fix",
			answerLane: "store",
			resumeHint: "No resume remains.",
			originalIssue: "The run continued as a replacement execution.",
			proposedAction: "Clear the superseded wait.",
			blastRadius: "Only the superseded run.",
			cwd: "/workflow",
		});
		expect(await workflowRunIsTerminal(openQuestions(file)[0]!, {
			env: { SMITHERS_GATEWAY_TOKEN: "status-test" },
			fetch: async () => new Response(JSON.stringify({
				ok: true,
				payload: { runId: "run-continued", status: "continued" },
			}), { status: 200 }),
		})).toBe(true);
	});


	test("Gateway failure leaves the workflow approval visibly open", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-gateway-down",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Retry after Gateway recovery.",
			originalIssue: "The PR needs a stamp.",
			proposedAction: "Submit the stamp.",
			blastRadius: "Only the recorded PR head.",
			cwd: "/workflow",
		});
		await expect(routeWorkflowQuestionAnswer(
			file,
			openQuestions(file)[0]!,
			"Stamp",
			{
				env: { SMITHERS_GATEWAY_TOKEN: "smithers-test" },
				fetch: async () => new Response("unavailable", { status: 503 }),
			},
		)).rejects.toThrow("Smithers approval failed (503)");
		expect(openQuestions(file)).toHaveLength(1);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("malformed Gateway success leaves the workflow approval visibly open", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-bad-receipt",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Retry after Gateway recovery.",
			originalIssue: "The PR needs a stamp.",
			proposedAction: "Submit the stamp.",
			blastRadius: "Only the recorded PR head.",
			cwd: "/workflow",
		});
		await expect(routeWorkflowQuestionAnswer(file, openQuestions(file)[0]!, "Stamp", {
			env: { SMITHERS_GATEWAY_TOKEN: "smithers-test" },
			fetch: async () => new Response("{}", { status: 200 }),
		})).rejects.toThrow("mismatched success receipt");
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("matching AlreadyDecided reconciles a lost receipt without accepting a conflict", async () => {
		const askStamp = (file: string, runId: string): Question => {
			askWorkflowQuestion(file, {
				runId,
				nodeId: "r0-stamp",
				answerLane: "smithers-approval",
				resumeHint: "Reconcile the prior Gateway decision.",
				originalIssue: "The approval response was lost.",
				proposedAction: "Confirm the durable approval.",
				blastRadius: "Only the same approval node and iteration.",
				cwd: "/workflow",
			});
			return openQuestions(file)[0]!;
		};
		const response = (runId: string, status: "approved" | "denied"): Response =>
			new Response(JSON.stringify({
				ok: false,
				error: {
					code: "AlreadyDecided",
					runId,
					nodeId: "r0-stamp",
					iteration: 0,
					status,
				},
			}), { status: 409 });

		const recovered = freshFile();
		const result = await routeWorkflowQuestionAnswer(
			recovered,
			askStamp(recovered, "run-recover"),
			"Stamp",
			{
				env: { SMITHERS_GATEWAY_TOKEN: "smithers-test" },
				fetch: async () => response("run-recover", "approved"),
			},
		);
		expect(result).toEqual({ lane: "smithers-approval", choice: "approve", applied: true });
		expect(openQuestions(recovered)).toEqual([]);

		const conflict = freshFile();
		await expect(routeWorkflowQuestionAnswer(
			conflict,
			askStamp(conflict, "run-conflict"),
			"Stamp",
			{
				env: { SMITHERS_GATEWAY_TOKEN: "smithers-test" },
				fetch: async () => response("run-conflict", "denied"),
			},
		)).rejects.toThrow("conflicts with the decision already recorded");
		expect(openQuestions(conflict)).toHaveLength(1);
	});

	test("plain workflow answers stay in the store for next-run hydration", async () => {
		const file = freshFile();
		askWorkflowQuestion(file, {
			runId: "run-watch",
			nodeId: "r0-watch-fix",
			decisionKey: "thread=https://example.test/thread/1",
			answerLane: "store",
			resumeHint: "The next watch-fix seat hydrates this answer.",
			originalIssue: "Review intent is ambiguous.",
			proposedAction: "Captain chooses the intended behavior.",
			blastRadius: "Only this review thread; no push occurs before hydration.",
			cwd: "/workflow",
		});
		const question = openQuestions(file)[0]!;
		const result = await routeWorkflowQuestionAnswer(file, question, "Keep backward compatibility.");
		expect(result).toEqual({ lane: "store", applied: true });
		expect(workflowQuestions(file, "run-watch", "r0-watch-fix")[0]).toMatchObject({
			status: "answered",
			answer: "Keep backward compatibility.",
		});
	});

});

describe("compact", () => {
	test("purges delivered answers and stale or junk asks, keeps open live ones", () => {
		const file = freshFile();
		const now = STALE_AFTER_MS * 2;

		const fresh = ask(file, { question: "fresh open", sessionId: "s", cwd: "/", now });
		ask(file, { question: "stale open", sessionId: "s", cwd: "/", now: now - STALE_AFTER_MS - 1 });
		const delivered = ask(file, { question: "answered+delivered", sessionId: "s", cwd: "/", now });
		answer(file, delivered.id, "yes", "answered", now);
		markDelivered(file, delivered.id, now);
		const undelivered = ask(file, { question: "answered, not delivered", sessionId: "s", cwd: "/", now });
		answer(file, undelivered.id, "go", "answered", now);
		// firstmate-era junk: no usable askedAt, so it can never age out.
		writeFileSync(
			file,
			`${JSON.stringify({ kind: "ask", id: "junk", question: "ghost", urgency: "normal", sessionId: "s", cwd: "/" })}\n`,
			{ flag: "a" },
		);

		const result = compact(file, now);
		expect(result).toEqual({ kept: 2, archived: 3 });

		const kept = readQuestions(file);
		expect(kept.map((e) => e.question).sort()).toEqual(["answered, not delivered", "fresh open"]);
		// The undelivered answer survives the rewrite intact, so delivery still happens.
		expect(pendingAnswersFor(file, "s").map((e) => e.answer)).toEqual(["go"]);
		expect(openQuestions(file).map((e) => e.id)).toEqual([fresh.id]);

		// Dropped entries are archived beside the queue, not lost.
		const archive = readFileSync(path.join(path.dirname(file), "archive.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(archive.map((e: any) => e.question).sort()).toEqual([
			"answered+delivered",
			"ghost",
			"stale open",
		]);
	});

	test("REGRESSION: an old answered-but-undelivered question survives compaction and still delivers", async () => {
		// Even exclusive maintenance must preserve an answered question until it
		// has been delivered to the asking session.
		const file = freshFile();
		const asked = ask(file, { question: "old but answered", sessionId: "s", cwd: "/", now: 0 });
		answer(file, asked.id, "the word", "answered", 1000);

		expect(compact(file, STALE_AFTER_MS * 10)).toEqual({ kept: 1, archived: 0 });
		expect(pendingAnswersFor(file, "s").map((e) => e.answer)).toEqual(["the word"]);

		const agent = new Harness();
		agent.currentTime = STALE_AFTER_MS * 10;
		registerQuestions(agent as any, envFor(file), agent.runtime);
		await agent.emit("session_start", fakeContext("s"));
		expect(agent.sent.map((m) => m.content.includes("A: the word"))).toEqual([true]);
	});

	test("the queue dir and files are private to the operator", () => {
		const file = freshFile();
		ask(file, { question: "Q", sessionId: "s", cwd: "/", now: 1000 });
		answer(file, readQuestions(file)[0]!.id, "a", "answered", 1000);
		markDelivered(file, readQuestions(file)[0]!.id, 1000);
		compact(file, STALE_AFTER_MS * 2);
		const mode = (target: string) => statSync(target).mode & 0o777;
		expect(mode(file)).toBe(0o600);
		expect(mode(path.join(path.dirname(file), "archive.jsonl"))).toBe(0o600);
	});

	test("a clean queue is left untouched", () => {
		const file = freshFile();
		ask(file, { question: "Q", sessionId: "s", cwd: "/", now: 1000 });
		expect(compact(file, 2000)).toEqual({ kept: 1, archived: 0 });
		expect(openQuestions(file)).toHaveLength(1);
	});
});


// --- extension wiring -------------------------------------------------------

type Handler = (event: any, ctx: any) => Promise<void> | void;

class Harness {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	hooks = new Map<string, Handler[]>();
	sent: Array<{ content: string; triggerTurn?: boolean }> = [];
	intervals: Array<() => void> = [];
	currentTime = 0;

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}
	registerCommand(name: string, options: any): void {
		this.commands.set(name, options);
	}
	on(event: string, handler: Handler): void {
		this.hooks.set(event, [...(this.hooks.get(event) ?? []), handler]);
	}
	sendMessageThrows = false;
	sendMessage(message: any, options?: any): void {
		if (this.sendMessageThrows) throw new Error("send failed");
		this.sent.push({ content: message.content, triggerTurn: options?.triggerTurn });
	}

	runtime = {
		now: () => this.currentTime,
		setInterval: (callback: () => void) => {
			this.intervals.push(callback);
			return this.intervals.length as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval: (handle: ReturnType<typeof setInterval>) => {
			this.intervals.splice((handle as unknown as number) - 1, 1);
		},
	};

	async emit(event: string, ctx: any): Promise<void> {
		for (const handler of this.hooks.get(event) ?? []) await handler({ type: event }, ctx);
	}
}

function fakeContext(sessionId: string, selections: string[] = [], written?: string, customInput?: string | string[]) {
	const notices: string[] = [];
	const prompts: string[] = [];
	const customRenders: { count: number } = { count: 0 };
	return {
		hasUI: true,
		cwd: "/work/deck",
		notices,
		prompts,
		sessionManager: { getSessionId: () => sessionId },
		customRenders,
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (title: string) => {
				prompts.push(title);
				return selections.shift();
			},
			custom: customInput === undefined ? undefined : async (factory: any) => {
				let result: string | undefined;
				const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, value: string) => value }, {}, (value: string | undefined) => { result = value; });
				const render = component.render.bind(component);
				component.render = (width: number) => {
					customRenders.count += 1;
					return render(width);
				};
				component.render(80);
				for (const input of Array.isArray(customInput) ? customInput : [customInput]) component.handleInput(input);
				return result;
			},
			editor: async () => written,
		},
	};
}

describe("questions extension", () => {
	// `ask_captain` is gone: code execution is the only tool, so the agent-facing
	// path is `deck.ask()` -> `deck-v2 questions ask` -> this store call. The
	// queue behaviour it depended on is asserted here, one layer down.
	test("asking queues durably and reports the backlog", () => {
		const file = freshFile();
		ask(file, {
			question: "Flag or not?",
			options: ["flag", "no flag"],
			urgency: "high",
			sessionId: "session-a",
			cwd: "/tmp",
		});
		expect(openQuestions(file)).toHaveLength(1);
		expect(openQuestions(file)[0]!.urgency).toBe("high");
	});

	test("no agent-callable question tool is registered", () => {
		const agent = new Harness();
		registerQuestions(agent as unknown as Parameters<typeof registerQuestions>[0], envFor(freshFile()), agent.runtime);
		for (const retired of ["ask_captain", "list_questions", "answer_question"]) {
			expect(agent.tools.get(retired)).toBeUndefined();
		}
	});

	test("/questions uses the host selector even when ui.custom exists", async () => {
		// A custom overlay built from this module's bundled pi-tui classes
		// renders nothing on a host with a different pi-tui version, resolving
		// undefined and exiting the loop with "Resolved 0 of N" (observed live
		// on the prime host). The host's own select is the portable contract.
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "Choose", options: ["yes", "no"], sessionId: "session-a", cwd: "/tmp" });
		const captain = fakeContext("session-captain", ["1. yes"], undefined, ["x", "\n"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(openQuestions(file)).toHaveLength(0);
		// The overlay path must not run at all.
		expect(captain.customRenders.count).toBe(0);
	});


	test("REGRESSION: a throwing host dialog names the open question and stops", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "risky merge?", options: ["yes"], sessionId: "s1", cwd: "/" });
		const captain = fakeContext("session-captain");
		captain.ui.select = async () => {
			throw new Error("dialog backend gone");
		};
		await agent.commands.get("questions")!.handler("", captain);
		// The entry stays open, and the fallback notice identifies it.
		expect(openQuestions(file)).toHaveLength(1);
		expect(captain.notices.some((n) => n.includes("risky merge?") && n.includes("remains open"))).toBe(true);
	});

	test("REGRESSION: Dismiss losing the race drops the stale card and shows the next one", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "first", options: ["a"], sessionId: "s1", cwd: "/" });
		ask(file, { question: "second", options: ["b"], sessionId: "s2", cwd: "/" });
		const captain = fakeContext("session-captain", ["Dismiss", "1. b"]);
		// Another session resolves the first card while its dialog is open.
		const select = captain.ui.select;
		let raced = false;
		captain.ui.select = async (title: string) => {
			if (!raced) {
				raced = true;
				const target = openQuestions(file)[0]!;
				answer(file, target.id, "elsewhere");
			}
			return select(title);
		};
		await agent.commands.get("questions")!.handler("", captain);
		// Both cards end resolved: first elsewhere, second answered here.
		expect(openQuestions(file)).toHaveLength(0);
	});

	test("/questions Previous returns to the earlier question", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "first", options: ["a"], sessionId: "s1", cwd: "/" });
		ask(file, { question: "second", options: ["b"], sessionId: "s2", cwd: "/" });
		// Skip to the second card, step back with Previous, then answer the first.
		const captain = fakeContext("captain", ["Skip", "Previous", "1. a", "1. b"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(openQuestions(file)).toHaveLength(0);
		const history = readQuestionHistory(file);
		expect(history.find((q) => q.question === "first")?.answer).toBe("a");
		expect(history.find((q) => q.question === "second")?.answer).toBe("b");
		// The loop showed: second card, first card (after Previous), and both got titles.
		expect(captain.prompts.filter((title) => title.startsWith("(")).length).toBe(4);
	});

	test("/questions Previous on the first question stays on it", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "only", options: ["a"], sessionId: "s", cwd: "/" });
		const captain = fakeContext("captain", ["Previous", "1. a"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(openQuestions(file)).toHaveLength(0);
	});

	test("/questions Show detail renders the full card read-only and returns to the question", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asked = ask(file, {
			question: "Pick one",
			options: ["a", "b"],
			context: "long background",
			recommendation: "a",
			sessionId: "s",
			cwd: "/w",
		});
		const captain = fakeContext("captain", ["Show detail", "anything", "2. b"]);
		await agent.commands.get("questions")!.handler("", captain);
		// The detail view went through the host select dialog with the full card.
		const detail = captain.prompts.find((title) => title.startsWith("Question "));
		expect(detail).toBe(`Question ${asked.id}`);
		// Viewing detail resolved nothing; the follow-up pick did.
		expect(readQuestionHistory(file).find((q) => q.id === asked.id)?.answer).toBe("b");
	});

	test("fullDetail includes id, options with actions, and context", () => {
		const file = freshFile();
		ask(file, {
			id: "det",
			idScope: "global",
			question: "Q?",
			options: ["Stamp", "Close"],
			actions: ["stamp", "deny-gate"],
			context: "why this matters",
			sessionId: "s",
			cwd: "/w",
		});
		const detail = fullDetail(openQuestions(file)[0]!, 0);
		expect(detail).toContain("id: det");
		expect(detail).toContain("1. Stamp [stamp]");
		expect(detail).toContain("2. Close [deny-gate]");
		expect(detail).toContain("context: why this matters");
	});

	test("/questions stays on a card whose submission failed so it can be resubmitted", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(
			agent as any,
			envFor(file),
			agent.runtime,
			// The stamp executor fails once, then succeeds: first pick fails,
			// the loop re-offers the SAME card, second pick lands.
			(() => {
				let calls = 0;
				return async (command: string) => {
					if (command === "gh") {
						return { stdout: JSON.stringify({ headRefOid: "abc", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [] }) };
					}
					calls += 1;
					if (calls === 1) throw new Error("gateway down");
					return {};
				};
			})() as any,
		);
		ask(file, {
			id: "deck-fleet:stamp:o/r:7:stamp:run-1:gate",
			idScope: "global",
			questionKind: "stamp",
			origin: "fleet",
			prContext: { prNumber: 7, prRepo: "o/r", headSha: "abc" },
			question: "Stamp?",
			options: ["Stamp"],
			actions: ["stamp"],
			sessionId: "s",
			cwd: "/w",
		});
		const captain = fakeContext("captain", ["1. Stamp", "1. Stamp"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(openQuestions(file)).toHaveLength(0);
		expect(captain.notices.some((notice) => notice.includes("resubmit"))).toBe(true);
	});

	test("/questions drops a card another session already resolved instead of looping", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asked = ask(file, { question: "raced", options: ["a"], sessionId: "s", cwd: "/" });
		const captain = fakeContext("captain", []);
		captain.ui.select = async (title: string) => {
			captain.prompts.push(title);
			// A second captain resolves it while this dialog is open.
			answer(file, asked.id, "other captain won");
			return "1. a";
		};
		await agent.commands.get("questions")!.handler("", captain);
		// Not answered by us, not stuck: the loop noticed it was closed and moved on.
		expect(captain.prompts.filter((title) => title.startsWith("(")).length).toBe(1);
		expect(readQuestionHistory(file).find((q) => q.id === asked.id)?.answer).toBe("other captain won");
	});

	test("/questions answers with a listed option and delivers to the asker", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);

		const asker = fakeContext("session-a");
		ask(file, { question: "Flag or not?", options: ["flag", "no flag"], sessionId: "session-a", cwd: "/tmp" });

		// The captain reviews from a DIFFERENT session. Agent options are numbered
		// so they can never collide with the control labels.
		const captain = fakeContext("session-captain", ["1. flag"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(captain.prompts[0]).toContain("Flag or not?");
		expect(openQuestions(file)).toHaveLength(0);

		// The asking session picks the answer up on its next settle.
		await agent.emit("agent_settled", asker);
		expect(agent.sent).toHaveLength(1);
		expect(agent.sent[0]!.content).toContain("A: flag");
		expect(agent.sent[0]!.triggerTurn).toBe(true);

		// And never twice.
		await agent.emit("agent_settled", asker);
		expect(agent.sent).toHaveLength(1);
	});

	test("an answer left while the asker was down is delivered on session_start", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/work/deck" });
		answer(file, asked.id, "do it");

		const asker = fakeContext("session-a");
		await agent.emit("session_start", asker);
		expect(agent.sent.map((m) => m.content.includes("A: do it"))).toEqual([true]);
	});

	test("the background poll wakes a parked asker when the queue changes", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asker = fakeContext("session-a");
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/work/deck" });
		await agent.emit("session_start", asker);
		expect(agent.sent).toHaveLength(0);

		agent.intervals[0]!();
		expect(agent.sent).toHaveLength(0); // no change yet

		answer(file, asked.id, "go");
		agent.intervals[0]!();
		expect(agent.sent).toHaveLength(1);
		expect(agent.sent[0]!.triggerTurn).toBe(true);
	});

	test("a failed send leaves the answer pending rather than losing it forever", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/" });
		answer(file, asked.id, "go");

		const asker = fakeContext("session-a");
		agent.sendMessageThrows = true;
		await expect(agent.emit("session_start", asker)).rejects.toThrow("send failed");
		expect(readQuestions(file)[0]?.delivered).toBe(false);

		// The next delivery attempt still finds it.
		agent.sendMessageThrows = false;
		await agent.emit("agent_settled", asker);
		expect(agent.sent).toHaveLength(1);
		expect(readQuestions(file)[0]?.delivered).toBe(true);
	});

	test("a captain whose answer lost the race is told, and it is not counted", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const asked = ask(file, {
			question: "Flag?",
			options: ["flag"],
			sessionId: "session-a",
			cwd: "/",
		});
		// Another captain session resolved it after this one listed it.
		const captain = fakeContext("session-captain", ["1. flag"]);
		const originalSelect = captain.ui.select;
		captain.ui.select = async (title: string) => {
			answer(file, asked.id, "unguarded");
			return originalSelect(title);
		};

		await agent.commands.get("questions")!.handler("", captain);
		expect(readQuestions(file)[0]?.answer).toBe("unguarded");
		expect(captain.notices.some((n) => n.includes("Already resolved elsewhere"))).toBe(true);
		expect(captain.notices.at(-1)).toContain("Resolved 0 of 1");
	});

	test("free-text answers, dismissal, skip, and stop all behave", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		for (const question of ["Q1", "Q2", "Q3", "Q4"]) {
			ask(file, { question, sessionId: "session-a", cwd: "/", now: agent.currentTime++ });
		}

		const captain = fakeContext(
			"session-captain",
			["Write an answer...", "Dismiss", "Skip", "Stop reviewing"],
			"my own words",
		);
		await agent.commands.get("questions")!.handler("", captain);

		const byQuestion = new Map(readQuestions(file).map((entry) => [entry.question, entry]));
		expect(byQuestion.get("Q1")!.answer).toBe("my own words");
		expect(byQuestion.get("Q2")!.status).toBe("dismissed");
		expect(byQuestion.get("Q3")!.status).toBe("open");
		expect(byQuestion.get("Q4")!.status).toBe("open");
		expect(captain.notices.at(-1)).toContain("Resolved 2 of 4");
	});

	test("an agent option named like a control is still selectable as an answer", async () => {
		// Matching choices by display string would turn picking the agent's own
		// "Dismiss" option into a dismissal.
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, {
			question: "Q",
			options: ["Dismiss", "Skip", "Stop reviewing", "Write an answer..."],
			sessionId: "session-a",
			cwd: "/",
		});

		const captain = fakeContext("session-captain", ["1. Dismiss"]);
		await agent.commands.get("questions")!.handler("", captain);
		const [entry] = readQuestions(file);
		expect(entry?.status).toBe("answered");
		expect(entry?.answer).toBe("Dismiss");
	});

	test("the real controls still work when the agent shadows their labels", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "Q", options: ["Dismiss"], sessionId: "session-a", cwd: "/" });
		const captain = fakeContext("session-captain", ["Dismiss"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(readQuestions(file)[0]?.status).toBe("dismissed");
	});

	test("a truncated captain answer is reported, not silently clipped", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		ask(file, { question: "Q", sessionId: "session-a", cwd: "/" });
		const captain = fakeContext(
			"session-captain",
			["Write an answer..."],
			"x".repeat(MAX_EVENT_BYTES),
		);
		await agent.commands.get("questions")!.handler("", captain);
		expect(captain.notices.some((n) => n.includes("truncated"))).toBe(true);
		expect(readQuestions(file)[0]?.status).toBe("answered");
	});

	test("/questions routes workflow stamps through the authenticated Gateway", async () => {
		const file = freshFile();
		const agent = new Harness();
		let submitted: unknown;
		registerQuestions(
			agent as never,
			{
				...envFor(file),
				SMITHERS_GATEWAY_TOKEN: "smithers-ui-test",
				SMITHERS_GATEWAY_URL: "http://gateway.test",
			},
			{
				...agent.runtime,
				fetch: async (_input, init) => {
					submitted = JSON.parse(String(init?.body));
					return new Response(JSON.stringify({
						ok: true,
						payload: {
							runId: "run-ui",
							nodeId: "r0-stamp",
							iteration: 0,
							approved: true,
						},
					}), { status: 200 });
				},
			},
		);
		askWorkflowQuestion(file, {
			runId: "run-ui",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Gateway releases the node.",
			originalIssue: "PR #12 is ready for a stamp.",
			proposedAction: "Stamp the reviewed head.",
			blastRadius: "Only PR #12 at head-12.",
			prNumber: 12,
			approvalValue: { headSha: "head-12", prNumber: 12 },
			questionKind: "stamp",
			options: ["Stamp", "Hold", "Deny gate"],
			actions: ["stamp", "hold", "deny-gate"],
			cwd: "/workflow",
		});
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(submitted).toMatchObject({
			runId: "run-ui",
			nodeId: "r0-stamp",
			approved: true,
			decision: { value: { headSha: "head-12", prNumber: 12 } },
		});
		expect(openQuestions(file)).toEqual([]);
	});

	test("/questions cannot dismiss an active workflow wait into a ghost", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(
			agent as never,
			{ ...envFor(file), SMITHERS_GATEWAY_TOKEN: "status-test" },
			{
				...agent.runtime,
				fetch: async (input) => {
					expect(String(input)).toBe("http://127.0.0.1:7331/v1/rpc/getRun");
					return new Response(JSON.stringify({
						ok: true,
						payload: { runId: "run-ui", status: "running" },
					}), { status: 200 });
				},
			},
		);
		askWorkflowQuestion(file, {
			runId: "run-ui",
			nodeId: "r0-watch-fix",
			decisionKey: "thread-12",
			answerLane: "store",
			resumeHint: "Next watch-fix hydrates the answer.",
			originalIssue: "Thread 12 needs a product decision.",
			proposedAction: "State the intended behavior.",
			blastRadius: "Only thread 12.",
			cwd: "/workflow",
		});
		const captain = fakeContext("captain", ["Dismiss"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(openQuestions(file)).toHaveLength(1);
		expect(captain.notices).toContain(
			"Workflow decisions cannot be dismissed while their wait is active; choose Hold, approve/deny the gate, or answer the plain decision.",
		);
	});
	test("/questions dismisses a workflow wait after Gateway reports its run terminal", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(
			agent as never,
			{ ...envFor(file), SMITHERS_GATEWAY_TOKEN: "status-test" },
			{
				...agent.runtime,
				fetch: async () => new Response(JSON.stringify({
					ok: true,
					payload: { runId: "run-cancelled", status: "cancelled" },
				}), { status: 200 }),
			},
		);
		askWorkflowQuestion(file, {
			runId: "run-cancelled",
			nodeId: "r0-watch-fix",
			decisionKey: "thread-12",
			answerLane: "store",
			resumeHint: "Next watch-fix hydrates the answer.",
			originalIssue: "Thread 12 needs a product decision.",
			proposedAction: "State the intended behavior.",
			blastRadius: "Only thread 12.",
			cwd: "/workflow",
		});
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["Dismiss"]));
		expect(openQuestions(file)).toEqual([]);
		expect(readQuestionHistory(file)[0]?.status).toBe("dismissed");
	});


	test("stamp approves the exact gate and resumes the exact run", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: Array<{ command: string; args: string[] }> = [];
		const executor = async (command: string, args: string[]) => { commands.push({ command, args }); return command === "gh" ? { stdout: JSON.stringify({ headRefOid: "head-12", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }] }) } : {}; };
		registerQuestions(agent as any, envFor(file), agent.runtime, executor as any);
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:stamp", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp"], sessionId: "s", cwd: "/" });
		const captain = fakeContext("captain", ["1. Stamp"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(commands).toEqual([
			{ command: "gh", args: ["pr", "view", "12", "--repo", "owner/repo", "--json", "headRefOid,mergeable,mergeStateStatus,statusCheckRollup"] },
			{ command: "smithers", args: ["approve", "run-7", "--node", "stamp", "--by", "captain"] },
			{ command: "smithers", args: ["up", "pipeline.tsx", "--run-id", "run-7", "--resume", "true"] },
		]);
		expect(openQuestions(file)).toHaveLength(0);
	});

	test("legacy review-gate approval questions fail closed without calling GitHub", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: Array<{ command: string; args: string[] }> = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (command, args) => {
			commands.push({ command, args });
			return {};
		});
		ask(file, {
			id: "review-gate-pr-12-head",
			question: "Captain approval needed",
			questionKind: "approve", origin: "review-gate",
			prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12", prUrl: "https://github.com/owner/repo/pull/12", prTitle: "Fix gate" },
			options: ["Approve", "Hold"], actions: ["approve", "hold"], sessionId: "s", cwd: "/work/deck",
		});
		const captain = fakeContext("captain", ["1. Approve"]);
		await agent.commands.get("questions")!.handler("", captain);
		expect(commands).toEqual([]);
		expect(openQuestions(file)).toHaveLength(1);
		expect(captain.notices).toContain(
			"Legacy review-gate approvals cannot be submitted. Re-queue this decision through its Smithers workflow.",
		);
	});


	test("Close option closes the reviewed PR", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (_command, args) => { commands.push(args); return { stdout: JSON.stringify({ headRefOid: "head-12" }) }; });
		ask(file, { id: "review-gate-pr-12-head", question: "Captain decision needed", questionKind: "agent", origin: "review-gate", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Hold", "Close"], actions: ["hold", "close-pr"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["2. Close"]));
		expect(commands).toEqual([
			["pr", "view", "12", "--repo", "owner/repo", "--json", "headRefOid"],
			["pr", "close", "12", "--repo", "owner/repo"],
		]);
		expect(openQuestions(file)).toHaveLength(0);
	});


	test("PR context is bounded before it enters the durable queue", () => {
		const file = freshFile();
		ask(file, { question: "Q", sessionId: "s", cwd: "/", prContext: { originalIssue: "x".repeat(5000), ourFix: "y".repeat(5000), whyCorrect: "z".repeat(5000) } });
		const entry = readQuestions(file)[0]!;
		expect(entry.prContext?.originalIssue?.length).toBeLessThanOrEqual(800);
		expect(entry.prContext?.ourFix?.length).toBeLessThanOrEqual(800);
		expect(entry.prContext?.whyCorrect?.length).toBeLessThanOrEqual(1400);
	});

	test("rich PR context is rendered as a self-contained decision", () => {
		const file = freshFile();
		const asked = ask(file, { question: "Stamp this PR?", questionKind: "stamp", origin: "fleet", prContext: {
			prUrl: "https://github.com/owner/repo/pull/12", prRepo: "owner/repo", prNumber: 12, prTitle: "Fix gate",
			originalIssue: "The gate did not notify the captain.", ourFix: "The gate posts findings and queues approval.",
			whyCorrect: "43 tests pass. Adversarial review found no blockers. Blast radius is limited to gate decisions.", ciState: "green", mergeStateStatus: "CLEAN",
		}, options: ["Stamp", "Hold", "Close"], sessionId: "s", cwd: "/", now: 0 });
		const rendered = describeQuestion({ ...asked, status: "open", delivered: false }, 0);
		expect(rendered).toContain("https://github.com/owner/repo/pull/12");
		expect(rendered).toContain("THE ORIGINAL ISSUE (AGENT CLAIM): The gate did not notify the captain.");
		expect(rendered).toContain("OUR FIX (AGENT CLAIM): The gate posts findings and queues approval.");
		expect(rendered).toContain("WHY IT IS CORRECT (AGENT CLAIM): 43 tests pass.");
		expect(rendered).toContain("Target: owner/repo#12@unknown");
		expect(rendered).toContain("CI: green");
		expect(rendered).toContain("mergeStateStatus: CLEAN");
	});

	test("legacy stamp without PR evidence stays open", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (_command, args) => { commands.push(args); return {}; });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", options: ["Stamp"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(commands).toEqual([]);
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("hold keeps the decision open", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime, async () => ({}));
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp", "Hold", "Deny gate"], actions: ["stamp", "hold", "deny-gate"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["2. Hold"]));
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("stamp refuses when the reviewed PR head changed", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (_command, args) => { commands.push(args); return { stdout: JSON.stringify({ headRefOid: "new-head" }) }; });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "old-head" }, options: ["Stamp"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(commands).toHaveLength(1);
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("stamp Close denies the exact gate", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (_command, args) => { commands.push(args); return {}; });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp", "Hold", "Deny gate"], actions: ["stamp", "hold", "deny-gate"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["3. Deny gate"]));
		expect(commands).toEqual([["deny", "run-7", "--node", "gate", "--by", "captain"]]);
		expect(openQuestions(file)).toHaveLength(0);
	});

	test("stamp approval failure does not resume or resolve", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (_command, args) => { commands.push(args); throw new Error("permission denied"); });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(commands).toHaveLength(1);
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("stamp keeps the question open when resume fails", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (command, args) => { if (command === "gh") return { stdout: JSON.stringify({ headRefOid: "head-12", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }] }) }; commands.push(args); if (commands.length === 2) throw new Error("resume failed"); return {}; });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(commands).toHaveLength(2);
		expect(openQuestions(file)).toHaveLength(1);
	});

	test("stamp retries resume after an already-approved error", async () => {
		const file = freshFile();
		const agent = new Harness();
		const commands: string[][] = [];
		registerQuestions(agent as any, envFor(file), agent.runtime, async (command, args) => { if (command === "gh") return { stdout: JSON.stringify({ headRefOid: "head-12", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }] }) }; commands.push(args); if (commands.length === 1) throw new Error("approval is already approved"); return {}; });
		ask(file, { id: "deck-fleet:stamp:owner/repo:12:stamp:run-7:gate", question: "Stamp?", questionKind: "stamp", origin: "fleet", prContext: { prRepo: "owner/repo", prNumber: 12, headSha: "head-12" }, options: ["Stamp"], sessionId: "s", cwd: "/" });
		await agent.commands.get("questions")!.handler("", fakeContext("captain", ["1. Stamp"]));
		expect(commands).toHaveLength(2);
		expect(openQuestions(file)).toHaveLength(0);
	});

	test("/questions on an empty queue says so rather than opening a dialog", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);
		const captain = fakeContext("session-captain");
		await agent.commands.get("questions")!.handler("", captain);
		expect(captain.prompts).toEqual([]);
		expect(captain.notices[0]).toContain("No open questions");
	});

	test("the captain's view names age, asker, options and recommendation", () => {
		const file = freshFile();
		const asked = ask(file, {
			question: "Which path?",
			context: "both compile",
			recommendation: "path A",
			urgency: "high",
			sessionId: "session-a",
			cwd: "/work/deck",
			now: 0,
		});
		const rendered = describeQuestion({ ...asked, status: "open", delivered: false }, 120_000);
		expect(rendered).toContain("[high]");
		expect(rendered).toContain("asked 2m ago");
		expect(rendered).toContain("session-a");
		expect(rendered).toContain("both compile");
		expect(rendered).toContain("path A");
	});

	test("session_shutdown stops the poll", async () => {
		const agent = new Harness();
		registerQuestions(agent as any, envFor(freshFile()), agent.runtime);
		await agent.emit("session_start", fakeContext("session-a"));
		expect(agent.intervals).toHaveLength(1);
		await agent.emit("session_shutdown", fakeContext("session-a"));
		expect(agent.intervals).toHaveLength(0);
	});
});

describe("poll does not hold a dead ctx", () => {
	// Observed live: every session in a directory with this extension printed
	// "This extension ctx is stale after session replacement or reload", because
	// startPolling captured the session_start ctx and reused it forever. A stale
	// ctx throws instead of delivering, which parks the asking agent for good —
	// the exact failure this extension exists to prevent.
	test("REGRESSION: the poll still delivers after the session ctx goes stale", async () => {
		const file = freshFile();
		const agent = new Harness();
		registerQuestions(agent as any, envFor(file), agent.runtime);

		const asker = fakeContext("session-a");
		await agent.emit("session_start", asker);

		// The host replaces the session: the old ctx is now poison. Anything that touches
		// it throws, so a poll holding it cannot deliver.
		asker.sessionManager.getSessionId = () => {
			throw new Error("This extension ctx is stale after session replacement or reload");
		};

		// Queue a question and answer it while only the stale ctx exists.
		const queued = ask(file, { question: "ship it?", sessionId: "session-a", cwd: "/" });
		answer(file, queued.id, "yes");

		// The poll must run without throwing and must deliver the answer.
		expect(() => agent.intervals.forEach((tick) => tick())).not.toThrow();
		expect(pendingAnswersFor(file, "session-a")).toHaveLength(0);
	});
});
