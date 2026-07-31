/**
 * The overlay renderer's contract: severity-ordered chips, a framed panel whose
 * borders actually align, and workflow rows that appear when smithers reports
 * runs. All pure — no herdr, no smithers, no TUI.
 */
import { describe, expect, test } from "bun:test";
import {
	attentionRank,
	buildFleetText,
	buildFleetView,
	chipFor,
	framed,
	humanAge,
	PLAIN_FLEET_THEME,
	renderStatusline,
	sliceVisible,
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

	test("truncated view advertises j/k scroll; untruncated view does not", () => {
		const clamped = buildFleetView(frame({ tasks: [...doneTasks, ...live] }), PLAIN_FLEET_THEME, {
			showAll: true,
			maxBodyLines: 10,
		});
		expect(clamped.scrollable).toBe(true);
		expect(clamped.text).toContain("[j/k] scroll");
		const open = buildFleetView(frame({ tasks: live }), PLAIN_FLEET_THEME, { showAll: true });
		expect(open.scrollable).toBe(false);
		expect(open.text).not.toContain("[j/k] scroll");
	});

	test("scrollOffset moves the window, stays on-budget, and comes back clamped", () => {
		const opts = { showAll: true, maxBodyLines: 10 };
		const f = frame({ tasks: [...doneTasks, ...live] });
		const top = buildFleetView(f, PLAIN_FLEET_THEME, { ...opts, scrollOffset: 0 });
		const scrolled = buildFleetView(f, PLAIN_FLEET_THEME, { ...opts, scrollOffset: 5 });
		expect(scrolled.scrollOffset).toBe(5);
		expect(scrolled.text).toContain("line(s) above");
		expect(scrolled.text).not.toBe(top.text);
		// Frame height never grows past the budget while scrolled.
		expect(scrolled.text.split("\n").length).toBe(14);
		// Over-scroll clamps to the real end of the body.
		const bottom = buildFleetView(f, PLAIN_FLEET_THEME, { ...opts, scrollOffset: 9_999 });
		expect(bottom.scrollOffset).toBeLessThan(9_999);
		expect(bottom.text).not.toContain("more line(s)");
		expect(bottom.text.split("\n").length).toBeLessThanOrEqual(14);
	});
});

describe("sliceVisible", () => {
	const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);

	test("fits: everything visible, no markers", () => {
		expect(sliceVisible(lines, 0, 20)).toEqual({ visible: lines, offset: 0, above: 0, below: 0 });
		expect(sliceVisible(lines, 7, 25).offset).toBe(0);
	});

	test("top of a clamped list: below marker only, budget respected", () => {
		const win = sliceVisible(lines, 0, 10);
		expect(win).toEqual({ visible: lines.slice(0, 9), offset: 0, above: 0, below: 11 });
	});

	test("middle: both markers, still on budget", () => {
		const win = sliceVisible(lines, 5, 10);
		expect(win.above).toBe(5);
		expect(win.visible).toEqual(lines.slice(5, 13));
		expect(win.below).toBe(7);
		expect(win.visible.length + 2).toBe(10);
	});

	test("bottom: offset clamps so the last line lands on screen", () => {
		const win = sliceVisible(lines, 9_999, 10);
		expect(win.offset).toBe(11);
		expect(win.below).toBe(0);
		expect(win.visible[win.visible.length - 1]).toBe("L19");
		expect(win.visible.length + 1).toBeLessThanOrEqual(10);
	});

	test("negative offset clamps to 0", () => {
		expect(sliceVisible(lines, -3, 10).offset).toBe(0);
	});

	test("max=1 still shows one line", () => {
		const win = sliceVisible(lines, 0, 1);
		expect(win.visible).toEqual(["L0"]);
		expect(win.below).toBe(19);
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
