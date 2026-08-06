import { describe, expect, test } from "bun:test";
import {
	parsePrReference,
	registerDeckRecall,
	resolveEffortReference,
	type DeckRecallDependencies,
} from "../deck-recall";

interface RegisteredTool {
	name: string;
	execute(...args: unknown[]): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

describe("recall_effort argument handling", () => {
	const efforts = [
		{ id: "alpha", run_epoch: 4, pr: "https://github.com/acme/widgets/pull/17" },
		{ id: "beta", run_epoch: 2, pr: "other/tools#17" },
		{ id: "123", run_epoch: 8, pr: "#99" },
	];

	test("parses supported PR spellings", () => {
		expect(parsePrReference("17")).toEqual({ number: 17 });
		expect(parsePrReference("#17")).toEqual({ number: 17 });
		expect(parsePrReference("Acme/Widgets#17")).toEqual({ repo: "acme/widgets", number: 17 });
		expect(parsePrReference("https://github.com/Acme/Widgets/pull/17/files")).toEqual({
			repo: "acme/widgets",
			number: 17,
		});
		expect(parsePrReference("not a pr")).toBeNull();
	});

	test("prefers an exact task id and requires unique bare PRs", () => {
		expect(resolveEffortReference("123", efforts)).toEqual({ taskId: "123", epoch: 8 });
		expect(resolveEffortReference("acme/widgets#17", efforts)).toEqual({ taskId: "alpha", epoch: 4 });
		expect(() => resolveEffortReference("#17", efforts)).toThrow("ambiguous");
		expect(() => resolveEffortReference("missing", efforts)).toThrow('no Deck effort matches "missing"');
		expect(() => resolveEffortReference("   ", efforts)).toThrow("needs a task id or PR reference");
	});

	test("passes the resolved task and current epoch to buildHydration", async () => {
		const tools = new Map<string, RegisteredTool>();
		const calls: Array<[string, number]> = [];
		const dependencies: DeckRecallDependencies = {
			wake: async () => null,
			efforts: () => efforts,
			hydrate: (taskId, epoch) => {
				calls.push([taskId, epoch]);
				return { text: `hydrated ${taskId}@${epoch}`, messageIds: ["message-1"] };
			},
		};
		registerDeckRecall({
			registerTool: (tool) => tools.set(tool.name, tool as RegisteredTool),
			on() {},
			sendMessage() {},
		}, dependencies);

		const result = await tools.get("recall_effort")!.execute(
			"recall-1",
			{ effort: "https://github.com/acme/widgets/pull/17" },
			undefined,
			undefined,
			{},
		);
		expect(calls).toEqual([["alpha", 4]]);
		expect(result.content[0]?.text).toBe("hydrated alpha@4");
		expect(result.details).toEqual({ taskId: "alpha", epoch: 4, messageIds: ["message-1"] });
		await expect(tools.get("recall_effort")!.execute(
			"recall-2",
			{ effort: 17 },
			undefined,
			undefined,
			{},
		)).rejects.toThrow("needs an effort string");
	});

	test("injects memo wake at session start and once per compaction id", async () => {
		type Handler = (event: unknown, ctx: {}) => Promise<void> | void;
		const handlers = new Map<string, Handler[]>();
		const sent: Array<{
			message: { content: string; customType: string };
			options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
		}> = [];
		let wakeCalls = 0;
		registerDeckRecall({
			registerTool() {},
			on(event, handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message, options) {
				sent.push({ message, options });
			},
		}, {
			wake: async () => {
				wakeCalls += 1;
				return "global OptMem context";
			},
			efforts: () => [],
			hydrate: () => ({ text: "", messageIds: [] }),
		});

		for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
		for (const handler of handlers.get("session_compact") ?? []) {
			await handler({ compactionEntry: { id: "compact-1" } }, {});
			await handler({ compactionEntry: { id: "compact-1" } }, {});
		}

		expect(wakeCalls).toBe(2);
		expect(sent.map(({ message, options }) => ({
			content: message.content,
			customType: message.customType,
			deliverAs: options?.deliverAs,
			triggerTurn: options?.triggerTurn,
		}))).toEqual([
			{
				content: "global OptMem context",
				customType: "deck.optmem-wake.v1",
				deliverAs: "nextTurn",
				triggerTurn: false,
			},
			{
				content: "global OptMem context",
				customType: "deck.optmem-wake.v1",
				deliverAs: "steer",
				triggerTurn: false,
			},
		]);
	});
});
