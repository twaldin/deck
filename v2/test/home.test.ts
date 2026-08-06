/**
 * The deck home is a plain runtime directory, not a code checkout.
 *
 * The guard prevents project instructions and disposable worktree operations
 * from capturing private home state.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	test("creates the plain pi home and copies the public contract seed", async () => {
		const home = path.join(sandbox, "home");
		process.env.DECK_V2_HOME = home;
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });

		expect(fs.existsSync(path.join(home, "data"))).toBe(true);
		expect(fs.existsSync(path.join(home, "state"))).toBe(true);
		const contract = path.join(home, "AGENTS.md");
		expect(fs.lstatSync(contract).isSymbolicLink()).toBe(false);
		const body = fs.readFileSync(contract, "utf8");
		expect(body).toContain("You are a plain pi session");
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

	test("does not clobber a real AGENTS.md the operator wrote", async () => {
		const home = path.join(sandbox, "home");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, "AGENTS.md"), "# mine\n");
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8")).toBe("# mine\n");
		expect(result.notes.join(" ")).toContain("yours to edit");
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
		expect(seed).toContain("You are a plain pi session");
		expect(seed).not.toContain("single point of contact");
	});
});

describe("the seeded contract is clean", () => {
	test("is a compact, public-safe plain-session contract", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home, optMem: false });
		const contract = fs.readFileSync(path.join(home, "AGENTS.md"), "utf8");
		expect(contract).toStartWith("# Deck home");
		expect(contract).toContain("## THE FACTORY");
		expect(contract).toContain("## QUESTIONS DISCIPLINE");
		expect(contract).toContain("## THIS SESSION NEVER");
		expect(contract).toContain(
			"this plain pi chat session discharges\n" +
				"them only through `ship`, `adopt`, `status`, and queued questions",
		);
		expect(contract).not.toMatch(/\b(?:Lindy|captain|twaldin)\b/i);
		expect(Buffer.byteLength(contract, "utf8")).toBeLessThan(12 * 1024);
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
