/**
 * The projection's pure decisions: which herdr state a task maps to, and how
 * smithers runs fold into one agent. The herdr CLI itself is not exercised —
 * the pass degrades to "skipped" without it, asserted last.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskRow } from "../src/fleet";
import { desiredState, projectionMessage, smithersSummary } from "../src/herdr";

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

describe("smithersSummary", () => {
	test("active runs fold into one working agent", () => {
		const summary = smithersSummary([
			{ runId: "r1", workflow: "pr", status: "running", step: "build", taskId: null },
			{ runId: "r2", workflow: "pr", status: "completed", step: null, taskId: null },
		]);
		expect(summary.state).toBe("working");
		expect(summary.message).toContain("1 active");
		expect(summary.message).toContain("r1@build");
	});

	test("no active runs is idle", () => {
		const summary = smithersSummary([
			{ runId: "r2", workflow: "pr", status: "completed", step: null, taskId: null },
		]);
		expect(summary.state).toBe("idle");
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
				counters: { tasks: 1, running: 1, openDecisions: 0, queuedMessages: 0, internalOpen: 0, internalCap: 12 },
				sources: [],
			});
			expect(health.state).toBe("skipped");
		} finally {
			process.env.PATH = original;
		}
	});
});
