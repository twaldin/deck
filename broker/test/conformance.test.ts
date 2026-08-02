/**
 * SPEC §6.5 conformance battery — Claude plan-limits module acceptance.
 * Runs against the LIVE broker daemon (hub process `deck-broker`).
 * Points covered here: (2) streaming. Others land as vertical slices.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CHEAP_MODEL, gatewayPost, hasLiveBroker, readSse } from "./harness";

const sseEvent = z.looseObject({ type: z.string() });
const contentDelta = z.looseObject({
	type: z.literal("content_block_delta"),
	delta: z.looseObject({ text: z.string().optional() }),
});

// The battery burns real tokens against a running deck-broker. It skips when
// none is reachable, which is also the case when a unit-test file in the same
// `bun test` process has repointed DECK_HOME at a throwaway home.
describe.skipIf(!hasLiveBroker())("SPEC 6.5 conformance", () => {
	test("(2) streaming: /v1/messages stream=true delivers SSE deltas and final usage", async () => {
		const response = await gatewayPost("/v1/messages", {
			model: CHEAP_MODEL,
			max_tokens: 32,
			stream: true,
			messages: [{ role: "user", content: "Reply with exactly: STREAM OK" }],
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const events = (await readSse(response)).map(entry => sseEvent.parse(entry.data));
		const types = events.map(event => event.type);
		expect(types).toContain("message_start");
		expect(types).toContain("content_block_delta");
		expect(types).toContain("message_stop");

		const text = events
			.filter(event => event.type === "content_block_delta")
			.map(event => contentDelta.parse(event).delta.text ?? "")
			.join("");
		expect(text).toContain("STREAM OK");
	}, 30_000);

	test("(3) tool-calls: forced tool_choice yields a parsed tool_use block", async () => {
		const response = await gatewayPost("/v1/messages", {
			model: CHEAP_MODEL,
			max_tokens: 128,
			messages: [{ role: "user", content: "Weather in Paris?" }],
			tools: [
				{
					name: "get_weather",
					description: "Get current weather for a city",
					input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
				},
			],
			tool_choice: { type: "tool", name: "get_weather" },
		});
		expect(response.status).toBe(200);
		const body = z
			.looseObject({
				stop_reason: z.string(),
				content: z.array(z.looseObject({ type: z.string() })),
			})
			.parse(await response.json());
		expect(body.stop_reason).toBe("tool_use");
		const toolUse = body.content.find(block => block.type === "tool_use");
		const parsed = z.looseObject({ name: z.string(), input: z.looseObject({ city: z.string() }) }).parse(toolUse);
		expect(parsed.name).toBe("get_weather");
		expect(parsed.input.city.toLowerCase()).toContain("paris");
	}, 30_000);

	test("(4) thinking: budgeted thinking on a reasoning model yields thinking blocks", async () => {
		// sonnet-4-5, not fable-5: the battery account's 7d fable window can be
		// exhausted (observed live); thinking support is what's under test.
		const response = await gatewayPost("/v1/messages", {
			model: "claude-sonnet-4-5",
			max_tokens: 2048,
			thinking: { type: "enabled", budget_tokens: 1024 },
			messages: [{ role: "user", content: "Is 91 prime? Answer yes or no." }],
		});
		expect(response.status).toBe(200);
		const body = z
			.looseObject({ content: z.array(z.looseObject({ type: z.string() })) })
			.parse(await response.json());
		const blockTypes = body.content.map(block => block.type);
		expect(blockTypes).toContain("thinking");
		expect(blockTypes).toContain("text");
	}, 60_000);

	test("(5) prompt caching: cache_control writes then reads the prefix cache", async () => {
		// sonnet-4-5: min cacheable prefix is 1024 tokens (haiku 4.5 needs 4096).
		// Distinct ~3.4k-token prefix per run so the first call MUST create, not read.
		const noise = `battery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const bigPrefix = `${"You are a meticulous assistant. ".repeat(420)}[run ${noise}]`;
		const makeCall = () =>
			gatewayPost("/v1/messages", {
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				system: [{ type: "text", text: bigPrefix, cache_control: { type: "ephemeral" } }],
				messages: [{ role: "user", content: "Say OK." }],
			});
		const usageShape = z.looseObject({
			usage: z.looseObject({
				cache_creation_input_tokens: z.number().nullish(),
				cache_read_input_tokens: z.number().nullish(),
			}),
		});

		const first = usageShape.parse(await (await makeCall()).json());
		expect(first.usage.cache_creation_input_tokens ?? 0).toBeGreaterThan(1000);

		const second = usageShape.parse(await (await makeCall()).json());
		expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(1000);
	}, 60_000);
});
