import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import deckV2 from "../src/extension/index";
import { appendStatus } from "../src/events";
import { pendingWakes } from "../src/wake";
import { warnOnShadowWorkspace } from "../src/workspace";

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
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	const sent: unknown[][] = [];
	const api = {
		registerTool: () => {},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) =>
			commands.set(name, command.handler),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: sendMessage ?? ((...args: unknown[]) => { sent.push(args); }),
	};
	const emit = async (event: string, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { api, emit, sent, commands };
}
const ctx = (busy = false) => ({ mode: "tui", isIdle: () => !busy, hasPendingMessages: () => busy, ui: undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const wakeCalls = (calls: unknown[][]) =>
	calls.filter((call) => (call[0] as { customType?: string } | undefined)?.customType === "deck.wake");

describe("fleet workspace safeguards", () => {
	test("REGRESSION: shadow warning lists execution run ids only", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		fs.mkdirSync(path.join(shadow, "executions", "run-123"), { recursive: true });
		fs.mkdirSync(path.join(shadow, "lib"), { recursive: true });
		const warnings: string[] = [];
		const ids = warnOnShadowWorkspace(home, (message) => warnings.push(message));
		expect(ids).toEqual(["run-123"]);
		expect(warnings[0]).toContain("run-123");
		expect(warnings[0]).not.toContain("lib");
	});

	test("REGRESSION: an empty shadow workspace does not warn", () => {
		const shadow = path.join(home, "workflows", "pr-pipeline", ".smithers");
		fs.mkdirSync(path.join(shadow, "executions"), { recursive: true });
		const warnings: string[] = [];
		expect(warnOnShadowWorkspace(home, (message) => warnings.push(message))).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("REGRESSION: TUI fleet opens from the cached frame before Smithers ps returns", async () => {
		const bin = path.join(home, "slow-bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "bunx"), "#!/bin/sh\nsleep 1\nprintf '[]'\n");
		fs.chmodSync(path.join(bin, "bunx"), 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = bin;
		try {
			const pi = fakePi();
			let customOpened = false;
			deckV2(pi.api as never);
			const ctx = {
				mode: "tui",
				ui: {
					custom: async () => {
						customOpened = true;
					},
					setStatus: () => {},
					setWorkingVisible: () => {},
					setHiddenThinkingLabel: () => {},
					setFooter: () => {},
				},
			};
			await pi.emit("session_start", ctx);
			const fleet = pi.commands.get("fleet");
			const pending = fleet?.("", ctx);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(customOpened).toBe(true);
			await pending;
		} finally {
			process.env.PATH = previousPath;
		}
	});

	test("REGRESSION: non-TUI fleet prints a live first frame", async () => {
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "bunx"), "#!/bin/sh\nprintf '[{\\\"id\\\":\\\"live-run\\\",\\\"status\\\":\\\"running\\\"}]'\n");
		fs.chmodSync(path.join(bin, "bunx"), 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			fs.mkdirSync(path.join(home, "workflows", ".smithers"), { recursive: true });
			const pi = fakePi();
			const notifications: string[] = [];
			deckV2(pi.api as never);
			const printCtx = {
				mode: "print",
				ui: {
					notify: (value: string) => notifications.push(value),
					setWorkingVisible: () => {},
					setHiddenThinkingLabel: () => {},
					setFooter: () => {},
					setStatus: () => {},
				},
			};
			await pi.emit("session_start", printCtx);
			await pi.commands.get("fleet")?.("", printCtx);
			expect(notifications.join("\n")).toContain("live-run");
		} finally {
			process.env.PATH = previousPath;
		}
	});
});

describe("wake delivery", () => {
	test("queues a wake after a busy cycle through followUp", async () => {
		appendStatus("t1", "blocked", "main is red");
		const pi = fakePi();
		deckV2(pi.api as never);
		const busyCtx = ctx(true);
		await pi.emit("session_start", busyCtx);
		await settle();
		expect(wakeCalls(pi.sent)).toHaveLength(0);
		// A status watcher retries the durable outbox after the turn becomes idle.
		const idleCtx = ctx();
		await pi.emit("agent_settled", idleCtx);
		await pi.emit("session_start", idleCtx);
		await settle();
		const sent = wakeCalls(pi.sent);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.[0]).toMatchObject({ customType: "deck.wake", display: true });
		expect(sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
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
		expect(wakeCalls(pi.sent)).toHaveLength(1);
	});

	test("does not expose a bare user injection path", async () => {
		appendStatus("t1", "blocked", "main is red");
		const calls: unknown[][] = [];
		const pi = fakePi((...args) => { calls.push(args); });
		deckV2(pi.api as never);
		await pi.emit("session_start", ctx());
		await settle();
		expect(wakeCalls(calls)[0]?.[0]).not.toBeTypeOf("string");
	});
});
