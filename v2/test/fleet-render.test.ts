/**
 * The overlay renderer's contract: severity-ordered chips, a framed panel whose
 * borders actually align, and workflow rows that appear when smithers reports
 * runs. All pure — no herdr, no smithers, no TUI.
 */
import { describe, expect, test } from "bun:test";
import {
	buildFleetText,
	chipFor,
	framed,
	humanAge,
	PLAIN_FLEET_THEME,
	textWidth,
	type FleetFrame,
	type TaskRow,
} from "../src/fleet";

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

function frame(overrides: Partial<FleetFrame> = {}): FleetFrame {
	return {
		generatedAt: new Date().toISOString(),
		tasks: [],
		workflows: [],
		counters: {
			tasks: 0,
			running: 0,
			openDecisions: 0,
			queuedMessages: 0,
			internalOpen: 0,
			internalCap: 12,
		},
		sources: [
			{ name: "smithers", state: "skipped", detail: "" },
			{ name: "herdr", state: "ok", detail: "" },
		],
		...overrides,
	};
}

describe("chipFor severity order", () => {
	test("an open decision outranks a live run", () => {
		expect(chipFor(task({ runState: "running", openDecisions: 1 }))).toEqual({
			label: "decision",
			color: "warning",
		});
	});

	test("blocked outranks running", () => {
		expect(chipFor(task({ runState: "running", lastVerb: "blocked" }))).toEqual({
			label: "blocked",
			color: "error",
		});
	});

	test("running, done, queued, idle", () => {
		expect(chipFor(task({ runState: "running" })).label).toBe("running");
		expect(chipFor(task({ runState: "finished", lastVerb: "done" })).label).toBe("done");
		expect(chipFor(task({ queuedMessages: 2 })).label).toBe("queued");
		expect(chipFor(task()).label).toBe("idle");
	});
});

describe("humanAge", () => {
	test("compact forms", () => {
		expect(humanAge(41_000)).toBe("41s");
		expect(humanAge(12 * 60_000)).toBe("12m");
		expect(humanAge(3 * 3_600_000 + 7 * 60_000)).toBe("3h7m");
		expect(humanAge(-5)).toBe("?");
	});
});

describe("framed", () => {
	test("every border line has the same width", () => {
		const out = framed("fleet", "short\na much longer line here", "footer", PLAIN_FLEET_THEME);
		const lines = out.split("\n");
		const bordered = lines.filter((line) => line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"));
		const widths = new Set(bordered.map(textWidth));
		expect(widths.size).toBe(1);
	});
});

describe("buildFleetText", () => {
	test("shows chips, note, PR and source health", () => {
		const out = buildFleetText(
			frame({
				tasks: [
					task({
						taskId: "fix-login",
						runState: "running",
						lastVerb: "working",
						lastNote: "editing auth.ts",
						pr: "https://github.com/o/r/pull/7",
					}),
				],
				counters: {
					tasks: 1,
					running: 1,
					openDecisions: 0,
					queuedMessages: 0,
					internalOpen: 0,
					internalCap: 12,
				},
			}),
		);
		expect(out).toContain("[running ]");
		expect(out).toContain("fix-login");
		expect(out).toContain("working: editing auth.ts");
		expect(out).toContain("https://github.com/o/r/pull/7");
		expect(out).toContain("herdr=ok");
	});

	test("workflow rows appear when smithers reports runs", () => {
		const out = buildFleetText(
			frame({
				workflows: [
					{ runId: "r42", workflow: "pr-pipeline", status: "running", step: "review", taskId: "fix-login" },
				],
			}),
		);
		expect(out).toContain("wf:r42");
		expect(out).toContain("pr-pipeline · running · @review · fix-login");
	});

	test("long notes are truncated so rows stay width-safe", () => {
		const out = buildFleetText(
			frame({ tasks: [task({ lastVerb: "working", lastNote: "x".repeat(300) })] }),
		);
		const longest = Math.max(...out.split("\n").map(textWidth));
		expect(longest).toBeLessThan(140);
	});
});
