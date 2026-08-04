import { describe, expect, test } from "bun:test";
import { buildUsageText } from "../src/monitor";
import { usageStatusLine, type UsageRoster } from "../src/usage-roster";

describe("footer usage roster", () => {
	test("renders compact provider quota bars", () => {
		const roster: UsageRoster = {
			reports: [
				{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.91 } }] },
				{ provider: "openai-codex", limits: [{ window: { id: "7d" }, amount: { remainingFraction: 0.86 } }] },
			],
		};
		const line = usageStatusLine(roster);
		expect(line).toContain("claude 5h");
		expect(line).toContain("91%");
		expect(line).toContain("codex 7d");
		expect(line).toContain("86%");
	});

	test("averages account headroom into one provider/window cell", () => {
		const roster: UsageRoster = {
			reports: [
				{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.9 } }] },
				{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.6 } }] },
				{ provider: "anthropic", limits: [{ window: { id: "5h" }, amount: { remainingFraction: 0.3 } }] },
			],
		};
		const line = usageStatusLine(roster);
		expect(line).toBe("claude 5h ████░░ 60%");
	});

	test("keeps tiered windows and label-only limits separate", () => {
		const line = usageStatusLine({
			reports: [
				{
					provider: "anthropic",
					limits: [
						{ id: "anthropic:7d:fable", window: { id: "7d" }, scope: { tier: "fable" }, amount: { remainingFraction: 0.5 } },
						{ id: "anthropic:7d", window: { id: "7d" }, amount: { remainingFraction: 0.7 } },
						{ id: "anthropic:7d:model", window: { id: "7d" }, scope: { modelId: "model" }, amount: { remainingFraction: 0.2 } },
						{ label: "credits", amount: { remainingFraction: 0.9 } },
						{ label: "other", amount: { remainingFraction: 0.3 } },
					],
				},
			],
		});
		expect(line).toContain("7d ████░░ 70%");
		expect(line).toContain("7d·fable ███░░░ 50%");
		expect(line).toContain("7d █░░░░░ 20%");
		expect(line).toContain("credits █████░ 90%");
		expect(line).toContain("other ██░░░░ 30%");
	});

	test("renders account statuses and roster age", () => {
		const text = buildUsageText({
			generatedAt: new Date(Date.now() - 12_000).toISOString(),
			accounts: [
				{ provider: "anthropic", email: "reported@example.com", status: "reported" },
				{ provider: "openai", email: "missing@example.com", status: "no usage API" },
				{ provider: "xai", status: "not logged in" },
			],
			reports: [{ provider: "anthropic", metadata: { email: "reported@example.com" }, limits: [] }],
		});
		expect(text).toMatch(/as of 1[0-4]s ago/);
		expect(text).toContain("missing@example.com · openai: no usage API");
		expect(text).toContain("xai · not logged in");
		expect(text).not.toContain("reported@example.com · anthropic: no usage API");
	});

	test("trusts reported account status even when report identity differs", () => {
		const text = buildUsageText({
			accounts: [{ provider: "api-key-provider", status: "reported" }],
			reports: [{ provider: "api-key-provider", metadata: { account: "key" }, limits: [] }],
		});
		expect(text).not.toContain("no usage API");
		expect(text).toContain("key · api-key-provider");
	});

	test("returns empty for a missing or empty roster", () => {
		expect(usageStatusLine(null)).toBe("");
		expect(usageStatusLine({ reports: [] })).toBe("");
	});
});
