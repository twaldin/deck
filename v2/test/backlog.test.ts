/**
 * The debate verdict named exactly one runnable check: assert that (a)
 * pr-pipeline rejects an internal item id, (b) the 21st open internal item is
 * rejected, (c) an item past expiry reads as closed with `expired-unattended`.
 *
 * Those three are the design; everything else here is one test per real refusal.
 * Deliberately not one test per field.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-backlog-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

const load = () => import("../src/backlog");

describe("backlog boundary (the three checks the debate required)", () => {
	test("(a) a delivery run rejects an internal item id", async () => {
		const b = await load();
		b.createInternal({ id: "scout-thing", type: "scout", intent: "look at X", owner: "orchestrator" });
		expect(() => b.assertDispatchable("scout-thing")).toThrow(/internal scout item/);
		// External refs pass.
		b.assertDispatchable("#123");
		b.assertDispatchable("lindy-ai/lindy#456");
		b.assertDispatchable("REL-10508");
	});

	test("(b) the 21st open internal item is rejected", async () => {
		const b = await load();
		for (let n = 1; n <= b.INTERNAL_CAP; n += 1) {
			b.createInternal({ id: `item-${n}`, type: "chore", intent: "x", owner: "o" });
		}
		expect(b.openItems()).toHaveLength(b.INTERNAL_CAP);
		expect(() =>
			b.createInternal({ id: "one-too-many", type: "chore", intent: "x", owner: "o" }),
		).toThrow(/cap of 20/);
		// The refusal must name the two exits, or a crew handles it badly.
		try {
			b.createInternal({ id: "one-too-many", type: "chore", intent: "x", owner: "o" });
		} catch (error) {
			expect(String(error)).toContain("externalize");
			expect(String(error)).toContain("close");
		}
	});

	test("(c) an item past expiry auto-closes as expired-unattended", async () => {
		const b = await load();
		const created = new Date("2026-07-01T00:00:00Z");
		b.createInternal({ id: "stale", type: "investigation", intent: "x", owner: "o" }, created);
		// 72h default: still open just before, closed after.
		expect(b.sweepExpired(new Date("2026-07-03T23:00:00Z"))).toHaveLength(0);
		const closed = b.sweepExpired(new Date("2026-07-04T01:00:00Z"));
		expect(closed).toHaveLength(1);
		expect(closed[0]?.close_reason).toBe("expired-unattended");
		expect(b.openItems()).toHaveLength(0);
	});
});

describe("backlog refusals", () => {
	test("delivery work cannot be created as an internal item", async () => {
		const b = await load();
		expect(() =>
			b.createInternal({ id: "feature-x", type: "feature", intent: "ship it", owner: "o" }),
		).toThrow(/not allowed/);
	});

	test("missing owner or intent is refused, never defaulted", async () => {
		const b = await load();
		expect(() => b.createInternal({ id: "a", type: "chore", intent: "", owner: "o" })).toThrow(
			/intent is required/,
		);
		expect(() => b.createInternal({ id: "a", type: "chore", intent: "x", owner: "" })).toThrow(
			/owner is required/,
		);
	});

	test("an empty or non-external reference is not dispatchable", async () => {
		const b = await load();
		expect(() => b.assertDispatchable("")).toThrow(/requires an external reference/);
		expect(() => b.assertDispatchable("some-made-up-thing")).toThrow(/does not look like/);
	});

	test("externalize closes with a pointer; close needs a reason", async () => {
		const b = await load();
		b.createInternal({ id: "s1", type: "scout", intent: "x", owner: "o" });
		const done = b.externalize("s1", "REL-11000");
		expect(done.state).toBe("closed");
		expect(done.external_ref).toBe("REL-11000");
		expect(b.openItems()).toHaveLength(0);

		b.createInternal({ id: "s2", type: "scout", intent: "x", owner: "o" });
		expect(() => b.closeInternal("s2", "")).toThrow(/one-line reason/);
		expect(b.closeInternal("s2", "carried by REL-11000").state).toBe("closed");
	});

	test("holds are bounded: the third closes the item", async () => {
		const b = await load();
		b.createInternal({ id: "h1", type: "decision", intent: "x", owner: "o" });
		expect(b.holdInternal("h1", "waiting on captain", 24).holds).toBe(1);
		expect(b.holdInternal("h1", "still waiting", 24).holds).toBe(2);
		const third = b.holdInternal("h1", "still waiting", 24);
		expect(third.state).toBe("closed");
		expect(third.close_reason).toContain("after 2 holds");
	});

	test("summary reports growth as a number before it becomes noise", async () => {
		const b = await load();
		b.createInternal({ id: "a", type: "chore", intent: "x", owner: "o" });
		b.createInternal({ id: "z", type: "chore", intent: "x", owner: "o" }, new Date(Date.now() + 1000));
		const summary = b.internalSummary();
		expect(summary.open).toBe(2);
		expect(summary.cap).toBe(20);
		expect(summary.nearestExpiry).not.toBeNull();
	});
});
