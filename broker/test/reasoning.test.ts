import { describe, expect, test } from "bun:test";
import { clampReasoning, nativeReasoning, NATIVE_REASONING_LEVELS, supportedReasoning } from "../src/reasoning";

describe("native reasoning passthrough", () => {
	test("keeps OpenAI xhigh in the outgoing native field", () => {
		expect(nativeReasoning("openai", "xhigh")).toEqual({ provider: "openai", reasoning_effort: "xhigh" });
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
		expect(nativeReasoning("anthropic", "high")).toEqual({ provider: "anthropic", thinking: { type: "enabled", budget_tokens: 16384 } });
	});

	test("clamps unsupported named levels to the nearest model-supported level", () => {
		expect(clampReasoning("medium", supportedReasoning("grok-4.5", "xai"))).toBe("low");
		expect(clampReasoning("max", supportedReasoning("gpt-5.6-sol", "openai"))).toBe("xhigh");
		expect(() => clampReasoning("turbo", supportedReasoning("gpt-5.6-sol", "openai"))).toThrow("Unsupported reasoning effort");
	});

	test("publishes the provider catalog surface", () => {
		expect(NATIVE_REASONING_LEVELS.openai).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(NATIVE_REASONING_LEVELS.xai).toEqual(["low", "high"]);
	});
});
