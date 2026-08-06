import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bunExec, execOrThrow } from "../lib/gh.ts";
import { rebaseStackUpstack } from "../lib/adopt.ts";
import {
	assertBoundedRebase,
	RebaseDecisionRequired,
	rebaseAndPush,
	wakeRebaseConflictSeat,
} from "../lib/rebase.ts";

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

async function createTextConflict(repo: Fixture): Promise<string> {
	await git(repo.worktree, "checkout", "feature");
	fs.writeFileSync(path.join(repo.worktree, "base.txt"), "feature intent\n");
	await git(repo.worktree, "add", "base.txt");
	await git(
		repo.worktree,
		"-c",
		"user.name=Feature Author",
		"-c",
		"user.email=feature-author@example.test",
		"commit",
		"-m",
		"feature changes shared behavior",
	);
	await git(repo.worktree, "push", "origin", "feature");
	const expectedRemoteHead = (
		await git(repo.worktree, "rev-parse", "origin/feature")
	).trim();
	await git(repo.worktree, "checkout", "main");
	await commitFile(
		repo.worktree,
		"base.txt",
		"main behavior\n",
		"main changes shared behavior",
	);
	await git(repo.worktree, "push", "origin", "main");
	await git(repo.worktree, "checkout", "feature");
	return expectedRemoteHead;
}

