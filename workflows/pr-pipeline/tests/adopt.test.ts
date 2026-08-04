/**
 * Adopt-path safety checks, tested WITHOUT dryRun shortcuts: fetchPrOverview
 * runs against a mocked ExecFn (real parse path), and assertAdoptable covers
 * every live rejection - closed PR, fork head, branch/base mismatch, and a
 * stale or wrong worktree.
 */

import { describe, expect, test } from "bun:test";

import { assertAdoptable, cleanKnownScratchFiles, decideAdoptPush, KNOWN_SCRATCH_FILES, repoFromRemoteUrl, type PrOverview } from "../lib/adopt.ts";
import { fetchPrOverview, type ExecFn } from "../lib/gh.ts";

const goodOverview: PrOverview = {
	number: 777,
	url: "https://github.com/lindy-ai/lindy/pull/777",
	state: "open",
	draft: false,
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
	worktreeStatus: "",
	worktreeOriginUrl: "git@github.com:lindy-ai/lindy.git",
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

	test("rejects a draft PR (open state, but not mergeable until marked ready)", () => {
		expect(() =>
			assertAdoptable({ ...goodOverview, draft: true }, goodExpectation),
		).toThrow(/is a draft/);
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

	test("allows a clean descendant after a local review fix", () => {
		expect(() =>
			assertAdoptable(goodOverview, {
				...goodExpectation,
				worktreeHead: "fix456",
				allowWorktreeAhead: true,
				worktreeIsDescendant: true,
			}),
		).not.toThrow();
	});

	test("rejects an ahead flag without a proven descendant", () => {
		expect(() =>
			assertAdoptable(goodOverview, {
				...goodExpectation,
				worktreeHead: "rebased999",
				allowWorktreeAhead: true,
			}),
		).toThrow(/worktree HEAD is rebased999/);
	});

	test("allows a verified descendant even when ahead worktrees are not generally allowed", () => {
		expect(() =>
			assertAdoptable(goodOverview, {
				...goodExpectation,
				worktreeHead: "fix456",
				worktreeIsDescendant: true,
			}),
		).not.toThrow();
	});

	test("rejects a dirty worktree (modified files)", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeStatus: " M src/app.ts\n" }),
		).toThrow(/worktree is not clean/);
	});

	test("rejects a dirty worktree (untracked files)", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeStatus: "?? scratch.txt\n" }),
		).toThrow(/worktree is not clean/);
	});

	test("accepts whitespace-only status output as clean", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeStatus: "\n" }),
		).not.toThrow();
	});

	test("rejects a worktree whose origin is a different repository", () => {
		expect(() =>
			assertAdoptable(goodOverview, {
				...goodExpectation,
				worktreeOriginUrl: "git@github.com:someone/lindy.git",
			}),
		).toThrow(/worktree origin is "git@github.com:someone\/lindy.git"/);
	});

	test("rejects a worktree with an unparseable origin URL", () => {
		expect(() =>
			assertAdoptable(goodOverview, { ...goodExpectation, worktreeOriginUrl: "not-a-url" }),
		).toThrow(/unparseable/);
	});

	test("accepts https and ssh origin URL forms for the same repo", () => {
		for (const url of [
			"https://github.com/lindy-ai/lindy.git",
			"https://github.com/lindy-ai/lindy",
			"ssh://git@github.com/lindy-ai/lindy.git",
			"git@github.com:Lindy-AI/Lindy.git",
		]) {
			expect(() =>
				assertAdoptable(goodOverview, { ...goodExpectation, worktreeOriginUrl: url }),
			).not.toThrow();
		}
	});
});

describe("adopt push decision", () => {
	test("proceeds when heads match", () => {
		expect(decideAdoptPush({ worktreeHead: "abc", prHead: "abc", isAncestor: false })).toBe("proceed");
	});

	test("pushes a proven descendant", () => {
		expect(decideAdoptPush({ worktreeHead: "fix", prHead: "base", isAncestor: true })).toBe("push");
	});

	test("escalates a non-descendant", () => {
		expect(decideAdoptPush({ worktreeHead: "other", prHead: "base", isAncestor: false })).toBe("escalate");
	});
});

describe("repoFromRemoteUrl", () => {
	test.each([
		["git@github.com:lindy-ai/lindy.git", "lindy-ai/lindy"],
		["https://github.com/lindy-ai/lindy.git", "lindy-ai/lindy"],
		["https://github.com/lindy-ai/lindy", "lindy-ai/lindy"],
		["ssh://git@github.com/lindy-ai/lindy.git", "lindy-ai/lindy"],
		["https://github.com/lindy-ai/lindy/", "lindy-ai/lindy"],
		["not-a-url", ""],
		["", ""],
	])("%s -> %s", (url, expected) => {
		expect(repoFromRemoteUrl(url)).toBe(expected);
	});
});

describe("fetchPrOverview (mocked gh, non-dry-run parse path)", () => {
	const payload = {
		number: 777,
		html_url: "https://github.com/lindy-ai/lindy/pull/777",
		state: "open",
		draft: false,
		head: { ref: "fm/lin-123", sha: "abc123", repo: { full_name: "lindy-ai/lindy" } },
		base: { ref: "main" },
	};

	const calls: string[][] = [];
	const execReturning =
		(stdout: string, code = 0): ExecFn =>
		async (argv) => {
			calls.push(argv);
			return { code, stdout, stderr: code === 0 ? "" : "boom" };
		};

	test("parses number, url, state, head ref/sha/repo, and base ref from the live payload", async () => {
		const overview = await fetchPrOverview(
			{ gh: "gh", repo: "lindy-ai/lindy", exec: execReturning(JSON.stringify(payload)) },
			777,
		);
		expect(overview).toEqual(goodOverview);
		expect(calls.at(-1)).toEqual(["gh", "api", "repos/lindy-ai/lindy/pulls/777"]);
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

	test("a draft PR is fetched with draft=true and rejected by assertAdoptable", async () => {
		const overview = await fetchPrOverview(
			{
				gh: "gh",
				repo: "lindy-ai/lindy",
				exec: execReturning(JSON.stringify({ ...payload, draft: true })),
			},
			777,
		);
		expect(overview.draft).toBe(true);
		expect(() => assertAdoptable(overview, goodExpectation)).toThrow(/is a draft/);
	});

	test("a payload without a draft field parses as draft=false", async () => {
		const { draft: _omit, ...noDraft } = payload;
		const overview = await fetchPrOverview(
			{ gh: "gh", repo: "lindy-ai/lindy", exec: execReturning(JSON.stringify(noDraft)) },
			777,
		);
		expect(overview.draft).toBe(false);
	});

	test("a gh failure surfaces as an error (no silent adopt)", async () => {
		await expect(
			fetchPrOverview({ gh: "gh", repo: "lindy-ai/lindy", exec: execReturning("", 1) }, 777),
		).rejects.toThrow(/command failed/);
	});
});

test("cleanKnownScratchFiles removes every known scratch file", () => {
	const removed: string[] = [];
	cleanKnownScratchFiles("/tmp/worktree", (file) => removed.push(file));
	expect(removed).toEqual(KNOWN_SCRATCH_FILES.map((file) => `/tmp/worktree/${file}`));
});
