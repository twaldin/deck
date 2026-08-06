import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerDeckQuestions } from "../deck-questions";
import {
	ask,
	askWorkflowQuestion,
	openQuestions,
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

describe("deck-questions extension", () => {
	// The agent-callable question tools are gone; code execution is the only tool.
	// Their behaviour is covered where it now lives: v2/test/questions-cli.test.ts
	// (ask/list/answer + the human-only Smithers approval gate).
	test("registers no agent-callable tool", () => {
		const { tools, commands } = fixture();
		expect([...tools.keys()]).toEqual([]);
		// The captain's interactive path must survive the tool removal.
		expect(commands.has("questions")).toBe(true);
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