function fakeGhStack(root: string): string {
	const script = path.join(root, "fake-gh-stack.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh
if [ "$1 $2 $3" = "stack rebase --upstack" ]; then
  git rebase origin/main
  code=$?
  if [ "$code" -ne 0 ]; then
    printf '%s' '{"currentBranchIndex":0,"conflictBranch":"feature"}' > "$(git rev-parse --git-dir)/gh-stack-rebase-state"
  fi
  exit "$code"
fi
if [ "$1 $2 $3" = "stack rebase --continue" ]; then
  git -c core.editor=true rebase --continue
  code=$?
  if [ "$code" -eq 0 ]; then rm -f "$(git rev-parse --git-dir)/gh-stack-rebase-state"; fi
  exit "$code"
fi
if [ "$1 $2 $3" = "stack rebase --abort" ]; then
  git rebase --abort >/dev/null 2>&1 || true
  rm -f "$(git rev-parse --git-dir)/gh-stack-rebase-state"
  git checkout --force feature >/dev/null 2>&1 || true
  exit 0
fi
if [ "$1 $2" = "stack push" ]; then exit 0; fi
if [ "$1 $2 $3" = "stack view --json" ]; then
  printf '%s' '{"trunk":"main","currentBranch":"feature","branches":[{"name":"feature","head":"local","base":"main","isCurrent":true,"isMerged":false,"isQueued":false,"needsRebase":false,"pr":{"number":42,"url":"https://example.test/42","state":"OPEN"}}]}'
  exit 0
fi
exit 2
`,
	);
	fs.chmodSync(script, 0o755);
	return script;
}

async function expectResidueFree(
	worktree: string,
	expectedHead?: string,
	allowMarkerLikeLines = false,
): Promise<void> {
	const reportedGitDir = (await git(worktree, "rev-parse", "--git-dir")).trim();
	const gitDir = path.isAbsolute(reportedGitDir)
		? reportedGitDir
		: path.resolve(worktree, reportedGitDir);
	for (const state of [
		"rebase-merge",
		"rebase-apply",
		"REBASE_HEAD",
		"AUTO_MERGE",
		"MERGE_MSG",
		"gh-stack-rebase-state",
		"MERGE_RR",
	]) {
		expect(fs.existsSync(path.join(gitDir, state)), state).toBe(false);
	}
	const artifactCommands = [
		["git", "ls-files", "--cached", "-z", "--", "*.orig", "*.rej"],
		["git", "ls-files", "--others", "--exclude-standard", "-z", "--", "*.orig", "*.rej"],
		[
			"git",
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			"*.orig",
			"*.rej",
		],
	];
	for (const command of artifactCommands) {
		expect((await execOrThrow(bunExec, command, { cwd: worktree })).trim()).toBe("");
	}
	if (!allowMarkerLikeLines) {
		const markers = await bunExec(
			[
				"git",
				"grep",
				"-n",
				"-I",
				"-E",
				"^(<{7,} |>{7,} )",
				"--",
				".",
			],
			{ cwd: worktree },
		);
		expect(markers.code, markers.stdout || markers.stderr).toBe(1);
	}
	expect(
		(await git(worktree, "status", "--porcelain=v1", "--untracked-files=all")).trim(),
	).toBe("");
	expect((await git(worktree, "branch", "--show-current")).trim()).toBe("feature");
	if (expectedHead !== undefined) {
		expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(expectedHead);
	}
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
	test("does not reject isolated marker-like documentation lines", async () => {
		const repo = await fixture();
		await commitFile(
			repo.worktree,
			"marker-example.txt",
			"<<<<<<< example opening only\nnormal text\n>>>>>>> example closing only\n",
			"document marker syntax",
		);
		await git(repo.worktree, "push", "origin", "feature");
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await advanceBase(repo.worktree);

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
			}),
		).resolves.toContain("bounded rebase verified");
		await expectResidueFree(
			repo.worktree,
			(await git(repo.worktree, "rev-parse", "HEAD")).trim(),
			true,
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
		await expectResidueFree(repo.worktree, expectedRemoteHead);
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

	// SPEC.md cross-cutting invariant #4: rebase is continuous and clean.
	test("aborts a real unresolved conflict and restores the branch without Git residue", async () => {
		const repo = await fixture();
		const expectedRemoteHead = await createTextConflict(repo);

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
			}),
		).rejects.toThrow(/requires an agent seat.*will not choose ours\/theirs/);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
		expect(
			(await git(repo.worktree, "rev-parse", "origin/feature")).trim(),
		).toBe(expectedRemoteHead);
	});

	test("wakes a conflict resolver with real Git context and publishes its semantic merge", async () => {
		const repo = await fixture();
		const expectedRemoteHead = await createTextConflict(repo);
		let calls = 0;

		const actions = await rebaseAndPush(bunExec, {
			git: "git",
			worktree: repo.worktree,
			branch: "feature",
			baseBranch: "main",
			expectedRemoteHead,
			testCommand: "true",
			resolveConflict: (conflict) =>
				wakeRebaseConflictSeat(
					{
						generate: async (options) => {
							calls += 1;
							const prompt = options?.prompt ?? "";
							expect(prompt).toContain('"ticket": "LIN-REBASE"');
							expect(prompt).toContain('"prNumber": 42');
							expect(prompt).toContain('"kind": "merge_conflict"');
							expect(prompt).toContain("main behavior");
							expect(prompt).toContain("feature intent");
							expect(prompt).toContain(
								"do not use checkout/restore --ours or --theirs",
							);
							expect(conflict.branch).toBe("feature");
							expect(conflict.baseBranch).toBe("main");
							expect(conflict.originalHead).toBe(expectedRemoteHead);
							expect(conflict.conflictedFiles).toEqual(["base.txt"]);
							expect(conflict.status).toContain("UU base.txt");
							expect(conflict.unmergedIndex).toContain("base.txt");
							fs.writeFileSync(
								path.join(repo.worktree, "base.txt"),
								"main behavior\nfeature intent\n",
							);
							await git(repo.worktree, "add", "--", "base.txt");
							return {
								output: {
									disposition: "resolved",
									strategy: "continue",
									summary:
										"preserved the new base behavior and the feature intent",
								},
							};
						},
					},
					{
						worktree: repo.worktree,
						originalEffortContext: {
							ticket: "LIN-REBASE",
							summary: "Preserve both behaviors",
						},
						prContext: { repo: "lindy-ai/lindy", prNumber: 42 },
						trigger: {
							kind: "merge_conflict",
							headSha: expectedRemoteHead,
						},
						conflict,
						taskContext: {
							runId: "rebase-test",
							nodeId: "rebase-conflict",
							iteration: 0,
							attempt: conflict.attempt,
						},
					},
				),
		});

		expect(calls).toBe(1);
		expect(actions.join("\n")).toContain("agent resolved rebase conflict");
		expect(fs.readFileSync(path.join(repo.worktree, "base.txt"), "utf8")).toBe(
			"main behavior\nfeature intent\n",
		);
		expect(
			(await git(repo.worktree, "show", "-s", "--format=%an <%ae>", "HEAD")).trim(),
		).toBe("Feature Author <feature-author@example.test>");
		await expectResidueFree(
			repo.worktree,
			(await git(repo.worktree, "rev-parse", "origin/feature")).trim(),
		);
	});

	test("aborts and cleans resolver-created markers, residue, and out-of-scope staging", async () => {
		const repo = await fixture();
		await commitFile(repo.worktree, ".gitignore", "*.orig\n", "ignore resolver backups");
		await git(repo.worktree, "push", "origin", "feature");
		const expectedRemoteHead = await createTextConflict(repo);

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
				resolveConflict: async () => {
					fs.writeFileSync(
						path.join(repo.worktree, "base.txt"),
						"<<<<<<< HEAD\nmain behavior\n=======\nfeature intent\n>>>>>>> feature\n",
					);
					fs.writeFileSync(
						path.join(repo.worktree, "base.txt.orig"),
						"resolver backup\n",
					);
					fs.writeFileSync(
						path.join(repo.worktree, "base.txt.rej"),
						"resolver reject\n",
					);
					fs.mkdirSync(path.join(repo.worktree, "nested"), { recursive: true });
					fs.writeFileSync(
						path.join(repo.worktree, "nested", "ignored.orig"),
						"ignored resolver backup\n",
					);
					fs.writeFileSync(
						path.join(repo.worktree, "indexed.rej"),
						"indexed resolver reject\n",
					);
					fs.writeFileSync(
						path.join(repo.worktree, "unrelated.txt"),
						"unrelated resolver edit\n",
					);
					await git(
						repo.worktree,
						"add",
						"-f",
						"--",
						"base.txt",
						"unrelated.txt",
						"indexed.rej",
					);
					return {
						disposition: "resolved",
						strategy: "continue",
						summary: "unsafe resolution",
					};
				},
			}),
		).rejects.toThrow(
			/artifact files remain:[\s\S]*conflict markers remain:[\s\S]*outside the halted commit/,
		);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
	});

	test("rejects staged conflict blocks using a repository-defined marker width", async () => {
		const repo = await fixture();
		await git(repo.worktree, "checkout", "main");
		await commitFile(
			repo.worktree,
			".gitattributes",
			"base.txt conflict-marker-size=32\n",
			"widen conflict markers",
		);
		await git(repo.worktree, "push", "origin", "main");
		await git(repo.worktree, "checkout", "feature");
		await commitFile(repo.worktree, "base.txt", "feature wide\n", "feature:123: intent");
		await git(repo.worktree, "push", "origin", "feature");
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await git(repo.worktree, "checkout", "main");
		await commitFile(repo.worktree, "base.txt", "main wide\n", "main wide conflict");
		await git(repo.worktree, "push", "origin", "main");
		await git(repo.worktree, "checkout", "feature");
		await git(repo.worktree, "fetch", "origin");

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
				resolveConflict: async () => {
					expect(fs.readFileSync(path.join(repo.worktree, "base.txt"), "utf8")).toStartWith(
						"<".repeat(32),
					);
					expect(fs.readFileSync(path.join(repo.worktree, "base.txt"), "utf8")).toContain(
						":123:",
					);
					await git(repo.worktree, "add", "--", "base.txt");
					return {
						disposition: "resolved",
						strategy: "continue",
						summary: "unsafe wide markers",
					};
				},
			}),
		).rejects.toThrow(/conflict markers remain/);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
	});

	test("routes a genuinely ambiguous conflict to a decision and still aborts cleanly", async () => {
		const repo = await fixture();
		const expectedRemoteHead = await createTextConflict(repo);
		let caught: unknown;

		try {
			await rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
				resolveConflict: async (conflict) => ({
					disposition: "decision",
					summary: `both behaviors are plausible in ${conflict.conflictedFiles.join(", ")}`,
					question: "Should shared behavior follow the base contract or retain the feature contract?",
				}),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(RebaseDecisionRequired);
		expect(String(caught)).toContain("needs the captain");
		await expectResidueFree(repo.worktree, expectedRemoteHead);
	});

	test("restores the original branch when post-rebase validation fails", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "false",

			}),
		).rejects.toThrow(/command failed/);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
		expect(
			(await git(repo.worktree, "rev-parse", "origin/feature")).trim(),
		).toBe(expectedRemoteHead);
	});
	test("resolves and cleans a real gh-stack conflict through the judgment seat", async () => {
		const repo = await fixture();
		const expectedRemoteHead = await createTextConflict(repo);
		const gh = fakeGhStack(repo.root);
		let calls = 0;

		const actions = await rebaseStackUpstack(bunExec, {
			gh,
			git: "git",
			worktree: repo.worktree,
			rootBaseBranch: "main",
			branches: ["feature"],
			fromBranch: "feature",
			expectedRemoteHeads: { feature: expectedRemoteHead },
			testCommand: "true",
			resolveConflict: async (conflict) => {
				calls += 1;
				expect(conflict.conflictedFiles).toEqual(["base.txt"]);
				fs.writeFileSync(
					path.join(repo.worktree, "base.txt"),
					"main behavior\nfeature intent\n",
				);
				await git(repo.worktree, "add", "--", "base.txt");
				return {
					disposition: "resolved",
					strategy: "continue",
					summary: "preserved both stack-layer behaviors",
				};
			},
		});

		expect(calls).toBe(1);
		expect(actions.join("\n")).toContain("agent resolved stack rebase conflict");
		await expectResidueFree(
			repo.worktree,
			(await git(repo.worktree, "rev-parse", "HEAD")).trim(),
		);
		expect(expectedRemoteHead).not.toBe(
			(await git(repo.worktree, "rev-parse", "HEAD")).trim(),
		);
	});

	test("wakes the stack judgment seat again when dropping one commit reveals another conflict", async () => {
		const repo = await fixture();
		await commitFile(repo.worktree, "base.txt", "feature one\n", "feature conflict one");
		await commitFile(repo.worktree, "base.txt", "feature two\n", "feature conflict two");
		await git(repo.worktree, "push", "origin", "feature");
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await git(repo.worktree, "checkout", "main");
		await commitFile(repo.worktree, "base.txt", "main behavior\n", "main conflicts twice");
		await git(repo.worktree, "push", "origin", "main");
		await git(repo.worktree, "checkout", "feature");
		const attempts: number[] = [];

		const actions = await rebaseStackUpstack(bunExec, {
			gh: fakeGhStack(repo.root),
			git: "git",
			worktree: repo.worktree,
			rootBaseBranch: "main",
			branches: ["feature"],
			fromBranch: "feature",
			expectedRemoteHeads: { feature: expectedRemoteHead },
			runCommitShasByBranch: {},
			testCommand: "true",
			resolveConflict: async (conflict) => {
				attempts.push(conflict.attempt);
				if (conflict.attempt === 1) {
					return {
						disposition: "resolved",
						strategy: "drop",
						summary: "first change was superseded",
					};
				}
				fs.writeFileSync(
					path.join(repo.worktree, "base.txt"),
					"main behavior\nfeature two\n",
				);
				await git(repo.worktree, "add", "--", "base.txt");
				return {
					disposition: "resolved",
					strategy: "continue",
					summary: "preserved the surviving feature behavior",
				};
			},
		});

		expect(attempts).toEqual([1, 2]);
		expect(
			actions.filter((action) => action.includes("agent resolved stack rebase conflict")),
		).toHaveLength(2);
		await expectResidueFree(
			repo.worktree,
			(await git(repo.worktree, "rev-parse", "HEAD")).trim(),
		);
	});

	test("aborts a real gh-stack judgment decision without stack or Git residue", async () => {
		const repo = await fixture();
		const expectedRemoteHead = await createTextConflict(repo);
		const gh = fakeGhStack(repo.root);

		await expect(
			rebaseStackUpstack(bunExec, {
				gh,
				git: "git",
				worktree: repo.worktree,
				rootBaseBranch: "main",
				branches: ["feature"],
				fromBranch: "feature",
				testCommand: "true",
				expectedRemoteHeads: { feature: expectedRemoteHead },
				resolveConflict: async () => ({
					disposition: "decision",
					summary: "stack intent is ambiguous",
					question: "Which stack-layer behavior is intended?",
				}),
			}),
		).rejects.toBeInstanceOf(RebaseDecisionRequired);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
	});
	test("rejects an untrusted local commit on a non-current stack parent", async () => {
		const repo = await fixture();
		const parentRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await git(repo.worktree, "checkout", "-b", "stack-child", "feature");
		await commitFile(repo.worktree, "child.txt", "child\n", "stack child");
		await git(repo.worktree, "push", "-u", "origin", "stack-child");
		const childRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/stack-child")
		).trim();
		await git(repo.worktree, "checkout", "feature");
		await commitFile(repo.worktree, "untrusted.txt", "untrusted\n", "untrusted parent commit");
		await git(repo.worktree, "checkout", "stack-child");

		await expect(
			rebaseStackUpstack(bunExec, {
				gh: fakeGhStack(repo.root),
				git: "git",
				worktree: repo.worktree,
				rootBaseBranch: "main",
				branches: ["feature", "stack-child"],
				fromBranch: "feature",
				expectedRemoteHeads: {
					feature: parentRemoteHead,
					"stack-child": childRemoteHead,
				},
				runCommitShasByBranch: {},
				testCommand: "true",
			}),
		).rejects.toThrow(/feature local commits.*do not exactly match/);

		expect((await git(repo.worktree, "branch", "--show-current")).trim()).toBe(
			"stack-child",
		);
		expect((await git(repo.worktree, "rev-parse", "HEAD")).trim()).toBe(
			childRemoteHead,
		);
		expect((await git(repo.worktree, "rev-parse", "origin/feature")).trim()).toBe(
			parentRemoteHead,
		);
	});

	test("rejects pre-existing PR merge commits instead of flattening merge-resolution content", async () => {
		const repo = await fixture();
		await git(repo.worktree, "checkout", "-b", "side", "feature");
		await commitFile(repo.worktree, "side.txt", "side\n", "side branch");
		await git(repo.worktree, "checkout", "feature");
		await commitFile(repo.worktree, "feature-2.txt", "feature two\n", "second feature");
		await git(repo.worktree, "merge", "--no-ff", "side", "-m", "merge side intent");
		await git(repo.worktree, "push", "--force", "origin", "feature");
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await advanceBase(repo.worktree);

		await expect(
			rebaseAndPush(bunExec, {
				git: "git",
				worktree: repo.worktree,
				branch: "feature",
				baseBranch: "main",
				expectedRemoteHead,
				testCommand: "true",
			}),
		).rejects.toThrow(/merge commits are not supported.*flattening/);

		await expectResidueFree(repo.worktree, expectedRemoteHead);
	});


	test("cleans residue created by a successful push hook without rolling back the published head", async () => {
		const repo = await fixture();
		await advanceBase(repo.worktree);
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		const gitDir = (await git(repo.worktree, "rev-parse", "--git-dir")).trim();
		const hooks = path.join(
			repo.worktree,
			path.isAbsolute(gitDir) ? path.relative(repo.worktree, gitDir) : gitDir,
			"hooks",
		);
		fs.mkdirSync(hooks, { recursive: true });
		const hook = path.join(hooks, "pre-push");
		await git(repo.worktree, "config", "core.hooksPath", hooks);
		fs.writeFileSync(
			hook,
			`#!/bin/sh\ntouch ${JSON.stringify(path.join(repo.worktree, "post-push.orig"))}\n`,
		);
		fs.chmodSync(hook, 0o755);

		const actions = await rebaseAndPush(bunExec, {
			git: "git",
			worktree: repo.worktree,
			branch: "feature",
			baseBranch: "main",
			expectedRemoteHead,
			testCommand: "true",
		});

		expect(actions).toContain("cleaned post-push worktree residue");
		const publishedHead = (await git(repo.worktree, "rev-parse", "HEAD")).trim();
		expect((await git(repo.worktree, "rev-parse", "origin/feature")).trim()).toBe(
			publishedHead,
		);
		await expectResidueFree(repo.worktree, publishedHead);
	});

	test("drops intentional empty commits instead of publishing rewritten empty artifacts", async () => {
		const repo = await fixture();
		await git(repo.worktree, "commit", "--allow-empty", "-m", "empty retry artifact");
		await git(repo.worktree, "push", "origin", "feature");
		const expectedRemoteHead = (
			await git(repo.worktree, "rev-parse", "origin/feature")
		).trim();
		await advanceBase(repo.worktree);

		await rebaseAndPush(bunExec, {
			git: "git",
			worktree: repo.worktree,
			branch: "feature",
			baseBranch: "main",
			expectedRemoteHead,
			testCommand: "true",
		});

		const subjects = (
			await git(repo.worktree, "log", "--format=%s", "origin/main..HEAD")
		).split("\n");
		expect(subjects).not.toContain("empty retry artifact");
		await expectResidueFree(
			repo.worktree,
			(await git(repo.worktree, "rev-parse", "origin/feature")).trim(),
		);
	});
});
