import { describe, expect, test } from "bun:test";
import registerDeckProvider from "../prime/deck-provider";
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

	test("rejects unknown values instead of downgrading them", () => {
		expect(nativeReasoning("xai", "xhigh")).toEqual({ provider: "xai", reasoning_effort: "xhigh" });
		expect(() => nativeReasoning("openai", "turbo")).toThrow("Unsupported openai");
		expect(nativeReasoning("anthropic", "high")).toEqual({ provider: "anthropic", thinking: { type: "enabled", budget_tokens: 16384 } });
	});

	test("clamps unsupported named levels downward", () => {
		expect(clampReasoning("max", supportedReasoning("gpt-5.5", "openai"))).toBe("xhigh");
		expect(clampReasoning("xhigh", ["low", "high"])).toBe("high");
		expect(clampReasoning("max", supportedReasoning("gpt-5.6-sol", "openai"))).toBe("max");
		expect(() => clampReasoning("turbo", supportedReasoning("gpt-5.6-sol", "openai"))).toThrow("Unsupported reasoning effort");
	});

	test("Deck model maps preserve Codex max and pass Grok selectors to broker", () => {
		let registered: { models: Array<{ id: string; thinkingLevelMap?: Record<string, string | null> }> } | undefined;
		registerDeckProvider({ registerProvider: (_name, config) => { registered = config as typeof registered; } });
		const sol = registered?.models.find(model => model.id === "gpt-5.6-sol");
		const grok = registered?.models.find(model => model.id === "grok-4.5");
		expect(sol?.thinkingLevelMap?.max).toBe("max");
		expect(sol?.thinkingLevelMap?.max).not.toBe("xhigh");
		expect(grok?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(supportedReasoning("grok-4.5", "xai")).toEqual(["low", "medium", "high"]);
		expect(clampReasoning("xhigh", supportedReasoning("grok-4.5", "xai"))).toBe("high");
	});

	test("opts only the documented Deck models into Prime Fast capability", () => {
		let registered: { models: Array<{ id: string; supportsFastMode?: boolean }> } | undefined;
		registerDeckProvider({ registerProvider: (_name, config) => { registered = config as typeof registered; } });
		const fastModels = registered?.models
			.filter(model => model.supportsFastMode)
			.map(model => model.id)
			.sort();
		expect(fastModels).toEqual([
			"gpt-5.4",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
	});

	test("publishes the provider catalog surface", () => {
		expect(NATIVE_REASONING_LEVELS.openai).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(NATIVE_REASONING_LEVELS.xai).toEqual(["low", "medium", "high"]);
	});
});
