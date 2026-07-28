import { describe, expect, test } from "bun:test";
import { diffStates, formatChangeLine, normalizePrUrl, resolveRemoval, untrackedChanges } from "../src/diff";
import type { GithubClient, PrLookup, RawPr } from "../src/github";
import type { DiffChange, IntakeState, PrItem } from "../src/schema";

const LOGIN = "twaldin";

function makeItem(overrides: Partial<PrItem> & { url: string }): PrItem {
	return {
		repo: "lindy-ai/lindy",
		number: 1,
		title: "a change",
		author: LOGIN,
		state: "open",
		isDraft: false,
		buckets: ["my-pr"],
		ci: "passing",
		reviewDecision: "review-required",
		requestedReviewers: [],
		baseRef: "main",
		headRef: "feat",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeState(items: PrItem[]): IntakeState {
	return {
		v: 1,
		generatedAt: "2026-01-01T00:00:00Z",
		items: Object.fromEntries(items.map((item) => [item.url, item])),
	};
}

/** Mock client. Tests must never hit the live API. */
function mockClient(overrides: Partial<GithubClient> = {}): GithubClient {
	return {
		searchOpenPrs: async () => [] as RawPr[],
		lookupPr: async () => null as PrLookup | null,
		findSquashCommit: async () => null,
		...overrides,
	};
}

describe("diff engine", () => {
	test("new my-PR is reported as new, not review-requested", async () => {
		const current = makeState([makeItem({ url: "https://github.com/lindy-ai/lindy/pull/1" })]);
		const changes = await diffStates(makeState([]), current, LOGIN, mockClient());
		expect(changes).toEqual([
			{
				kind: "new",
				url: "https://github.com/lindy-ai/lindy/pull/1",
				buckets: ["my-pr"],
				reviewRequested: false,
				title: "a change",
			},
		]);
		expect(formatChangeLine(changes[0]!)).toBe(
			"new\thttps://github.com/lindy-ai/lindy/pull/1\tmy-pr\ta change",
		);
	});

	test("new review-owed PR is high-signal REVIEW-REQUESTED", async () => {
		const current = makeState([
			makeItem({
				url: "https://github.com/lindy-ai/lindy/pull/2",
				author: "someone-else",
				buckets: ["review-owed"],
				requestedReviewers: [LOGIN],
			}),
		]);
		const changes = await diffStates(makeState([]), current, LOGIN, mockClient());
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "new", reviewRequested: true });
		expect(formatChangeLine(changes[0]!)).toStartWith("REVIEW-REQUESTED\t");
	});

	test("ci, review-decision, reviewer and bucket transitions each emit one line", async () => {
		const url = "https://github.com/lindy-ai/lindy/pull/3";
		const before = makeState([
			makeItem({ url, ci: "pending", reviewDecision: "review-required", requestedReviewers: ["alice"] }),
		]);
		const after = makeState([
			makeItem({
				url,
				ci: "failing",
				reviewDecision: "changes-requested",
				requestedReviewers: ["bob"],
				buckets: ["my-pr", "review-owed"],
			}),
		]);
		const changes = await diffStates(before, after, LOGIN, mockClient());
		expect(changes.map((change) => change.kind).sort()).toEqual([
			"buckets",
			"ci",
			"review-decision",
			"reviewers",
		]);
		const reviewers = changes.find((change) => change.kind === "reviewers");
		expect(reviewers).toMatchObject({ added: ["bob"], removed: ["alice"], selfRequested: false });
		const buckets = changes.find((change) => change.kind === "buckets");
		// entering review-owed = high signal
		expect(buckets).toMatchObject({ reviewRequested: true });
	});

	test("self newly requested as reviewer is high-signal", async () => {
		const url = "https://github.com/lindy-ai/lindy/pull/4";
		const before = makeState([makeItem({ url, requestedReviewers: [] })]);
		const after = makeState([makeItem({ url, requestedReviewers: [LOGIN] })]);
		const changes = await diffStates(before, after, LOGIN, mockClient());
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "reviewers", selfRequested: true });
		expect(formatChangeLine(changes[0]!)).toBe(`REVIEW-REQUESTED\t${url}\t+${LOGIN}`);
	});

	test("no changes on identical states", async () => {
		const state = makeState([makeItem({ url: "https://github.com/lindy-ai/lindy/pull/5" })]);
		expect(await diffStates(state, state, LOGIN, mockClient())).toEqual([]);
	});
});

describe("removal resolution (Graphite trap)", () => {
	const item = makeItem({ url: "https://github.com/lindy-ai/lindy/pull/900", number: 900 });

	test("merged PR resolves as merged, no squash search needed", async () => {
		let squashCalls = 0;
		const client = mockClient({
			lookupPr: async () => ({ state: "merged", mergedAt: "2026-01-02T00:00:00Z" }),
			findSquashCommit: async () => {
				squashCalls += 1;
				return null;
			},
		});
		expect(await resolveRemoval(item, client)).toBe("merged");
		expect(squashCalls).toBe(0);
	});

	test("closed+unmerged WITH squash commit on main resolves as landed-squash (the trap)", async () => {
		const client = mockClient({
			lookupPr: async () => ({ state: "closed", mergedAt: null }),
			findSquashCommit: async (repo, number) => {
				expect(repo).toBe("lindy-ai/lindy");
				expect(number).toBe(900);
				return "abc1234";
			},
		});
		expect(await resolveRemoval(item, client)).toBe("landed-squash");
	});

	test("closed+unmerged WITHOUT squash commit resolves as closed-without-landing", async () => {
		const client = mockClient({
			lookupPr: async () => ({ state: "closed", mergedAt: null }),
			findSquashCommit: async () => null,
		});
		expect(await resolveRemoval(item, client)).toBe("closed-without-landing");
	});

	test("still-open PR that left the search scope resolves as descoped", async () => {
		const client = mockClient({ lookupPr: async () => ({ state: "open", mergedAt: null }) });
		expect(await resolveRemoval(item, client)).toBe("descoped");
	});

	test("unresolvable PR resolves as vanished", async () => {
		expect(await resolveRemoval(item, mockClient())).toBe("vanished");
	});

	test("diffStates routes disappeared items through resolution", async () => {
		const before = makeState([item]);
		const client = mockClient({
			lookupPr: async () => ({ state: "closed", mergedAt: null }),
			findSquashCommit: async () => "abc1234",
		});
		const changes = await diffStates(before, makeState([]), LOGIN, client);
		expect(changes).toEqual([
			{ kind: "removed", url: item.url, resolution: "landed-squash", title: item.title },
		]);
		expect(formatChangeLine(changes[0]!)).toBe(`removed\t${item.url}\tlanded-squash\ta change`);
	});
});

describe("untracked flagging", () => {
	test("flags items missing from the tracked set, tolerant of trailing slash/case", () => {
		const state = makeState([
			makeItem({ url: "https://github.com/lindy-ai/lindy/pull/10", number: 10 }),
			makeItem({ url: "https://github.com/lindy-ai/lindy/pull/11", number: 11, title: "rogue" }),
		]);
		const tracked = new Set([normalizePrUrl("https://github.com/lindy-ai/lindy/pull/10/")]);
		const changes: DiffChange[] = untrackedChanges(state, tracked);
		expect(changes).toEqual([
			{ kind: "untracked", url: "https://github.com/lindy-ai/lindy/pull/11", title: "rogue" },
		]);
	});
});
