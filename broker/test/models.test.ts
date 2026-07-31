/**
 * Pure unit tests for the default allowlist and model index — no live broker.
 * Guards the full-catalog expansion: every bundled provider is admitted, plan
 * providers keep their exact validated ids, and bare plan ids never leak to
 * aggregator providers that re-list the same model names.
 */
import { describe, expect, test } from "bun:test";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { buildModelIndex, DEFAULT_ALLOWLIST } from "../src/models";
import { parseFastModel } from "../src/fast-gateway";

describe("default allowlist covers the full catalog", () => {
	test("every bundled provider is admitted", () => {
		for (const provider of getBundledProviders()) {
			expect(DEFAULT_ALLOWLIST[provider]).toBeDefined();
		}
	});

	test("xai-oauth and openrouter models resolve under the default allowlist", () => {
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		expect(index.resolve("xai-oauth/grok-4.5")?.provider).toBe("xai-oauth");
		expect(index.resolve("xai/grok-2")?.provider).toBe("xai");
		expect(index.resolve("openrouter/~anthropic/claude-opus-latest")?.provider).toBe("openrouter");
	});

	test("plan providers keep exact ids: legacy anthropic ids still never resolve", () => {
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		expect(index.resolve("anthropic/claude-haiku-4-5")?.provider).toBe("anthropic");
		expect(index.resolve("openai-codex/gpt-5.5")?.provider).toBe("openai-codex");
		expect(index.resolve("anthropic/claude-3-opus-20240229")).toBeUndefined();
		expect(index.resolve("claude-3-opus-20240229")).toBeUndefined();
	});

	test("bare plan ids route to the plan provider, not an aggregator re-listing", () => {
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		expect(index.resolve("claude-opus-4-6")?.provider).toBe("anthropic");
		expect(index.resolve("gpt-5.6-sol")?.provider).toBe("openai-codex");
		expect(index.resolve("glm-4.7")?.provider).toBe("zai");
	});

	test(":fast strips the suffix and selects priority for OpenAI", () => {
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		expect(parseFastModel("openai-codex/gpt-5.6-luna:fast", index.resolve)).toEqual({ modelId: "openai-codex/gpt-5.6-luna", serviceTier: "priority" });
	});

	test(":fast rejects non-OpenAI models", () => {
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		expect(() => parseFastModel("anthropic/claude-haiku-4-5:fast", index.resolve)).toThrow(":fast is supported only for OpenAI models");
	});

	test("an explicit allowlist argument still tightens down", () => {
		const index = buildModelIndex({ anthropic: ["claude-haiku-4-5"] });
		expect(index.resolve("anthropic/claude-haiku-4-5")?.provider).toBe("anthropic");
		expect(index.resolve("xai-oauth/grok-4.5")).toBeUndefined();
	});
});
