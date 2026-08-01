import { describe, expect, test } from "bun:test";
import { nativeReasoning, NATIVE_REASONING_LEVELS } from "../src/reasoning";

describe("native reasoning passthrough", () => {
	test("keeps OpenAI xhigh in the outgoing native field", () => {
		expect(nativeReasoning("openai", "xhigh")).toEqual({ provider: "openai", reasoning: "xhigh" });
	});

	test("passes an explicit Anthropic token budget untouched", () => {
		expect(nativeReasoning("anthropic", "budget:32768")).toEqual({
			provider: "anthropic",
			thinking: { type: "enabled", budget_tokens: 32768 },
		});
	});

	test("uses xAI's low/high vocabulary", () => {
		expect(nativeReasoning("xai", "high")).toEqual({ provider: "xai", reasoning_effort: "high" });
	});

	test("rejects unsupported values instead of downgrading them", () => {
		expect(() => nativeReasoning("xai", "xhigh")).toThrow("only low or high");
		expect(() => nativeReasoning("openai", "turbo")).toThrow("Unsupported openai");
		expect(() => nativeReasoning("anthropic", "high")).toThrow("budget:<tokens>");
	});

	test("publishes the provider catalog surface", () => {
		expect(NATIVE_REASONING_LEVELS.openai).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(NATIVE_REASONING_LEVELS.xai).toEqual(["low", "high"]);
	});
});
