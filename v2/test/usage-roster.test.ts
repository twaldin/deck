import { describe, expect, test } from "bun:test";
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

	test("returns empty for a missing or empty roster", () => {
		expect(usageStatusLine(null)).toBe("");
		expect(usageStatusLine({ reports: [] })).toBe("");
	});
});
