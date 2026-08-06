import { describe, expect, test } from "bun:test";

import {
	assertGhStackMatches,
	assertLocalStackTracking,
	compareStackHeads,
	enqueueStackParentFirst,
	fetchAdoptedPrs,
	normalizeStackSpecs,
	nextStackMergeCar,
	parseGhStackView,
	rebaseStackUpstack,
	submitStack,
	syncStackPrune,
	validateAdoptedStack,
	verifyStackImplementation,
	type AdoptedPrLive,
} from "../lib/adopt.ts";
import type { ExecFn } from "../lib/gh.ts";
import { evaluateWatchExit } from "../lib/watch.ts";
import type { WatchSnapshot } from "../lib/types.ts";
import { buildApprovalStampMetadata, inputSchema, stackInputSchema } from "../pipeline.tsx";

const livePr = (overrides: Partial<AdoptedPrLive> = {}): AdoptedPrLive => ({
	number: 11,
	url: "https://github.com/org/repo/pull/11",
	state: "open",
	merged: false,
	draft: false,
	headRefName: "stack/parent",
	headSha: "sha-parent",
	baseRefName: "main",
	headRepoFullName: "org/repo",
	...overrides,
});

const liveStack = (): AdoptedPrLive[] => [
	livePr(),
	livePr({
		number: 12,
		url: "https://github.com/org/repo/pull/12",
		headRefName: "stack/child",
		headSha: "sha-child",
		baseRefName: "stack/parent",
	}),
];

const viewJson = (numbers = [11, 12]) =>
	JSON.stringify({
		trunk: "main",
		currentBranch: "stack/child",
		branches: [
			{
				name: "stack/parent",
				head: "sha-parent",
				base: "base-sha",
				isCurrent: false,
				isMerged: false,
				isQueued: false,
				needsRebase: false,
				pr: { number: numbers[0], url: `https://github.com/org/repo/pull/${numbers[0]}`, state: "OPEN" },
			},
			{
				name: "stack/child",
				head: "sha-child",
				base: "sha-parent",
				isCurrent: true,
				isMerged: false,
				isQueued: false,
				needsRebase: false,
				pr: { number: numbers[1], url: `https://github.com/org/repo/pull/${numbers[1]}`, state: "OPEN" },
			},
		],
	});

function routedExec(routes: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
	const calls: string[][] = [];
	const exec: ExecFn = async (argv) => {
		calls.push(argv);
		const key = argv.join(" ");
		const route = routes[key];
		return {
			code: route?.code ?? 0,
			stdout: route?.stdout ?? "",
			stderr: route?.stderr ?? "",
		};
	};
	return { exec, calls };
}

describe("stack input contract", () => {
	const run = {
		ticket: "LIN-123",
		repo: "org/repo",
		worktree: "/tmp/wt",
		branch: "stack/child",
		github: { reviewPolicy: { requireHuman: false, requiredBots: [] } },
	};

	test("accepts exactly one parent-first create or adopt source", () => {
		expect(inputSchema.safeParse({
			...run,
			stack: {
				specs: [
					{ branch: "stack/parent" },
					{ branch: "stack/child", baseBranch: "stack/parent" },
				],
			},
		}).success).toBe(true);
		expect(inputSchema.safeParse({
			...run,
			stack: { existingPrNumbers: [11, 12] },
		}).success).toBe(true);
		expect(stackInputSchema.safeParse({}).success).toBe(false);
		expect(stackInputSchema.safeParse({
			specs: [{ branch: "stack/parent" }],
			existingPrNumbers: [11],
		}).success).toBe(false);
		expect(inputSchema.safeParse({
			...run,
			existingPr: 10,
			stack: { existingPrNumbers: [11, 12] },
		}).success).toBe(false);
	});

	test("treats Smithers' persisted null effort-mode columns as omitted", () => {
		expect(inputSchema.safeParse({ ...run, stack: null }).success).toBe(true);
		expect(inputSchema.safeParse({ ...run, existingPr: 10, stack: null }).success).toBe(true);
		expect(inputSchema.safeParse({
			...run,
			existingPr: null,
			stack: { existingPrNumbers: [11, 12] },
		}).success).toBe(true);
	});
});

