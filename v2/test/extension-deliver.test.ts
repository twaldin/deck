/**
 * The wake delivery guards. The failure these tests pin down is real: isIdle()
 * read true, a turn started, then sendUserMessage hit an active run and pi
 * emitted `Extension "<runtime>" error: Agent is already processing a prompt`
 * — pi's bindCore catches the rejection internally, so the caller never sees
 * it. Pi's native follow-up queue accepts input during the active turn and
 * delivers it in FIFO order. These tests verify the extension uses that queue.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { appendStatus } from "../src/events";

let home: string;
let savedPath: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-deliver-"));
	process.env.DECK_V2_HOME = home;
	// No herdr, no bunx: the statusline refresh degrades to skipped sources
	// instead of spawning real subprocesses (herdr projection creates panes).
	savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	if (savedPath !== undefined) process.env.PATH = savedPath;
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Fake pi that keeps EVERY handler per event, like the real runner. */
function fakePi(sendUserMessage?: (...args: unknown[]) => unknown) {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[][] = [];
	const api = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendUserMessage:
			sendUserMessage ??
			((...args: unknown[]) => {
				sent.push(args);
			}),
	};
	const emit = async (event: string, ctx: unknown): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { api, emit, sent };
}

function tuiCtx(overrides: Record<string, unknown> = {}) {
	return {
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: undefined,
		...overrides,
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("wake delivery guards", () => {
	test("baseline: an idle session delivers a blocked wake once", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const ctx = tuiCtx();
		await pi.emit("session_start", ctx);
		await settle();
		await pi.emit("session_shutdown", ctx);
		expect(pi.sent).toHaveLength(1);
		expect(String(pi.sent[0]?.[0])).toContain("t1: blocked");
	});

	test("agent_start queues sends during the active turn", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const ctx = tuiCtx();
		// A turn is running when the session starts delivering.
		await pi.emit("agent_start", ctx);
		await pi.emit("session_start", ctx);
		await settle();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.[1]).toEqual({ deliverAs: "followUp" });
		await pi.emit("session_shutdown", ctx);
	});

	test("before_agent_start queues input during the pre-start window", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const ctx = tuiCtx();
		// The earliest turn signal, before agent_start, while isIdle still
		// reads true: a nudge landing here must not send.
		await pi.emit("before_agent_start", ctx);
		await pi.emit("session_start", ctx);
		await settle();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.[1]).toEqual({ deliverAs: "followUp" });
		await pi.emit("session_shutdown", ctx);
	});

	test("hasPendingMessages does not block native queueing", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const ctx = tuiCtx({ hasPendingMessages: () => true });
		await pi.emit("session_start", ctx);
		await settle();
		await pi.emit("session_shutdown", ctx);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.[1]).toEqual({ deliverAs: "followUp" });
	});

	test("multiple messages are accepted in FIFO order while a turn runs", async () => {
		appendStatus("t1", "blocked", "red");
		appendStatus("t2", "blocked", "also red");
		const calls: unknown[][] = [];
		const pi = fakePi((...args: unknown[]) => {
			calls.push(args);
		});
		deckV2(pi.api as never);
		const ctx = tuiCtx({ isIdle: () => false, hasPendingMessages: () => true });
		await pi.emit("session_start", ctx);
		await settle();
		await pi.emit("session_shutdown", ctx);
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call[1])).toEqual([{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
		expect(String(calls[0]?.[0])).toContain("t1: blocked");
		expect(String(calls[1]?.[0])).toContain("t2: blocked");
	});

	test("a rejected send promise is a failed send, not a success and not a throw", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi(() => Promise.reject(new Error("Agent is already processing a prompt")));
		deckV2(pi.api as never);
		const ctx = tuiCtx();
		await pi.emit("session_start", ctx);
		await settle();
		await pi.emit("session_shutdown", ctx);

		// Undelivered: the wake is still owed in the outbox.
		const { pendingWakes } = await import("../src/wake");
		expect(pendingWakes()).toHaveLength(1);
	});

	test("re-entrancy: overlapping deliver passes drain the outbox once", async () => {
		appendStatus("t1", "blocked", "main is red");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: unknown[][] = [];
		const pi = fakePi((...args: unknown[]) => {
			calls.push(args);
			return gate; // the first pass parks inside its send
		});
		deckV2(pi.api as never);
		const ctx = tuiCtx();
		// Two overlapping passes: session_start fires deliver, and firing the
		// session_start handler again is the same shape as the interval/watch
		// nudge landing while the first pass is mid-send.
		const first = pi.emit("session_start", ctx);
		const second = pi.emit("session_start", ctx);
		await Promise.all([first, second]);
		release();
		await settle();
		await pi.emit("session_shutdown", ctx);
		expect(calls).toHaveLength(1);
	});
});
