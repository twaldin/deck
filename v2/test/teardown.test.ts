import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
let sandbox: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test" },
	}).trim();
}

/** A bare "remote" plus a clone, so reachability tests are real. */
function makeRepo(): { remote: string; work: string } {
	const remote = path.join(sandbox, "remote.git");
	fs.mkdirSync(remote, { recursive: true });
	git(sandbox, "init", "--bare", "--initial-branch=main", remote);

	const work = path.join(sandbox, "work");
	git(sandbox, "clone", remote, work);
	fs.writeFileSync(path.join(work, "README.md"), "base\n");
	git(work, "add", ".");
	git(work, "commit", "-m", "base");
	git(work, "push", "origin", "main");
	return { remote, work };
}

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-td-"));
	home = path.join(sandbox, "home");
	fs.mkdirSync(home, { recursive: true });
	process.env.DECK_V2_HOME = home;
	delete process.env.DECK_PROTECTED_WORKTREES;
});

afterEach(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	delete process.env.DECK_PROTECTED_WORKTREES;
});

async function mods() {
	return {
		teardown: await import("../src/teardown"),
		meta: await import("../src/meta"),
		events: await import("../src/events"),
	};
}

describe("teardown guard", () => {
	test("GREEN: clean worktree, everything pushed", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(true);
	});

	test("RED: uncommitted changes refuse", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		fs.writeFileSync(path.join(work, "README.md"), "edited but never committed\n");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_DIRTY");
	});

	test("RED: untracked file refuses (it is unlanded work too)", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		fs.writeFileSync(path.join(work, "scratch-findings.md"), "the only copy\n");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_DIRTY");
	});

	test("RED: committed but unpushed refuses", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		git(work, "checkout", "-b", "fm/feature");
		fs.writeFileSync(path.join(work, "new.ts"), "export const x = 1;\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "real work nobody else has");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_UNPUSHED");
	});

	test("GREEN: pushed branch is reachable, so teardown is allowed", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		git(work, "checkout", "-b", "fm/feature");
		fs.writeFileSync(path.join(work, "new.ts"), "export const x = 1;\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "work");
		git(work, "push", "origin", "fm/feature");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		expect(teardown.evaluateTeardown("t1").allowed).toBe(true);
	});

	// The trap that would silently discard landed work: a GitHub merge queue-merged
	// PR reads state=closed, merged=false. Three confirmed repros in fm2.
	test("REGRESSION lands-and-closes: squash-landed PR is allowed despite unreachable local commits", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		git(work, "checkout", "-b", "fm/feature");
		fs.writeFileSync(path.join(work, "new.ts"), "export const x = 1;\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "original commit, rewritten by the squash");

		// Simulate the squash landing on main under a DIFFERENT sha.
		git(work, "checkout", "main");
		fs.writeFileSync(path.join(work, "new.ts"), "export const x = 1;\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "feat: add x (#4242)");
		git(work, "push", "origin", "main");
		git(work, "checkout", "fm/feature");

		meta.writeMeta({ id: "t1", worktree: work, kind: "ship", pr: "4242" });

		// Without the PR number this looks like unlanded work.
		const naive = teardown.evaluateTeardown("t1");
		expect(naive.allowed).toBe(false);

		// With it, the (#N) search finds the landing and allows teardown.
		const informed = teardown.evaluateTeardown("t1", { prNumber: 4242 });
		expect(informed.allowed).toBe(true);
		if (!informed.allowed) return;
		expect(informed.notes.join(" ")).toContain("landed as");
	});

	test("RED: a PR with no squash commit on main is NOT landed", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		git(work, "checkout", "-b", "fm/feature");
		fs.writeFileSync(path.join(work, "new.ts"), "export const x = 1;\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "work");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship", pr: "999" });
		const verdict = teardown.evaluateTeardown("t1", { prNumber: 999 });
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_NOT_LANDED");
	});

	test("RED: protected worktree refuses even when clean", async () => {
		const { work } = makeRepo();
		process.env.DECK_PROTECTED_WORKTREES = work;
		const { teardown, meta } = await mods();
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_PROTECTED_SLOT");
	});

	test("RED: scout with no report refuses", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		meta.writeMeta({ id: "s1", worktree: work, kind: "scout" });
		const verdict = teardown.evaluateTeardown("s1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_NO_REPORT");
	});

	test("GREEN: scout with a report is allowed", async () => {
		const { teardown, meta } = await mods();
		const { taskFiles, ensureTaskDirs } = await import("../src/home");
		const { work } = makeRepo();
		meta.writeMeta({ id: "s1", worktree: work, kind: "scout" });
		ensureTaskDirs("s1");
		fs.writeFileSync(taskFiles("s1").report, "# findings\n");
		expect(teardown.evaluateTeardown("s1").allowed).toBe(true);
	});

	test("RED: unresolved decision refuses", async () => {
		const { teardown, meta, events } = await mods();
		const { work } = makeRepo();
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		events.appendStatus("t1", "needs-decision", "which shape?", { key: "api-shape" });
		const verdict = teardown.evaluateTeardown("t1");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_OPEN_DECISION");

		events.appendStatus("t1", "resolved", "went with B", { key: "api-shape" });
		expect(teardown.evaluateTeardown("t1").allowed).toBe(true);
	});

	test("RED: non-terminal run refuses", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const verdict = teardown.evaluateTeardown("t1", { activeRun: true });
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals.map((r) => r.code)).toContain("E_ACTIVE_RUN");
	});

	test("RED: missing meta refuses", async () => {
		const { teardown } = await mods();
		const verdict = teardown.evaluateTeardown("ghost");
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.refusals[0]?.code).toBe("E_NO_META");
	});

	test("refusal text never suggests bypassing", async () => {
		const { teardown, meta } = await mods();
		const { work } = makeRepo();
		fs.writeFileSync(path.join(work, "x.txt"), "dirty\n");
		meta.writeMeta({ id: "t1", worktree: work, kind: "ship" });
		const text = teardown.formatVerdict("t1", teardown.evaluateTeardown("t1"));
		expect(text).toContain("stop-and-investigate");
		expect(text).not.toContain("--force");
	});
});
