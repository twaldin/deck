/**
 * Calm is presentation-only, so every assertion here is about what RENDERS,
 * not what is delivered: the same message/tool call must produce zero-height
 * output with Calm on and ordinary output with Calm off. Each test would go
 * red against pre-Calm code (no /calm command, no wrapped built-ins, full
 * rendering everywhere).
 *
 * These run against the real @earendil-works/pi-coding-agent package because
 * the adapters patch its live classes; a stub would prove nothing about the
 * seams they rely on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
	DECK_OPERATIONAL_PREFIX,
	calmPreferencePath,
	installCalmAssistantLayout,
	installCalmOperationalUserLayout,
	isDeckOperationalText,
	loadCalmPreference,
	persistCalmPreference,
	registerCalm,
	setCalmPresentation,
	setCalmStockExportRendering,
} from "../src/calm";

let home: string;

PiCodingAgent.initTheme();

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-calm-"));
	process.env.DECK_V2_HOME = home;
	setCalmPresentation(false);
	setCalmStockExportRendering(false);
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	setCalmPresentation(false);
	setCalmStockExportRendering(false);
});

/** renderCall paths only read theme.fg/theme.bg-style formatters. */
const fakeTheme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) =>
				typeof args[1] === "string" ? args[1] : typeof args[0] === "string" ? args[0] : "",
	},
) as never;

type FakePi = {
	tools: Array<Record<string, any>>;
	commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	handlers: Record<string, (event: unknown, ctx: any) => void>;
};

function fakePi(): FakePi & { api: any } {
	const state: FakePi = { tools: [], commands: {}, handlers: {} };
	return {
		...state,
		api: {
			registerTool: (tool: Record<string, any>) => state.tools.push(tool),
			registerCommand: (name: string, command: any) => {
				state.commands[name] = command;
			},
			on: (event: string, handler: any) => {
				state.handlers[event] = handler;
			},
		},
	};
}

function fakeUiContext() {
	const calls: Record<string, unknown[]> = {};
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			(calls[name] ??= []).push(args);
			return undefined;
		};
	return {
		calls,
		ctx: {
			ui: {
				setWorkingVisible: record("setWorkingVisible"),
				setHiddenThinkingLabel: record("setHiddenThinkingLabel"),
				getToolsExpanded: () => false,
				setToolsExpanded: record("setToolsExpanded"),
			},
		},
	};
}

describe("persisted preference", () => {
	test("defaults off, round-trips, and survives re-read", () => {
		expect(loadCalmPreference()).toBe(false);
		persistCalmPreference(true);
		expect(fs.readFileSync(calmPreferencePath(), "utf8")).toBe("on\n");
		expect(loadCalmPreference()).toBe(true);
		persistCalmPreference(false);
		expect(loadCalmPreference()).toBe(false);
	});
});

describe("operational classifier", () => {
	test("matches exactly the extension's wake prefix", () => {
		expect(isDeckOperationalText(`${DECK_OPERATIONAL_PREFIX}t1: done — PR up`)).toBe(true);
		expect(isDeckOperationalText("an ordinary captain prompt")).toBe(false);
		expect(isDeckOperationalText("[deck]no space")).toBe(false);
	});
});

