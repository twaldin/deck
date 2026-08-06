import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { manifestSchema } from "../src/core";
import { type WorktreeEntry, worktreesStateSchema } from "../src/schema";
import { warmDependencies } from "../src/worktrees";

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface Fixture {
	root: string;
	home: string;
	repo: string;
}

const DECK_BIN = path.resolve(import.meta.dir, "../bin/deck");
const roots: string[] = [];

async function runProcess(command: string[], cwd?: string, env?: Record<string, string | undefined>): Promise<ProcessResult> {
	const processHandle = Bun.spawn(command, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { exitCode, stdout, stderr };
}

function testEnvironment(home: string): Record<string, string | undefined> {
	return {
		...process.env,
		HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function git(repo: string, args: string[]): Promise<string> {
	const result = await runProcess(["git", "-C", repo, ...args], undefined, testEnvironment(path.dirname(repo)));
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function createFixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-cli-test-"));
	roots.push(root);
	const home = path.join(root, "deck-home");
	const repo = path.join(root, "sample-repo");
	fs.mkdirSync(repo, { recursive: true });
	await git(repo, ["init", "-b", "main"]);
	fs.writeFileSync(path.join(repo, "README.txt"), "fixture\n");
	await git(repo, ["add", "README.txt"]);
	await git(repo, ["-c", "user.name=Deck Test", "-c", "user.email=deck@example.test", "commit", "-m", "fixture"]);
	return { root, home, repo };
}

async function deck(fixture: Fixture, args: string[]): Promise<ProcessResult> {
	return runProcess(["bun", DECK_BIN, ...args], fixture.root, {
		...testEnvironment(fixture.root),
		DECK_HOME: fixture.home,
	});
}

function readState(home: string) {
	const text = fs.readFileSync(path.join(home, "worktrees.json"), "utf8");
	return worktreesStateSchema.parse(JSON.parse(text));
}

function writeManifest(home: string, effort: string, stage: "active" | "done" | "abandoned"): void {
	const now = new Date().toISOString();
	const manifest = manifestSchema.parse({
		v: 2,
		effort_id: effort,
		project: "sample-repo",
		title: effort,
		created: now,
		updated: now,
		revision: 0,
		stage,
		overlays: { blocked: null, needs_tim: [] },
		session: null,
		watch: { prs: [], tickets: [], slack_threads: [] },
		worktrees: [],
		dispatches: [],
		evidence: [],
		side_effects: [],
		cards: [],
		decisions: [],
		digest: null,
	});
	const directory = path.join(home, "efforts", effort);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("dependency warming", () => {
	test("runs the configured install and writes a ready marker after it exits", async () => {
		const fixture = await createFixture();
		const worktree = path.join(fixture.root, "warm");
		fs.mkdirSync(worktree);
		fs.mkdirSync(path.join(fixture.home, "config"), { recursive: true });
		fs.writeFileSync(path.join(fixture.home, "config", "projects.json"), JSON.stringify([{
			primary: fs.realpathSync(fixture.repo), depsWarm: true, installCommand: "printf warmed > installed.txt",
		}]));
		const previousHome = process.env.DECK_V2_HOME;
		process.env.DECK_V2_HOME = fixture.home;
		warmDependencies(worktree, fs.realpathSync(fixture.repo));
		if (previousHome === undefined) delete process.env.DECK_V2_HOME; else process.env.DECK_V2_HOME = previousHome;
		for (let attempt = 0; attempt < 40 && !fs.existsSync(path.join(worktree, ".deck-deps-ready")); attempt++) {
			await Bun.sleep(25);
		}
		expect(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8")).toBe("warmed");
		expect(fs.readFileSync(path.join(worktree, ".deck-deps-ready"), "utf8")).toBe("ready\n");
		expect(fs.existsSync(path.join(worktree, ".deck-deps-failed"))).toBe(false);
	});

	test("writes a failed marker with the install error", async () => {
		const fixture = await createFixture();
		const worktree = path.join(fixture.root, "warm");
		fs.mkdirSync(worktree);
		fs.mkdirSync(path.join(fixture.home, "config"), { recursive: true });
		fs.writeFileSync(path.join(fixture.home, "config", "projects.json"), JSON.stringify([{
			primary: fs.realpathSync(fixture.repo), depsWarm: true, installCommand: "printf broken >&2; exit 7",
		}]));
		const previousHome = process.env.DECK_V2_HOME;
		process.env.DECK_V2_HOME = fixture.home;
		warmDependencies(worktree, fs.realpathSync(fixture.repo));
		if (previousHome === undefined) delete process.env.DECK_V2_HOME; else process.env.DECK_V2_HOME = previousHome;
		for (let attempt = 0; attempt < 40 && !fs.existsSync(path.join(worktree, ".deck-deps-failed")); attempt++) {
			await Bun.sleep(25);
		}
		expect(fs.readFileSync(path.join(worktree, ".deck-deps-failed"), "utf8")).toContain("broken");
		expect(fs.existsSync(path.join(worktree, ".deck-deps-ready"))).toBe(false);
	});
});

describe("deck wt", () => {
	test("ls handles an empty state in human and JSON modes", async () => {
		const fixture = await createFixture();
		const human = await deck(fixture, ["wt", "ls"]);
		expect(human.exitCode).toBe(0);
		expect(human.stderr).toBe("");
		expect(human.stdout).toBe("No worktrees.\n");

		const machine = await deck(fixture, ["wt", "ls", "--json"]);
		expect(machine.exitCode).toBe(0);
		expect(JSON.parse(machine.stdout)).toEqual([]);
	});

	test("allocates, releases with branch deletion, and reuses the repo slot", async () => {
		const fixture = await createFixture();
		const allocated = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--first",
			"--base",
			"main",
		]);
		expect(allocated.exitCode).toBe(0);
		const first = readState(fixture.home).entries[0];
		expect(first?.state).toBe("active");
		expect(first === undefined ? false : fs.existsSync(first.path)).toBe(true);
		expect(first === undefined ? 0 : fs.statSync(first.path).mode & 0o777).toBe(0o700);

		const released = await deck(fixture, ["wt", "release", first?.id ?? "missing", "--delete-branch"]);
		expect(released.exitCode).toBe(0);
		const free = readState(fixture.home).entries[0];
		expect(free?.state).toBe("free");
		expect(first === undefined ? true : fs.existsSync(first.path)).toBe(false);
		expect(first === undefined ? "" : await git(fixture.repo, ["branch", "--list", first.branch])).toBe("");

		const linkedCheckout = path.join(fixture.root, "linked-checkout");
		await git(fixture.repo, ["worktree", "add", linkedCheckout, "-b", "linked-input", "main"]);
		fs.writeFileSync(path.join(linkedCheckout, "linked.txt"), "linked head\n");
		await git(linkedCheckout, ["add", "linked.txt"]);
		await git(linkedCheckout, [
			"-c",
			"user.name=Deck Test",
			"-c",
			"user.email=deck@example.test",
			"commit",
			"-m",
			"linked head",
		]);
		const linkedHead = await git(linkedCheckout, ["rev-parse", "HEAD"]);
		expect(linkedHead).not.toBe(await git(fixture.repo, ["rev-parse", "HEAD"]));

		const reallocated = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			linkedCheckout,
			"--effort",
			"sample--second",
			"--base",
			"HEAD",
		]);
		expect(reallocated.exitCode).toBe(0);
		const second = readState(fixture.home).entries[0];
		expect(second?.id).toBe(first?.id);
		expect(second?.path).toBe(first?.path);
		expect(second?.branch).not.toBe(first?.branch);
		expect(second?.repo).toBe(fs.realpathSync(fixture.repo));
		expect(second?.state).toBe("active");
		expect(second === undefined ? "" : await git(second.path, ["rev-parse", "HEAD"])).toBe(linkedHead);
	});

	test("records an explicit branch and desc, keeps the alloc line parseable, and shows desc in ls", async () => {
		const fixture = await createFixture();
		const allocated = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--labelled",
			"--base",
			"main",
			"--branch",
			"deck/custom-branch",
			"--desc",
			"fix the flux capacitor",
		]);
		expect(allocated.exitCode).toBe(0);
		const [id, wtPath, branch] = allocated.stdout.trim().split("\t");
		expect(id).toBe("wt:sample-repo:1");
		expect(branch).toBe("deck/custom-branch");
		expect(wtPath === undefined ? "" : await git(wtPath, ["branch", "--show-current"])).toBe(
			"deck/custom-branch",
		);
		const entry = readState(fixture.home).entries[0];
		expect(entry?.branch).toBe("deck/custom-branch");
		expect(entry?.desc).toBe("fix the flux capacitor");

		const listed = await deck(fixture, ["wt", "ls"]);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout).toContain("DESC");
		expect(listed.stdout).toContain("fix the flux capacitor");
	});

	test("fetches origin/main before a default-base allocation", async () => {
		const fixture = await createFixture();
		const remote = path.join(fixture.root, "remote.git");
		const clone = await runProcess(
			["git", "clone", "--bare", fixture.repo, remote],
			undefined,
			testEnvironment(fixture.root),
		);
		expect(clone.exitCode).toBe(0);
		await git(fixture.repo, ["remote", "add", "origin", remote]);

		const result = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--default-base",
		]);
		expect(result.exitCode).toBe(0);
		const entry = readState(fixture.home).entries[0];
		expect(entry === undefined ? "" : await git(entry.path, ["rev-parse", "HEAD"])).toBe(
			await git(fixture.repo, ["rev-parse", "origin/main"]),
		);
	});

	test("serializes concurrent allocator processes without double-assigning a slot", async () => {
		const fixture = await createFixture();
		const [first, second] = await Promise.all([
			deck(fixture, [
				"wt",
				"alloc",
				"--repo",
				fixture.repo,
				"--effort",
				"sample--parallel-a",
				"--base",
				"main",
			]),
			deck(fixture, [
				"wt",
				"alloc",
				"--repo",
				fixture.repo,
				"--effort",
				"sample--parallel-b",
				"--base",
				"main",
			]),
		]);
		expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
		const entries = readState(fixture.home).entries;
		expect(entries).toHaveLength(2);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
		expect(new Set(entries.map((entry) => entry.path)).size).toBe(2);
		expect(entries.every((entry) => entry.state === "active" && fs.existsSync(entry.path))).toBe(true);
	});

	test("skips an occupied free slot and creates the next pool slot", async () => {
		const fixture = await createFixture();
		const firstAlloc = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--occupied-first",
			"--base",
			"main",
		]);
		expect(firstAlloc.exitCode).toBe(0);
		const first = readState(fixture.home).entries[0];
		const released = await deck(fixture, ["wt", "release", first?.id ?? "missing"]);
		expect(released.exitCode).toBe(0);
		if (first === undefined) {
			throw new Error("expected allocated worktree entry");
		}
		fs.mkdirSync(first.path);

		const secondAlloc = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--occupied-second",
			"--base",
			"main",
		]);
		expect(secondAlloc.exitCode).toBe(0);
		const entries = readState(fixture.home).entries;
		expect(entries).toHaveLength(2);
		expect(entries[0]?.state).toBe("free");
		expect(entries[1]?.id).toBe("wt:sample-repo:2");
		expect(entries[1]?.state).toBe("active");
	});

	test("continues reaping after one repository fails and reports the failure", async () => {
		const fixture = await createFixture();
		for (const effort of ["sample--stuck", "sample--reapable"]) {
			const allocated = await deck(fixture, [
				"wt",
				"alloc",
				"--repo",
				fixture.repo,
				"--effort",
				effort,
				"--base",
				"main",
			]);
			expect(allocated.exitCode).toBe(0);
		}
		const current = readState(fixture.home);
		const poisoned = worktreesStateSchema.parse({
			v: 1,
			entries: current.entries.map((entry, index) => (
				index === 0 ? { ...entry, repo: path.join(fixture.root, "missing-repository") } : entry
			)),
		});
		fs.writeFileSync(
			path.join(fixture.home, "worktrees.json"),
			`${JSON.stringify(poisoned)}\n`,
			{ mode: 0o600 },
		);

		const result = await deck(fixture, ["wt", "reap"]);
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("reaped 1 worktree; 1 failed");
		const after = readState(fixture.home).entries;
		expect(after[0]?.state).toBe("active");
		expect(after[1]?.state).toBe("free");
		expect(after[0] === undefined ? false : fs.existsSync(after[0].path)).toBe(true);
		expect(after[1] === undefined ? true : fs.existsSync(after[1].path)).toBe(false);
	});

	test("reaps done, abandoned, and missing efforts while preserving active efforts", async () => {
		const fixture = await createFixture();
		const efforts: Array<[string, "active" | "done" | "abandoned" | "missing"]> = [
			["sample--done", "done"],
			["sample--abandoned", "abandoned"],
			["sample--missing", "missing"],
			["sample--active", "active"],
		];
		for (const [effort] of efforts) {
			const result = await deck(fixture, [
				"wt",
				"alloc",
				"--repo",
				fixture.repo,
				"--effort",
				effort,
				"--base",
				"main",
			]);
			expect(result.exitCode).toBe(0);
		}
		for (const [effort, stage] of efforts) {
			if (stage !== "missing") {
				writeManifest(fixture.home, effort, stage);
			}
		}
		const current = readState(fixture.home);
		const crashedReservation: WorktreeEntry = {
			id: "wt:sample-repo:5",
			repo: fs.realpathSync(fixture.repo),
			path: path.join(fixture.home, "wt", "sample-repo-5"),
			effort: "sample--crashed-reservation",
			branch: "deck/sample--crashed-reservation/ABCDEFGH",
			created: new Date().toISOString(),
			state: "active",
		};
		const journaled = worktreesStateSchema.parse({
			v: 1,
			entries: [...current.entries, crashedReservation],
		});
		fs.writeFileSync(
			path.join(fixture.home, "worktrees.json"),
			`${JSON.stringify(journaled)}\n`,
			{ mode: 0o600 },
		);
		writeManifest(fixture.home, crashedReservation.effort, "active");


		const before = readState(fixture.home).entries;
		const result = await deck(fixture, ["wt", "reap"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Reaped 4 worktrees.\n");
		const after = readState(fixture.home).entries;
		const stateByEffort = Object.fromEntries(after.map((entry) => [entry.effort, entry.state]));
		expect(stateByEffort).toEqual({
			"sample--done": "free",
			"sample--abandoned": "free",
			"sample--missing": "free",
			"sample--active": "active",
			"sample--crashed-reservation": "free",
		});
		for (const entry of before) {
			expect(fs.existsSync(entry.path)).toBe(entry.effort === "sample--active");
		}
	});

	test("reuses a stale lockfile left by a dead allocator", async () => {
		const fixture = await createFixture();
		fs.mkdirSync(fixture.home, { recursive: true });
		fs.writeFileSync(path.join(fixture.home, "worktrees.json.lock"), "stale owner\n", { mode: 0o600 });

		const result = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--after-crash",
			"--base",
			"main",
		]);
		expect(result.exitCode).toBe(0);
		expect(readState(fixture.home).entries[0]?.state).toBe("active");
	});

	test("returns admission exit 3 at the configured default cap of 24", async () => {
		const fixture = await createFixture();
		fs.mkdirSync(fixture.home, { recursive: true });
		const created = new Date().toISOString();
		const entries: WorktreeEntry[] = Array.from({ length: 24 }, (_, index) => ({
			id: `wt:occupied:${index + 1}`,
			repo: path.join(fixture.root, `occupied-${index + 1}`),
			path: path.join(fixture.home, "wt", `occupied-${index + 1}`),
			effort: `occupied-${index + 1}`,
			branch: `deck/occupied-${index + 1}/ABCDEFGH`,
			created,
			state: "active",
		}));
		const state = worktreesStateSchema.parse({ v: 1, entries });
		fs.writeFileSync(path.join(fixture.home, "worktrees.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

		const result = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample--over-cap",
			"--base",
			"main",
		]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("E_ADMISSION");
		expect(readState(fixture.home).entries).toHaveLength(24);
	});

	test("refuses an unowned worktree registry symlink without changing its target", async () => {
		const fixture = await createFixture();
		const foreign = path.join(fixture.root, "foreign-worktrees.json");
		const sentinel = '{"v":1,"entries":[]}\n';
		fs.mkdirSync(fixture.home, { recursive: true });
		fs.writeFileSync(foreign, sentinel);
		fs.symlinkSync(foreign, path.join(fixture.home, "worktrees.json"));

		const result = await deck(fixture, ["wt", "ls", "--json"]);
		expect(result.exitCode).toBe(4);
		expect(result.stderr).toContain("refusing unowned worktree registry link");
		expect(fs.readFileSync(foreign, "utf8")).toBe(sentinel);
	});

	test("maps malformed commands to user exit 2 and corrupt state to I/O exit 4", async () => {
		const fixture = await createFixture();
		const userError = await deck(fixture, ["wt", "alloc", "--repo", fixture.repo]);
		expect(userError.exitCode).toBe(2);
		expect(userError.stderr).toContain("E_ARG");

		const invalidRef = await deck(fixture, [
			"wt",
			"alloc",
			"--repo",
			fixture.repo,
			"--effort",
			"sample..invalid",
		]);
		expect(invalidRef.exitCode).toBe(2);
		expect(invalidRef.stderr).toContain("E_ARG");
		expect(invalidRef.stderr).not.toContain("fetch");

		fs.mkdirSync(fixture.home, { recursive: true });
		fs.writeFileSync(path.join(fixture.home, "worktrees.json"), "not-json\n");
		const ioError = await deck(fixture, ["wt", "ls", "--json"]);
		expect(ioError.exitCode).toBe(4);
		expect(ioError.stderr).toContain("E_IO");
	});
});
