import { describe, expect, test } from "bun:test";
import {
	assertTeamFacingPullRequestDescription,
	formatPullRequestTitle,
	generatePullRequestDescription,
	PULL_REQUEST_GENERATION_INSTRUCTION,
	sanitizeDescriptionInput,
} from "../lib/description.ts";
import { changedFilesForBranch } from "../pipeline.tsx";

const safeInput = (overrides: Partial<Parameters<typeof sanitizeDescriptionInput>[0]> = {}) =>
	sanitizeDescriptionInput({
		title: "fix(deck): Improve pull request descriptions",
		summary: "Reviewers need a clear explanation of the product change. The behavior is now explicit.",
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

	test.each([
		["an internal decision wrapper", "Captain decided fallback X because Y"],
		["an internal file reference", "DECISIONS-FOR-.md records that fallback X is required because Y."],
	] as const)("fails closed on %s instead of deleting its product claim", (_case, summary) => {
		expect(() =>
			generatePullRequestDescription(
				sanitizeDescriptionInput({
					title: "fix(evals): Preserve fallback behavior",
					summary,
					acceptanceCriteria: [],
				}),
			),
		).toThrow(/summary contains internal context.*regenerate it in team-facing English/);
	});

	test("fails closed instead of deleting an acceptance criterion", () => {
		expect(() =>
			generatePullRequestDescription(
				sanitizeDescriptionInput({
					title: "fix(evals): Preserve fallback behavior",
					summary: "Fallback behavior must remain stable. The failure reason must stay visible.",
					acceptanceCriteria: ["Captain requires fallback X because Y."],
				}),
			),
		).toThrow(/acceptance criterion 1 contains internal context.*regenerate it in team-facing English/);
	});

	test("rejects an empty summary instead of publishing a generic fallback", () => {
		expect(() =>
			generatePullRequestDescription(
				sanitizeDescriptionInput({
					title: "fix(evals): Preserve fallback behavior",
					summary: " ",
					acceptanceCriteria: ["Fallback X remains because Y."],
				}),
			),
		).toThrow(/summary is empty.*regenerate it in team-facing English/);
	});

	test("revalidates changed files at the runtime generation boundary", () => {
		const forgedInput = {
			...safeInput(),
			changedFiles: ["/Users/private/.deck/wt/src/internal.ts"],
		};
		expect(() => generatePullRequestDescription(forgedInput)).toThrow(
			/changed file 1 contains internal context.*regenerate it in team-facing English/,
		);
	});

	test("formats the documented plain brief without losing its one-sentence summary", () => {
		const input = sanitizeDescriptionInput({
			title: formatPullRequestTitle("TEST-1", "Add rate limiting to /api/foo"),
			summary: "Rate-limit the /api/foo endpoint to 100 requests per minute per user.",
			acceptanceCriteria: ["429 after 100 req/min"],
		});
		const body = generatePullRequestDescription(input);
		expect(input.title).toBe("[TEST-1] Add rate limiting to /api/foo");
		expect(body).toContain("Rate-limit the /api/foo endpoint to 100 requests per minute per user.");
		expect(body).toContain("It must satisfy this acceptance criterion: 429 after 100 req/min.");
		expect(body).toContain("- 429 after 100 req/min");
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
		["a bare internal doctrine reference", "DOCTRINE"],
		["a parenthetical internal doctrine reference", "DOCTRINE (evening)"],
		["an underscored doctrine reference", "DOCTRINE_2026-08-04"],
		["an internal document inside a URL", "https://example.com/DECISIONS-FOR-.md"],
		["an internal codename inside a URL", "https://example.com/ali-eval-fix-1"],
		["an internal run identifier inside a URL", "https://example.com/task?run_id=abc"],
		["an internal deck path inside a URL", "https://example.com/.deck/common/REPORT.md"],
		["a dated internal meeting reference", "MEETING FOLD-IN 2026-08-04"],
		["a hyphenated internal meeting reference", "MEETING-FOLD-IN 2026-08-04"],
		["an underscored internal meeting reference", "MEETING_FOLD_IN 2026-08-04"],
		["an internal effort codename", "ali-eval-fix-1"],
		["a machine path", "/Users/private/.deck/data/effort/REPORT.md"],
		["a comma-separated machine path", "see foo,/Users/tim/.deck/run"],
		["a nested deck path", "repo/.deck/config"],
		["an absolute usr path", "/usr/local/bin/node"],
		["an absolute volume path", "/Volumes/work/repo"],
		["an absolute data path", "/data/build/output"],
		["an absolute var path", "/var/lib/deck/output.json"],
		["an effort identifier", "effort id: abc12345"],
		["a lane identifier", "lane id: release_42"],
		["generated-agent attribution", "\nGenerated by Tim's agent."],
		["an inline generated-agent attribution", "This PR was generated by Tim's agent."],
		["a standalone generator attribution", "\nGenerated by Claude."],
		["generic agent attribution", "\nGenerated by the agent."],
		["generic inline agent attribution", "This was generated by the agent."],
		["named inline agent attribution", "This change was prepared by Tim's agent."],
		["a standing-rules reference", "STANDING-RULES"],
		["an underscore standing-rules reference", "STANDING_RULES"],
		["an effort dossier reference", "implementation dossier"],
		["an internal lane name", "Lane A1"],
		["a run identifier", "run id: abc12345"],
		["a short run identifier", "run id: 42"],
		["a short effort identifier", "effort id: X"],
		["a short lane identifier", "lane id: A1"],
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
			/internal context or malformed text/,
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
				"## Summary\nThe behavior is clear. The reason stays visible.\n\n## Testing\nTests passed.\n\n   ### Test plan\nDo not use this section.",
			),
		).toThrow(/Test plan/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe behavior is clear. The reason stays visible.\n\n## Testing\nTests passed.\n\n# Internals\nPrivate details.",
			),
		).toThrow(/unsupported heading level/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe behavior is clear. The reason stays visible.\n\n## Testing\nTests passed.\n\nTest plan\n=========\nDo not use this section.",
			),
		).toThrow(/Test plan/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe behavior is clear. The reason stays visible.\n\n## Testing\nTests passed.\n\nInternals\n=========\nPrivate details.",
			),
		).toThrow(/Setext heading/);
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe behavior is clear. The reason stays visible.\n\n## Testing\nTests passed.\n\n###",
			),
		).toThrow(/unsupported heading level/);
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

	test("the final assertion checks checklist prose after its Markdown bullet", () => {
		expect(() =>
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe fallback remains stable. Its reason stays visible.\n\n## Testing\nThe focused test passed.\n\n## Checklist\n- -decided fallback policy",
			),
		).toThrow(/malformed text/);
		expect(
			assertTeamFacingPullRequestDescription(
				"## Summary\nThe fallback remains stable. Its reason stays visible.\n\n## Testing\nThe focused test passed.\n\n## Checklist\n- Approved fallback behavior remains stable.",
			),
		).toContain("Approved fallback behavior");
	});

	test("fails closed when the summary violates its sentence or word limits", () => {
		expect(() =>
			generatePullRequestDescription(safeInput({ summary: "Only one sentence is present." })),
		).toThrow(/one sentence and no acceptance criterion/);
		const overlongSummary = `${Array.from({ length: 78 }, () => "detail").join(" ")}. The reason remains visible.`;
		expect(() => generatePullRequestDescription(safeInput({ summary: overlongSummary }))).toThrow(
			/at most 80 words/,
		);
	});

	test("counts sentence endings before closing quotes", () => {
		expect(
			generatePullRequestDescription(
				safeInput({
					summary: 'The API returns "ready." The client continues.',
				}),
			),
		).toContain('The API returns "ready." The client continues.');
	});

	test("requires a Lindy title format before publication", () => {
		expect(() => generatePullRequestDescription(safeInput({ title: "Upgrade routing" }))).toThrow(/PR title must use/);
		expect(() => formatPullRequestTitle("LIN-604", "Upgrade routing\nInternal trailer")).toThrow(
			/single line/,
		);
		expect(generatePullRequestDescription(safeInput({ title: "fix(web): Upgrade routing" }))).toContain("## Summary");
		expect(generatePullRequestDescription(safeInput({ title: "[LIN-604] Upgrade routing" }))).toContain("## Summary");
	});

	test("allows public package names, versions, and URLs", () => {
		const body = generatePullRequestDescription(
			safeInput({
				summary:
					"Upgrade doctrine and react-router-dom-6 while preserving navigation behavior. See https://example.com/login?next=/home/setup for public details.",
			}),
		);
		expect(body).toContain("react-router-dom-6");
		expect(body).toContain("doctrine");
		expect(body).toContain("https://example.com/login?next=/home/setup");
	});
});
