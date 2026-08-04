import { describe, expect, test } from "bun:test";
import { generatePullRequestDescription } from "../lib/description.ts";
import { changedFilesForBranch } from "../pipeline.tsx";

describe("pull request description", () => {
	test("adds the resume warning only when the diff changes pipeline.tsx", () => {
		const base = { brief: { summary: "Improve the workflow runner.", acceptanceCriteria: [] as string[] } };
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/pipeline.tsx"] })).toContain("RESUME_METADATA_MISMATCH");
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/other.ts"] })).not.toContain("RESUME_METADATA_MISMATCH");
	});

	test("passes the real git diff output into the pipeline note path", async () => {
		const exec = async () => ({
			code: 0,
			stdout: "a.ts\nworkflows/pr-pipeline/pipeline.tsx\nz.ts\n",
			stderr: "",
		});
		const changedFiles = await changedFilesForBranch(exec, "/tmp/worktree", "main");
		expect(
			generatePullRequestDescription({
				brief: { summary: "Improve the workflow runner.", acceptanceCriteria: [] },
				changedFiles,
			}),
		).toContain("RESUME_METADATA_MISMATCH");
	});

	test("rewrites internal input into a team-facing template", () => {
		const output = generatePullRequestDescription({
			brief: {
				summary:
					"PR 1 of the pi eng-agent harness sequence (captain priority #1). Spec = ~/.deck/data/eng-agent-pi-map/REPORT.md. Pins the pi coding agent in the sandbox image without changing the Claude path.",
				acceptanceCriteria: ["No local paths", "captain must approve"],
			},
			testing: "Managed by lindy-pr-pipeline run abc123. Local review nits (non-blocking):\n- nit. Tests passed in /Users/foo/wt.",
		});
		expect(output).toContain("## Summary");
		expect(output).toContain("## Testing");
		expect(output).toContain("Pins the pi coding agent");
		expect(output).not.toContain("/Users/");
		expect(output).not.toContain("captain");
		expect(output).not.toContain("priority #");
		expect(output).not.toContain("Managed by");
		expect(output).not.toContain("Local review nits");
		expect(output).not.toContain("REPORT.md");
		expect(output).not.toContain("~/.deck");
		expect(output).not.toContain("must approve");
	});
});
