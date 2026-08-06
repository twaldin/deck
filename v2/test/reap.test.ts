import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REAPER_OWNER, reapWorktrees, type ReapDeps } from "../src/reap";
import type { TaskMeta } from "../src/meta";

/**
 * The reaper DELETES, so its refusals are the contract. A dry run proving
 * "nothing was cleared" says nothing about whether a safe apply works or an
 * unsafe one stays blocked, so every path is exercised here against a real git
 * repo with a real linked worktree.
 */
let root: string;
let repo: string;
let wtRoot: string;
const homes: string[] = [];

function git(cwd: string, ...args: string[]): void {
	const done = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-reap-"));
	homes.push(root);
	repo = path.join(root, "repo");
	wtRoot = path.join(root, "wt");
	fs.mkdirSync(repo);
	fs.mkdirSync(wtRoot);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	// The guard refuses work that exists nowhere but this disk, so the fixture
	// needs a remote the commits are actually reachable from.
	const origin = path.join(root, "origin.git");
	spawnSync("git", ["init", "-q", "--bare", origin]);
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "-u", "origin", "main");
	// Deck state lives here; evaluateTeardown reads meta from DECK_V2_HOME.
	process.env.DECK_V2_HOME = root;
	fs.mkdirSync(path.join(root, "state"), { recursive: true });
});

afterEach(() => {
	delete process.env.DECK_V2_HOME;
	for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeMetaFile(id: string, meta: TaskMeta): void {
	const lines = Object.entries(meta)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`);
	fs.writeFileSync(path.join(root, "state", `${id}.meta`), `${lines.join("\n")}\n`);
}

/** A real linked worktree plus the durable meta record the guard reads. */
function effort(id: string, overrides: Partial<TaskMeta> = {}): TaskMeta {
	const worktree = path.join(wtRoot, id);
	git(repo, "worktree", "add", "-q", "-b", id, worktree);
	const meta: TaskMeta = {
		id,
		kind: "ship",
		worktree,
		pr: `acme/widgets#1`,
		...overrides,
	} as TaskMeta;
	// Meta files are key=value lines, not JSON - readMeta parses them by hand.
	writeMetaFile(id, meta);
	return meta;
}

function deps(over: Partial<ReapDeps> & { efforts: () => TaskMeta[] }): ReapDeps {
	return {
		wtRoot: () => fs.realpathSync(wtRoot),
		prState: () => "MERGED",
		runs: async () => ({ liveEffortIds: new Set<string>(), healthy: true }),
		claim: () => () => {},
		lockIsLive: () => false,
		remove: (worktree) => {
			const done = spawnSync("git", ["-C", worktree, "worktree", "remove", worktree], { encoding: "utf8" });
			return done.status === 0 ? null : done.stderr.trim();
		},
		...over,
	};
}

describe("reap refuses everything it cannot prove safe", () => {
	test("an OPEN pr is kept even though the branch is clean and pushed", async () => {
		const one = effort("open-pr");
		const result = await reapWorktrees(deps({ efforts: () => [one], prState: () => "OPEN" }), true);
		expect(result.refused).toEqual(["open-pr\tE_PR_OPEN"]);
		expect(result.cleared).toEqual([]);
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("a worktree outside the deck root is never touched", async () => {
		const outside = path.join(root, "mine");
		git(repo, "worktree", "add", "-q", "-b", "human", outside);
		const meta = { id: "human", kind: "ship", worktree: outside, pr: "acme/widgets#1" } as TaskMeta;
		writeMetaFile("human", meta);

		const result = await reapWorktrees(deps({ efforts: () => [meta] }), true);
		expect(result.refused).toEqual(["human\tE_NOT_DECK_OWNED"]);
		expect(fs.existsSync(outside)).toBe(true);
	});

	test("a live lock blocks, both on preflight and at the claim", async () => {
		const one = effort("locked");
		const preflight = await reapWorktrees(deps({ efforts: () => [one], lockIsLive: () => true }), true);
		expect(preflight.refused).toEqual(["locked\tE_LOCK_LIVE"]);
		expect(fs.existsSync(one.worktree!)).toBe(true);

		// The claim is the real authority: a run can appear after the preflight.
		const raced = await reapWorktrees(
			deps({
				efforts: () => [one],
				claim: () => {
					throw new Error("already in use");
				},
			}),
			true,
		);
		expect(raced.refused).toEqual(["locked\tE_LOCK_LIVE"]);
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("a live run blocks even when the PR merged", async () => {
		const one = effort("running");
		const result = await reapWorktrees(
			deps({ efforts: () => [one], runs: async () => ({ liveEffortIds: new Set(["running"]), healthy: true }) }),
			true,
		);
		expect(result.refused[0]).toContain("E_ACTIVE_RUN");
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("unhealthy run enumeration refuses the whole command", async () => {
		const one = effort("unknown-runs");
		await expect(
			reapWorktrees(deps({ efforts: () => [one], runs: async () => ({ liveEffortIds: new Set<string>(), healthy: false }) }), true),
		).rejects.toThrow(/cannot enumerate Smithers runs/);
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("a failed removal is reported refused, never cleared", async () => {
		const one = effort("stubborn");
		const result = await reapWorktrees(
			deps({ efforts: () => [one], remove: () => "fatal: worktree is dirty" }),
			true,
		);
		expect(result.cleared).toEqual([]);
		expect(result.refused[0]).toContain("E_REMOVE_FAILED");
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("uncommitted work blocks removal for real, not just by policy", async () => {
		const one = effort("dirty");
		fs.writeFileSync(path.join(one.worktree!, "scratch.txt"), "unsaved\n");
		const result = await reapWorktrees(deps({ efforts: () => [one] }), true);
		expect(result.cleared).toEqual([]);
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});
});

describe("reap removes what it can prove safe", () => {
	test("a dry run reports the candidate and deletes nothing", async () => {
		const one = effort("landed");
		const result = await reapWorktrees(deps({ efforts: () => [one] }), false);
		expect(result.cleared).toHaveLength(1);
		expect(result.cleared[0]).toContain("landed");
		expect(fs.existsSync(one.worktree!)).toBe(true);
	});

	test("apply removes a merged, clean, idle, deck-owned worktree under its lock", async () => {
		const one = effort("landed");
		const owners: string[] = [];
		let released = 0;
		const result = await reapWorktrees(
			deps({
				efforts: () => [one],
				claim: (_worktree, owner) => {
					owners.push(owner);
					return () => {
						released += 1;
					};
				},
			}),
			true,
		);
		expect(result.refused).toEqual([]);
		expect(result.cleared).toHaveLength(1);
		expect(fs.existsSync(one.worktree!)).toBe(false);
		// Held under the reaper's own lock, and released afterwards.
		expect(owners).toEqual([REAPER_OWNER]);
		expect(released).toBe(1);
	});
});
