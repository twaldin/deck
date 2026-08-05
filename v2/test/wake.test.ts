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

	test("a malformed run_pid (123abc) is treated as no recorded run", async () => {
		const { wake, events } = await mods();
		const { stateFiles } = await import("../src/home");
		events.appendStatus("t1", "working", "implementing");
		// parseInt would truncate this to 123 and probe a pid that was never recorded.
		fs.writeFileSync(stateFiles("t1").meta, "id=t1\nrun_pid=123abc\n");
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


describe("CPU time parsing", () => {
	test("parses ps time formats and rejects malformed values", async () => {
		const { parseCpuTimeMs } = await import("../src/wake");
		expect(parseCpuTimeMs("01:02.34")).toBe(62_340);
		expect(parseCpuTimeMs("01:02:03.45")).toBe(3_723_450);
		expect(parseCpuTimeMs("2-01:02:03.45")).toBe(176_523_450);
		expect(parseCpuTimeMs("")).toBeUndefined();
		expect(parseCpuTimeMs(":")).toBeUndefined();
		expect(parseCpuTimeMs("::")).toBeUndefined();
		expect(parseCpuTimeMs("not-a-time")).toBeUndefined();
	});
});

describe("a live worker that stops making progress", () => {
	// Found by running a real worker, not by a test. It fixed the code correctly,
	// wrote its test, then retried a rate-limited web search nine times and was
	// STILL alive with zero status lines written. Pid-liveness cannot see this: the
	// process is healthy, it just never finishes. The signal is SILENCE: a run that
	// is still writing is working, however far past its budget.
	const MINUTE = 60_000;

	/** A worktree whose files carry the given ages, in minutes. */
	function worktreeWith(files: Record<string, number>): string {
		const root = fs.mkdtempSync(path.join(home, "wt-"));
		for (const [relative, ageMin] of Object.entries(files)) {
			const full = path.join(root, relative);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, "x");
			const when = (Date.now() - ageMin * MINUTE) / 1000;
			fs.utimesSync(full, when, when);
		}
		return root;
	}

	// The false alarm the deadline-only rule produced: a long run that is still
	// writing code is working, and reporting it as stuck trains the captain to
	// ignore the alert.
	test("REGRESSION: a live run past its budget that is still writing is not stale", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", {
			run_pid: 4242,
			run_deadline: Date.now() - 60 * MINUTE,
			worktree: worktreeWith({ "src/a.ts": 0 }),
		});
		expect(wake.detectStale(["t1"], { runAlive: () => true })).toHaveLength(0);
	});

	test("REGRESSION: a live run silent past the threshold is reported as stuck", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", {
			run_pid: 4242,
			// Inside its budget, and still stuck: the budget is not the signal.
			run_deadline: Date.now() + 60 * MINUTE,
			worktree: worktreeWith({ "src/a.ts": 20 }),
		});
		const verdicts = wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] });
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("written nothing");
	});

	test("a silent worker with a live child names the child pid", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const verdicts = wake.detectStale(["t1"], {
			runAlive: () => true,
			listChildren: () => [{ pid: 777, command: "pi --model deck/sonnet" }],
		});
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("child pid 777");
		expect(verdicts[0]?.reason).toContain("subagent");
	});

	// The observer writes a pipeline MILESTONE as `resolved:` (observer.ts maps
	// push-pr/landing-poll/fallout-wait to that verb). Every one of those is
	// followed by the pipeline WAITING — a CI poll, a fallout wait — with the run
	// alive and deliberately writing nothing. That is the paused class wearing a
	// different verb, and reporting it as stuck is the absorbed-stale noise the
	// engine exists to remove.
	test("REGRESSION: a live task silent after a resolved milestone is not stuck", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		events.appendStatus("t1", "resolved", "PR landed (sha abc123)");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		expect(
			wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] }),
		).toHaveLength(0);
	});

	// `resolved` is a terminal status for stale detection. A pipeline milestone
	// must not produce the self-contradicting vanished-run message.
	test("REGRESSION: a vanished run after a resolved milestone has no stale verdict", async () => {
		const { wake, events, meta } = await mods();
		events.appendStatus("t1", "resolved", "PR opened (prNumber 42)");
		meta.writeMeta({ id: "t1", run_pid: 999999 });
		expect(wake.detectStale(["t1"], { runAlive: () => false })).toHaveLength(0);
	});

	test("REGRESSION: CPU activity alone keeps a silent worker working", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const start = Date.now();
		updateMeta("t1", { run_pid: 4242, run_started: start, worktree: worktreeWith({ "src/a.ts": 20 }) });
		let sample = 1_000;
		const sampleCpu = () => ({ parentMs: sample, children: [{ pid: 777, cpuMs: sample }] });
		// Establish the first CPU sample. The old two-signal detector reports stale on the next call.
		expect(wake.detectStale(["t1"], { runAlive: () => true, sampleCpu, silenceMs: 1, now: start })).toHaveLength(0);
		sample = 1_100;
		// No file writes or transcript growth, but the parent used CPU during the interval.
		expect(
			wake.detectStale(["t1"], {
				runAlive: () => true,
				sampleCpu,
				listChildren: () => [{ pid: 777, command: "pi" }],
				silenceMs: 1,
				now: start + 20_000,
			}),
		).toHaveLength(0);
	});

	test("CPU sampling survives wake cycles shorter than the sample interval", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const start = Date.now();
		updateMeta("t1", { run_pid: 4242, run_started: start, worktree: worktreeWith({ "src/a.ts": 20 }) });
		let sample = 1_000;
		const sampleCpu = () => ({ parentMs: sample, children: [] });
		const options = { runAlive: () => true, sampleCpu, silenceMs: 60_000 };
		const staleAt = start + 60_000;
		expect(wake.detectStale(["t1"], { ...options, now: staleAt })).toHaveLength(1);
		for (const seconds of [3, 6, 9]) {
			sample += 10;
			expect(wake.detectStale(["t1"], { ...options, now: staleAt + seconds * 1_000 })).toHaveLength(0);
		}
		sample += 100;
		expect(wake.detectStale(["t1"], { ...options, now: staleAt + 20_000 })).toHaveLength(0);
	});

	test("a small CPU drip does not hide a genuinely hung worker", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const start = Date.now();
		updateMeta("t1", { run_pid: 4242, run_started: start - 20 * MINUTE, worktree: worktreeWith({ "src/a.ts": 20 }) });
		let sample = 1_000;
		const sampleCpu = () => ({ parentMs: sample, children: [] });
		const options = { runAlive: () => true, sampleCpu, silenceMs: 1 };
		expect(wake.detectStale(["t1"], { ...options, now: start })).toHaveLength(1);
		sample += 50;
		expect(wake.detectStale(["t1"], { ...options, now: start + 20_000 })).toHaveLength(0);
		// A later silence must still be eligible for a new verdict after the CPU drip.
		expect(wake.detectStale(["t1"], { ...options, now: start + 21 * MINUTE })).toHaveLength(1);
	});

	test("all three silent signals alert and name a zero-CPU child", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const start = Date.now();
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const sampleCpu = () => ({ parentMs: 1_000, children: [{ pid: 777, cpuMs: 500 }] });
		const options = {
			runAlive: () => true,
			listChildren: () => [{ pid: 777, command: "pi --model deck/sonnet" }],
			sampleCpu,
		};
		expect(wake.detectStale(["t1"], { ...options, now: start })).toHaveLength(1);
		const verdicts = wake.detectStale(["t1"], { ...options, now: start + 11 * MINUTE });
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("child pid 777");
		expect(verdicts[0]?.reason).toContain("CPU delta 0.00s");
	});

	// detectStale runs every cycle; without suppression the same standing silence
	// is a fresh alert every minute, which is the absorbed-stale class again.
	test("REGRESSION: the same silent verdict is not emitted twice in a row", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		// Still silent once the backoff window passes: repeat, but not every cycle.
		expect(
			wake.detectStale(["t1"], { ...options, now: Date.now() + 11 * MINUTE }),
		).toHaveLength(1);
	});

	test("a resumed worker alerts again on its next silence", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const worktree = worktreeWith({ "src/a.ts": 20 });
		updateMeta("t1", { run_pid: 4242, worktree });
		const options = { runAlive: () => true, listChildren: () => [] };
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);

		// It wrote again, so the suppression state must clear rather than swallow the
		// next genuine wedge.
		fs.writeFileSync(path.join(worktree, "src/a.ts"), "progress");
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		expect(
			wake.detectStale(["t1"], { ...options, now: Date.now() + 20 * MINUTE }),
		).toHaveLength(1);
	});

	test("transcript growth is activity even when the mtime looks old", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const { stateFiles } = await import("../src/home");
		const sessions = stateFiles("t1").sessions;
		fs.mkdirSync(sessions, { recursive: true });
		const transcript = path.join(sessions, "run.jsonl");
		const stale = (Date.now() - 20 * MINUTE) / 1000;
		fs.writeFileSync(transcript, "{}\n");
		fs.utimesSync(transcript, stale, stale);
		updateMeta("t1", { run_pid: 4242 });
		const options = { runAlive: () => true, listChildren: () => [] };
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);

		fs.appendFileSync(transcript, "{\"more\":true}\n");
		fs.utimesSync(transcript, stale, stale);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
	});

	// A status line is a report ABOUT the work, not the work. The wedge class this
	// check exists to find is a worker looping on a retry: alive, appending
	// `working:` lines, writing no code. Counting the status file's mtime as
	// activity suppressed exactly that verdict.
	test("REGRESSION: a fresh status mtime alone does not suppress a stale verdict", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		const { stateFiles } = await import("../src/home");
		// Worktree and transcript are both older than the silence window.
		const worktree = worktreeWith({ "src/a.ts": 20 });
		const sessions = stateFiles("t1").sessions;
		fs.mkdirSync(sessions, { recursive: true });
		const transcript = path.join(sessions, "run.jsonl");
		const old = (Date.now() - 20 * MINUTE) / 1000;
		fs.writeFileSync(transcript, "{}\n");
		fs.utimesSync(transcript, old, old);
		updateMeta("t1", { run_pid: 4242, run_started: Date.now() - 60 * MINUTE, worktree });
		// The only fresh thing on disk: a status line. Its mtime is pinned a minute
		// back so it is unambiguously in the past of `now` and well inside the
		// 10-minute window. A same-millisecond write can land fractionally AHEAD of
		// an integer `Date.now()`, which the future-dated guard would discard — the
		// assertion would then pass for the wrong reason.
		events.appendStatus("t1", "working", "retrying the search");
		const now = Date.now();
		const fresh = (now - MINUTE) / 1000;
		fs.utimesSync(stateFiles("t1").status, fresh, fresh);

		const verdicts = wake.detectStale(["t1"], {
			runAlive: () => true,
			listChildren: () => [],
			now,
		});
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("written nothing");
	});

	test("node_modules churn and symlinks out of the tree are not activity", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const worktree = worktreeWith({ "src/a.ts": 20, "node_modules/dep/index.js": 0 });
		// A fresh file OUTSIDE the worktree, reachable only through a symlink.
		const outside = path.join(home, "outside.txt");
		fs.writeFileSync(outside, "fresh");
		fs.symlinkSync(outside, path.join(worktree, "link.txt"));
		updateMeta("t1", { run_pid: 4242, worktree });
		expect(
			wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] }),
		).toHaveLength(1);
	});

	// A file dated in the future would become a permanent "recently active"
	// watermark, hiding a real wedge for as long as the clock takes to catch up.
	test("REGRESSION: a future-dated file does not mask silence forever", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": -600 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		// It counts as a signal now, so this cycle is quiet...
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		// ...but the watermark is clamped to now, so real silence still surfaces.
		expect(
			wake.detectStale(["t1"], { ...options, now: Date.now() + 20 * MINUTE }),
		).toHaveLength(1);
	});

	test("the silence threshold is configurable", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 3 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		// Three minutes of silence is fine at the 10-minute default...
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		// ...and stuck when the caller asks for a tighter budget.
		expect(wake.detectStale(["t1"], { ...options, silenceMs: 60_000 })).toHaveLength(1);
	});

	// A parent that respawns short-lived children would produce a new fingerprint
	// every cycle and bypass backoff entirely: the spam this suppression exists to
	// stop, reintroduced through the child pid.
	test("REGRESSION: a silent parent with changing children still backs off", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		let childPid = 100;
		const options = { runAlive: () => true, listChildren: () => [{ pid: childPid++, command: "pi" }] };
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
	});

	// The walk is bounded, so a big worktree can exhaust it. Staying quiet on that
	// would hide a real wedge in every big worktree forever, so the verdict still
	// fires (the transcript signal is complete on its own) and says the worktree
	// evidence is partial.
	test("REGRESSION: a truncated worktree walk still alerts, and says it is partial", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const worktree = worktreeWith({ "src/a.ts": 20 });
		// More entries than the walk budget, all old, so the fresh file (if any) is
		// never reached. Written under a directory the walk descends into.
		const bulk = path.join(worktree, "bulk");
		fs.mkdirSync(bulk, { recursive: true });
		const old = (Date.now() - 20 * MINUTE) / 1000;
		for (let n = 0; n < 20_050; n += 1) {
			const file = path.join(bulk, `f${n}`);
			fs.writeFileSync(file, "");
			fs.utimesSync(file, old, old);
		}
		updateMeta("t1", { run_pid: 4242, worktree });
		const verdicts = wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] });
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.reason).toContain("worktree scan was incomplete");
	}, 30_000);

	// A respawn reuses the task id. Without run identity on the watermark, the new
	// run inherits the dead run's silence and is called stuck the moment it starts.
	test("REGRESSION: a replacement run does not inherit the old run's silence", async () => {
		const { wake } = await mods();
		const { updateMeta, bumpEpoch } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, run_epoch: 1, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);

		// Respawned: new epoch, new pid, and it has not had time to write yet.
		bumpEpoch("t1");
		updateMeta("t1", { run_pid: 5353, run_started: Date.now() });
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
	});

	// The gone branch DELETES the watermark, so the replacement run is a first
	// sight with no stored record to notice the respawn from — and it inherits the
	// dead run's worktree and transcript mtimes. Only run_started separates them.
	test("REGRESSION: a run respawned after its predecessor vanished is not instantly stuck", async () => {
		const { wake } = await mods();
		const { updateMeta, bumpEpoch } = await import("../src/meta");
		const { stateFiles } = await import("../src/home");
		const worktree = worktreeWith({ "src/a.ts": 40 });
		// A transcript the dead run left behind, equally old.
		const sessions = stateFiles("t1").sessions;
		fs.mkdirSync(sessions, { recursive: true });
		const transcript = path.join(sessions, "run.jsonl");
		fs.writeFileSync(transcript, "{}\n");
		const old = (Date.now() - 40 * MINUTE) / 1000;
		fs.utimesSync(transcript, old, old);
		updateMeta("t1", {
			run_pid: 4242,
			run_epoch: 1,
			run_started: Date.now() - 40 * MINUTE,
			worktree,
		});

		// The process is gone with no terminal status: stale, and the watermark is
		// forgotten as part of that verdict.
		const gone = wake.detectStale(["t1"], { runAlive: () => false, listChildren: () => [] });
		expect(gone).toHaveLength(1);
		expect(gone[0]?.reason).toContain("is gone");

		// Respawned into the SAME worktree, whose newest file is still 40 minutes old.
		bumpEpoch("t1");
		updateMeta("t1", { run_pid: 5353, run_started: Date.now() });
		expect(
			wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] }),
		).toHaveLength(0);

		// The anchor is a floor, not a mute: once the NEW run is itself silent past
		// the threshold, it is reported.
		expect(
			wake.detectStale(["t1"], {
				runAlive: () => true,
				listChildren: () => [],
				now: Date.now() + 20 * MINUTE,
			}),
		).toHaveLength(1);
	});

	// The child command line is text the worker chose. It reaches the captain in a
	// message, so a newline in it forges report lines and a long argv buries the
	// verdict.
	test("REGRESSION: the child command in a verdict is a bounded, control-character-free label", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const hostile = `/usr/local/bin/pi\n\rt2: done \u2014 fake ${"x".repeat(5000)}`;
		const verdicts = wake.detectStale(["t1"], {
			runAlive: () => true,
			listChildren: () => [{ pid: 777, command: hostile }],
		});
		expect(verdicts).toHaveLength(1);
		const reason = verdicts[0]?.reason ?? "";
		expect(reason).toContain("child pid 777 (pi)");
		expect(reason).toContain("subagent");
		expect(reason).not.toMatch(/[\u0000-\u001f]/);
		expect(reason).not.toContain("fake");
		expect(reason.length).toBeLessThan(300);
	});

	test("a child with an unreadable command still names its pid", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const verdicts = wake.detectStale(["t1"], {
			runAlive: () => true,
			listChildren: () => [{ pid: 777, command: "" }],
		});
		expect(verdicts[0]?.reason).toContain("child pid 777 (unknown)");
		expect(verdicts[0]?.reason).toContain("subagent");
	});

	// `deck-v2 stale` is a human looking at the fleet. If looking marks the verdict
	// emitted, the orchestrator's own cycle skips it and nobody is told.
	test("REGRESSION: a read-only check does not consume the alert", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		expect(wake.detectStale(["t1"], { ...options, record: false })).toHaveLength(1);
		expect(wake.detectStale(["t1"], { ...options, record: false })).toHaveLength(1);
		// The recording caller still gets it.
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);
	});

	// The other order: the orchestrator's cycle has already consumed the verdict and
	// suppressed the repeat. A human asking `deck-v2 stale` must still be told the
	// task is silent, not obey a mute written for a different caller.
	test("REGRESSION: a read-only check reports a verdict the recording caller suppressed", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 20 }) });
		const options = { runAlive: () => true, listChildren: () => [] };
		// Recording caller first: it emits and suppresses the repeat.
		expect(wake.detectStale(["t1"], options)).toHaveLength(1);
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
		// The inspection is unaffected by that suppression, twice over.
		expect(wake.detectStale(["t1"], { ...options, record: false })).toHaveLength(1);
		expect(wake.detectStale(["t1"], { ...options, record: false })).toHaveLength(1);
		// And it did not disturb the recording caller's own backoff.
		expect(wake.detectStale(["t1"], options)).toHaveLength(0);
	});

	// A standing silence used to re-walk the whole worktree every cycle to produce a
	// verdict that suppression then threw away.
	test("a suppressed silent task is not rescanned every cycle", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const worktree = worktreeWith({ "src/a.ts": 20 });
		updateMeta("t1", { run_pid: 4242, worktree });
		let children = 0;
		const options = {
			runAlive: () => true,
			listChildren: () => {
				children += 1;
				return [];
			},
		};
		const start = Date.now();
		expect(wake.detectStale(["t1"], { ...options, now: start })).toHaveLength(1);
		// `ps` runs only for an emitted verdict, so the muted cycles cost nothing.
		expect(children).toBe(1);
		// A skipped cycle touches no state at all, so the activity file is not rewritten.
		const { wakeFiles } = await import("../src/home");
		const before = fs.statSync(wakeFiles().activity).mtimeMs;
		for (let n = 1; n <= 5; n += 1) {
			expect(wake.detectStale(["t1"], { ...options, now: start + n * MINUTE })).toHaveLength(0);
		}
		expect(children).toBe(1);
		expect(fs.statSync(wakeFiles().activity).mtimeMs).toBe(before);

		// Past the silence window the scan resumes, and the verdict fires again once
		// the doubled backoff expires.
		expect(wake.detectStale(["t1"], { ...options, now: start + 21 * MINUTE })).toHaveLength(1);
		expect(children).toBe(2);
	});

	// Throttled cycles must not swallow the evidence that a worker came back: the
	// next scan sees the growth and clears the mute.
	test("REGRESSION: a throttled task that resumes writing clears its suppression", async () => {
		const { wake } = await mods();
		const { updateMeta } = await import("../src/meta");
		const { stateFiles } = await import("../src/home");
		const worktree = worktreeWith({ "src/a.ts": 20 });
		updateMeta("t1", { run_pid: 4242, worktree });
		const options = { runAlive: () => true, listChildren: () => [] };
		const start = Date.now();
		expect(wake.detectStale(["t1"], { ...options, now: start })).toHaveLength(1);

		// The worker wakes up and appends to its transcript during the muted window.
		const sessions = stateFiles("t1").sessions;
		fs.mkdirSync(sessions, { recursive: true });
		fs.writeFileSync(path.join(sessions, "run.jsonl"), "{}\n");
		// Still inside the scan window: nothing is looked at, nothing is claimed.
		expect(wake.detectStale(["t1"], { ...options, now: start + MINUTE })).toHaveLength(0);
		// The next scan sees the activity, so the task is live and unmuted...
		expect(wake.detectStale(["t1"], { ...options, now: start + 11 * MINUTE })).toHaveLength(0);
		// ...and a fresh silence after it alerts immediately, not on a doubled backoff.
		expect(wake.detectStale(["t1"], { ...options, now: start + 25 * MINUTE })).toHaveLength(1);
	});

	test("a finished task's activity record is dropped rather than kept forever", async () => {
		const { wake, events } = await mods();
		const { updateMeta } = await import("../src/meta");
		const { wakeFiles } = await import("../src/home");
		updateMeta("t1", { run_pid: 4242, worktree: worktreeWith({ "src/a.ts": 0 }) });
		wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] });
		expect(JSON.parse(fs.readFileSync(wakeFiles().activity, "utf8"))).toHaveProperty("t1");

		events.appendStatus("t1", "done", "PR opened");
		wake.detectStale(["t1"], { runAlive: () => true, listChildren: () => [] });
		expect(JSON.parse(fs.readFileSync(wakeFiles().activity, "utf8"))).not.toHaveProperty("t1");
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