describe("stack topology", () => {
	test("normalizes ordered create specs parent first", () => {
		expect(
			normalizeStackSpecs("main", [
				{ branch: "stack/parent", baseBranch: "main" },
				{ branch: "stack/child", baseBranch: "stack/parent" },
			]),
		).toEqual([
			{ branch: "stack/parent", baseBranch: "main" },
			{ branch: "stack/child", baseBranch: "stack/parent" },
		]);
	});

	test("rejects duplicate branches, unsafe refs, and a broken declared base", () => {
		expect(() => normalizeStackSpecs("main", [{ branch: "stack/one" }, { branch: "stack/one" }])).toThrow(/appears twice/);
		expect(() => normalizeStackSpecs("main$(bad)", [{ branch: "stack/one" }])).toThrow(/unsafe root base/);
		expect(() => normalizeStackSpecs("main", [{ branch: "stack/one" }, { branch: "stack/two", baseBranch: "main" }])).toThrow(/topology is broken/);
	});

	test("parses and validates the non-interactive gh stack view contract", () => {
		const view = parseGhStackView(viewJson());
		expect(view.currentBranch).toBe("stack/child");
		expect(view.branches.map((branch) => branch.pr?.number)).toEqual([11, 12]);
		expect(() => assertGhStackMatches(view, "main", ["stack/parent", "stack/child"])).not.toThrow();
		expect(() => assertGhStackMatches(view, "main", ["stack/child", "stack/parent"])).toThrow(/does not match declared parent-first order/);
	});
});

describe("existing stack adoption", () => {
	test("validates a parent-first live chain and preserves every stamped head", () => {
		expect(validateAdoptedStack("org/repo", "main", [11, 12], liveStack())).toEqual([
			{
				prNumber: 11,
				url: "https://github.com/org/repo/pull/11",
				branch: "stack/parent",
				baseBranch: "main",
				headSha: "sha-parent",
				landed: false,
			},
			{
				prNumber: 12,
				url: "https://github.com/org/repo/pull/12",
				branch: "stack/child",
				baseBranch: "stack/parent",
				headSha: "sha-child",
				landed: false,
			},
		]);
	});

	test("rejects duplicate numbers and live head/base/repo/state defects", () => {
		expect(() => validateAdoptedStack("org/repo", "main", [11, 11], liveStack())).toThrow(/appears twice/);
		expect(() => validateAdoptedStack("org/repo", "main", [11, 12], [liveStack()[0], { ...liveStack()[1], baseRefName: "main" }])).toThrow(/parent-first topology requires "stack\/parent"/);
		expect(() => validateAdoptedStack("org/repo", "main", [11, 12], [liveStack()[0], { ...liveStack()[1], headRepoFullName: "fork/repo" }])).toThrow(/head lives in "fork\/repo"/);
		expect(() => validateAdoptedStack("org/repo", "main", [11, 12], [{ ...liveStack()[0], state: "closed" }, liveStack()[1]])).toThrow(/state is "closed"/);
		expect(() => validateAdoptedStack("org/repo", "main", [11, 12], [liveStack()[0], { ...liveStack()[1], draft: true }])).toThrow(/draft/);
	});

	test("accepts a landed prefix only when GitHub retargets the remaining child to trunk", () => {
		const records = validateAdoptedStack("org/repo", "main", [11, 12], [
			{ ...liveStack()[0], state: "closed", merged: true },
			{ ...liveStack()[1], baseRefName: "main" },
		]);
		expect(records[0].landed).toBe(true);
		expect(records[1].baseBranch).toBe("main");
		expect(() => validateAdoptedStack("org/repo", "main", [11, 12], [liveStack()[0], { ...liveStack()[1], state: "closed", merged: true }])).toThrow(/landed PR appears above an unlanded parent/);
	});

	test("fetches only the declared PR records and never invokes a create or submit command", async () => {
		const live = liveStack();
		const { exec, calls } = routedExec({
			"gh api repos/org/repo/pulls/11": { stdout: JSON.stringify({ ...live[0], html_url: live[0].url, head: { ref: live[0].headRefName, sha: live[0].headSha, repo: { full_name: live[0].headRepoFullName } }, base: { ref: live[0].baseRefName } }) },
			"gh api repos/org/repo/pulls/12": { stdout: JSON.stringify({ ...live[1], html_url: live[1].url, head: { ref: live[1].headRefName, sha: live[1].headSha, repo: { full_name: live[1].headRepoFullName } }, base: { ref: live[1].baseRefName } }) },
		});
		const fetched = await fetchAdoptedPrs(exec, "org/repo", [11, 12]);
		expect(fetched.map((pr) => pr.number)).toEqual([11, 12]);
		expect(calls).toEqual([
			["gh", "api", "repos/org/repo/pulls/11"],
			["gh", "api", "repos/org/repo/pulls/12"],
		]);
		expect(calls.some((argv) => argv.includes("create") || argv.includes("submit"))).toBe(false);
	});

	test("requires matching local gh-stack tracking before adoption can proceed", async () => {
		const tracked = routedExec({
			"gh stack view --json": { stdout: viewJson() },
		});
		const view = await assertLocalStackTracking(tracked.exec, {
			gh: "gh",
			worktree: "/tmp/wt",
			rootBaseBranch: "main",
			cars: validateAdoptedStack("org/repo", "main", [11, 12], liveStack()),
		});
		expect(view.currentBranch).toBe("stack/child");
		expect(tracked.calls).toEqual([["gh", "stack", "view", "--json"]]);

		const missing = routedExec({
			"gh stack view --json": { code: 2, stderr: "not in a stack" },
		});
		await expect(
			assertLocalStackTracking(missing.exec, {
				gh: "gh",
				worktree: "/tmp/wt",
				rootBaseBranch: "main",
				cars: validateAdoptedStack("org/repo", "main", [11, 12], liveStack()),
			}),
		).rejects.toThrow(/not locally tracked/);
		expect(missing.calls.some((argv) => argv.includes("submit") || argv.includes("create"))).toBe(false);

		const staleParent = JSON.parse(viewJson()) as {
			branches: Array<{ head: string }>;
		};
		staleParent.branches[0].head = "stale-parent";
		const stale = routedExec({
			"gh stack view --json": { stdout: JSON.stringify(staleParent) },
		});
		await expect(
			assertLocalStackTracking(stale.exec, {
				gh: "gh",
				worktree: "/tmp/wt",
				rootBaseBranch: "main",
				cars: validateAdoptedStack("org/repo", "main", [11, 12], liveStack()),
				allowTopAhead: true,
			}),
		).rejects.toThrow(/not live PR head/);
		expect(stale.calls.some((argv) => argv.includes("push"))).toBe(false);
	});
});

