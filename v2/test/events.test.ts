import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-events-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

// home.ts resolves DECK_V2_HOME per call, so plain static imports are correct
// here and no module-cache tricks are needed.
async function load() {
	const events = await import("../src/events");
	const meta = await import("../src/meta");
	const home = await import("../src/home");
	return { events, meta, home };
}

describe("status append + cursor", () => {
	test("append then read round-trips", async () => {
		const { events } = await load();
		events.appendStatus("t1", "working", "started");
		events.appendStatus("t1", "done", "finished");
		const read = events.readStatus("t1");
		expect(read.events.map((e: { verb: string }) => e.verb)).toEqual(["working", "done"]);
		expect(read.malformed).toHaveLength(0);
	});

	test("epoch fencing rejects a superseded run's append", async () => {
		const { events, meta } = await load();
		const first = meta.bumpEpoch("t1"); // epoch 1
		events.appendStatus("t1", "working", "run one alive", { epoch: first });

		const second = meta.bumpEpoch("t1"); // epoch 2 supersedes run one
		expect(second).toBe(2);

		// The stale run tries to append after being superseded.
		expect(() => events.appendStatus("t1", "done", "stale claim", { epoch: first })).toThrow(
			/stale epoch/,
		);

		// The current run still writes fine.
		events.appendStatus("t1", "done", "run two finished", { epoch: second });
		const read = events.readStatus("t1");
		expect(read.events.map((e: { note: string }) => e.note)).toEqual([
			"run one alive",
			"run two finished",
		]);
	});

	test("cursor reads only new events", async () => {
		const { events } = await load();
		events.appendStatus("t1", "working", "one");
		const first = events.readStatusSince("t1", null);
		expect(first.events).toHaveLength(1);
		expect(first.rescanned).toBe(false);

		events.appendStatus("t1", "done", "two");
		const second = events.readStatusSince("t1", first.cursor);
		expect(second.events).toHaveLength(1);
		expect(second.events[0]?.note).toBe("two");
		expect(second.rescanned).toBe(false);

		// No new writes: nothing new to report.
		const third = events.readStatusSince("t1", second.cursor);
		expect(third.events).toHaveLength(0);
	});

	// Round-2 finding 3: a bare path+offset cursor skips events when the file is
	// replaced. This is the test that made the rename case pass instead of
	// contradicting the design.
	test("REGRESSION: atomic-replace invalidates the cursor and forces a rescan", async () => {
		const { events, home } = await load();
		const { stateFiles } = home;
		events.appendStatus("t1", "working", "one");
		events.appendStatus("t1", "working", "two");
		const before = events.readStatusSince("t1", null);
		expect(before.events).toHaveLength(2);

		// Replace the file with a DIFFERENT, shorter history (new inode).
		const file = stateFiles("t1").status;
		const replacement = `${file}.new`;
		fs.writeFileSync(replacement, "failed: replaced history\n");
		fs.renameSync(replacement, file);

		const after = events.readStatusSince("t1", before.cursor);
		expect(after.rescanned).toBe(true);
		expect(after.events).toHaveLength(1);
		expect(after.events[0]?.verb).toBe("failed");
	});

	test("REGRESSION: truncation is detected, not read past", async () => {
		const { events, home } = await load();
		const { stateFiles } = home;
		for (const n of ["one", "two", "three"]) events.appendStatus("t1", "working", n);
		const before = events.readStatusSince("t1", null);
		expect(before.events).toHaveLength(3);

		fs.writeFileSync(stateFiles("t1").status, "done: only line\n");
		const after = events.readStatusSince("t1", before.cursor);
		expect(after.rescanned).toBe(true);
		expect(after.events.map((e: { verb: string }) => e.verb)).toEqual(["done"]);
	});

	test("malformed lines are surfaced, never silently dropped", async () => {
		const { events, home } = await load();
		const { stateFiles } = home;
		events.appendStatus("t1", "working", "good");
		fs.appendFileSync(stateFiles("t1").status, "[2026-07-29T01:13 UTC] blocked: bad prefix\n");
		const read = events.readStatus("t1");
		expect(read.events).toHaveLength(1);
		expect(read.malformed).toHaveLength(1);
		expect(read.malformed[0]?.reason).toContain("does not start with a status verb");
	});

	test("open decisions track keys and resolve", async () => {
		const { events } = await load();
		events.appendStatus("t1", "needs-decision", "shape?", { key: "api-shape" });
		events.appendStatus("t1", "needs-decision", "name?", { key: "naming" });
		expect([...events.openDecisions("t1").keys()].sort()).toEqual(["api-shape", "naming"]);

		events.appendStatus("t1", "resolved", "went with B", { key: "api-shape" });
		expect([...events.openDecisions("t1").keys()]).toEqual(["naming"]);
	});

	test("cursor store persists", async () => {
		const { events } = await load();
		events.appendStatus("t1", "working", "one");
		const read = events.readStatusSince("t1", null);
		if (read.cursor === null) throw new Error("expected a cursor");
		events.saveCursors({ t1: read.cursor });
		expect(events.loadCursors().t1?.offset).toBe(read.cursor.offset);
	});
});
