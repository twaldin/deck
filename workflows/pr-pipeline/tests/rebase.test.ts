import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bunExec, execOrThrow } from "../lib/gh.ts";
import { assertBoundedRebase, rebaseAndPush } from "../lib/rebase.ts";

interface Fixture {
	root: string;
	origin: string;
	worktree: string;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	return execOrThrow(bunExec, ["git", ...args], { cwd });
}

async function commitFile(worktree: string, name: string, body: string, message: string): Promise<string> {
	fs.writeFileSync(path.join(worktree, name), body);
	await git(worktree, "add", name);
	await git(worktree, "commit", "-m", message);
	return (await git(worktree, "rev-parse", "HEAD")).trim();
}

async function fixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-bounded-rebase-"));
	roots.push(root);
	const origin = path.join(root, "origin.git");
	const worktree = path.join(root, "worktree");
	fs.mkdirSync(worktree);
	await execOrThrow(bunExec, ["git", "init", "--bare", origin]);
	await git(worktree, "init", "-b", "main");
	await git(worktree, "config", "user.name", "Deck Rebase Test");
	await git(worktree, "config", "user.email", "deck-rebase@example.test");
	await git(worktree, "config", "commit.gpgsign", "false");
	await git(worktree, "remote", "add", "origin", origin);
	await commitFile(worktree, "base.txt", "base\n", "base");
	await git(worktree, "push", "-u", "origin", "main");
	await git(worktree, "checkout", "-b", "feature");
	await commitFile(worktree, "feature.txt", "feature\n", "feature");
	await git(worktree, "push", "-u", "origin", "feature");
	return { root, origin, worktree };
}

async function advanceBase(worktree: string, baseBranch = "main"): Promise<void> {
	await git(worktree, "checkout", baseBranch);
	await commitFile(worktree, `${baseBranch.replaceAll("/", "-")}-advance.txt`, "advance\n", `advance ${baseBranch}`);
	await git(worktree, "push", "origin", baseBranch);
	await git(worktree, "checkout", "feature");
}

