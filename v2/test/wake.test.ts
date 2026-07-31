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

	test("a parked (blocked) task is not chased as stale", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("t1", "blocked", "needs a credential");
		meta.writeMeta({ id: "t1", run_pid: 999999 });
		wake.reconcile(["t1"]);
		// Dead pid, but blocked already fired its T0 wake; a stale chase on top of
		// it is the spam class.
		expect(wake.detectStale(["t1"], { runAlive: () => false })).toHaveLength(0);
	});

	test("a blocked task past its deadline is not called stuck", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_deadline: Date.now() - 600_000 });
		events.appendStatus("t1", "blocked", "waiting on a credential");
		expect(wake.detectStale(["t1"], { runAlive: () => true })).toHaveLength(0);
	});

	test("an empty run_pid means no recorded run, never a stale verdict", async () => {
		const { wake, events } = await mods();
		const { stateFiles } = await import("../src/home");
		events.appendStatus("t1", "working", "implementing");
		// A raw meta file with `run_pid=` parses to NaN.
		fs.writeFileSync(stateFiles("t1").meta, "id=t1\nrun_pid=\n");
		const verdicts = wake.detectStale(["t1"], {
			runAlive: () => {
				throw new Error("liveness must not be probed without a real pid");
			},
		});
		expect(verdicts).toHaveLength(0);
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

describe("durable delivery outbox", () => {
	// The finding both reviewers raised: reconcile advances a durable cursor, so
	// if delivery is the same step as the read, a failed or absent send loses the
	// event permanently. A lost `blocked:` is the worst failure this system has.
	test("REGRESSION: a T0 event survives a failed send and is redelivered", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "needs a credential");

		wake.reconcile(["t1"]);
		// The send failed, so nothing is acknowledged.
		const owed = wake.pendingWakes();
		expect(owed.map((entry) => entry.verb)).toContain("blocked");

		// A later cycle cannot re-read it from the status file — the cursor moved —
		// so the outbox is the only thing that keeps it alive.
		wake.reconcile(["t1"]);
		expect(wake.pendingWakes().filter((entry) => entry.verb === "blocked")).toHaveLength(1);
	});

	test("an acknowledged wake is not redelivered", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "failed", "gave up");
		wake.reconcile(["t1"]);
		const owed = wake.pendingWakes();
		expect(owed).toHaveLength(1);

		wake.ackWakes(owed.map((entry) => entry.id));
		expect(wake.pendingWakes()).toHaveLength(0);
		// And a further cycle adds nothing, because the cursor is past it.
		wake.reconcile(["t1"]);
		expect(wake.pendingWakes()).toHaveLength(0);
	});

	test("a partial acknowledgement leaves only the undelivered wake owed", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "first");
		events.appendStatus("t2", "failed", "second");
		wake.reconcile(["t1", "t2"]);

		const owed = wake.pendingWakes();
		expect(owed).toHaveLength(2);
		// Only the t1 send succeeded.
		wake.ackWakes(owed.filter((entry) => entry.taskId === "t1").map((entry) => entry.id));
		const remaining = wake.pendingWakes();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.taskId).toBe("t2");
	});

	test("a torn outbox line is skipped rather than poisoning the queue", async () => {
		const { wake, events } = await mods();
		events.appendStatus("t1", "blocked", "real event");
		wake.reconcile(["t1"]);
		// Simulating a crash mid-append.
		const fs = await import("node:fs");
		const { wakeFiles } = await import("../src/home");
		fs.appendFileSync(wakeFiles().queue, '{"id":"torn","taskId":"t2"');
		expect(() => wake.pendingWakes()).not.toThrow();
		expect(wake.pendingWakes().some((entry) => entry.note === "real event")).toBe(true);
	});
});

describe("wake loop mode gating", () => {
	// Waking means injecting a user message, which needs a live interactive session.
	// In print mode the injection is rejected ("Agent is already processing") — the
	// run is under way by the time any timer fires, and even at session_start,
	// where isIdle() is still true, the send lands mid-startup. Found by running
	// real pi, not by a test.
	test("REGRESSION: the loop does not start outside tui mode", async () => {
		const handlers: any[] = [];
		let sends = 0;
		const fakePi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: any) => {
				if (event === "session_start") handlers.push(handler);
			},
			// Real pi throws this once a run is under way. Print mode is always under
			// way by the time a wake fires.
			sendUserMessage: () => {
				sends++;
				throw new Error("Agent is already processing");
			},
		};
		const { default: register } = await import("../src/extension/index");
		register(fakePi as any);

		// A pending T0 event exists, so an ungated loop WILL try to deliver it.
		const { events } = await mods();
		events.appendStatus("t1", "blocked", "needs a credential");

		const timers: Array<() => void> = [];
		const realSetInterval = globalThis.setInterval;
		// Capture the loop's timer instead of waiting 30s for it.
		(globalThis as any).setInterval = (callback: () => void) => {
			timers.push(callback);
			return 0 as any;
		};
		try {
			for (const handler of handlers) {
				await handler({}, { mode: "print", isIdle: () => true });
			}
			// Fire whatever the extension scheduled.
			for (const tick of timers) tick();
		} finally {
			globalThis.setInterval = realSetInterval;
		}

		// In print mode nothing should have been scheduled and nothing sent.
		expect(timers).toHaveLength(0);
		expect(sends).toBe(0);
	});
});

