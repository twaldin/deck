import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	answer,
	ask,
	formatAge,
	markDelivered,
	MAX_EVENT_BYTES,
	openQuestions,
	pendingAnswersFor,
	queueFile,
	readQuestions,
} from "../src/questions-store";
import { answerMessage, describe as describeQuestion, registerQuestions } from "../src/questions";

const dirs: string[] = [];
function freshFile(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "deck-questions-"));
	dirs.push(dir);
	return path.join(dir, "queue.jsonl");
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
		// The log is shared by the whole pi home, so a bare "migration-decision"
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

	test("queueFile honours the test override and the pi home", () => {
		expect(queueFile({ DECK_QUESTIONS_FILE: "/tmp/q.jsonl" })).toBe("/tmp/q.jsonl");
		expect(queueFile({ PI_CONFIG_DIR: "/home/x/.pi/agent" })).toBe(
			"/home/x/.pi/agent/questions/queue.jsonl",
		);
	});

	test("formatAge stays readable across scales", () => {
		expect(formatAge(5_000)).toBe("5s");
		expect(formatAge(180_000)).toBe("3m");
		expect(formatAge(3_600_000)).toBe("1h");
		expect(formatAge(90 * 60_000)).toBe("1h30m");
		expect(formatAge(50 * 3_600_000)).toBe("2d2h");
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

function fakeContext(sessionId: string, selections: string[] = [], written?: string) {
	const notices: string[] = [];
	const prompts: string[] = [];
	return {
		hasUI: true,
		cwd: "/work/deck",
		notices,
		prompts,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (title: string) => {
				prompts.push(title);
				return selections.shift();
			},
			editor: async () => written,
		},
	};
}

describe("questions extension", () => {
	test("ask_captain queues durably and reports the backlog", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const ctx = fakeContext("session-a");

		const result = await pi.tools.get("ask_captain")!.execute(
			"call-1",
			{ question: "Flag or not?", options: ["flag", "no flag"], urgency: "high" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toContain("1 open");
		expect(openQuestions(file)).toHaveLength(1);
		expect(ctx.notices[0]).toContain("Queued question");
	});

	test("/questions answers with a listed option and delivers to the asker", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);

		const asker = fakeContext("session-a");
		await pi.tools
			.get("ask_captain")!
			.execute("c1", { question: "Flag or not?", options: ["flag", "no flag"] }, undefined, undefined, asker);

		// The captain reviews from a DIFFERENT session.
		const captain = fakeContext("session-captain", ["flag"]);
		await pi.commands.get("questions")!.handler("", captain);
		expect(captain.prompts[0]).toContain("Flag or not?");
		expect(openQuestions(file)).toHaveLength(0);

		// The asking session picks the answer up on its next settle.
		await pi.emit("agent_settled", asker);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.content).toContain("A: flag");
		expect(pi.sent[0]!.triggerTurn).toBe(true);

		// And never twice.
		await pi.emit("agent_settled", asker);
		expect(pi.sent).toHaveLength(1);
	});

	test("an answer left while the asker was down is delivered on session_start", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/work/deck" });
		answer(file, asked.id, "do it");

		const asker = fakeContext("session-a");
		await pi.emit("session_start", asker);
		expect(pi.sent.map((m) => m.content.includes("A: do it"))).toEqual([true]);
	});

	test("the background poll wakes a parked asker when the queue changes", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const asker = fakeContext("session-a");
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/work/deck" });
		await pi.emit("session_start", asker);
		expect(pi.sent).toHaveLength(0);

		pi.intervals[0]!();
		expect(pi.sent).toHaveLength(0); // no change yet

		answer(file, asked.id, "go");
		pi.intervals[0]!();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.triggerTurn).toBe(true);
	});

	test("a failed send leaves the answer pending rather than losing it forever", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const asked = ask(file, { question: "Q", sessionId: "session-a", cwd: "/" });
		answer(file, asked.id, "go");

		const asker = fakeContext("session-a");
		pi.sendMessageThrows = true;
		await expect(pi.emit("session_start", asker)).rejects.toThrow("send failed");
		expect(readQuestions(file)[0]?.delivered).toBe(false);

		// The next delivery attempt still finds it.
		pi.sendMessageThrows = false;
		await pi.emit("agent_settled", asker);
		expect(pi.sent).toHaveLength(1);
		expect(readQuestions(file)[0]?.delivered).toBe(true);
	});

	test("a captain whose answer lost the race is told, and it is not counted", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const asked = ask(file, { question: "Flag?", sessionId: "session-a", cwd: "/" });
		// Another captain session resolved it after this one listed it.
		const captain = fakeContext("session-captain", ["flag"]);
		const originalSelect = captain.ui.select;
		captain.ui.select = async (title: string) => {
			answer(file, asked.id, "unguarded");
			return originalSelect(title);
		};

		await pi.commands.get("questions")!.handler("", captain);
		expect(readQuestions(file)[0]?.answer).toBe("unguarded");
		expect(captain.notices.some((n) => n.includes("Already resolved elsewhere"))).toBe(true);
		expect(captain.notices.at(-1)).toContain("Resolved 0 of 1");
	});

	test("free-text answers, dismissal, skip, and stop all behave", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		for (const question of ["Q1", "Q2", "Q3", "Q4"]) {
			ask(file, { question, sessionId: "session-a", cwd: "/", now: pi.currentTime++ });
		}

		const captain = fakeContext(
			"session-captain",
			["Write an answer...", "Dismiss", "Skip", "Stop reviewing"],
			"my own words",
		);
		await pi.commands.get("questions")!.handler("", captain);

		const byQuestion = new Map(readQuestions(file).map((entry) => [entry.question, entry]));
		expect(byQuestion.get("Q1")!.answer).toBe("my own words");
		expect(byQuestion.get("Q2")!.status).toBe("dismissed");
		expect(byQuestion.get("Q3")!.status).toBe("open");
		expect(byQuestion.get("Q4")!.status).toBe("open");
		expect(captain.notices.at(-1)).toContain("Resolved 2 of 4");
	});

	test("a truncated captain answer is reported, not silently clipped", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		ask(file, { question: "Q", sessionId: "session-a", cwd: "/" });
		const captain = fakeContext(
			"session-captain",
			["Write an answer..."],
			"x".repeat(MAX_EVENT_BYTES),
		);
		await pi.commands.get("questions")!.handler("", captain);
		expect(captain.notices.some((n) => n.includes("truncated"))).toBe(true);
		expect(readQuestions(file)[0]?.status).toBe("answered");
	});

	test("/questions on an empty queue says so rather than opening a dialog", async () => {
		const file = freshFile();
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: file }, pi.runtime);
		const captain = fakeContext("session-captain");
		await pi.commands.get("questions")!.handler("", captain);
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
		const pi = new Harness();
		registerQuestions(pi as any, { DECK_QUESTIONS_FILE: freshFile() }, pi.runtime);
		await pi.emit("session_start", fakeContext("session-a"));
		expect(pi.intervals).toHaveLength(1);
		await pi.emit("session_shutdown", fakeContext("session-a"));
		expect(pi.intervals).toHaveLength(0);
	});
});
