import { describe, expect, test } from "bun:test";
import { generatePullRequestDescription } from "../lib/description.ts";

describe("pull request description", () => {
	test("adds the resume warning only when the diff changes pipeline.tsx", () => {
		const base = { brief: { summary: "pipeline", acceptanceCriteria: [] as string[] } };
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/pipeline.tsx"] })).toContain("RESUME_METADATA_MISMATCH");
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/other.ts"] })).not.toContain("RESUME_METADATA_MISMATCH");
	});

	test("rewrites internal input into a team-facing template", () => {
		const output = generatePullRequestDescription({
			brief: {
				summary: "Fix the pipeline. See $DECK_HOME/wt/example. READ BOTH FIRST.",
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