describe("assertBoundedRebase", () => {
	test("allows a clean rebase made only from commits already on the remote PR branch", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();

		const actions = await rebaseAndPush(bunExec, {
			git: "git",
			worktree: repo.worktree,
			branch: "feature",
			baseBranch: "main",
			testCommand: "true",
			expectedRemoteHead,
		});

		expect(actions).toContain("bounded rebase verified");
		expect((await git(repo.worktree, "rev-parse", "HEAD")).trim()).toBe(
			(await git(repo.worktree, "rev-parse", "origin/feature")).trim(),
		);
	});
	test("rebases onto a base update fetched from a separate clone", async () => {
		const repo = await fixture();
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();
		const basePusher = path.join(repo.root, "base-pusher");
		await execOrThrow(bunExec, [
			"git",
			"clone",
			"--branch",
			"main",
			repo.origin,
			basePusher,
		]);
		await git(basePusher, "config", "user.name", "Base Update Test");
		await git(basePusher, "config", "user.email", "base-update@example.test");
		await commitFile(basePusher, "external-base.txt", "new base\n", "external base update");
		await git(basePusher, "push", "origin", "main");

		await rebaseAndPush(bunExec, {
			git: "git",
			worktree: repo.worktree,
			branch: "feature",
			baseBranch: "main",
			expectedRemoteHead,
			testCommand: "true",
		});
		expect(
			(await Bun.spawn(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"], {
				cwd: repo.worktree,
			}).exited),
		).toBe(0);
	});

	test("rejects a local branch that does not descend from the trusted PR head", async () => {
		const repo = await fixture();
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();
		await git(repo.worktree, "checkout", "--orphan", "rewritten");
		await git(repo.worktree, "rm", "-rf", ".");
		const unrelated = await commitFile(
			repo.worktree,
			"unrelated.txt",
			"unrelated\n",
			"unrelated root",
		);
		await git(repo.worktree, "branch", "-D", "feature");
		await git(repo.worktree, "branch", "-m", "feature");

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
				runCommitShas: [unrelated],
			}),
		).rejects.toThrow(/is not an ancestor of local HEAD/);
	});


	test("rejects a local commit that was neither on the PR branch nor attributed to this run", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		await commitFile(repo.worktree, "foreign.txt", "foreign\n", "unrelated foreign commit");
		const remoteBefore = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead: remoteBefore,
				testCommand: "true",
			}),
		).rejects.toThrow(/do not exactly match this run's persisted commits/);
		expect((await git(repo.worktree, "ls-remote", "origin", "refs/heads/feature")).split("\t")[0]).toBe(
			remoteBefore,
		);
	});

	test("keeps the final force-with-lease bound across an out-of-band push during validation", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();
		const attacker = path.join(repo.root, "attacker");
		await execOrThrow(bunExec, [
			"git",
			"clone",
			"--branch",
			"feature",
			repo.origin,
			attacker,
		]);
		await git(attacker, "config", "user.name", "Out of Band Test");
		await git(attacker, "config", "user.email", "out-of-band@example.test");
		const attackerHead = await commitFile(
			attacker,
			"out-of-band.txt",
			"remote moved\n",
			"out-of-band push",
		);
		const mutateRemote = path.join(repo.root, "mutate-remote.sh");
		fs.writeFileSync(
			mutateRemote,
			`#!/bin/sh\ngit -C ${JSON.stringify(attacker)} push origin feature\n`,
		);
		fs.chmodSync(mutateRemote, 0o755);

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: `sh ${JSON.stringify(mutateRemote)}`,
			}),
		).rejects.toThrow(/force-with-lease/);
		expect(
			(await git(repo.worktree, "ls-remote", "origin", "refs/heads/feature")).split("\t")[0],
		).toBe(attackerHead);
	});
	test("rejects when the fetched tracking ref moves beyond the trusted PR head", async () => {
		const repo = await fixture();
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();
		const attacker = path.join(repo.root, "tracking-ref-attacker");
		await execOrThrow(bunExec, [
			"git",
			"clone",
			"--branch",
			"feature",
			repo.origin,
			attacker,
		]);
		await git(attacker, "config", "user.name", "Tracking Ref Test");
		await git(attacker, "config", "user.email", "tracking-ref@example.test");
		await commitFile(attacker, "moved.txt", "moved\n", "move trusted ref");
		await git(attacker, "push", "origin", "feature");
		await git(repo.worktree, "fetch", "origin", "feature");

		await expect(
			assertBoundedRebase(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
			}),
		).rejects.toThrow(/moved from trusted head/);
	});


	test("allows an unpushed commit explicitly attributed to this durable run", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		const runCommit = await commitFile(repo.worktree, "run-fix.txt", "fixed\n", "fix from this run");
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
				runCommitShas: [runCommit],
			}),
		).resolves.toContain("force-with-lease pushed feature");
	});

	test("rejects detached and wrong-branch worktrees", async () => {
		const repo = await fixture();
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();
		await git(repo.worktree, "checkout", "--detach");
		await expect(
			assertBoundedRebase(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
			}),
		).rejects.toThrow(/worktree HEAD is on "detached", not "feature"/);
	});

	test("accepts a stacked PR whose trusted base is a non-main parent branch", async () => {
		const repo = await fixture();
		await git(repo.worktree, "checkout", "main");
		await git(repo.worktree, "checkout", "-b", "stack-parent");
		await commitFile(repo.worktree, "parent.txt", "parent\n", "stack parent");
		await git(repo.worktree, "push", "-u", "origin", "stack-parent");
		await git(repo.worktree, "checkout", "-B", "feature", "stack-parent");
		await commitFile(repo.worktree, "stack-child.txt", "child\n", "stack child");
		await git(repo.worktree, "push", "--force", "origin", "feature");
		await git(repo.worktree, "fetch", "origin", "stack-parent", "feature");
		const expectedRemoteHead = (await git(repo.worktree, "rev-parse", "origin/feature")).trim();

		await expect(
			assertBoundedRebase(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "stack-parent",
				expectedRemoteHead,
			}),
		).resolves.toBeUndefined();
	});
});
