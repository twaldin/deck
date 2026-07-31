/**
 * Spawn owns worktree allocation: repo-only spawn allocates an isolated
 * worktree under DECK_HOME/wt via `deck wt alloc`; an absolute worktree path
 * stays the escape hatch; neither or both is an error.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readMeta } from "../src/meta";
import { REPO_ALIASES, resolveRepo, startRun } from "../src/spawn";

const DECK_BIN = path.resolve(import.meta.dir, "../../cli/bin/deck");

let root: string;
const savedEnv: Record<string, string | undefined> = {};

async function run(command: string[], cwd?: string): Promise<{ exitCode: number; stderr: string }> {
	const handle = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([
		new Response(handle.stderr).text(),
		handle.exited,
	]);
	return { exitCode, stderr };
}

async function git(repo: string, args: string[]): Promise<void> {
	const result = await run(["git", "-C", repo, ...args]);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-spawn-alloc-"));
	for (const key of ["DECK_HOME", "DECK_V2_HOME", "DECK_CLI_BIN", "PATH"]) {
		savedEnv[key] = process.env[key];
	}
	process.env.DECK_HOME = path.join(root, "deck-home");
	process.env.DECK_V2_HOME = path.join(root, "v2-home");
	process.env.DECK_CLI_BIN = DECK_BIN;
	fs.mkdirSync(process.env.DECK_V2_HOME, { recursive: true });

	// A fake `pi` so startRun launches nothing real.
	const fakeBin = path.join(root, "fakebin");
	fs.mkdirSync(fakeBin);
	fs.writeFileSync(path.join(fakeBin, "pi"), "#!/bin/sh\ncat > /dev/null\nexit 0\n", { mode: 0o755 });
	process.env.PATH = `${fakeBin}:${process.env.PATH}`;

	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	await git(repo, ["init", "-b", "main"]);
	fs.writeFileSync(path.join(repo, "README.txt"), "fixture\n");
	await git(repo, ["add", "README.txt"]);
	await git(repo, [
		"-c", "user.name=Deck Test",
		"-c", "user.email=deck@example.test",
		"commit", "-m", "fixture",
	]);
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

const baseRequest = () => ({
	taskId: "spawn-alloc-test",
	task: "do the thing",
	acceptance: ["it is done"],
	kind: "ship" as const,
});

describe("spawn worktree allocation", () => {
	test("repo-only spawn allocates an isolated worktree under DECK_HOME/wt and records it", () => {
		const result = startRun(
			{ ...baseRequest(), repo: path.join(root, "repo"), base: "main", desc: "short label" },
			path.join(root, "repo"),
		);
		expect(result.worktree.startsWith(path.join(process.env.DECK_HOME as string, "wt"))).toBe(true);
		expect(fs.existsSync(path.join(result.worktree, ".git"))).toBe(true);
		expect(result.wtId).toBe("wt:repo:1");
		expect(result.branch?.startsWith("deck/spawn-alloc-test/")).toBe(true);

		const meta = readMeta("spawn-alloc-test");
		expect(meta?.worktree).toBe(result.worktree);
		expect(meta?.wt_id).toBe("wt:repo:1");
		expect(meta?.branch).toBe(result.branch);
		expect(meta?.desc).toBe("short label");

		// The brief carries the allocated path, and no checkout instruction:
		// the allocated worktree is already on its branch.
		const brief = fs.readFileSync(result.briefPath, "utf8");
		expect(brief).toContain(result.worktree);
		expect(brief).not.toContain("git checkout -b");
	});

	test("an absolute worktree path still works as the escape hatch", async () => {
		const escape = path.join(root, "escape-wt");
		await git(path.join(root, "repo"), ["worktree", "add", escape, "-b", "escape-branch", "main"]);
		const result = startRun(
			{ ...baseRequest(), taskId: "spawn-escape-test", worktree: escape },
			path.join(root, "repo"),
		);
		expect(result.worktree).toBe(escape);
		expect(result.wtId).toBeUndefined();
		expect(readMeta("spawn-escape-test")?.worktree).toBe(escape);
	});

	test("missing both repo and worktree errors; giving both errors too", () => {
		expect(() => startRun(baseRequest(), path.join(root, "repo"))).toThrow(/exactly one/);
		expect(() =>
			startRun(
				{ ...baseRequest(), repo: path.join(root, "repo"), worktree: path.join(root, "x") },
				path.join(root, "repo"),
			),
		).toThrow(/exactly one/);
	});

	test("repo aliases resolve and unknown aliases are refused", () => {
		expect(resolveRepo("lindy")).toBe(REPO_ALIASES.lindy as string);
		expect(resolveRepo("deck")).toBe(REPO_ALIASES.deck as string);
		expect(resolveRepo("/abs/path")).toBe("/abs/path");
		expect(() => resolveRepo("nope")).toThrow(/unknown repo alias/);
	});
});
