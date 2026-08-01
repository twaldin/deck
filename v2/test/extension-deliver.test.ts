import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { appendStatus } from "../src/events";
import { pendingWakes } from "../src/wake";

let home: string;
let savedPath: string | undefined;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-deliver-"));
	process.env.DECK_V2_HOME = home;
	savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	if (savedPath !== undefined) process.env.PATH = savedPath;
});

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi(sendMessage?: (...args: unknown[]) => unknown) {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[][] = [];
	const api = {
		registerTool: () => {}, registerCommand: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: sendMessage ?? ((...args: unknown[]) => { sent.push(args); }),
	};
	const emit = async (event: string, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { api, emit, sent };
}
const ctx = (busy = false) => ({ mode: "tui", isIdle: () => !busy, hasPendingMessages: () => busy, ui: undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("wake delivery", () => {
	test("queues a wake after a busy cycle through followUp", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const busyCtx = ctx(true);
		await pi.emit("session_start", busyCtx);
		await settle();
		expect(pi.sent).toHaveLength(0);
		// A status watcher retries the durable outbox after the turn becomes idle.
		const idleCtx = ctx();
		await pi.emit("agent_settled", idleCtx);
		await pi.emit("session_start", idleCtx);
		await settle();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.[0]).toMatchObject({ customType: "deck.wake", display: true });
		expect(pi.sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("acks a queued wake only when agent_start fires", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(pendingWakes()).toHaveLength(1);
		await pi.emit("agent_start", ctx());
		expect(pendingWakes()).toHaveLength(0);
		await pi.emit("agent_start", ctx());
		expect(pendingWakes()).toHaveLength(0);
	});

	test("keeps a queued wake owed when shutdown happens before agent_start", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(pendingWakes()).toHaveLength(1);
		await pi.emit("session_shutdown", ctx());
		expect(pendingWakes()).toHaveLength(1);
	});

	test("acks only after a successful queue call", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi(() => { throw new Error("transport"); });
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		const { pendingWakes } = await import("../src/wake");
		expect(pendingWakes()).toHaveLength(1);
	});

	test("T1 events fold into one queued message", async () => {
		appendStatus("t1", "done", "one");
		appendStatus("t1", "resolved", "two");
		const pi = fakePi();
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(pi.sent).toHaveLength(1);
	});

	test("does not expose a bare user injection path", async () => {
		appendStatus("t1", "blocked", "main is red");
		const calls: unknown[][] = [];
		const pi = fakePi((...args) => { calls.push(args); });
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(calls[0]?.[0]).not.toBeTypeOf("string");
	});
});
