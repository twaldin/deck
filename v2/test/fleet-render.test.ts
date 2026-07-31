/**
 * The overlay renderer's contract: severity-ordered chips, a framed panel whose
 * borders actually align, and workflow rows that appear when smithers reports
 * runs. All pure — no herdr, no smithers, no TUI.
 */
import { describe, expect, test } from "bun:test";
import {
	attentionRank,
	buildFleetText,
	chipFor,
	framed,
	humanAge,
	PLAIN_FLEET_THEME,
	renderStatusline,
	textWidth,
	visibleTasks,
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
			openQuestions: 0,
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
					openQuestions: 0,
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

	test("REGRESSION: every dynamic field is clamped, not just the note", () => {
		const out = buildFleetText(
			frame({
				tasks: [
					task({
						taskId: "a".repeat(80),
						project: "p".repeat(80),
						stage: "s".repeat(80),
						pane: "w".repeat(80),
						pr: `https://github.com/org/repo/pull/${"9".repeat(80)}`,
						lastVerb: "working",
						lastNote: "n".repeat(300),
					}),
				],
				workflows: [
					{
						runId: "r".repeat(80),
						workflow: "w".repeat(80),
						status: "running",
						step: "x".repeat(80),
						taskId: null,
					},
				],
			}),
		);
		const longest = Math.max(...out.split("\n").map(textWidth));
		expect(longest).toBeLessThan(140);
	});
});

describe("attention-first default view", () => {
	const doneTasks = Array.from({ length: 15 }, (_, i) =>
		task({ taskId: `old-${i}`, runState: "finished", lastVerb: "done", lastNote: "shipped" }),
	);
	const live = [
		task({ taskId: "live-run", runState: "running", lastVerb: "working" }),
		task({ taskId: "stuck", lastVerb: "blocked" }),
		task({ taskId: "ask", openDecisions: 1 }),
	];

	test("terminal done/failed rows hide by default and collapse to one line", () => {
		const out = buildFleetText(frame({ tasks: [...doneTasks, ...live] }));
		expect(out).not.toContain("old-3");
		expect(out).toContain("15 done/failed hidden");
		expect(out).toContain("live-run");
	});

	test("show-all includes the terminal rows", () => {
		const out = buildFleetText(frame({ tasks: [...doneTasks, ...live] }), PLAIN_FLEET_THEME, {
			showAll: true,
		});
		expect(out).toContain("old-3");
		expect(out).not.toContain("hidden");
	});

	test("attention order: decision, blocked, then running, before idle", () => {
		const { shown } = visibleTasks([...doneTasks, ...live], false);
		expect(shown.map((t) => t.taskId)).toEqual(["ask", "stuck", "live-run"]);
	});

	test("a failed task with an open decision is not terminal", () => {
		const t = task({ lastVerb: "failed", openDecisions: 1 });
		expect(attentionRank(t)).toBe(0);
		expect(visibleTasks([t], false).shown).toHaveLength(1);
	});

	test("maxBodyLines clamps the frame height with the border intact", () => {
		const out = buildFleetText(frame({ tasks: [...doneTasks, ...live] }), PLAIN_FLEET_THEME, {
			showAll: true,
			maxBodyLines: 10,
		});
		const lines = out.split("\n");
		// 10 body lines + top/bottom border + blank + footer
		expect(lines.length).toBe(14);
		expect(out).toContain("more line(s)");
		const bordered = lines.filter(
			(line) => line.startsWith("\u256d") || line.startsWith("\u2502") || line.startsWith("\u2570"),
		);
		expect(new Set(bordered.map(textWidth)).size).toBe(1);
	});
});

describe("statusline question badge", () => {
	test("open questions show as Nq next to the task count", () => {
		const f = frame();
		f.counters.tasks = 10;
		f.counters.openQuestions = 2;
		expect(renderStatusline(f)).toBe("0\u25b6 \u00b7 10 task \u00b7 2q");
	});

	test("no badge when the queue is clear", () => {
		const f = frame();
		f.counters.tasks = 10;
		expect(renderStatusline(f)).toBe("0\u25b6 \u00b7 10 task");
	});

	test("the overlay header names /questions so the captain knows the next move", () => {
		const f = frame();
		f.counters.openQuestions = 3;
		expect(buildFleetText(f)).toContain("3 question(s) \u2014 /questions");
	});
});
