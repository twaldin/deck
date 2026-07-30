/**
 * Side-effect claim tests.
 *
 * This module guards the operations that cannot be undone: push, merge, deploy,
 * migration. The assertion that matters is exclusivity under genuine concurrency
 * — not "does the happy path work", but "can two callers both believe they hold
 * the claim and both push". The adversarial review found they could, because the
 * claim was taken with read-then-write plus a rename that silently overwrote a
 * competing claim.
 *
 * The concurrency test therefore uses real OS processes racing on the same file.
 * An in-process test cannot exercise this: single-threaded JS interleaves only at
 * await points, so it would pass against the broken code and prove nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_V2 = path.resolve(import.meta.dir, "..");
let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-se-"));
	process.env.DECK_V2_HOME = home;
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
	fs.writeFileSync(path.join(home, "state", "t1.meta"), "run_epoch=1\n");
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

async function mod() {
	return await import("../src/side-effects");
}

describe("claim exclusivity", () => {
	// Two tests cover exclusivity, because one alone is not honest.
	//
	// This one is DETERMINISTIC: it drives the reclaim window directly instead of
	// hoping OS scheduling lands inside it. Wall-clock barriers across bun
	// processes could not be made reliable — the collision rate moved with startup
	// jitter, not with the bug — and a guard on an irreversible-operation path that
	// only fails 2 runs in 8 gives false confidence.
	test("REGRESSION: reclaiming a dead holder is atomic, so two callers cannot both win", async () => {
		const { acquireClaim, ClaimError } = await mod();
		const claimFile = path.join(home, "state", "t1.side-effect.claim");
		const deadClaim = `${JSON.stringify({ receipt_id: "dead", op: "push", epoch: 1, pid: 999999, at: new Date().toISOString() })}\n`;
		fs.writeFileSync(claimFile, deadClaim);

		// Hold the reclaim lock: this is precisely the state a competing caller is in
		// after it has seen the dead holder and started replacing it.
		fs.mkdirSync(`${claimFile}.reclaim`);

		// The second caller must refuse rather than proceed. Under the old
		// rm-then-create reclaim both callers removed the file and both created it,
		// so both entered the push.
		expect(() => acquireClaim("t1", "push", 1, { target: "origin/main" })).toThrow(ClaimError);
		// The dead holder's claim is untouched: a loser must not destroy state.
		expect(fs.readFileSync(claimFile, "utf8")).toBe(deadClaim);

		// Once the winner finishes, reclaiming works again.
		fs.rmSync(`${claimFile}.reclaim`, { recursive: true });
		expect(acquireClaim("t1", "push", 1, { target: "origin/main" }).status).toBe("pending");
	});

	// And this one is the end-to-end sanity check with real processes. It is not
	// relied on to catch the race (it cannot do so deterministically); it proves
	// the invariant holds when many processes genuinely contend.
	test("many real processes contending produce exactly one winner", async () => {
		const contenders = 8;
		const script = `
			process.env.DECK_V2_HOME = ${JSON.stringify(home)};
			const fs = await import("node:fs");
			const { acquireClaim } = await import(${JSON.stringify(path.join(REPO_V2, "src", "side-effects.ts"))});
			const barrier = ${JSON.stringify(path.join(home, "barrier"))};
			fs.appendFileSync(barrier, "x");
			while (fs.readFileSync(barrier, "utf8").length < ${contenders}) {}
			try {
				acquireClaim("t1", "push", 1, { target: "origin/main" });
				console.log("WON");
			} catch {
				console.log("REFUSED");
			}
		`;
		const file = path.join(home, "race.mjs");
		fs.writeFileSync(file, script);
		fs.writeFileSync(path.join(home, "barrier"), "");

		const procs = Array.from({ length: contenders }, () =>
			Bun.spawn(["bun", file], { env: { ...process.env }, stdout: "pipe" }),
		);
		const texts = await Promise.all(procs.map((proc) => new Response(proc.stdout).text()));

		expect(texts.filter((text) => text.includes("WON"))).toHaveLength(1);
		// The durable evidence must agree: two pending receipts would mean two
		// processes each believed they were pushing.
		const { unresolvedReceipts } = await mod();
		expect(unresolvedReceipts("t1")).toHaveLength(1);
	});

	test("a live holder blocks a claim from ANY epoch", async () => {
		const { acquireClaim, ClaimError } = await mod();
		// This process is alive and holds the claim at epoch 1.
		acquireClaim("t1", "push", 1, { target: "origin/main" });

		// A newer epoch must still be refused: a superseded run that is still alive
		// can be mid-push, and an epoch grants the right to START, not the power to
		// un-land someone else's push.
		fs.writeFileSync(path.join(home, "state", "t1.meta"), "run_epoch=2\n");
		expect(() => acquireClaim("t1", "push", 2, { target: "origin/main" })).toThrow(ClaimError);
	});

	test("a dead holder's claim is reclaimable", async () => {
		const { acquireClaim } = await mod();
		const claimFile = path.join(home, "state", "t1.side-effect.claim");
		// A claim left by a process that no longer exists. PID 999999 is not live.
		fs.writeFileSync(
			claimFile,
			`${JSON.stringify({ receipt_id: "r0", op: "push", epoch: 1, pid: 999999, at: new Date().toISOString() })}\n`,
		);
		const receipt = acquireClaim("t1", "push", 1, { target: "origin/main" });
		expect(receipt.status).toBe("pending");
	});

	test("a superseded epoch cannot claim at all", async () => {
		const { acquireClaim, ClaimError } = await mod();
		fs.writeFileSync(path.join(home, "state", "t1.meta"), "run_epoch=3\n");
		expect(() => acquireClaim("t1", "push", 1, { target: "origin/main" })).toThrow(ClaimError);
	});
});

describe("receipts", () => {
	test("a pending receipt exists before the op, so a crash reads as may-have-happened", async () => {
		const { acquireClaim, unresolvedReceipts } = await mod();
		acquireClaim("t1", "push", 1, { target: "origin/main" });
		const unresolved = unresolvedReceipts("t1");
		expect(unresolved).toHaveLength(1);
		expect(unresolved[0]?.status).toBe("pending");
	});

	test("settling resolves the receipt and releases the claim", async () => {
		const { acquireClaim, settleClaim, unresolvedReceipts } = await mod();
		const receipt = acquireClaim("t1", "push", 1, { target: "origin/main" });
		settleClaim("t1", receipt, { status: "confirmed", ref: "abc123" });
		expect(unresolvedReceipts("t1")).toHaveLength(0);
		expect(fs.existsSync(path.join(home, "state", "t1.side-effect.claim"))).toBe(false);
	});

	test("reclaiming from a dead holder does NOT resolve its receipt", async () => {
		const { acquireClaim, unresolvedReceipts } = await mod();
		const first = acquireClaim("t1", "push", 1, { target: "origin/main" });
		// Simulate the holder dying: its claim points at a dead pid.
		const claimFile = path.join(home, "state", "t1.side-effect.claim");
		const claim = JSON.parse(fs.readFileSync(claimFile, "utf8"));
		fs.writeFileSync(claimFile, `${JSON.stringify({ ...claim, pid: 999999 })}\n`);

		acquireClaim("t1", "push", 1, { target: "origin/main" });
		// The dead run's pending receipt survives: we cannot know whether its push
		// landed, and pretending we do is how work gets pushed twice.
		const unresolved = unresolvedReceipts("t1");
		expect(unresolved.some((item) => item.receipt_id === first.receipt_id)).toBe(true);
	});
});
