import { describe, expect, test } from "bun:test";
import { NoQuotaError, normalizeBlockScopes, normalizeTier, pickAccount, routeModel, tiersForModel } from "../src/quota";

describe("quota routing self-check", () => {
	test("normalizes pi-ai tier and provider-wide block scopes", () => {
		expect(normalizeTier("tier:fable")).toBe("fable-7d");
		expect(normalizeBlockScopes("")).toEqual(["all-model-5h", "all-model-7d", "fable-7d"]);
	});
	test("skips a cooling account and picks a warm account", () => {
		const model = { id: "claude-fable-5", provider: "anthropic" };
		const account = pickAccount(model, [
			{ credentialId: 1, provider: "anthropic", blocked: ["fable-7d"] },
			{ credentialId: 2, provider: "anthropic", blocked: [] },
		]);
		expect(account.credentialId).toBe(2);
	});

	test("fable uses three tiers and regular Anthropic uses two", () => {
		expect(tiersForModel({ id: "claude-fable-5", provider: "anthropic" })).toHaveLength(3);
		expect(tiersForModel({ id: "claude-sonnet-5", provider: "anthropic" })).toHaveLength(2);
	});

	test("falls back to a warm same-provider preference and emits an event", () => {
		const events: unknown[] = [];
		const result = routeModel(
			{ id: "claude-fable-5", provider: "anthropic" },
			[{ credentialId: 1, provider: "anthropic", blocked: ["fable-7d"] }],
			[{ id: "claude-sonnet-5", provider: "anthropic" }],
			event => events.push(event),
		);
		expect(result.model.id).toBe("claude-sonnet-5");
		expect(events).toHaveLength(1);
	});

	test("returns structured no-quota instead of a retryable 429", () => {
		try {
			pickAccount({ id: "claude-sonnet-5", provider: "anthropic" }, [{ credentialId: 1, provider: "anthropic", blocked: ["all-model-5h", "all-model-7d"] }]);
			throw new Error("expected no quota");
		} catch (error) {
			expect(error).toBeInstanceOf(NoQuotaError);
			expect((error as NoQuotaError).code).toBe("NO_QUOTA");
		}
	});
});
