import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../src/cli";
import { askWorkflowQuestion, openQuestions, readQuestions } from "../src/questions-store";

/**
 * The `list_questions` / `answer_question` pi-tools are gone; `deck.questions()`
 * and `deck.answer()` reach the queue through this CLI instead. The invariant
 * they enforced is not negotiable and is re-asserted here: an agent can resolve
 * a plain decision, but a Smithers approval is the captain's alone.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	delete process.env.DECK_QUESTIONS_FILE;
});

function freshQueue(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-questions-cli-"));
	roots.push(root);
	const file = path.join(root, "questions", "queue.jsonl");
	process.env.DECK_QUESTIONS_FILE = file;
	return file;
}

describe("questions code surface", () => {
	test("refuses to advance a Smithers approval and leaves it open", async () => {
		const file = freshQueue();
		const stamp = askWorkflowQuestion(file, {
			runId: "run-1",
			nodeId: "r0-stamp",
			answerLane: "smithers-approval",
			resumeHint: "Gateway releases the parked node.",
			originalIssue: "PR #7 is waiting for a stamp.",
			proposedAction: "Stamp the reviewed head.",
			blastRadius: "Only PR #7 at head abc.",
			prNumber: 7,
			approvalValue: { headSha: "abc", prNumber: 7 },
			cwd: "/workflow",
		});

		expect(await runCli(["questions", "answer", "--id", stamp.id, "--answer", "Stamp"])).toBe(1);
		expect(openQuestions(file).find((question) => question.id === stamp.id)).toMatchObject({
			status: "open",
			workflow: { answerLane: "smithers-approval" },
		});
	});

	test("resolves a plain workflow decision through the store", async () => {
		const file = freshQueue();
		const blocker = askWorkflowQuestion(file, {
			runId: "run-1",
			nodeId: "r0-watch-fix",
			decisionKey: "thread=review-thread-9",
			answerLane: "store",
			resumeHint: "Next watch-fix hydrates the answer.",
			originalIssue: "The review thread requires product judgment.",
			proposedAction: "Captain selects the intended behavior.",
			blastRadius: "Only review-thread-9.",
			cwd: "/workflow",
		});

		expect(
			await runCli(["questions", "answer", "--id", blocker.id, "--answer", "Preserve the current behavior."]),
		).toBe(0);
		expect(readQuestions(file).find((question) => question.id === blocker.id)).toMatchObject({
			status: "answered",
			answer: "Preserve the current behavior.",
		});
	});

	test("asks, lists, and folds an answer without any tool", async () => {
		const file = freshQueue();
		expect(
			await runCli(["questions", "ask", "--question", "Flag or not?", "--session", "session-a", "--id", "d1"]),
		).toBe(0);
		expect(openQuestions(file)).toHaveLength(1);

		expect(await runCli(["questions", "answer", "--id", "session-a:d1", "--answer", "flag"])).toBe(0);
		expect(openQuestions(file)).toHaveLength(0);

		// Answering twice must not overwrite the folded resolution.
		expect(await runCli(["questions", "answer", "--id", "session-a:d1", "--answer", "no flag"])).toBe(1);
		expect(readQuestions(file).find((question) => question.id === "session-a:d1")?.answer).toBe("flag");
	});

	test("an unknown question id fails loudly rather than silently queueing", async () => {
		freshQueue();
		expect(await runCli(["questions", "answer", "--id", "session-a:nope", "--answer", "x"])).toBe(1);
	});
});
