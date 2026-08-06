/**
 * The deck home is a plain runtime directory, not a code checkout.
 *
 * The guard prevents project instructions and disposable worktree operations
 * from capturing private home state.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ARCHIVE_ONCE_NAMES,
	DURABLE_LINK_NAMES,
	bootstrapHome,
} from "../src/bootstrap";
import { openQuestions } from "../src/questions-store";
import { homeSyncMayCopyEntry, purgeNonPortableProfileEntries } from "../src/home-sync";

const REPO_V2 = path.resolve(import.meta.dir, "..");
let sandbox: string;

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-home-"));
	delete process.env.DECK_V2_ALLOW_REPO_HOME;
});

afterEach(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
	delete process.env.DECK_V2_ALLOW_REPO_HOME;
	delete process.env.DECK_HOME_PROFILE;
});

describe("home sync profile resolution", () => {
	test("refuses when neither env nor marker resolves a profile", async () => {
		delete process.env.DECK_HOME_PROFILE;
		const { resolveHomeSyncProfile } = await import("../src/home-sync");
		expect(() => resolveHomeSyncProfile(path.join(sandbox, "home"))).toThrow(/refused/);
	});

	test("uses the marker and lets the environment override it", async () => {
		const home = path.join(sandbox, "home");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, ".deck-profile"), "full\n");
		const { resolveHomeSyncProfile } = await import("../src/home-sync");
		delete process.env.DECK_HOME_PROFILE;
		expect(resolveHomeSyncProfile(home)).toBe("full");
		process.env.DECK_HOME_PROFILE = "personal";
		expect(resolveHomeSyncProfile(home)).toBe("personal");
	});
});

	test("never copies host-local, retired, or installer-owned entries between hosts", () => {
		for (const name of [...DURABLE_LINK_NAMES, ...ARCHIVE_ONCE_NAMES, "enter.sh", "START.md", "workflows"]) {
			expect(homeSyncMayCopyEntry(name)).toBe(false);
		}
		expect(homeSyncMayCopyEntry("operator-prompt.txt")).toBe(true);
	});

	test("purges newly private entries from an existing profile clone", () => {
		const profile = path.join(sandbox, "profile");
		fs.mkdirSync(path.join(profile, ".git"), { recursive: true });
		fs.mkdirSync(path.join(profile, "config"));
		fs.writeFileSync(path.join(profile, "worktrees.json"), "{}\n");
		fs.writeFileSync(path.join(profile, "operator-prompt.txt"), "portable\n");
		purgeNonPortableProfileEntries(profile);
		expect(fs.existsSync(path.join(profile, "config"))).toBe(false);
		expect(fs.existsSync(path.join(profile, "worktrees.json"))).toBe(false);
		expect(fs.existsSync(path.join(profile, ".git"))).toBe(true);
		expect(fs.readFileSync(path.join(profile, "operator-prompt.txt"), "utf8")).toBe("portable\n");
	});

describe("home is not a checkout", () => {
	test("REGRESSION: refuses a home inside a git working tree", async () => {
		const repo = path.join(sandbox, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		process.env.DECK_V2_HOME = repo;
		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(repo)).toThrow(/not a code checkout/);
	});

	test("REGRESSION: refuses a path NESTED inside a checkout", async () => {
		const repo = path.join(sandbox, "repo");
		const nested = path.join(repo, "sub", "deeper");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(nested, { recursive: true });
		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(nested)).toThrow(/git working tree/);
	});

	test("accepts a plain directory", async () => {
		const home = path.join(sandbox, "home");
		fs.mkdirSync(home, { recursive: true });
		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(home)).not.toThrow();
	});

	test("an explicit override is honored", async () => {
		const repo = path.join(sandbox, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		process.env.DECK_V2_ALLOW_REPO_HOME = "1";
		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(repo)).not.toThrow();
	});

	test("the CLI refuses a checkout home before writing state", () => {
		const repo = path.join(sandbox, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		let failed = false;
		try {
			execFileSync("bun", [path.join(REPO_V2, "bin", "deck-v2"), "note", "t1", "working", "x"], {
				env: { ...process.env, DECK_V2_HOME: repo },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		// And nothing was written.
		expect(fs.existsSync(path.join(repo, "state"))).toBe(false);
	});
});

describe("bootstrap", () => {
	test("creates the Deck conversation home and copies the public contract seed", async () => {
		const home = path.join(sandbox, "home");
		process.env.DECK_V2_HOME = home;
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });

		expect(fs.existsSync(path.join(home, "data"))).toBe(true);
		expect(fs.existsSync(path.join(home, "state"))).toBe(true);
		const contract = path.join(home, "AGENTS.md");
		expect(fs.lstatSync(contract).isSymbolicLink()).toBe(false);
		const body = fs.readFileSync(contract, "utf8");
		expect(body).toContain("You are a Deck conversation seat");
		expect(body).toContain("Run `~/.optmem/memo wake` before any other tool call");
		expect(body).toContain("Attempt `memo wake` exactly once");
		expect(body).toContain("DEGRADED MEMORY — OptMem wake failed");
		expect(body).toContain("Queue one operational-defect question");
		expect(body).toContain("do not retry, loop, or wait in the background");
		expect(body).toMatch(/do not claim durable\s+memory, remembered identity, or remembered decisions/);
		expect(body).not.toContain("single point of contact");
		expect(result.created.length).toBeGreaterThan(0);
		expect(
			JSON.parse(fs.readFileSync(path.join(home, "config", "reviewers.json"), "utf8")),
		).toEqual({
			selfLogins: [],
			excludedApprovers: [],
			reviewerDenylist: [],
			reviewers: [],
		});
		expect(fs.statSync(path.join(home, "config", "reviewers.json")).mode & 0o777).toBe(0o600);
	});

	test("is idempotent", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		const second = bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		expect(second.created).toHaveLength(0);
		expect(second.linked).toHaveLength(0);
	});

	test("rejects foreign durable symlinks before claiming or changing them", () => {
		const home = path.join(sandbox, "home");
		const durableRoot = path.join(sandbox, "durable");
		const foreign = path.join(sandbox, "foreign-data");
		fs.mkdirSync(home);
		fs.mkdirSync(foreign);
		fs.symlinkSync(foreign, path.join(home, "data"));

		expect(() => bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem: false }))
			.toThrow(/unowned durable Deck link/);
		expect(fs.readlinkSync(path.join(home, "data"))).toBe(foreign);
		expect(fs.existsSync(durableRoot)).toBe(false);
	});

	test("rejects a durable root inside the wipe path before writing the home", () => {
		const home = path.join(sandbox, "absent-home");
		expect(() => bootstrapHome({
			repoV2Dir: REPO_V2,
			home,
			durableRoot: path.join(home, "not-durable"),
			optMem: false,
		})).toThrow(/must live outside the wipe path/);
		expect(fs.existsSync(home)).toBe(false);
	});

	test("rejects a durable-root symlink that resolves back inside the wipe path", () => {
		const home = path.join(sandbox, "home-with-alias");
		const inside = path.join(home, "inside");
		const alias = path.join(sandbox, "durable-alias");
		fs.mkdirSync(inside, { recursive: true });
		fs.symlinkSync(inside, alias);
		expect(() => bootstrapHome({
			repoV2Dir: REPO_V2,
			home,
			durableRoot: alias,
			optMem: false,
		})).toThrow(/must live outside the wipe path/);
	});

	test("rejects symlinked backing entries inside the owned durable root", () => {
		const home = path.join(sandbox, "owned-home");
		const durableRoot = path.join(sandbox, "owned-durable");
		const foreign = path.join(sandbox, "foreign-backing");
		bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem: false });
		fs.rmSync(path.join(home, "data"));
		fs.rmdirSync(path.join(durableRoot, "data"));
		fs.mkdirSync(foreign);
		fs.symlinkSync(foreign, path.join(durableRoot, "data"));
		expect(() => bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem: false }))
			.toThrow(/target is not a directory/);
		expect(fs.readlinkSync(path.join(durableRoot, "data"))).toBe(foreign);
	});

	test("rename-wipe and reinstall preserve every host-local durable authority", async () => {
		const home = path.join(sandbox, ".deck");
		const durableRoot = path.join(sandbox, ".deck-durable");
		const memo = path.join(sandbox, ".optmem", "memo");
		const repo = path.join(sandbox, "repo");
		const worktree = path.join(home, "wt", "wipe-proof");
		const brokerDir = path.join(home, "broker");
		const brokerDb = path.join(brokerDir, "store.db");

		fs.mkdirSync(path.join(home, "data", "wipe-proof"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "state", "smithers"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "questions"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(brokerDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "config"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "efforts", "legacy"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "intake"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, ".pi", "skills", "operator"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, ".prime", "sessions"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(home, "logs"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.dirname(memo), { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(home, "data", "wipe-proof", "brief.md"), "# irreplaceable dossier\n");
		fs.writeFileSync(path.join(home, "state", "wipe-proof.status"), "2026-08-06T00:00:00Z\tWORKING\tresume\n");
		fs.writeFileSync(path.join(home, "state", "wipe-proof.meta"), '{"task":"wipe-proof"}\n');
		fs.writeFileSync(path.join(home, "state", "wipe-proof.queue"), "continue\n");
		fs.writeFileSync(
			path.join(home, "questions", "queue.jsonl"),
			`${JSON.stringify({
				kind: "ask",
				id: "wipe-question",
				question: "Keep the durable queue?",
				urgency: "normal",
				sessionId: "wipe-session",
				cwd: worktree,
				askedAt: Date.now(),
			})}\n`,
		);
		fs.writeFileSync(path.join(brokerDir, "control.token"), "host-secret-control\n", { mode: 0o644 });
		fs.writeFileSync(path.join(brokerDir, "gateway.token"), "host-secret-gateway\n", { mode: 0o644 });
		fs.writeFileSync(path.join(home, "config", "projects.json"), '[{"id":"local-only"}]\n');
		fs.writeFileSync(path.join(home, "efforts", "legacy", "manifest.json"), '{"effort":"legacy"}\n');
		fs.writeFileSync(path.join(home, "intake", "events.jsonl"), '{"kind":"review","id":"edge-triggered"}\n');
		fs.writeFileSync(path.join(home, ".pi", "skills", "operator", "prompt.txt"), "retired technique\n");
		fs.writeFileSync(path.join(home, ".prime", "sessions", "disposable.jsonl"), "runtime transcript\n");
		fs.writeFileSync(path.join(home, "logs", "disposable.log"), "reconstructible diagnostics\n");
		fs.writeFileSync(path.join(home, ".env"), "HOST_ONLY_SECRET=still-here\n", { mode: 0o600 });
		fs.writeFileSync(path.join(home, ".deck-profile"), "personal\n", { mode: 0o600 });
		fs.writeFileSync(path.join(home, "config.json"), '{"admission":{"maxWorktreesGlobal":7}}\n', { mode: 0o600 });
		fs.writeFileSync(
			memo,
			'#!/bin/sh\n[ "${1:-}" = wake ] || exit 2\nprintf "memory awake: durable fact\\n"\n',
			{ mode: 0o700 },
		);

		execFileSync("git", ["init", "-q", "--initial-branch=main", repo]);
		execFileSync("git", ["-C", repo, "config", "user.email", "deck-test@example.invalid"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "Deck Test"]);
		fs.writeFileSync(path.join(repo, "README"), "base\n");
		execFileSync("git", ["-C", repo, "add", "README"]);
		execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);
		fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "deck/wipe-proof", worktree]);
		fs.writeFileSync(
			path.join(home, "worktrees.json"),
			`${JSON.stringify({
				v: 1,
				entries: [{
					id: "wt:repo:1",
					repo,
					path: worktree,
					effort: "wipe-proof",
					branch: "deck/wipe-proof",
					created: new Date().toISOString(),
					state: "active",
				}],
			}, null, "\t")}\n`,
			{ mode: 0o600 },
		);

		const brokerRoot = path.resolve(REPO_V2, "..", "broker");
		execFileSync(
			"bun",
			["-e", `
				import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
				const store = await SqliteAuthCredentialStore.open(${JSON.stringify(brokerDb)});
				store.upsertAuthCredentialForProvider("anthropic", {
					type: "oauth",
					access: "test-access-token",
					refresh: "test-refresh-token",
					expires: Date.now() + 3_600_000,
					email: "wipe-proof@example.invalid"
				});
				store.close();
			`],
			{ cwd: brokerRoot, stdio: "pipe" },
		);
		const smithersDb = path.join(home, "state", "smithers", "smithers.db");
		const smithers = new Database(smithersDb, { create: true });
		smithers.exec("CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('live-run');");
		smithers.close();

		const optMem = {
			memoPath: memo,
			installerPath: path.join(sandbox, "must-not-run"),
			runInstaller: () => {
				throw new Error("existing memory executable should be adopted without reinstall");
			},
		};
		bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem });

		for (const name of DURABLE_LINK_NAMES) {
			expect(fs.lstatSync(path.join(home, name)).isSymbolicLink()).toBe(true);
		}
		for (const name of ARCHIVE_ONCE_NAMES) expect(fs.existsSync(path.join(home, name))).toBe(false);
		expect(fs.readFileSync(path.join(durableRoot, "archive", "retired-pi-profile", "skills", "operator", "prompt.txt"), "utf8")).toBe("retired technique\n");
		expect(fs.statSync(durableRoot).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(durableRoot, ".deck-durable.json")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(durableRoot, "broker", "store.db")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(durableRoot, "broker", "control.token")).mode & 0o777).toBe(0o600);

		const archivedHome = path.join(sandbox, ".deck.pre-cutover");
		fs.renameSync(home, archivedHome);
		bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem });

		const linkTargets = Object.fromEntries(
			DURABLE_LINK_NAMES.map((name) => [name, fs.readlinkSync(path.join(home, name))]),
		);
		const emptyWorkflows = path.join(sandbox, "workflows");
		const binTarget = path.join(sandbox, "bin");
		fs.mkdirSync(emptyWorkflows);
		execFileSync("bash", [path.join(REPO_V2, "install.sh")], {
			env: {
				...process.env,
				HOME: sandbox,
				DECK_V2_HOME: home,
				DECK_DURABLE_HOME: durableRoot,
				BIN_TARGET: binTarget,
				WORKFLOWS_SOURCE: emptyWorkflows,
			},
			stdio: "pipe",
		});
		const converged = bootstrapHome({ repoV2Dir: REPO_V2, home, durableRoot, optMem });
		expect(converged.linked).toHaveLength(0);
		for (const [name, target] of Object.entries(linkTargets)) {
			expect(fs.readlinkSync(path.join(home, name))).toBe(target);
		}

		expect(fs.readFileSync(path.join(home, "data", "wipe-proof", "brief.md"), "utf8")).toBe("# irreplaceable dossier\n");
		expect(fs.readFileSync(path.join(home, "state", "wipe-proof.meta"), "utf8")).toBe('{"task":"wipe-proof"}\n');
		expect(fs.readFileSync(path.join(home, "intake", "events.jsonl"), "utf8")).toContain("edge-triggered");
		const questionIds = openQuestions(path.join(home, "questions", "queue.jsonl"))
			.map((question) => question.id);
		expect(questionIds).toEqual(["wipe-question"]);
		const reopenedSmithers = new Database(path.join(home, "state", "smithers", "smithers.db"), { readonly: true });
		expect(reopenedSmithers.query<{ value: string }, []>("SELECT value FROM proof").get()?.value).toBe("live-run");
		reopenedSmithers.close();
		expect(execFileSync(memo, ["wake"], { encoding: "utf8" })).toBe("memory awake: durable fact\n");
		expect(execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" })).toBe("");

		execFileSync(
			"bun",
			["-e", `
				import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
				const store = await SqliteAuthCredentialStore.open(${JSON.stringify(path.join(home, "broker", "store.db"))});
				const storage = new AuthStorage(store);
				await storage.reload();
				const live = storage.exportSnapshot().credentials.some(
					(row) => row.provider === "anthropic" && row.credential.type === "oauth" &&
						row.credential.email === "wipe-proof@example.invalid"
				);
				storage.close();
				if (!live) throw new Error("OAuth account did not survive the home rebuild");
			`],
			{ cwd: brokerRoot, stdio: "pipe" },
		);

		const allocated = execFileSync(
			"bun",
			[
				path.resolve(REPO_V2, "..", "cli", "bin", "deck"),
				"wt",
				"alloc",
				"--repo",
				repo,
				"--effort",
				"wipe-proof-2",
				"--base",
				"main",
				"--branch",
				"deck/wipe-proof-2",
			],
			{ env: { ...process.env, DECK_HOME: home }, encoding: "utf8" },
		);
		const [allocatedId, allocatedPath] = allocated.trim().split("\t");
		expect(allocatedId).toBe("wt:repo:2");
		expect(fs.lstatSync(path.join(home, "worktrees.json")).isSymbolicLink()).toBe(true);
		expect(allocatedPath).toBeDefined();
		expect(fs.existsSync(path.join(allocatedPath!, ".git"))).toBe(true);
		expect(fs.readFileSync(path.join(home, ".env"), "utf8")).toContain("HOST_ONLY_SECRET=still-here");
		expect(fs.readFileSync(path.join(home, "config", "projects.json"), "utf8")).toContain("local-only");
		expect(fs.readFileSync(path.join(home, "config.json"), "utf8")).toContain('"maxWorktreesGlobal":7');
		expect(fs.existsSync(path.join(home, ".prime", "sessions", "disposable.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(home, "logs", "disposable.log"))).toBe(false);
	}, 30_000);

	test("backs up local AGENTS.md drift before restoring the managed seed", async () => {
		const home = path.join(sandbox, "home");
		const contract = path.join(home, "AGENTS.md");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(contract, "# mine\n");
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		expect(fs.readFileSync(contract, "utf8")).toBe(fs.readFileSync(path.join(REPO_V2, "seed", "AGENTS.md"), "utf8"));
		expect(fs.statSync(contract).mode & 0o777).toBe(0o644);
		const backupRoots = fs.readdirSync(path.join(home, "backups"));
		expect(backupRoots).toHaveLength(1);
		const backup = path.join(home, "backups", backupRoots[0]!, "AGENTS.md");
		expect(fs.readFileSync(backup, "utf8")).toBe("# mine\n");
		expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
		expect(result.notes).toContain(`backed up local AGENTS.md to ${backup}`);
		expect(result.notes).toContain(`updated installer-managed home contract ${contract}`);
	});

	test("does not recreate the retired markdown memory stores", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		expect(fs.existsSync(path.join(home, "data", "captain.md"))).toBe(false);
		expect(fs.existsSync(path.join(home, "data", "learnings.md"))).toBe(false);
	});
});

describe("symlink escape", () => {
	// The adversarial review found this: path.resolve does not follow symlinks, so
	// a home that is a LINK into a checkout walked the link's own parents, never
	// saw the repo's .git, and the guard passed. Live state then lived in a working
	// tree a crew could rebase.
	test("REGRESSION: a symlink pointing into a checkout is still refused", async () => {
		const repo = path.join(sandbox, "repo");
		const inside = path.join(repo, "home");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(inside, { recursive: true });
		const link = path.join(sandbox, "link-home");
		fs.symlinkSync(inside, link);

		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(link)).toThrow(/git working tree/);
	});

	test("a symlink to a plain directory is still accepted", async () => {
		const real = path.join(sandbox, "real-home");
		fs.mkdirSync(real, { recursive: true });
		const link = path.join(sandbox, "ok-home");
		fs.symlinkSync(real, link);
		const { assertHomeIsNotACheckout } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(link)).not.toThrow();
	});

	test("a home that does not exist yet is still checked against its ancestors", async () => {
		const repo = path.join(sandbox, "repo2");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		const { assertHomeIsNotACheckout } = await import("../src/home");
		// bootstrap runs before the directory exists; the guard must still fire.
		expect(() => assertHomeIsNotACheckout(path.join(repo, "not", "yet"))).toThrow(/git working tree/);
	});
});

describe("prompt isolation in the checkout", () => {
	test("the only nested AGENTS.md is the mandated public home seed", () => {
		const repoRoot = path.resolve(REPO_V2, "..");
		const found = execFileSync("git", ["ls-files", "*AGENTS.md", "AGENTS.md"], {
			cwd: repoRoot,
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => line.length > 0)
			// Only files literally named AGENTS.md are auto-loaded as agent
			// context; suffix matches like docs/LAPTOP-AGENTS.md are docs.
			.filter((line) => path.basename(line) === "AGENTS.md");

		expect(found.filter((file) => file !== "AGENTS.md")).toEqual(["v2/seed/AGENTS.md"]);
		const seed = fs.readFileSync(path.join(REPO_V2, "seed", "AGENTS.md"), "utf8");
		expect(seed).toContain("You are a Deck conversation seat");
		expect(seed).not.toContain("single point of contact");
	});
});

describe("the seeded contract is clean", () => {
	test("is a compact, public-safe conversation-seat contract", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		const contract = fs.readFileSync(path.join(home, "AGENTS.md"), "utf8");
		expect(contract).toStartWith("# Deck home");
		expect(contract).toContain("## THE FACTORY");
		expect(contract).toContain("## QUESTIONS DISCIPLINE");
		expect(contract).toContain("## THIS SESSION NEVER");
		expect(contract).toContain(
			"This seat discharges build, review, and deploy obligations only through those\n" +
				"calls and queued questions",
		);
		// Named explicitly: pointing the factory at a repo with human reviewers is
		// the change most likely to make a seat call a blocked PR "done".
		expect(contract).toContain("### Repos with human reviewers");
		expect(contract).toContain("green CI is not delivery evidence");
		expect(contract).toContain("Prime seats delegate bounded work only through native `rlm()`");
		expect(contract).toMatch(/RLM depth is one:\s+children are allowed and grandchildren are not/);
		expect(contract).toMatch(/A bare child uses\s+`deck\/gpt-5\.6-luna` at reasoning `xhigh`/);
		expect(contract).not.toMatch(/\b(?:Lindy|captain|twaldin)\b/i);
		// The human-reviewer contract, the memory privacy boundary, and the CLI
		// table are all load-bearing for a production repo, so the budget moved
		// once, deliberately. Keep it tight: this is injected into every session.
		expect(Buffer.byteLength(contract, "utf8")).toBeLessThan(15 * 1024);
	});
});

describe("the two fleets stay apart", () => {
	// The previous system has NO notion of owner_system (verified: zero references
	// across its 90 scripts) and its watcher globs every *.status in its own state
	// dir. So a marker cannot make it skip deck-owned tasks — the only real
	// isolation is separate homes, and that was incidental until this guard.
	test("REGRESSION: refuses the previous fleet's home", async () => {
		const legacy = path.join(sandbox, "fm-home");
		fs.mkdirSync(path.join(legacy, "state"), { recursive: true });
		fs.mkdirSync(path.join(legacy, "bin"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "bin", "fm-watch.sh"), "#!/bin/sh\n");

		const { assertHomeIsNotAnotherFleet } = await import("../src/home");
		expect(() => assertHomeIsNotAnotherFleet(legacy)).toThrow(/previous fleet's home/);
	});

	test("a deck home with its own state dir is fine", async () => {
		const home = path.join(sandbox, "deck-home");
		fs.mkdirSync(path.join(home, "state"), { recursive: true });
		const { assertHomeIsNotAnotherFleet } = await import("../src/home");
		expect(() => assertHomeIsNotAnotherFleet(home)).not.toThrow();
	});

	test("the guard is independent of the checkout guard", async () => {
		// Someone who sets DECK_V2_ALLOW_REPO_HOME must still not land on the old home.
		const legacy = path.join(sandbox, "fm-repo");
		fs.mkdirSync(path.join(legacy, "state"), { recursive: true });
		fs.mkdirSync(path.join(legacy, "bin"), { recursive: true });
		fs.mkdirSync(path.join(legacy, ".git"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "bin", "fm-watch.sh"), "#!/bin/sh\n");
		process.env.DECK_V2_ALLOW_REPO_HOME = "1";
		const { assertHomeIsNotACheckout, assertHomeIsNotAnotherFleet } = await import("../src/home");
		expect(() => assertHomeIsNotACheckout(legacy)).not.toThrow();
		expect(() => assertHomeIsNotAnotherFleet(legacy)).toThrow();
	});
});