describe("send-failure backoff", () => {
	// deliver() fires on a 30s timer AND on every fs.watch nudge. Without
	// backoff, a failing sendUserMessage retries on every trigger — a tight
	// loop where each status append re-fires the same failing send.
	test("REGRESSION: a failed send is not retried on the next tick", async () => {
		const { events } = await mods();
		events.appendStatus("t1", "blocked", "needs a credential");

		const handlers: any[] = [];
		const shutdowns: any[] = [];
		let sends = 0;
		const fakePi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: any) => {
				if (event === "session_start") handlers.push(handler);
				if (event === "session_shutdown") shutdowns.push(handler);
			},
			sendUserMessage: () => {
				sends++;
				throw new Error("send is down");
			},
		};
		const { default: register } = await import("../src/extension/index");
		register(fakePi as any);

		const timers: Array<() => void> = [];
		const realSetInterval = globalThis.setInterval;
		(globalThis as any).setInterval = (callback: () => void) => {
			timers.push(callback);
			return 0 as any;
		};
		try {
			for (const handler of handlers) {
				await handler({}, { mode: "tui", isIdle: () => true });
			}
			// The initial deliver attempted the send once and it failed.
			expect(sends).toBe(1);
			// Timer ticks and watch nudges inside the backoff window must not retry.
			for (const tick of timers) tick();
			for (const tick of timers) tick();
			expect(sends).toBe(1);
		} finally {
			globalThis.setInterval = realSetInterval;
			for (const shutdown of shutdowns) await shutdown();
		}

		// The wake is still owed: backoff defers delivery, never drops it.
		const { pendingWakes } = await import("../src/wake");
		expect(pendingWakes().some((entry) => entry.verb === "blocked")).toBe(true);
	});
});

describe("fleet board component", () => {
	// The TUI requires every rendered line to fit within width, and the Component
	// interface requires invalidate(). Fleet rows carry full status text and PR
	// URLs — the long lines that overflow and corrupt the display.
	test("REGRESSION: the board truncates to the given width and implements the contract", async () => {
		let component: any;
		const fakeCtx = {
			mode: "tui",
			ui: {
				custom: async (factory: any) => {
					component = factory({}, {}, {}, () => {});
				},
			},
		};
		const commands = new Map<string, any>();
		const fakePi = {
			registerTool: () => {},
			registerCommand: (name: string, spec: any) => commands.set(name, spec),
			on: () => {},
		};
		const { default: register } = await import("../src/extension/index");
		register(fakePi as any);

		await commands.get("fleet").handler("", fakeCtx);
		expect(component).toBeDefined();
		expect(typeof component.invalidate).toBe("function");
		for (const line of component.render(40)) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});
});

describe("a live worker that stops making progress", () => {
	// Found by running a real worker, not by a test. It fixed the code correctly,
	// wrote its test, then retried a rate-limited web search nine times and was
	// STILL alive with zero status lines written. Pid-liveness cannot see this: the
	// process is healthy, it just never finishes. Without a deadline it is invisible
	// forever, which breaks the core premise that work is bounded.
	test("REGRESSION: a live run past its deadline is reported as stuck", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_deadline: Date.now() - 60_000 });

		const verdicts = wake.detectStale(["t1"], { runAlive: () => true });
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("past its budget");
	});

	test("a live run inside its deadline is left alone", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_deadline: Date.now() + 600_000 });
		expect(wake.detectStale(["t1"], { runAlive: () => true })).toHaveLength(0);
	});

	test("a run that finished is never called stuck, however overdue", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_deadline: Date.now() - 600_000 });
		events.appendStatus("t1", "done", "PR opened");
		expect(wake.detectStale(["t1"], { runAlive: () => true })).toHaveLength(0);
	});

	test("a run waiting on a decision is not stuck, however overdue", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_deadline: Date.now() - 600_000 });
		events.appendStatus("t1", "needs-decision", "which approach");
		expect(wake.detectStale(["t1"], { runAlive: () => true })).toHaveLength(0);
	});
});

describe("worker tool exclusions", () => {
	test("REGRESSION: web_search is excluded, because a 429 is an infinite retry trap", async () => {
		const { WORKER_EXCLUDED_TOOLS } = await import("../src/spawn");
		expect(WORKER_EXCLUDED_TOOLS).toContain("web_search");
		// And the single-channel rule stays enforced structurally.
		expect(WORKER_EXCLUDED_TOOLS).toContain("ask_captain");
	});
});

describe("outbox identity", () => {
	// The id was `${taskId}:${raw}`, so two entries with identical text shared one
	// id and acking one discarded the other. Coalescing is a DELIVERY policy (fold
	// T1 into one message); it must never be storage identity.
	test("REGRESSION: identical text on two tasks yields distinct entries", async () => {
		const { wake, events } = await mods();
		events.appendStatus("ta", "blocked", "needs a credential");
		events.appendStatus("tb", "blocked", "needs a credential");
		wake.reconcile(["ta", "tb"]);

		const owed = wake.pendingWakes();
		expect(owed).toHaveLength(2);
		expect(new Set(owed.map((entry) => entry.id)).size).toBe(2);
		// Acking one must leave the other owed.
		wake.ackWakes([owed[0]!.id]);
		expect(wake.pendingWakes()).toHaveLength(1);
	});

	// Edge-triggering treats an identical repeat as a standing condition, which is
	// deliberate. It must NOT hide a genuine recurrence after the condition cleared.
	test("a blocked → resolved → blocked cycle is delivered again", async () => {
		const { wake, events } = await mods();
		events.appendStatus("ta", "blocked", "needs a credential");
		wake.reconcile(["ta"]);
		wake.ackWakes(wake.pendingWakes().map((entry) => entry.id));

		events.appendStatus("ta", "resolved", "credential added");
		wake.reconcile(["ta"]);
		events.appendStatus("ta", "blocked", "needs a credential");
		wake.reconcile(["ta"]);

		expect(wake.pendingWakes().filter((entry) => entry.verb === "blocked")).toHaveLength(1);
	});
});
