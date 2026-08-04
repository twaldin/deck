import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimWorktree, releaseWorktree } from "../src/worktree-lock";

const oldHome = process.env.DECK_V2_HOME;
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
	if (oldHome === undefined) delete process.env.DECK_V2_HOME; else process.env.DECK_V2_HOME = oldHome;
});

describe("worktree locks", () => {
	test("release only removes the matching owner and claim cleanup is reusable", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lock-")); homes.push(home);
		process.env.DECK_V2_HOME = home;
		const wt = path.join(home, "wt"); fs.mkdirSync(wt);
		const release = claimWorktree(wt, "one");
		expect(() => claimWorktree(wt, "two")).toThrow(/already in use by one/);
		release();
		const releaseAgain = claimWorktree(wt, "two");
		releaseAgain();
	});

	test("a stale owner pid can be reclaimed", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lock-")); homes.push(home);
		process.env.DECK_V2_HOME = home;
		const wt = path.join(home, "wt"); fs.mkdirSync(wt);
		claimWorktree(wt, "dead", 999999);
		const release = claimWorktree(wt, "live");
		release();
	});

	test("a durable owner is not reclaimed when its launcher pid dies", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lock-")); homes.push(home);
		process.env.DECK_V2_HOME = home;
		const wt = path.join(home, "wt"); fs.mkdirSync(wt);
		claimWorktree(wt, "run", 999999, true);
		expect(() => claimWorktree(wt, "next")).toThrow(/already in use by run/);
		releaseWorktree(wt, "run");
	});

	test("a stale release closure cannot remove a replacement owner", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lock-")); homes.push(home);
		process.env.DECK_V2_HOME = home;
		const wt = path.join(home, "wt"); fs.mkdirSync(wt);
		const first = claimWorktree(wt, "first");
		releaseWorktree(wt, "first");
		const second = claimWorktree(wt, "second");
		first();
		expect(() => claimWorktree(wt, "third")).toThrow(/already in use by second/);
		second();
	});
});
