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
	isTerminalWorkflow,
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
			blocked: 0,
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
					blocked: 0,
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

	test("maxRowWidth widens the note clamp on wide terminals", () => {
		const note = "z".repeat(150);
		const narrow = buildFleetText(frame({ tasks: [task({ lastVerb: "working", lastNote: note })] }));
		const wide = buildFleetText(
			frame({ tasks: [task({ lastVerb: "working", lastNote: note })] }),
			PLAIN_FLEET_THEME,
			{ maxRowWidth: 200 },
		);
		const count = (out: string): number => Math.max(...out.split("\n").map((l) => (l.match(/z/g) ?? []).length));
		expect(count(wide)).toBeGreaterThan(count(narrow));
		expect(count(wide)).toBe(150);
	});

	test("blocked tasks surface in the overlay header", () => {
		const f = frame({ tasks: [task({ lastVerb: "blocked", lastNote: "main is red" })] });
		f.counters.tasks = 1;
		f.counters.blocked = 1;
		expect(buildFleetText(f)).toContain("1 blocked");
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

	test("a running workflow renders with the active tasks, above the collapse line", () => {
		const out = buildFleetText(
			frame({
				tasks: [...doneTasks, ...live],
				workflows: [{ runId: "r1", workflow: "pr-pipeline", status: "running", step: null, taskId: null }],
			}),
		);
		expect(out.indexOf("wf:r1")).toBeGreaterThan(out.indexOf("live-run"));
		expect(out.indexOf("wf:r1")).toBeLessThan(out.indexOf("hidden"));
	});

	test("finished workflows hide by default and count into the collapse line", () => {
		const out = buildFleetText(
			frame({
				tasks: [...doneTasks, ...live],
				workflows: [{ runId: "r9", workflow: "pr-pipeline", status: "Completed", step: null, taskId: null }],
			}),
		);
		expect(out).not.toContain("wf:r9");
		expect(out).toContain("16 done/failed hidden");
	});

	test("show-all puts terminal rows below every active row, finished workflows last", () => {
		const out = buildFleetText(
			frame({
				tasks: [...doneTasks, ...live],
				workflows: [
					{ runId: "r1", workflow: "pr-pipeline", status: "running", step: null, taskId: null },
					{ runId: "r9", workflow: "pr-pipeline", status: "failed", step: null, taskId: null },
				],
			}),
			PLAIN_FLEET_THEME,
			{ showAll: true },
		);
		expect(out.indexOf("wf:r1")).toBeLessThan(out.indexOf("old-0"));
		expect(out.indexOf("old-14")).toBeLessThan(out.indexOf("wf:r9"));
		expect(out).toContain("finished workflows");
	});

	test("isTerminalWorkflow: terminal statuses case-insensitive, unknown/null stay active", () => {
		const wf = (status: string | null) => ({ runId: "r", workflow: null, status, step: null, taskId: null });
		for (const s of ["completed", "Failed", "CANCELLED", "succeeded"]) expect(isTerminalWorkflow(wf(s))).toBe(true);
		for (const s of ["running", "weird", null]) expect(isTerminalWorkflow(wf(s))).toBe(false);
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

	const bodyRows = (win: { visible: string[]; above: number; below: number }): number =>
		win.visible.length + (win.above > 0 ? 1 : 0) + (win.below > 0 ? 1 : 0);

	test("max=1 still shows one line and drops the markers to stay on budget", () => {
		const top = sliceVisible(lines, 0, 1);
		expect(top.visible).toEqual(["L0"]);
		expect(bodyRows(top)).toBe(1);
		const mid = sliceVisible(lines, 5, 1);
		expect(mid.visible).toEqual(["L5"]);
		expect(bodyRows(mid)).toBe(1);
	});

	test("max=2 mid-list keeps one content line inside the budget", () => {
		const win = sliceVisible(lines, 5, 2);
		expect(win.visible.length).toBeGreaterThanOrEqual(1);
		expect(bodyRows(win)).toBeLessThanOrEqual(2);
	});

	test("body rows never exceed max at any offset for small budgets", () => {
		for (const max of [1, 2, 3]) {
			for (let off = 0; off < 25; off++) {
				const win = sliceVisible(lines, off, max);
				expect(bodyRows(win)).toBeLessThanOrEqual(max);
				expect(win.visible.length).toBeGreaterThanOrEqual(1);
			}
		}
	});

	test("buildFleetView honors tiny maxBodyLines budgets when scrolled", () => {
		const f = frame({ tasks: [...Array.from({ length: 15 }, (_, i) => task({ taskId: `old-${i}`, lastVerb: "done" })), task({ taskId: "live", runState: "running" })] });
		for (const maxBodyLines of [1, 2]) {
			const view = buildFleetView(f, PLAIN_FLEET_THEME, { showAll: true, maxBodyLines, scrollOffset: 1 });
			// top/bottom border + body + blank + footer
			expect(view.text.split("\n").length).toBeLessThanOrEqual(maxBodyLines + 4);
		}
	});
});

describe("statusline", () => {
	test("open questions show as Nq; zero-count segments are dropped", () => {
		const f = frame();
		f.counters.tasks = 10;
		f.counters.openQuestions = 2;
		expect(renderStatusline(f)).toBe("2q \u00b7 10 task");
	});

	test("a quiet fleet reads idle, never 0\u25b6", () => {
		const f = frame();
		f.counters.tasks = 10;
		expect(renderStatusline(f)).toBe("idle \u00b7 10 task");
	});

	test("live fleet: running, blocked, questions, decisions, queued all show", () => {
		const f = frame();
		f.counters.tasks = 6;
		f.counters.running = 2;
		f.counters.blocked = 1;
		f.counters.openQuestions = 1;
		f.counters.openDecisions = 1;
		f.counters.queuedMessages = 3;
		expect(renderStatusline(f)).toBe("2\u25b6 \u00b7 1 blocked \u00b7 1q \u00b7 1? \u00b7 3\u2709 \u00b7 6 task");
	});

	test("the overlay header names /questions so the captain knows the next move", () => {
		const f = frame();
		f.counters.openQuestions = 3;
		expect(buildFleetText(f)).toContain("3 question(s) \u2014 /questions");
	});
});
