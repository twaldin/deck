import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { appendStatus } from "../src/events";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-deliver-"));
	process.env.DECK_V2_HOME = home;
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
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
const ctx = () => ({ mode: "tui", isIdle: () => false, hasPendingMessages: () => true, ui: undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("wake delivery", () => {
	test("queues a wake while busy through followUp", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.[0]).toMatchObject({ customType: "deck.wake", display: true });
		expect(pi.sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
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
		appendStatus("t1", "started", "one");
		appendStatus("t1", "started", "two");
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
