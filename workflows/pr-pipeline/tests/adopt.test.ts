/**
 * Adopt-path safety checks, tested WITHOUT dryRun shortcuts: fetchPrOverview
 * runs against a mocked ExecFn (real parse path), and assertAdoptable covers
 * every live rejection - closed PR, fork head, branch/base mismatch, and a
 * stale or wrong worktree.
 */

import { describe, expect, test } from "bun:test";

import { assertAdoptable, type PrOverview } from "../lib/adopt.ts";
import { fetchPrOverview, type ExecFn } from "../lib/gh.ts";

const goodOverview: PrOverview = {
	number: 777,
	url: "https://github.com/lindy-ai/lindy/pull/777",
	state: "open",
	headRefName: "fm/lin-123",
	headSha: "abc123",
	baseRefName: "main",
	headRepoFullName: "lindy-ai/lindy",
};

const goodExpectation = {
	repo: "lindy-ai/lindy",
	branch: "fm/lin-123",
	baseBranch: "main",
	worktreeBranch: "fm/lin-123",
	worktreeHead: "abc123",
};

describe("assertAdoptable", () => {
	test("a matching open same-repo PR with a synced worktree passes", () => {
		expect(() => assertAdoptable(goodOverview, goodExpectation)).not.toThrow();
	});

	test("rejects a closed PR", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, state: "closed" }, goodExpectation),
		).toThrow(/state is "closed"/);
	});

	test("rejects a fork PR (head repo differs from the run's repo)", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, headRepoFullName: "someone/lindy" }, goodExpectation),
		).toThrow(/head lives in "someone\/lindy"/);
	});

	test("rejects a deleted-fork PR (empty head repo)", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, headRepoFullName: "" }, goodExpectation),
		).toThrow(/head lives in ""/);
	});

	test("rejects a head-branch mismatch", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, headRefName: "other-branch" }, goodExpectation),
		).toThrow(/head branch is "other-branch"/);
	});

	test("rejects a base-branch mismatch (PR targets a different base than the run declares)", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, baseRefName: "release-1.2" }, goodExpectation),
		).toThrow(/targets base "release-1.2"/);
	});

	test("rejects a worktree checked out on a different branch", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeBranch: "main" }),
		).toThrow(/worktree has branch "main"/);
	});

	test("rejects a stale worktree (local HEAD differs from the PR head)", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeHead: "stale999" }),
		).toThrow(/worktree HEAD is stale999/);
	});
});

describe("fetchPrOverview (mocked gh, non-dry-run parse path)", () => {
	const payload = {
		number: 777,
		html_url: "https://github.com/lindy-ai/lindy/pull/777",
		state: "open",
		head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } },
		base: { ref: "main" },
	};

	const execReturning =
		(stdout: string, code = 0): ExecFn =>
		async () => ({ code, stdout, stderr: code === 0 ? "" : "boom" });

	test("parses number, url, state, head ref/sha/repo, and base ref from the live payload", async () => {
		const overview = await fetchPrOverview(
			{ gh: "gh", repo: "lindy-ai/lindy", exec: execReturning(JSON.stringify(payload)) },
			777,
		);
		expect(overview).toEqual(goodOverview);
	});

	test("a deleted fork (head.repo null) yields an empty headRepoFullName, which assertAdoptable rejects", async () => {
		const overview = await fetchPrOverview(
			{
				gh: "gh",
				repo: "lindy-ai/lindy",
				exec: execReturning(JSON.stringify({ ...payload, head: { ...payload.head, repo: null } })),
			},
			777,
		);
		expect(overview.headRepoFullName).toBe("");
		expect(() => assertAdoptable(overview, goodExpectation)).toThrow(/head lives in ""/);
	});

	test("a closed PR is fetched as-is and rejected by assertAdoptable", async () => {
		const overview = await fetchPrOverview(
			{
				gh: "gh",
				repo: "lindy-ai/lindy",
				exec: execReturning(JSON.stringify({ ...payload, state: "closed" })),
			},
			777,
		);
		expect(() => assertAdoptable(overview, goodExpectation)).toThrow(/not open/);
	});

	test("a gh failure surfaces as an error (no silent adopt)", async () => {
		await expect(
			fetchPrOverview({ gh: "gh", repo: "lindy-ai/lindy", exec: execReturning("", 1) }, 777),
		).rejects.toThrow(/command failed/);
	});
});
