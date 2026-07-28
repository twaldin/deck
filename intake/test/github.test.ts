import { describe, expect, test } from "bun:test";
import { buildSearchQueries, mergeBuckets, pickSquashCommit, type RawPr } from "../src/github";

function makeRawPr(overrides: Partial<RawPr> & { url: string }): RawPr {
	return {
		repo: "lindy-ai/lindy",
		number: 1,
		title: "t",
		author: "twaldin",
		isDraft: false,
		ci: "passing",
		reviewDecision: "none",
		requestedReviewers: [],
		baseRef: "main",
		headRef: "feat",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("pickSquashCommit", () => {
	test("matches headline ending in (#N)", () => {
		const sha = pickSquashCommit(
			[{ sha: "abc", message: "feat: do the thing (#900)\n\nlong body" }],
			900,
		);
		expect(sha).toBe("abc");
	});

	test("does not match (#N) only in the body", () => {
		const sha = pickSquashCommit(
			[{ sha: "abc", message: "revert something\n\nthis reverts (#900)" }],
			900,
		);
		expect(sha).toBeNull();
	});

	test("does not match a different or prefix-colliding number", () => {
		const commits = [
			{ sha: "a", message: "feat: other (#9001)" },
			{ sha: "b", message: "feat: other (#90)" },
		];
		expect(pickSquashCommit(commits, 900)).toBeNull();
	});

	test("tolerates trailing whitespace on the headline", () => {
		expect(pickSquashCommit([{ sha: "a", message: "fix (#12)  \nbody" }], 12)).toBe("a");
	});
});

describe("buildSearchQueries", () => {
	test("builds author + review-requested queries over all scopes", () => {
		const queries = buildSearchQueries("twaldin", ["org:lindy-ai", "user:twaldin"]);
		expect(queries).toEqual([
			{ bucket: "my-pr", query: "is:pr is:open author:twaldin archived:false org:lindy-ai user:twaldin" },
			{
				bucket: "review-owed",
				query: "is:pr is:open review-requested:twaldin archived:false org:lindy-ai user:twaldin",
			},
		]);
	});
});

describe("mergeBuckets", () => {
	test("PR in both buckets gets both, once", () => {
		const pr = makeRawPr({ url: "https://github.com/lindy-ai/lindy/pull/1" });
		const items = mergeBuckets([
			{ bucket: "my-pr", prs: [pr] },
			{ bucket: "review-owed", prs: [pr] },
		]);
		expect(items.size).toBe(1);
		expect(items.get(pr.url)?.buckets).toEqual(["my-pr", "review-owed"]);
	});

	test("distinct PRs keep their own bucket", () => {
		const mine = makeRawPr({ url: "https://github.com/lindy-ai/lindy/pull/1" });
		const owed = makeRawPr({ url: "https://github.com/lindy-ai/lindy/pull/2", number: 2, author: "other" });
		const items = mergeBuckets([
			{ bucket: "my-pr", prs: [mine] },
			{ bucket: "review-owed", prs: [owed] },
		]);
		expect(items.get(mine.url)?.buckets).toEqual(["my-pr"]);
		expect(items.get(owed.url)?.buckets).toEqual(["review-owed"]);
	});
});
