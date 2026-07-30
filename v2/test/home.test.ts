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
	test("creates the home and symlinks the contract", async () => {
		const home = path.join(sandbox, "home");
		process.env.DECK_V2_HOME = home;
		const { bootstrapHome } = await import("../src/bootstrap");
		const result = bootstrapHome({ repoV2Dir: REPO_V2, home });

		expect(fs.existsSync(path.join(home, "data"))).toBe(true);
		expect(fs.existsSync(path.join(home, "state"))).toBe(true);
		// The contract is a LINK so improving it stays a normal repo commit.
		const contract = path.join(home, "AGENTS.md");
		expect(fs.lstatSync(contract).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(contract)).toBe(path.join(REPO_V2, "AGENTS.md"));
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
		expect(result.notes.join(" ")).toContain("not our symlink");
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
