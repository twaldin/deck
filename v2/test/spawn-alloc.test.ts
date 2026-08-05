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
import { profilesFile, seedProfiles } from "../src/projects";
import { runCli } from "../src/cli";
import { DEFAULT_WORKER_MODEL, piArgs, resolveRepo, startRun } from "../src/spawn";

const DECK_BIN = path.resolve(import.meta.dir, "../../cli/bin/deck");
const V2_BIN = path.resolve(import.meta.dir, "../bin/deck-v2");

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
	for (const key of ["DECK_HOME", "DECK_V2_HOME", "DECK_CLI_BIN", "DECK_TEST_PI_ARGS", "PATH"]) {
		savedEnv[key] = process.env[key];
	}
	process.env.DECK_HOME = path.join(root, "deck-home");
	process.env.DECK_V2_HOME = path.join(root, "v2-home");
	process.env.DECK_CLI_BIN = DECK_BIN;
	fs.mkdirSync(process.env.DECK_V2_HOME, { recursive: true });

	// A fake `pi` so startRun launches nothing real.
	const fakeBin = path.join(root, "fakebin");
	fs.mkdirSync(fakeBin);
	fs.writeFileSync(path.join(fakeBin, "pi"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$DECK_TEST_PI_ARGS\"\ncat > /dev/null\nexit 0\n", { mode: 0o755 });
	process.env.DECK_TEST_PI_ARGS = path.join(root, "pi-args.txt");
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
	test("passes the requested reasoning level to Pi as --thinking", () => {
		expect(piArgs("session", `${DEFAULT_WORKER_MODEL}:fast`, "high", false)).toEqual([
			"-p", "--session-dir", "session", "--model", `${DEFAULT_WORKER_MODEL}:fast`, "--thinking", "high", "--exclude-tools", "ask_captain,web_search",
		]);
	});

	test("legacy thinking remains the fallback when reasoning is absent", () => {
		expect(piArgs("session", `${DEFAULT_WORKER_MODEL}:fast`, "legacy", false)).toContain("legacy");
	});

	test("CLI validates reasoning and the launched Pi receives the explicit value over profile defaults", async () => {
		const invalid = await run([Bun.which("bun") as string, V2_BIN, "spawn", "bad", "--task", "x", "--accept", "ok", "--repo", path.join(root, "repo"), "--reasoning", "turbo", "--no-pipeline"], root);
		expect(invalid.exitCode).toBe(1);
		expect(invalid.stderr).toContain("reasoning must be");

		const escape = path.join(root, "cli-escape-wt");
		await git(path.join(root, "repo"), ["worktree", "add", escape, "-b", "cli-escape", "main"]);
		const profilePath = profilesFile(process.env.DECK_V2_HOME as string);
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });
		fs.writeFileSync(profilePath, JSON.stringify([{
			id: "fixture", repo: "fixture/repo", primary: path.join(root, "repo"), pipeline: "yolo-ship",
			yolo: true, stamp: false, knowledge: [], depsWarm: false, models: { reasoning: "low" },
		}]));
		const exitCode = await runCli(["spawn", "cli-proof", "--task", "x", "--accept", "ok", "--kind", "scout", "--worktree", escape, "--project", "fixture", "--reasoning", "high"]);
		expect(exitCode).toBe(0);
		for (let attempt = 0; attempt < 20 && !fs.existsSync(process.env.DECK_TEST_PI_ARGS as string); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(fs.readFileSync(process.env.DECK_TEST_PI_ARGS as string, "utf8").split("\n")).toContain("high");
	});
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

	test("REGRESSION: the escape hatch refuses a repository's primary checkout", () => {
		// The repo itself, not a linked worktree: .git is a directory here.
		expect(() =>
			startRun(
				{ ...baseRequest(), taskId: "spawn-primary-test", worktree: path.join(root, "repo") },
				path.join(root, "unrelated"),
			),
		).toThrow(/primary checkout/);
	});

	test("a failed launch releases the fresh allocation instead of stranding it", () => {
		// Point PATH at an empty dir so `pi` cannot launch. Keep DECK_CLI_BIN
		// absolute and spawn bun via its absolute path? deck's shebang needs bun on
		// PATH, so keep bun's dir plus an empty dir with no pi.
		const bunDir = path.dirname(Bun.which("bun") as string);
		const gitDir = path.dirname(Bun.which("git") as string);
		process.env.PATH = `${bunDir}:${gitDir}`;
		expect(() =>
			startRun(
				{ ...baseRequest(), taskId: "spawn-fail-test", repo: path.join(root, "repo"), base: "main" },
				path.join(root, "repo"),
			),
		).toThrow();
		const state = JSON.parse(
			fs.readFileSync(path.join(process.env.DECK_HOME as string, "worktrees.json"), "utf8"),
		);
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0].state).toBe("free");
	});

	test("repo aliases resolve from the home config", () => {
		const file = profilesFile(process.env.DECK_V2_HOME!);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify([{
			id: "example-project", repo: "example-org/example-project", primary: "/opt/example-project",
			pipeline: "yolo-ship", yolo: true, stamp: false, knowledge: [], depsWarm: true,
		}]));
		expect(resolveRepo("example-project")).toBe("/opt/example-project");
		expect(resolveRepo("/abs/path")).toBe("/abs/path");
		expect(() => resolveRepo("nope")).toThrow(/unknown repo alias/);
	});

	test("a config file overrides the seeded primary for an alias", () => {
		const home = process.env.DECK_V2_HOME as string;
		const file = profilesFile(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					id: "example-project",
					repo: "example-org/example-project",
					primary: "/somewhere/else/deck",
					pipeline: "yolo-ship",
					yolo: true,
					stamp: false,
					knowledge: [],
				},
			]),
		);
		expect(resolveRepo("example-project")).toBe("/somewhere/else/deck");
		// Wholesale replacement: an alias absent from the file no longer resolves.
		expect(() => resolveRepo("review-project")).toThrow(/unknown repo alias/);
	});
});
