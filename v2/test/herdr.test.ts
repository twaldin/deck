/**
 * The projection's pure decisions: which herdr state a task maps to. The herdr
 * CLI itself is not exercised — the pass degrades to "skipped" without it,
 * asserted last. Smithers runs are fleet-only and never get a pane.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskRow } from "../src/monitor";
import {
	desiredState,
	mayClosePane,
	projectionMessage,
	shellQuote,
	shouldReleasePane,
} from "../src/herdr";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
	return {
		taskId: "t1",
		kind: "ship",
		project: null,
		runState: "none",
		lastVerb: null,
		lastNote: null,
		openDecisions: 0,
		queuedMessages: 0,
		unresolvedSideEffects: 0,
		pr: null,
		worktree: null,
		runId: null,
		stage: null,
		pane: null,
		statusAgeMs: null,
		...overrides,
	};
}

describe("desiredState", () => {
	test("running maps to working", () => {
		expect(desiredState(task({ runState: "running" }))).toBe("working");
	});

	test("blocked, failed and needs-decision map to blocked even while running", () => {
		expect(desiredState(task({ runState: "running", lastVerb: "blocked" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", lastVerb: "failed" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", lastVerb: "needs-decision" }))).toBe("blocked");
		expect(desiredState(task({ runState: "running", openDecisions: 1 }))).toBe("blocked");
	});

	test("finished or never-started maps to idle", () => {
		expect(desiredState(task({ runState: "finished", lastVerb: "done" }))).toBe("idle");
		expect(desiredState(task())).toBe("idle");
	});
});

describe("shouldReleasePane", () => {
	test("terminal verbs release even with the worktree still on disk", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "done", worktreeExists: true }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: "failed", worktreeExists: true }),
		).toBe(true);
	});

	test("parked (paused/blocked, no live run) releases", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "paused", worktreeExists: true }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: "blocked", worktreeExists: true }),
		).toBe(true);
	});

	test("running keeps the pane unless the verb is terminal", () => {
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "working", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "blocked", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "running", lastVerb: "done", worktreeExists: true }),
		).toBe(true);
	});

	test("gone worktree releases any non-running task", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: false }),
		).toBe(true);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: false }),
		).toBe(true);
	});

	test("between events (not running, non-terminal verb, worktree present) parks idle", () => {
		expect(
			shouldReleasePane({ runState: "finished", lastVerb: "working", worktreeExists: true }),
		).toBe(false);
		expect(
			shouldReleasePane({ runState: "none", lastVerb: null, worktreeExists: true }),
		).toBe(false);
	});
});

describe("projectionMessage", () => {
	test("carries the last verb + note, truncated", () => {
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "step 3" }))).toBe(
			"working: step 3",
		);
		expect(projectionMessage(task())).toBe("no status yet");
		expect(projectionMessage(task({ lastVerb: "working", lastNote: "x".repeat(300) })).length).toBe(
			120,
		);
	});
});

describe("mayClosePane: identity-exact, never less", () => {
	test("closes only on exact pane id + agent label match", () => {
		expect(mayClosePane({ pane_id: "w1:p2", agent: "t1" }, "w1:p2", "t1")).toBe(true);
	});

	test("REGRESSION: a missing agent field is not authorization to close", () => {
		// A herdr schema change or a reused pane id yields pane info without our
		// label; closing on that would close somebody else's pane.
		expect(mayClosePane({ pane_id: "w1:p2" }, "w1:p2", "t1")).toBe(false);
	});

	test("mismatched agent, mismatched pane, or no pane never close", () => {
		expect(mayClosePane({ pane_id: "w1:p2", agent: "other" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane({ pane_id: "w1:p9", agent: "t1" }, "w1:p2", "t1")).toBe(false);
		expect(mayClosePane(null, "w1:p2", "t1")).toBe(false);
	});
});

describe("shellQuote", () => {
	test("spaces and metacharacters stay data", () => {
		expect(shellQuote("/a b/c.status")).toBe("'/a b/c.status'");
		expect(shellQuote("/x;rm -rf /")).toBe("'/x;rm -rf /'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe("projectFleet degrades without herdr", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-herdr-"));
		process.env.DECK_V2_HOME = home;
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		delete process.env.DECK_V2_HOME;
	});

	test("missing herdr binary yields skipped health, never a throw", async () => {
		const original = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const { projectFleet } = await import("../src/herdr");
			const health = await projectFleet({
				generatedAt: new Date().toISOString(),
				tasks: [task({ runState: "running" })],
				workflows: [],
				counters: { tasks: 1, running: 1, blocked: 0, openDecisions: 0, queuedMessages: 0, openQuestions: 0, internalOpen: 0, internalCap: 12 },
				sources: [],
			});
			expect(health.state).toBe("skipped");
		} finally {
			process.env.PATH = original;
		}
	});
});