describe("registerCalm", () => {
	test("wraps all seven built-ins with self shells and registers /calm", () => {
		const pi = fakePi();
		registerCalm(pi.api);
		expect(pi.tools.map((tool) => tool.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"write",
		]);
		for (const tool of pi.tools) expect(tool.renderShell).toBe("self");
		expect(typeof pi.commands.calm?.handler).toBe("function");
		expect(typeof pi.handlers.session_start).toBe("function");
	});

	test("built-in tool chrome renders zero-height with Calm on, normally off", () => {
		const pi = fakePi();
		registerCalm(pi.api);
		const read = pi.tools.find((tool) => tool.name === "read")!;
		const context = { state: {}, isPartial: false, isError: false };

		setCalmPresentation(true);
		expect(read.renderCall({ path: "/tmp/x" }, fakeTheme, context).render(60)).toEqual([]);

		setCalmPresentation(false);
		expect(
			read.renderCall({ path: "/tmp/x" }, fakeTheme, context).render(60).length,
		).toBeGreaterThan(0);
	});

	test("export rendering overrides an active Calm", () => {
		const pi = fakePi();
		registerCalm(pi.api);
		const read = pi.tools.find((tool) => tool.name === "read")!;
		setCalmPresentation(true);
		setCalmStockExportRendering(true);
		// module-level export override is what /export uses across components
		expect(
			read.renderCall({ path: "/tmp/x" }, fakeTheme, { state: {}, isPartial: false, isError: false }),
		).toBeDefined();
		// the wrapped renderCall's own exportRendering flag is session-scoped;
		// the module-level flag governs the layout adapters:
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret plan" },
				{ type: "text", text: "hello world" },
			],
		} as any;
		installCalmAssistantLayout();
		const component = new PiCodingAgent.AssistantMessageComponent(
			message,
			true,
			PiCodingAgent.getMarkdownTheme(),
			"",
			0,
		);
		component.updateContent(message);
		// export rendering active: thinking spacing stays
		expect(component.render(60).length).toBeGreaterThan(2);
	});

	test("/calm toggles persistence and thinking label together", async () => {
		const pi = fakePi();
		registerCalm(pi.api);
		const { calls, ctx } = fakeUiContext();

		await pi.commands.calm!.handler("", ctx);
		expect(loadCalmPreference()).toBe(true);
		expect(calls.setHiddenThinkingLabel).toEqual([[""]]);
		expect(calls.setWorkingVisible).toEqual([[true]]);

		await pi.commands.calm!.handler("", ctx);
		expect(loadCalmPreference()).toBe(false);
		expect(calls.setHiddenThinkingLabel).toEqual([[""], [undefined]]);
	});

	test("session_start restores the persisted choice", () => {
		const pi = fakePi();
		registerCalm(pi.api);
		persistCalmPreference(true);
		const { calls, ctx } = fakeUiContext();
		pi.handlers.session_start!({}, ctx);
		expect(calls.setHiddenThinkingLabel).toEqual([[""]]);

		const read = pi.tools.find((tool) => tool.name === "read")!;
		expect(
			read
				.renderCall({ path: "/tmp/x" }, fakeTheme, { state: {}, isPartial: false, isError: false })
				.render(60),
		).toEqual([]);
	});
});

describe("collapsed-thinking adapter", () => {
	test("removes thinking rows from the presentation copy only when Calm hides", () => {
		installCalmAssistantLayout();
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret plan" },
				{ type: "text", text: "hello world" },
			],
		} as any;
		const render = () => {
			const component = new PiCodingAgent.AssistantMessageComponent(
				message,
				true,
				PiCodingAgent.getMarkdownTheme(),
				"",
				0,
			);
			component.updateContent(message);
			return component.render(60);
		};

		setCalmPresentation(false);
		const off = render();
		setCalmPresentation(true);
		const on = render();

		expect(on.length).toBeLessThan(off.length);
		expect(on.join(" ")).toContain("hello world");
		expect(on.join(" ")).not.toContain("secret");
		// the real message object is never mutated
		expect(message.content).toHaveLength(2);
	});
});

describe("operational-user adapter", () => {
	test("deck wake rows render zero-height with Calm on and fully with Calm off", () => {
		installCalmOperationalUserLayout();
		const added: any[] = [];
		const fakeMode = {
			chatContainer: { children: [1], addChild: (component: any) => added.push(component) },
			editor: { addToHistory: () => {} },
			getMarkdownThemeWithSettings: () => PiCodingAgent.getMarkdownTheme(),
			getUserMessageText: (message: any) =>
				typeof message.content === "string" ? message.content : "",
			outputPad: 0,
		};
		(PiCodingAgent.InteractiveMode.prototype as any).addMessageToChat.call(fakeMode, {
			role: "user",
			content: `${DECK_OPERATIONAL_PREFIX}t1: done — PR up`,
		});
		expect(added).toHaveLength(1);

		setCalmPresentation(true);
		expect(added[0].render(60)).toEqual([]);

		setCalmPresentation(false);
		const lines = added[0].render(60);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join(" ")).toContain("t1: done");
	});
});
