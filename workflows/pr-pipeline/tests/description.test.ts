import { describe, expect, test } from "bun:test";
import {
	assertTeamFacingPullRequestDescription,
	generatePullRequestDescription,
	PULL_REQUEST_GENERATION_INSTRUCTION,
	sanitizeDescriptionInput,
} from "../lib/description.ts";
import { changedFilesForBranch } from "../pipeline.tsx";

const safeInput = (overrides: Partial<Parameters<typeof sanitizeDescriptionInput>[0]> = {}) =>
	sanitizeDescriptionInput({
		title: "fix(deck): Improve pull request descriptions",
		summary: "Reviewers need a clear explanation of the product change.",
		acceptanceCriteria: [],
		...overrides,
	});

describe("pull request description", () => {
	test("adds the restart note only when the diff changes pipeline.tsx", () => {
		expect(generatePullRequestDescription(safeInput({ changedFiles: ["src/pipeline.tsx"] }))).toContain(
			"Start new runs after merge",
		);
		expect(generatePullRequestDescription(safeInput({ changedFiles: ["src/other.ts"] }))).not.toContain(
			"Start new runs after merge",
		);
	});

	test("passes the real git diff output into the pipeline note path", async () => {
		const exec = async () => ({ code: 0, stdout: "a.ts\nworkflows/pr-pipeline/pipeline.tsx\nz.ts\n", stderr: "" });
		const changedFiles = await changedFilesForBranch(exec, "/tmp/worktree", "main");
		expect(generatePullRequestDescription(safeInput({ changedFiles }))).toContain("Start new runs after merge");
	});

	test("drops private context at the boundary before generation", () => {
		const input = sanitizeDescriptionInput({
			title: "fix(deck): Explain expired sessions",
			summary: [
				"Customers lose access when a session expires.",
				"Read DECISIONS-FOR-CAPTAIN.md.",
				"DOCTRINE 2026-08-04 (evening) overrides older text.",
				"MEETING FOLD-IN 2026-08-04 defines the lane.",
				"STANDING-RULES says to use ali-eval-fix-1 in Lane A1.",
				"The effort dossier is under /Users/private/.deck/data/eval-fix.",
				"The API now returns a clear 401 response.",
			].join(" "),
			acceptanceCriteria: [
				"Expired sessions return 401 with a clear message.",
				"captain must stamp the factory lane",
			],
			testing: "The auth regression test passed. Managed by workflow run abc1234 in /home/user/wt.",
			reviewOutcome: "Round 4 approved. No auth regression remains.",
			changedFiles: ["src/auth.ts", "/Users/private/.deck/wt/src/internal.ts"],
		});
		const { formatInstruction: _, ...generationFields } = input;
		const serialized = JSON.stringify(generationFields);

		expect(serialized).not.toMatch(
			/DECISIONS-FOR|DOCTRINE|MEETING FOLD-IN|STANDING-RULES|ali-eval-fix|Lane A1|dossier|\/Users|\/home|\.deck|captain|factory|Managed by|Round 4/i,
		);
		expect(input.summary).toBe(
			"Customers lose access when a session expires. The API now returns a clear 401 response.",
		);
		expect(input.acceptanceCriteria).toEqual(["Expired sessions return 401 with a clear message."]);
		expect(input.testing).toBe("The auth regression test passed.");
		expect(input.reviewOutcome).toBe("No auth regression remains.");
		expect(input.changedFiles).toEqual(["src/auth.ts"]);

		const body = generatePullRequestDescription(input);
		expect(body).not.toMatch(/DECISIONS-FOR|DOCTRINE|MEETING FOLD-IN|ali-eval-fix|\/Users|\.deck/i);
	});

	test("carries and enforces the explicit Lindy format contract", () => {
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("[TICKET-123] Title");
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("feat(username): Title");
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("## Summary");
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("## Testing");
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("STE-100");
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain('Never add a "Test plan" section');
		expect(PULL_REQUEST_GENERATION_INSTRUCTION).toContain("Do not add agent attribution");

		const body = generatePullRequestDescription(
			safeInput({
				title: "[FHEAD-1234] Explain expired sessions",
				acceptanceCriteria: ["Expired sessions return a clear 401 response."],
				testing: "The focused auth test passed.",
				reviewOutcome: "No auth regression remains.",
				changedFiles: ["workflows/pr-pipeline/pipeline.tsx"],
			}),
		);
		expect(body.match(/^## .+$/gm)).toEqual([
			"## Summary",
			"## Testing",
			"## Checklist",
			"## Notes",
			"## Review",
		]);
		expect(body).not.toMatch(/^## Test[- ]plan/im);
		expect(body).not.toContain("-- tim's agent");
	});

	test.each([
		["a placeholder-shaped filename with an empty segment", "DECISIONS-FOR-.md"],
		["a dated internal doctrine reference", "DOCTRINE 2026-08-04 (evening)"],
		["a dated internal meeting reference", "MEETING FOLD-IN 2026-08-04"],
		["an internal effort codename", "ali-eval-fix-1"],
		["a machine path", "/Users/private/.deck/data/effort/REPORT.md"],
		["a standing-rules reference", "STANDING-RULES"],
		["an effort dossier reference", "implementation dossier"],
		["an internal lane name", "Lane A1"],
		["a run identifier", "run id: abc12345"],
		["factory vocabulary", "captain must recut the workflow seat"],
		["agent attribution", "\n-- tim's agent"],
	] as const)("the final assertion rejects %s", (_case, leakedText) => {
		expect(() =>
			assertTeamFacingPullRequestDescription(
				`## Summary\nCustomers lose access. ${leakedText}\n\n## Testing\nThe focused test passed.`,
			),
		).toThrow(/internal context/);
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
	] as const)("fails closed on %s", (_case, malformedText) => {
		expect(() => generatePullRequestDescription(safeInput({ summary: malformedText }))).toThrow(
			/internal vocabulary or malformed text/,
		);
	});

	test("fails closed on missing, empty, forbidden, and unsupported sections", () => {
		expect(() => assertTeamFacingPullRequestDescription("## Summary\nClear change.")).toThrow(/## Testing/);
		expect(() => assertTeamFacingPullRequestDescription("## Summary\n\n## Testing\nTests passed.")).toThrow(
			/empty section/,
		);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nClear change.\n\n## Testing\nTests passed.\n\n## Test plan\nDo not use this section.",
			),
		).toThrow(/Test plan/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nClear change.\n\n## Testing\nTests passed.\n\n## Internals\nPrivate details.",
			),
		).toThrow(/unsupported section/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nClear change.\n\n## Review\nApproved.\n\n## Testing\nTests passed.",
			),
		).toThrow(/out of order/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nClear change.\n\n## Testing\nTests passed.\n\n## Review\nApproved.\n\n## Review\nApproved again.",
			),
		).toThrow(/duplicated/);
	});

	test("requires a Lindy title format before publication", () => {
		expect(() => generatePullRequestDescription(safeInput({ title: "Upgrade routing" }))).toThrow(/PR title must use/);
		expect(generatePullRequestDescription(safeInput({ title: "fix(web): Upgrade routing" }))).toContain("## Summary");
		expect(generatePullRequestDescription(safeInput({ title: "[LIN-604] Upgrade routing" }))).toContain("## Summary");
	});

	test("allows public package names, versions, and URLs", () => {
		const body = generatePullRequestDescription(
			safeInput({
				summary:
					"Upgrade react-router-dom-6 while preserving navigation behavior. See https://example.com/change for public details.",
			}),
		);
		expect(body).toContain("react-router-dom-6");
		expect(body).toContain("https://example.com/change");
	});
});
