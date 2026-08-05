import { describe, expect, test } from "bun:test";
import { diffStates, formatChangeLine, normalizePrUrl, resolveRemoval, untrackedChanges } from "../src/diff";
import type { GithubClient, PrLookup, RawPr } from "../src/github";
import type { DiffChange, IntakeState, PrItem } from "../src/schema";

const LOGIN = "example-user";

function makeItem(overrides: Partial<PrItem> & { url: string }): PrItem {
	return {
		repo: "example-org/review-project",
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
		const current = makeState([makeItem({ url: "https://github.com/example-org/review-project/pull/1" })]);
		const changes = await diffStates(makeState([]), current, LOGIN, mockClient());
		expect(changes).toEqual([
			{
				kind: "new",
				url: "https://github.com/example-org/review-project/pull/1",
				buckets: ["my-pr"],
				reviewRequested: false,
				title: "a change",
			},
		]);
		expect(formatChangeLine(changes[0]!)).toBe(
			"new\t-\thttps://github.com/example-org/review-project/pull/1\tmy-pr\ta change",
		);
	});

	test("new review-owed PR is high-signal REVIEW-REQUESTED", async () => {
		const current = makeState([
			makeItem({
				url: "https://github.com/example-org/review-project/pull/2",
				author: "someone-else",
				buckets: ["review-owed"],
				requestedReviewers: [LOGIN],
			}),
		]);
		const changes = await diffStates(makeState([]), current, LOGIN, mockClient());
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "new", reviewRequested: true });
		expect(formatChangeLine(changes[0]!)).toStartWith("new\tREVIEW-REQUESTED\t");
	});

	test("ci, review-decision, reviewer and bucket transitions each emit one line", async () => {
		const url = "https://github.com/example-org/review-project/pull/3";
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
		const url = "https://github.com/example-org/review-project/pull/4";
		const before = makeState([makeItem({ url, requestedReviewers: [] })]);
		const after = makeState([makeItem({ url, requestedReviewers: [LOGIN] })]);
		const changes = await diffStates(before, after, LOGIN, mockClient());
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "reviewers", selfRequested: true });
		expect(formatChangeLine(changes[0]!)).toBe(`reviewers\tREVIEW-REQUESTED\t${url}\t+${LOGIN}`);
	});

	test("no changes on identical states", async () => {
		const state = makeState([makeItem({ url: "https://github.com/example-org/review-project/pull/5" })]);
		expect(await diffStates(state, state, LOGIN, mockClient())).toEqual([]);
	});
});

describe("removal resolution (GitHub merge queue landing check)", () => {
	const item = makeItem({ url: "https://github.com/example-org/review-project/pull/900", number: 900 });

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
				expect(repo).toBe("example-org/review-project");
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

	test("squash-search API failure propagates \u2014 never becomes closed-without-landing", async () => {
		const client = mockClient({
			lookupPr: async () => ({ state: "closed", mergedAt: null }),
			findSquashCommit: async () => {
				throw new Error("rate limited");
			},
		});
		expect(resolveRemoval(item, client)).rejects.toThrow("rate limited");
	});

	test("lookup API failure propagates \u2014 never becomes vanished", async () => {
		const client = mockClient({
			lookupPr: async () => {
				throw new Error("gh api failed");
			},
		});
		expect(resolveRemoval(item, client)).rejects.toThrow("gh api failed");
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
		expect(formatChangeLine(changes[0]!)).toBe(`removed\t-\t${item.url}\tlanded-squash\ta change`);
	});
});

describe("line format fixtures (watcher parser contract)", () => {
	const url = "https://github.com/example-org/review-project/pull/7";
	const cases: Array<[DiffChange, string]> = [
		[
			{ kind: "new", url, buckets: ["my-pr"], reviewRequested: false, title: "t" },
			`new\t-\t${url}\tmy-pr\tt`,
		],
		[
			{ kind: "new", url, buckets: ["review-owed"], reviewRequested: true, title: "t" },
			`new\tREVIEW-REQUESTED\t${url}\treview-owed\tt`,
		],
		[
			{ kind: "removed", url, resolution: "closed-without-landing", title: "t" },
			`removed\t-\t${url}\tclosed-without-landing\tt`,
		],
		[{ kind: "ci", url, from: "passing", to: "failing" }, `ci\t-\t${url}\tpassing->failing`],
		[
			{ kind: "review-decision", url, from: "none", to: "approved" },
			`review-decision\t-\t${url}\tnone->approved`,
		],
		[
			{ kind: "reviewers", url, added: ["a"], removed: ["b"], selfRequested: false },
			`reviewers\t-\t${url}\t+a,-b`,
		],
		[
			{ kind: "buckets", url, from: ["my-pr"], to: ["my-pr", "review-owed"], reviewRequested: true },
			`buckets\tREVIEW-REQUESTED\t${url}\tmy-pr->my-pr,review-owed`,
		],
		[{ kind: "untracked", url, title: "t" }, `untracked\t-\t${url}\tt`],
	];

	test.each(cases)("stable columns: %#", (change, expected) => {
		expect(formatChangeLine(change)).toBe(expected);
		// column 1 = stable schema kind, column 2 = signal
		expect(formatChangeLine(change).split("\t")[0]).toBe(change.kind);
	});
});

describe("untracked flagging", () => {
	test("flags items missing from the tracked set, tolerant of trailing slash/case", () => {
		const state = makeState([
			makeItem({ url: "https://github.com/example-org/review-project/pull/10", number: 10 }),
			makeItem({ url: "https://github.com/example-org/review-project/pull/11", number: 11, title: "rogue" }),
		]);
		const tracked = new Set([normalizePrUrl("https://github.com/example-org/review-project/pull/10/")]);
		const changes: DiffChange[] = untrackedChanges(state, tracked);
		expect(changes).toEqual([
			{ kind: "untracked", url: "https://github.com/example-org/review-project/pull/11", title: "rogue" },
		]);
	});
});
