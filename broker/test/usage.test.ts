import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("usage roster refresh", () => {
	test("keeps cached reports when the aggregate probe aborts", async () => {
		const home = mkdtempSync(join(tmpdir(), "deck-usage-"));
		process.env.DECK_HOME = home;
		try {
			const paths = await import("../src/paths");
			paths.ensureDirs();
			paths.writeJsonAtomic(paths.USAGE_JSON, {
				generatedAt: "2020-01-01T00:00:00.000Z",
				accounts: [],
				reports: [{ provider: "anthropic", metadata: { email: "cached@example.com" }, limits: [] }],
			});
			const { refreshUsageRoster } = await import("../src/usage");
			const storage = {
				fetchUsageReports: async () => { throw new Error("provider timeout"); },
				exportSnapshot: () => ({ credentials: [] }),
			} as any;
			const roster = await refreshUsageRoster(storage);
			expect(roster.reports).toHaveLength(1);
			expect(roster.reports[0]?.metadata).toEqual({ email: "cached@example.com" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
