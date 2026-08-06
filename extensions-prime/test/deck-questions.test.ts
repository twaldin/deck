import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerDeckQuestions } from "../deck-questions";
import {
	ask,
	askWorkflowQuestion,
	readQuestionHistory,
	readQuestions,
} from "../../v2/src/questions-store";

interface RegisteredTool {
	name: string;
	execute(...args: unknown[]): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: {
	env?: Record<string, string | undefined>;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-questions-extension-"));
	roots.push(root);
	const file = path.join(root, "questions", "queue.jsonl");
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const statuses: Array<string | undefined> = [];
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage() {},
	};
	const runtime = {
		now: () => 1_000,
		setInterval: () => 1 as never,
		clearInterval: () => {},
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	};
	registerDeckQuestions(
		api as never,
		{ DECK_QUESTIONS_FILE: file, ...(options.env ?? {}) },
		runtime,
	);
	const ctx = {
		hasUI: true,
		cwd: root,
		ui: {
			notify() {},
			select: async () => undefined,
			editor: async () => undefined,
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
		},
		sessionManager: { getSessionId: () => "session-1" },
	};
	return { file, tools, commands, handlers, statuses, ctx };
}

describe("deck-questions tools", () => {
	test("queues immediately, lists the folded open state, then folds an answer", async () => {
		const { file, tools, commands, statuses, ctx } = fixture();
		expect(commands.has("questions")).toBe(true);

		const ask = tools.get("ask_captain");
		const list = tools.get("list_questions");
		const answer = tools.get("answer_question");
		expect([ask?.name, list?.name, answer?.name]).toEqual([
			"ask_captain",
			"list_questions",
			"answer_question",
		]);

		const queued = await ask!.execute(
			"ask-1",
			{ id: "decision-1", question: "Which path?", options: ["A", "B"], urgency: "high" },
			undefined,
			undefined,
			ctx,
		);
		expect(queued.content[0]?.text).toContain("Queued question session-1:decision-1");
		expect(queued.content[0]?.text).toContain("answer arrives");
		expect(statuses.at(-1)).toBe("1?");
		expect(readQuestions(file)).toMatchObject([
			{ id: "session-1:decision-1", status: "open", question: "Which path?" },
		]);

		const listed = await list!.execute("list-1", {}, undefined, undefined, ctx);
		expect(listed.content[0]?.text).toContain('\"id\": \"session-1:decision-1\"');

		const resolved = await answer!.execute(
			"answer-1",
			{ id: "session-1:decision-1", answer: "Take B" },
			undefined,
			undefined,
			ctx,
		);
		expect(resolved.content[0]?.text).toContain("0 open");
		expect(statuses.at(-1)).toBeUndefined();
		expect(readQuestions(file)).toMatchObject([
			{ id: "session-1:decision-1", status: "answered", answer: "Take B" },
		]);
		expect(readQuestionHistory(file)).toHaveLength(1);
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
	});

	test("never overwrites a folded resolution", async () => {
		const { file, tools, ctx } = fixture();
		await tools.get("ask_captain")!.execute(
			"ask-1",
			{ id: "decision-2", question: "Ship?" },
			undefined,
			undefined,
			ctx,
		);
		await tools.get("answer_question")!.execute(
			"answer-1",
			{ id: "session-1:decision-2", answer: "Yes" },
			undefined,
			undefined,
			ctx,
		);
		await expect(tools.get("answer_question")!.execute(
			"answer-2",
			{ id: "session-1:decision-2", answer: "No" },
			undefined,
			undefined,
			ctx,
		)).rejects.toThrow("already answered");
		expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
	});

	test("routes workflow approvals through Gateway and plain decisions through the store", async () => {
		let approvalRequest: unknown;
		let gatewayCalls = 0;
		const { file, tools, ctx } = fixture({
			env: {
				SMITHERS_GATEWAY_TOKEN: "smithers-extension-test",
				SMITHERS_GATEWAY_URL: "http://gateway.test",
			},
			fetch: async (_input, init) => {
				gatewayCalls += 1;
				approvalRequest = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						runId: "run-1",
						nodeId: "r0-stamp",
						iteration: 0,
						approved: true,
					},
				}), { status: 200 });
			},
		});
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
		const listed = await tools.get("list_questions")!.execute(
			"list-workflow",
			{},
			undefined,
			undefined,
			ctx,
		);
		expect(listed.content[0]?.text).toContain('"answerLane": "smithers-approval"');
		expect(listed.content[0]?.text).toContain('"originalIssue": "PR #7 is waiting for a stamp."');
		expect(listed.content[0]?.text).toContain('"resumeHint": "Gateway releases the parked node."');
		const stampResult = await tools.get("answer_question")!.execute(
			"stamp-answer",
			{ id: stamp.id, answer: "Stamp" },
			undefined,
			undefined,
			ctx,
		);
		expect(stampResult.details).toMatchObject({
			lane: "smithers-approval",
			choice: "approve",
		});
		expect(approvalRequest).toMatchObject({
			runId: "run-1",
			nodeId: "r0-stamp",
			approved: true,
			decision: { value: { headSha: "abc", prNumber: 7 } },
		});

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
		const plainResult = await tools.get("answer_question")!.execute(
			"plain-answer",
			{ id: blocker.id, answer: "Preserve the current behavior." },
			undefined,
			undefined,
			ctx,
		);
		expect(plainResult.details).toMatchObject({ lane: "store" });
		expect(gatewayCalls).toBe(1);
		expect(readQuestions(file).find((question) => question.id === blocker.id)).toMatchObject({
			status: "answered",
			answer: "Preserve the current behavior.",
		});
	});

	test("session startup never rewrites the shared append-only queue", async () => {
		const { file, handlers, ctx } = fixture();
		ask(file, {
			id: "stale-but-durable",
			question: "Still needed?",
			sessionId: "other-session",
			cwd: "/tmp",
			now: -1_000_000_000,
		});
		const before = fs.readFileSync(file, "utf8");
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	});
});
