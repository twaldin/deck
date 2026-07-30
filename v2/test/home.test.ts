/**
 * The orchestrator home is a plain directory, not a code checkout.
 *
 * This is the fm2 flaw the captain named: FM_HOME was the repo you also
 * developed the tooling in, so the orchestrator loaded the repo's AGENTS.md
 * (project memory) instead of an operating contract, and its live state sat in a
 * working tree a crew could rebase. The guard here is what stops the natural
 * drift back to that shape.
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
	test("creates the home and copies the contract seed", async () => {
		const home = path.join(sandbox, "home");
		process.env.DECK_V2_HOME = home;
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home });

		expect(fs.existsSync(path.join(home, "data"))).toBe(true);
		expect(fs.existsSync(path.join(home, "state"))).toBe(true);
		// COPIED, not linked: the captain owns this file and edits it in place, so a
		// link would make his edits a repo diff and a reinstall would clobber them.
		const contract = path.join(home, "AGENTS.md");
		expect(fs.lstatSync(contract).isSymbolicLink()).toBe(false);
		// And it is the ORCHESTRATOR contract, not deck's project memory.
		const body = fs.readFileSync(contract, "utf8");
		expect(body).toContain("You are the captain's single point of contact");
		expect(body).not.toContain("Project agent memory");
		expect(result.created.length).toBeGreaterThan(0);
	});

	test("is idempotent", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home });
		const second = bootstrapHome({ repoV2Dir: REPO_V2, home });
		expect(second.created).toHaveLength(0);
		expect(second.linked).toHaveLength(0);
	});

	test("does not clobber a real AGENTS.md the captain wrote", async () => {
		const home = path.join(sandbox, "home");
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, "AGENTS.md"), "# mine\n");
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home });
		expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8")).toBe("# mine\n");
		expect(result.notes.join(" ")).toContain("yours to edit");
	});

	test("seeds memory files once, then leaves them alone", async () => {
		const home = path.join(sandbox, "home");
		process.env.DECK_V2_HOME = home;
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home });
		const learnings = path.join(home, "data", "learnings.md");
		fs.appendFileSync(learnings, "- something we learned\n");
		bootstrapHome({ repoV2Dir: REPO_V2, home });
		expect(fs.readFileSync(learnings, "utf8")).toContain("something we learned");
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
	// pi discovers AGENTS.md in the working directory and its ancestors. The
	// orchestrator contract therefore must not be committed under that name
	// anywhere in this repo: a worker running here would load "you are the
	// captain's single point of contact, you never write code" as its own
	// instructions.
	test("REGRESSION: no AGENTS.md in the repo carries operator doctrine", () => {
		const repoRoot = path.resolve(REPO_V2, "..");
		const found = execFileSync("git", ["ls-files", "*AGENTS.md", "AGENTS.md"], {
			cwd: repoRoot,
			encoding: "utf8",
		})
			.split("\n")
			.filter((line) => line.length > 0);

		for (const file of found) {
			const body = fs.readFileSync(path.join(repoRoot, file), "utf8");
			expect(body).not.toContain("You are the captain's single point of contact");
		}
		// And the seed exists under a name pi does not auto-load.
		expect(fs.existsSync(path.join(REPO_V2, "seed", "orchestrator-contract.md"))).toBe(true);
	});
});

describe("the seeded contract is clean", () => {
	test("build guidance does not ship into the captain's contract", async () => {
		const home = path.join(sandbox, "home");
		const { bootstrapHome } = await import("../src/bootstrap");
		bootstrapHome({ repoV2Dir: REPO_V2, home });
		const contract = fs.readFileSync(path.join(home, "AGENTS.md"), "utf8");
		// The seed explains why it is not named AGENTS.md; that is for whoever works
		// on deck, not an instruction for the agent reading its own contract.
		expect(contract).not.toContain("<!--");
		expect(contract).toStartWith("# Orchestrator");
		expect(contract).toContain("only agent that asks him anything");
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