describe("native stack creation and maintenance", () => {
	test("initializes once, submits non-interactively, and returns live PR topology", async () => {
		const live = liveStack();
		const { exec, calls } = routedExec({
			"gh stack view --json": { code: 2, stderr: "not in a stack" },
			"gh stack init --base main stack/parent stack/child": {},
			"gh stack submit --auto --open": {},
			"gh api repos/org/repo/pulls/11": { stdout: JSON.stringify({ state: "open", merged: false, draft: false, html_url: live[0].url, head: { ref: live[0].headRefName, sha: live[0].headSha, repo: { full_name: "org/repo" } }, base: { ref: live[0].baseRefName } }) },
			"gh api repos/org/repo/pulls/12": { stdout: JSON.stringify({ state: "open", merged: false, draft: false, html_url: live[1].url, head: { ref: live[1].headRefName, sha: live[1].headSha, repo: { full_name: "org/repo" } }, base: { ref: live[1].baseRefName } }) },
		});
		let viewCalls = 0;
		const wrapped: ExecFn = async (argv, options) => {
			if (argv.join(" ") === "gh stack view --json") {
				viewCalls += 1;
				if (viewCalls === 2) return { code: 0, stdout: viewJson(), stderr: "" };
			}
			return exec(argv, options);
		};
		const records = await submitStack(wrapped, {
			gh: "gh",
			repo: "org/repo",
			worktree: "/tmp/wt",
			rootBaseBranch: "main",
			specs: [{ branch: "stack/parent" }, { branch: "stack/child" }],
		});
		expect(records.map((record) => record.prNumber)).toEqual([11, 12]);
		expect(calls.some((argv) => argv.join(" ") === "gh stack init --base main stack/parent stack/child")).toBe(true);
		expect(calls.some((argv) => argv.join(" ") === "gh stack submit --auto --open")).toBe(true);
		expect(calls.some((argv) => argv[1] === "pr" && argv[2] === "create")).toBe(false);
	});

	test("verifies each layer's exact reported commit range before publication", async () => {
		const { exec } = routedExec({
			"git fetch origin main": {},
			"git branch --show-current": { stdout: "stack/child\n" },
			"git rev-parse stack/parent^{commit}": { stdout: "head-parent\n" },
			"git rev-list --reverse origin/main..stack/parent": { stdout: "commit-parent\n" },
			"git rev-parse --verify commit-parent^{commit}": { stdout: "commit-parent\n" },
			"git rev-parse stack/child^{commit}": { stdout: "head-child\n" },
			"git rev-list --reverse stack/parent..stack/child": { stdout: "commit-child\n" },
			"git rev-parse --verify commit-child^{commit}": { stdout: "commit-child\n" },
		});
		const verified = await verifyStackImplementation(exec, {
			git: "git",
			worktree: "/tmp/wt",
			rootBaseBranch: "main",
			specs: [{ branch: "stack/parent" }, { branch: "stack/child" }],
			reported: [
				{ branch: "stack/parent", commits: ["commit-parent"] },
				{ branch: "stack/child", commits: ["commit-child"] },
			],
		});
		expect(verified.map((car) => car.headSha)).toEqual(["head-parent", "head-child"]);

		await expect(verifyStackImplementation(exec, {
			git: "git",
			worktree: "/tmp/wt",
			rootBaseBranch: "main",
			specs: [{ branch: "stack/parent" }, { branch: "stack/child" }],
			reported: [
				{ branch: "stack/parent", commits: ["wrong"] },
				{ branch: "stack/child", commits: ["commit-child"] },
			],
		})).rejects.toThrow(/reported commits/);
	});

	test("uses gh stack rebase --upstack, push, and sync --prune non-interactively", async () => {
		const { exec, calls } = routedExec({
			"git branch --show-current": { stdout: "stack/child\n" },
			"git rev-parse refs/heads/stack/parent": { stdout: "sha-parent\n" },
			"git rev-parse refs/heads/stack/child": { stdout: "sha-child\n" },
			"git rev-parse HEAD": { stdout: "sha-child\n" },
			"git rev-parse --path-format=absolute --git-path rebase-merge": {
				stdout: "/tmp/deck-stack-test-state/rebase-merge\n",
			},
			"git rev-parse --path-format=absolute --git-path rebase-apply": {
				stdout: "/tmp/deck-stack-test-state/rebase-apply\n",
			},
			"git rev-parse --path-format=absolute --git-path gh-stack-rebase-state": {
				stdout: "/tmp/deck-stack-test-state/gh-stack-rebase-state\n",
			},
			"git rev-parse --path-format=absolute --git-path REBASE_HEAD": {
				stdout: "/tmp/deck-stack-test-state/REBASE_HEAD\n",
			},
			"git rev-parse --path-format=absolute --git-path MERGE_MSG": {
				stdout: "/tmp/deck-stack-test-state/MERGE_MSG\n",
			},
			"git rev-parse --path-format=absolute --git-path MERGE_RR": {
				stdout: "/tmp/deck-stack-test-state/MERGE_RR\n",
			},
			"git rev-parse --path-format=absolute --git-path AUTO_MERGE": {
				stdout: "/tmp/deck-stack-test-state/AUTO_MERGE\n",
			},
			"gh stack rebase --upstack stack/parent --remote origin": {},
			"bash -lc bun test": {},
			"gh stack push": {},
			"gh stack view --json": { stdout: viewJson() },
			"gh stack sync --prune": {},
		});
		const actions = await rebaseStackUpstack(exec, {
			gh: "gh",
			git: "git",
			worktree: "/tmp/wt",
			rootBaseBranch: "main",
			branches: ["stack/parent", "stack/child"],
			fromBranch: "stack/parent",
			expectedRemoteHeads: {
				"stack/parent": "sha-parent",
				"stack/child": "sha-child",
			},
			testCommand: "bun test",
		});
		expect(actions[0]).toContain("gh stack rebase --upstack");
		expect(await syncStackPrune(exec, { gh: "gh", worktree: "/tmp/wt" })).toContain("sync --prune");
		expect(
			calls.some(
				(argv) =>
					argv.includes("push") &&
					argv.includes("--atomic") &&
					argv.some((arg) => arg.includes("--force-with-lease=refs/heads/stack/child:sha-child")),
			),
		).toBe(true);
	});
});

