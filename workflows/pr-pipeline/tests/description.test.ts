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
			summary: "Pins the agent. See /Users/private/.deck/wt/example and ~/.deck/wt/example; captain says yolo.",
			acceptanceCriteria: ["No orch or stamp details"],
			testing: "Managed by workflow run abc123. Tests passed in /home/user/wt.",
		});
		const serialized = JSON.stringify(input);
		expect(serialized).not.toMatch(/\/Users|\/home|\.deck|captain|yolo|orch|stamp|Managed by/i);
		expect(generatePullRequestDescription(input)).not.toMatch(/\/Users|\/home|\.deck|captain|yolo|orch|stamp|Managed by/i);
	});

	test("denylist hits fail instead of being silently scrubbed", () => {
		expect(() => generatePullRequestDescription({ title: "Fix", summary: "captain leaked", acceptanceCriteria: [] })).toThrow(
			/internal vocabulary/,
		);
	});

	test.each([
		[
			"a sentence with a stripped subject",
			"-decided fallback policy (2026-08-04), recorded at the end of — read that CORRECTION section first; it supersedes the older fix-3 text.",
		],
		["a spaced dangling dash", "- decided fallback policy"],
		["a dangling colon", ": decided fallback policy"],
		["a stripped subject after prose", "The -decided fallback policy"],
		["a stripped subject after a clause label", "Fix: - decided fallback policy"],
		["a stripped subject before an em dash", "The — decided fallback policy"],
		["a stripped subject before a colon", "The : decided fallback policy"],
		["a stripped subject before a comma", "The , decided fallback policy"],
		["a placeholder-shaped filename with an empty segment", "DECISIONS-FOR-.md"],
		["a dated internal doctrine reference", "DOCTRINE 2026-08-04 (evening)"],
		["a dated internal meeting reference", "MEETING FOLD-IN 2026-08-04"],
		["an internal effort codename", "ali-eval-fix-1"],
	] as const)("fails closed on %s", (_case, leakedText) => {
		const input = sanitizeDescriptionInput({
			title: "Fix eval behavior",
			summary: leakedText,
			acceptanceCriteria: [],
		});
		expect(() => generatePullRequestDescription(input)).toThrow(/internal vocabulary or malformed text/);
	});

	test("allows public package names that end in a version", () => {
		expect(
			generatePullRequestDescription({
				title: "Upgrade routing",
				summary: "Upgrade react-router-dom-6 while preserving navigation behavior.",
				acceptanceCriteria: [],
			}),
		).toContain("react-router-dom-6");
	});
});
