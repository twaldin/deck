import { describe, expect, test } from "bun:test";
import { generatePullRequestDescription, sanitizeDescriptionInput } from "../lib/description.ts";
import { changedFilesForBranch } from "../pipeline.tsx";

describe("pull request description", () => {
	test("adds the resume warning only when the diff changes pipeline.tsx", () => {
		const base = { title: "pipeline", summary: "Improve the workflow runner for long jobs.", acceptanceCriteria: [] as string[] };
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/pipeline.tsx"] })).toContain("recut");
		expect(generatePullRequestDescription({ ...base, changedFiles: ["src/other.ts"] })).not.toContain("recut");
	});

	test("passes the real git diff output into the pipeline note path", async () => {
		const exec = async () => ({ code: 0, stdout: "a.ts\nworkflows/pr-pipeline/pipeline.tsx\nz.ts\n", stderr: "" });
		const changedFiles = await changedFilesForBranch(exec, "/tmp/worktree", "main");
		expect(generatePullRequestDescription({ title: "pipeline", summary: "pipeline", acceptanceCriteria: [], changedFiles })).toContain("recut");
	});

	test("sanitizes raw brief input before body generation", () => {
		const input = sanitizeDescriptionInput({
			title: "Fix",
<<<<<<< HEAD
			summary: "Pins the agent. See /Users/private/.deck/wt/example; captain says yolo.",
=======
			summary: "See /Users/private/.deck/wt/example and ~/.deck/wt/example; captain says yolo",
>>>>>>> bb57dc7 (fix(pipeline): wire sanitized PR descriptions)
			acceptanceCriteria: ["No orch or stamp details"],
			testing: "Managed by workflow run abc123. Tests passed in /home/user/wt.",
		});
<<<<<<< HEAD
		const serialized = JSON.stringify(input);
		expect(serialized).not.toMatch(/\/Users|\/home|\.deck|captain|yolo|orch|stamp|Managed by/i);
		expect(generatePullRequestDescription(input)).not.toMatch(/\/Users|\/home|\.deck|captain|yolo|orch|stamp|Managed by/i);
=======
		expect(input.summary).toBe("See the local worktree and the local workflow directory  says");
		expect(JSON.stringify(input)).not.toMatch(/\/Users|\.deck|captain|yolo|orch|stamp/i);
>>>>>>> bb57dc7 (fix(pipeline): wire sanitized PR descriptions)
	});

	test("denylist hits fail instead of being silently scrubbed", () => {
		expect(() => generatePullRequestDescription({ title: "Fix", summary: "captain leaked", acceptanceCriteria: [] })).toThrow(
			/internal vocabulary/,
		);
	});
});