describe("stack-wide stamp and merge ordering", () => {
	const stamped = [
		{ prNumber: 11, branch: "stack/parent", baseBranch: "main", headSha: "sha-parent" },
		{ prNumber: 12, branch: "stack/child", baseBranch: "stack/parent", headSha: "sha-child" },
	];

	test("one approval metadata row carries every car's commit-bound topology", () => {
		expect(
			buildApprovalStampMetadata({
				headSha: "sha-child",
				prNumber: 12,
				headBranch: "stack/child",
				baseBranch: "stack/parent",
				cars: stamped,
			}),
		).toEqual({
			headSha: "sha-child",
			prNumber: 12,
			stackTopology: {
				cars: [
					{ prNumber: 11, branch: "stack/parent", baseBranch: "main", headSha: "sha-parent" },
					{ prNumber: 12, branch: "stack/child", baseBranch: "stack/parent", headSha: "sha-child" },
				],
			},
		});
	});

	test("does not enqueue a child until its parent has landed", () => {
		expect(nextStackMergeCar(stamped, [
			{ prNumber: 11, landed: false, submitted: false },
			{ prNumber: 12, landed: false, submitted: false },
		])?.prNumber).toBe(11);
		expect(nextStackMergeCar(stamped, [
			{ prNumber: 11, landed: false, submitted: true },
			{ prNumber: 12, landed: false, submitted: false },
		])).toBeUndefined();
		expect(nextStackMergeCar(stamped, [
			{ prNumber: 11, landed: true, submitted: true },
			{ prNumber: 12, landed: false, submitted: false },
		])?.prNumber).toBe(12);
	});

	test("one moved child invalidates the full comparison before any enqueue", async () => {
		const heads: Record<number, string> = { 11: "sha-parent", 12: "sha-child-moved" };
		const comparisons = await compareStackHeads(stamped, async (number) => heads[number]);
		expect(comparisons.map((comparison) => comparison.ok)).toEqual([true, false]);
		const enqueued: number[] = [];
		if (comparisons.every((comparison) => comparison.ok)) {
			await enqueueStackParentFirst(stamped, async (number) => {
				enqueued.push(number);
				return "queued";
			});
		}
		expect(enqueued).toEqual([]);
	});

	test("enqueues every unchanged car parent first", async () => {
		const order: number[] = [];
		const comparisons = await compareStackHeads(stamped, async (number) => number === 11 ? "sha-parent" : "sha-child");
		expect(comparisons.every((comparison) => comparison.ok)).toBe(true);
		const receipts = await enqueueStackParentFirst(stamped, async (number) => {
			order.push(number);
			return `queued ${number}`;
		});
		expect(order).toEqual([11, 12]);
		expect(receipts.map((receipt) => receipt.receipt)).toEqual(["queued 11", "queued 12"]);
	});
});

describe("stack child watch state", () => {
	test("BLOCKED solely by an open parent does not rebase but still waits for approvals", () => {
		const snapshot: WatchSnapshot = {
			headSha: "sha-child",
			lastPushAt: "2026-08-01T00:00:00Z",
			behindBy: 0,
			mergeable: "MERGEABLE",
			mergeStateStatus: "BLOCKED",
			checkRuns: [{ name: "PR Check Required", status: "completed", conclusion: "success" }],
			threads: [],
			comments: [],
			reviewers: [],
			requestedReviewers: [],
		};
		const verdict = evaluateWatchExit(snapshot, {
			selfLogins: [],
			reviewPolicy: { requireHuman: true, requiredBots: [] },
		});
		expect(verdict.rebaseRequired).toBe(false);
		expect(verdict.actionable).toBe(false);
		expect(verdict.disposition).toBe("wait");
		expect(verdict.exitOk).toBe(false);
	});
});
