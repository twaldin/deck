import { describe, expect, test } from "bun:test";
import { registerDeckRecall } from "../deck-recall";

describe("deck-recall extension", () => {
	test("registers no agent-callable tool", () => {
		const names: string[] = [];
		registerDeckRecall({ registerTool: (tool) => names.push(tool.name), on() {}, sendMessage() {} });
		expect(names).toEqual([]);
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
