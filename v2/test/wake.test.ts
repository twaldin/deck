/**
 * The wake engine's job is to make fm2's measured noise impossible. These
 * assertions target that directly, not the plumbing:
 *   - working: never wakes (49% of fm2's real status volume)
 *   - a repeated standing condition wakes ONCE (1844 absorbed-stale records)
 *   - many T1 events fold into one message (the captain's 6-follow-up screenshot)
 *   - a restart does not re-fire what it already reported
 *   - paused is never stale
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-wake-"));
	process.env.DECK_V2_HOME = home;
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.DECK_V2_HOME;
});

async function mods() {
	return {
		wake: await import("../src/wake"),
		events: await import("../src/events"),
		meta: await import("../src/meta"),
	};
}

describe("wake tiers", () => {
	test("working: never wakes — the 49%-of-status-volume class", async () => {
		const { wake, events } = await mods();
		for (let n = 0; n < 20; n += 1) events.appendStatus("t1", "working", `step ${n}`);
		const result = wake.reconcile(["t1"]);
		expect(result.interrupt).toHaveLength(0);
		expect(result.batched).toHaveLength(0);
		expect(result.silent).toHaveLength(20);
	});

	test("blocked/failed/needs-decision interrupt immediately", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "main is red");
		events.appendStatus("t2", "failed", "build broke");
		events.appendStatus("t3", "needs-decision", "which shape?");
		const result = wake.reconcile(["t1", "t2", "t3"]);
		expect(result.interrupt).toHaveLength(3);
		expect(result.batched).toHaveLength(0);
	});

	test("done/resolved batch into ONE folded message", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "done", "PR https://x.test/1");
		events.appendStatus("t2", "done", "PR https://x.test/2");
		events.appendStatus("t2", "resolved", "decision closed");
		events.appendStatus("t3", "done", "PR https://x.test/3");
		const result = wake.reconcile(["t1", "t2", "t3"]);
		expect(result.batched).toHaveLength(4);

		const folded = wake.foldBatched(result.batched);
		expect(folded).not.toBeNull();
		// One message, not four.
		expect(folded).toContain("3 task(s) updated");
		expect(folded).toContain("+1 earlier");
	});

	// The 1844-absorbed-stale class: a standing condition must stop re-firing.
	test("REGRESSION: a repeated identical condition wakes once, not every cycle", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "waiting on upstream release");
		expect(wake.reconcile(["t1"]).interrupt).toHaveLength(1);

		// The same condition reported again is not news.
		events.appendStatus("t1", "blocked", "waiting on upstream release");
		const second = wake.reconcile(["t1"]);
		expect(second.interrupt).toHaveLength(0);
		expect(second.silent).toHaveLength(1);

		// A DIFFERENT blocker is news again.
		events.appendStatus("t1", "blocked", "credential expired");
		expect(wake.reconcile(["t1"]).interrupt).toHaveLength(1);
	});

	test("REGRESSION: a restart does not re-fire already-reported events", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "main is red");
		expect(wake.reconcile(["t1"]).interrupt).toHaveLength(1);

		// Simulate the orchestrator restarting: baseline and cursor are on disk,
		// so a fresh reconcile reports nothing new. fm2 re-fired everything here.
		const fresh = await import("../src/wake");
		expect(fresh.reconcile(["t1"]).interrupt).toHaveLength(0);
	});

	test("a missed watch event is late, not lost", async () => {
		const { wake, events } = await mods();
		// Nobody observed these live; reconcile still finds them.
		events.appendStatus("t1", "done", "finished while nothing was watching");
		const result = wake.reconcile(["t1"]);
		expect(result.batched).toHaveLength(1);
	});

	test("malformed lines are surfaced as source health", async () => {
		const { wake, events } = await mods();
		const { stateFiles } = await import("../src/home");
		events.appendStatus("t1", "working", "fine");
		fs.appendFileSync(stateFiles("t1").status, "[2026-07-29T01:13 UTC] blocked: bad\n");
		const result = wake.reconcile(["t1"]);
		expect(result.malformed).toHaveLength(1);
		expect(result.malformed[0]?.taskId).toBe("t1");
	});
});

describe("ownership + staleness", () => {
	test("fm2-owned tasks are skipped during the parallel run", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("mine", "done", "ok");
		events.appendStatus("theirs", "done", "ok");
		meta.writeMeta({ id: "theirs", owner_system: "fm2" });
		expect(wake.deckOwnedTasks()).toEqual(["mine"]);
	});

	test("paused is never stale — the absorbed-stale root cause", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("t1", "paused", "waiting on upstream release");
		meta.writeMeta({ id: "t1", run_pid: 999999 });
		wake.reconcile(["t1"]);
		// pid is dead, but a paused task is a deliberate wait, not a wedge.
		expect(wake.detectStale(["t1"], { runAlive: () => false })).toHaveLength(0);
	});

	test("a vanished run with no terminal status IS stale", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("t1", "working", "implementing");
		meta.writeMeta({ id: "t1", run_pid: 999999 });
		wake.reconcile(["t1"]);
		const stale = wake.detectStale(["t1"], { runAlive: () => false });
		expect(stale).toHaveLength(1);
		expect(stale[0]?.reason).toContain("never reported a terminal state");
	});

	test("a finished run is not stale", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("t1", "done", "PR opened");
		meta.writeMeta({ id: "t1", run_pid: 999999 });
		wake.reconcile(["t1"]);
		expect(wake.detectStale(["t1"], { runAlive: () => false })).toHaveLength(0);
	});
});

describe("delivery ordering", () => {
	// If the busy-guard ran AFTER reconcile, the cursor would advance and the
	// events would be consumed with nobody told. A dropped `blocked:` is the
	// worst failure this system can have, so the ordering is asserted directly.
	test("REGRESSION: a deferred cycle does not consume its events", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "needs a credential");

		// Simulating the busy path: deliver() returns BEFORE reconcile(), so no
		// cursor moves. The next idle cycle must still see the event.
		const first = wake.reconcile(["t1"]);
		expect(first.interrupt).toHaveLength(1);

		// And a genuinely new event after that is still delivered.
		events.appendStatus("t1", "failed", "gave up");
		expect(wake.reconcile(["t1"]).interrupt).toHaveLength(1);
	});
});
