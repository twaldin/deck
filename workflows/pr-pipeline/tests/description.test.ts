import { describe, expect, test } from "bun:test";
import { generatePullRequestDescription } from "../lib/description.ts";

describe("pull request description", () => {
	test("rewrites internal input into a team-facing template", () => {
		const output = generatePullRequestDescription({
			brief: {
				summary: "Fix the pipeline. See /Users/twaldin/.deck/wt/deck-18. READ BOTH FIRST.",
				acceptanceCriteria: ["No local paths"],
			},
			testing: "Managed by lindy-pr-pipeline run abc123. Local review nits (non-blocking):\n- nit",
		});
		expect(output).toContain("## Problem");
		expect(output).toContain("## Fix");
		expect(output).toContain("## Testing");
		expect(output).toContain("## Notes");
		expect(output).not.toContain("/Users/");
		expect(output).not.toContain("Managed by");
		expect(output).not.toContain("Local review nits");
		expect(output).not.toContain("READ BOTH");
	});
});
