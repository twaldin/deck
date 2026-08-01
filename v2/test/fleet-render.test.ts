/**
 * The overlay renderer's contract: severity-ordered chips, a framed panel whose
 * borders actually align, and workflow rows that appear when smithers reports
 * runs. All pure — no herdr, no smithers, no TUI.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	activityFor,
	actionableWorkflowFailures,
	attentionRank,
	buildFleetText,
	buildFleetView,
	chipFor,
	framed,
	isTerminalWorkflow,
	humanAge,
	waitingForFor,
	normalizeStep,
	collectRuns,
	buildFrame,
	PLAIN_FLEET_THEME,
	renderFooterLines,
	sliceVisible,
	textWidth,
	visibleTasks,
	type FleetFrame,
	type TaskRow,
	type WorkflowRow,
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
			efforts: 0,
			agents: 0,
			unhealedFailures: 0,
		},
		sources: [
			{ name: "smithers", state: "skipped", detail: "" },
			{ name: "herdr", state: "ok", detail: "" },
		],
		...overrides,
	};
}

describe("fleet frame state", () => {
	test("asks once for a parked stamp and keeps resolved questions from reappearing", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-frame-"));
		const queue = path.join(directory, "queue.jsonl");
		const previous = process.env.DECK_QUESTIONS_FILE;
		process.env.DECK_QUESTIONS_FILE = queue;
		const run = {
			id: "run-stamp",
			rootDir: directory,
			prNumber: 42,
			step: "r0-stamp",
			status: "waiting-approval",
			state: "paused",
			started: "2026-01-01T00:00:00.000Z",
		};
		try {
			const first = await buildFrame({ workflowCwd: directory, psRuns: [run] });
			expect(first.efforts?.[0]?.waitingFor).toBe("stamp-question");
			expect(fs.readFileSync(queue, "utf8")).toContain('"questionKind":"stamp"');
			const second = await buildFrame({ workflowCwd: directory, psRuns: [run] });
			expect(second.counters.openQuestions).toBe(1);
			expect(fs.readFileSync(queue, "utf8").trim().split("\\n")).toHaveLength(1);
			const { answer, readQuestions } = await import("../src/questions-store");
			answer(queue, readQuestions(queue)[0]!.id, "Do not stamp", "dismissed");
			const afterAnswer = await buildFrame({ workflowCwd: directory, psRuns: [run] });
			expect(afterAnswer.counters.openQuestions).toBe(0);
			expect(fs.readFileSync(queue, "utf8")).toContain('"status":"dismissed"');
		} finally {
			if (previous === undefined) delete process.env.DECK_QUESTIONS_FILE;
			else process.env.DECK_QUESTIONS_FILE = previous;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test("folds live generations by repo-qualified PR and keeps the newest run", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fold-"));
		try {
			const runs = [
				{ id: "old", rootDir: directory, prNumber: 7, step: "watch-poll", started: "2026-01-01T00:00:00.000Z" },
				{ id: "new", rootDir: directory, prNumber: 7, step: "watch-poll", started: "2026-01-02T00:00:00.000Z" },
				{ id: "other-repo", rootDir: `${directory}-other`, prNumber: 7, step: "watch-poll", started: "2026-01-01T00:00:00.000Z" },
			];
			const result = await buildFrame({ workflowCwd: directory, psRuns: runs });
			expect(result.efforts).toHaveLength(2);
			expect(result.efforts?.map((effort) => effort.runId)).toEqual(expect.arrayContaining(["new", "other-repo"]));
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("run collection", () => {
	test("uses one ps subprocess per tick and deduplicates concurrent collectors", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-collect-"));
		const bin = path.join(directory, "bin");
		const count = path.join(directory, "count");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "bunx"), `#!/bin/sh\nprintf x >> ${JSON.stringify(count)}\nprintf '[]\\n'\n`);
		fs.chmodSync(path.join(bin, "bunx"), 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			await Promise.all([collectRuns(directory), collectRuns(directory)]);
			expect(fs.readFileSync(count, "utf8")).toHaveLength(1);
			await collectRuns(directory);
			expect(fs.readFileSync(count, "utf8")).toHaveLength(2);
		} finally {
			process.env.PATH = previousPath;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("three-surface footer", () => {
	test("renders only questions, efforts, agents, and failures", () => {
		const base = frame();
		const out = renderFooterLines(frame({ counters: { ...base.counters, openQuestions: 2, efforts: 3, agents: 4, unhealedFailures: 1 } }));
		expect(out[2]).toBe("Nq 2 · 3 efforts · 4 agents · fail 1");
	});
});

describe("chipFor severity order", () => {
	test("an open decision outranks a live run", () => {
		expect(
			chipFor(task({ runState: "running", openDecisions: 1 })),
		).toEqual({
			label: "decision",
			color: "warning",
		});
	});

	test("blocked outranks running", () => {
		expect(
			chipFor(task({ runState: "running", lastVerb: "blocked" })),
		).toEqual({
			label: "blocked",
			color: "error",
		});
	});

	test("running, done, queued, idle", () => {
		expect(chipFor(task({ runState: "running" })).label).toBe("running");
		expect(
			chipFor(task({ runState: "finished", lastVerb: "done" })).label,
		).toBe("done");
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
		const out = framed(
			"fleet",
			"short\na much longer line here",
			"footer",
			PLAIN_FLEET_THEME,
		);
		const lines = out.split("\n");
		const bordered = lines.filter(
			(line) =>
				line.startsWith("╭") ||
				line.startsWith("│") ||
				line.startsWith("╰"),
		);
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
					{
						runId: "r42",
						workflow: "pr-pipeline",
						status: "running",
						state: null,
						step: "review",
						taskId: "fix-login",
					},
				],
			}),
		);
		expect(out).toContain("wf:r42");
		expect(out).toContain("pr-pipeline · running · @review · fix-login");
	});

	test("REGRESSION: a pipeline row carries PR identity, phase, wait reason, and idle/fixing", () => {
		const out = buildFleetText(
			frame({
				workflows: [
					{
						runId: "adopt-26865",
						workflow: "lindy-pr-pipeline",
						status: "waiting-approval",
						state: null,
						step: "r0-stamp",
						taskId: null,
						prNumber: 26865,
						prTitle: "Wire split Anthropic secrets",
						phase: "stamp",
						waitingFor: "stamp",
						activity: "idle",
						waitAgeMs: 7 * 60_000,
					},
					{
						runId: "adopt-26861",
						workflow: "lindy-pr-pipeline",
						status: "running",
						state: null,
						step: "r0-watch-fix",
						taskId: null,
						prNumber: 26861,
						prTitle: "Defer raw trigger payload write",
						phase: "watch",
						waitingFor: null,
						activity: "fixing",
					},
				],
			}),
		);
		expect(out).toContain("PR #26865");
		expect(out).toContain('"Wire split An');
		expect(out).toContain("phase=stamp");
		expect(out).toContain("waitingFor=stamp");
		expect(out).toContain("7m");
		expect(out).toContain("[wait]");
		expect(out).toContain("PR #26861");
		expect(out).toContain("[fixing]");
	});

	test("pipeline state maps poll to idle CI wait and fix to active fixing", () => {
		expect(waitingForFor("r0-watch-poll", "running")).toBe("ci-poll");
		expect(activityFor("r0-watch-poll", "running")).toBe("idle");
		expect(waitingForFor("r0-watch-fix", "running")).toBe("fixing");
		expect(activityFor("r0-watch-fix", "running")).toBe("fixing");
		expect(waitingForFor(null, "waiting-approval")).toBe("gate:approval");
		expect(waitingForFor("r0-stamp-validity", "running")).toBe("none");
		expect(activityFor("r0-watch-fix", "failed")).toBe("failed");
	});

	test("REGRESSION: production-shaped no-step and failed rows retain identity and failure", () => {
		const out = buildFleetText(
			frame({
				workflows: [
					{
						runId: "adopt-26865",
						workflow: "lindy-pr-pipeline",
						status: "waiting-approval",
						state: "waiting-approval",
						step: null,
						taskId: null,
						prNumber: 26865,
						prTitle: "Stamp this change",
						phase: "waiting-approval",
						waitingFor: "approval",
						activity: "idle",
					},
					{
						runId: "26819-pipeline",
						workflow: "lindy-pr-pipeline",
						status: "failed",
						state: "failed",
						step: null,
						taskId: null,
						prNumber: 26819,
						prTitle: "Validator off arm",
						phase: null,
						waitingFor: null,
						activity: "failed",
					},
				],
			}),
		);
		expect(out).toContain("PR #26865");
		expect(out).toContain("waitingFor=approval");
		expect(out).toContain("[failed]");
		expect(out).toContain("failed");
	});

	test("long notes are truncated so rows stay width-safe", () => {
		const out = buildFleetText(
			frame({
				tasks: [
					task({ lastVerb: "working", lastNote: "x".repeat(300) }),
				],
			}),
		);
		const longest = Math.max(...out.split("\n").map(textWidth));
		expect(longest).toBeLessThan(140);
	});

	test("maxRowWidth widens the note clamp on wide terminals", () => {
		const note = "z".repeat(150);
		const narrow = buildFleetText(
			frame({ tasks: [task({ lastVerb: "working", lastNote: note })] }),
		);
		const wide = buildFleetText(
			frame({ tasks: [task({ lastVerb: "working", lastNote: note })] }),
			PLAIN_FLEET_THEME,
			{ maxRowWidth: 200 },
		);
		const count = (out: string): number =>
			Math.max(
				...out.split("\n").map((l) => (l.match(/z/g) ?? []).length),
			);
		expect(count(wide)).toBeGreaterThan(count(narrow));
		expect(count(wide)).toBe(150);
	});

	test("blocked tasks surface in the overlay header", () => {
		const f = frame({
			tasks: [task({ lastVerb: "blocked", lastNote: "main is red" })],
		});
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
						state: null,
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
		task({
			taskId: `old-${i}`,
			runState: "finished",
			lastVerb: "done",
			lastNote: "shipped",
		}),
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
		const out = buildFleetText(
			frame({ tasks: [...doneTasks, ...live] }),
			PLAIN_FLEET_THEME,
			{
				showAll: true,
			},
		);
		expect(out).toContain("old-3");
		expect(out).not.toContain("hidden");
	});

	test("attention order: decision, blocked, then running, before idle", () => {
		const { shown } = visibleTasks([...doneTasks, ...live], false);
		expect(shown.map((t) => t.taskId)).toEqual([
			"ask",
			"stuck",
			"live-run",
		]);
	});

	test("a failed task with an open decision is not terminal", () => {
		const t = task({ lastVerb: "failed", openDecisions: 1 });
		expect(attentionRank(t)).toBe(0);
		expect(visibleTasks([t], false).shown).toHaveLength(1);
	});

	test("a failed task stays visible by default even with nothing pending", () => {
		const t = task({ lastVerb: "failed" });
		expect(attentionRank(t)).toBe(1);
		expect(visibleTasks([t], false).shown).toHaveLength(1);
	});

	test("done wins over a stale queue: still terminal, still hidden by default", () => {
		const t = task({
			taskId: "stale-queue",
			runState: "finished",
			lastVerb: "done",
			queuedMessages: 1,
		});
		expect(attentionRank(t)).toBe(7);
		const out = buildFleetText(frame({ tasks: [t, ...live] }));
		expect(out).not.toContain("stale-queue");
		expect(out).toContain("1 done/failed hidden");
	});

	test("done wins over a stale open decision", () => {
		expect(
			attentionRank(task({ lastVerb: "done", openDecisions: 1 })),
		).toBe(7);
	});

	test("a running workflow renders with the active tasks, above the collapse line", () => {
		const out = buildFleetText(
			frame({
				tasks: [...doneTasks, ...live],
				workflows: [
					{
						runId: "r1",
						workflow: "pr-pipeline",
						status: "running",
						state: null,
						step: null,
						taskId: null,
					},
				],
			}),
		);
		expect(out.indexOf("wf:r1")).toBeGreaterThan(out.indexOf("live-run"));
		expect(out.indexOf("wf:r1")).toBeLessThan(out.indexOf("hidden"));
	});

	test("finished workflows hide by default and count into the collapse line", () => {
		const out = buildFleetText(
			frame({
				tasks: [...doneTasks, ...live],
				workflows: [
					{
						runId: "r9",
						workflow: "pr-pipeline",
						status: "Completed",
						state: null,
						step: null,
						taskId: null,
					},
				],
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
					{
						runId: "r1",
						workflow: "pr-pipeline",
						status: "running",
						state: null,
						step: null,
						taskId: null,
					},
					{
						runId: "r9",
						workflow: "pr-pipeline",
						status: "failed",
						state: null,
						step: null,
						taskId: null,
					},
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
		const wf = (status: string | null, state: string | null = null) => ({
			runId: "r",
			workflow: null,
			status,
			state,
			step: null,
			taskId: null,
		});
		for (const s of [
			"completed",
			"Failed",
			"CANCELLED",
			"succeeded",
			"finished",
			"done",
			"Complete",
		]) {
			expect(isTerminalWorkflow(wf(s))).toBe(true);
		}
		for (const s of ["running", "weird", null])
			expect(isTerminalWorkflow(wf(s))).toBe(false);
		// Live smithers ps shape: status "finished" + state "succeeded".
		expect(isTerminalWorkflow(wf("finished", "succeeded"))).toBe(true);
		// A state field alone can carry the terminal verdict.
		expect(isTerminalWorkflow(wf("weird", "succeeded"))).toBe(true);
	});

	test("normalizeStep: em-dash, dash, and empty read as no step", () => {
		for (const s of ["\u2014", "-", "", "  ", null, undefined])
			expect(normalizeStep(s)).toBe(null);
		expect(normalizeStep("review")).toBe("review");
	});

	test("bare chrome: no box-drawing frame, title and footer still present", () => {
		const f = frame({
			tasks: [task({ taskId: "live", runState: "running" })],
		});
		const bare = buildFleetText(f, PLAIN_FLEET_THEME, { chrome: "bare" });
		expect(bare).not.toContain("\u256d");
		expect(bare).not.toContain("\u2570");
		expect(bare).not.toContain("\u2502");
		expect(bare).toContain("deck fleet");
		expect(bare).toContain("[q/Esc]");
		expect(bare).toContain("live");
		const framedOut = buildFleetText(f);
		expect(framedOut).toContain("\u256d");
		expect(framedOut).toContain("\u2570");
	});

	test("maxBodyLines clamps the frame height with the border intact", () => {
		const out = buildFleetText(
			frame({ tasks: [...doneTasks, ...live] }),
			PLAIN_FLEET_THEME,
			{
				showAll: true,
				maxBodyLines: 10,
			},
		);
		const lines = out.split("\n");
		// 10 body lines + top/bottom border + blank + footer
		expect(lines.length).toBe(14);
		expect(out).toContain("more line(s)");
		const bordered = lines.filter(
			(line) =>
				line.startsWith("\u256d") ||
				line.startsWith("\u2502") ||
				line.startsWith("\u2570"),
		);
		expect(new Set(bordered.map(textWidth)).size).toBe(1);
	});

	test("truncated view advertises j/k scroll; untruncated view does not", () => {
		const clamped = buildFleetView(
			frame({ tasks: [...doneTasks, ...live] }),
			PLAIN_FLEET_THEME,
			{
				showAll: true,
				maxBodyLines: 10,
			},
		);
		expect(clamped.scrollable).toBe(true);
		expect(clamped.text).toContain("[j/k] scroll");
		const open = buildFleetView(frame({ tasks: live }), PLAIN_FLEET_THEME, {
			showAll: true,
		});
		expect(open.scrollable).toBe(false);
		expect(open.text).not.toContain("[j/k] scroll");
	});

	test("scrollOffset moves the window, stays on-budget, and comes back clamped", () => {
		const opts = { showAll: true, maxBodyLines: 10 };
		const f = frame({ tasks: [...doneTasks, ...live] });
		const top = buildFleetView(f, PLAIN_FLEET_THEME, {
			...opts,
			scrollOffset: 0,
		});
		const scrolled = buildFleetView(f, PLAIN_FLEET_THEME, {
			...opts,
			scrollOffset: 5,
		});
		expect(scrolled.scrollOffset).toBe(5);
		expect(scrolled.text).toContain("line(s) above");
		expect(scrolled.text).not.toBe(top.text);
		// Frame height never grows past the budget while scrolled.
		expect(scrolled.text.split("\n").length).toBe(14);
		// Over-scroll clamps to the real end of the body.
		const bottom = buildFleetView(f, PLAIN_FLEET_THEME, {
			...opts,
			scrollOffset: 9_999,
		});
		expect(bottom.scrollOffset).toBeLessThan(9_999);
		expect(bottom.text).not.toContain("more line(s)");
		expect(bottom.text.split("\n").length).toBeLessThanOrEqual(14);
	});
});

describe("sliceVisible", () => {
	const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);

	test("fits: everything visible, no markers", () => {
		expect(sliceVisible(lines, 0, 20)).toEqual({
			visible: lines,
			offset: 0,
			above: 0,
			below: 0,
		});
		expect(sliceVisible(lines, 7, 25).offset).toBe(0);
	});

	test("top of a clamped list: below marker only, budget respected", () => {
		const win = sliceVisible(lines, 0, 10);
		expect(win).toEqual({
			visible: lines.slice(0, 9),
			offset: 0,
			above: 0,
			below: 11,
		});
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

	const bodyRows = (win: {
		visible: string[];
		above: number;
		below: number;
	}): number =>
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
		const f = frame({
			tasks: [
				...Array.from({ length: 15 }, (_, i) =>
					task({ taskId: `old-${i}`, lastVerb: "done" }),
				),
				task({ taskId: "live", runState: "running" }),
			],
		});
		for (const maxBodyLines of [1, 2]) {
			const view = buildFleetView(f, PLAIN_FLEET_THEME, {
				showAll: true,
				maxBodyLines,
				scrollOffset: 1,
			});
			// top/bottom border + body + blank + footer
			expect(view.text.split("\n").length).toBeLessThanOrEqual(
				maxBodyLines + 4,
			);
		}
	});
});

describe("three-line footer", () => {
	test("renders exactly three width-safe lines with session and fleet facts", () => {
		const out = renderFooterLines(
			frame({
				counters: { ...frame().counters, running: 2, openQuestions: 1 },
				workflows: [
					{
						runId: "r-stamp",
						workflow: "pr-pipeline",
						status: "waiting-approval",
						state: "waiting-approval",
						step: "r0-stamp",
						taskId: null,
						prNumber: 26866,
						prTitle: "Footer",
						waitingFor: "stamp",
						activity: "idle",
					},
				],
			}),
			{ cwd: "/Users/test/deck", branch: "main", model: "sonnet", contextPercent: 42.5, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 400, cacheWriteTokens: 100, cost: 0.123, usageLine: "claude 5h █████░ 91% · codex 7d █████░ 86%" },
			PLAIN_FLEET_THEME,
			140,
		);
		expect(out).toHaveLength(3);
		expect(out[0]).toContain("main");
		expect(out[0]).toContain("CH25%");
		expect(out[1]).toContain("claude");
		expect(out[1]).toContain("codex");
		expect(out[2]).toContain("Nq 1");
		for (const line of out) expect(textWidth(line)).toBeLessThanOrEqual(140);
	});
});

describe("zombie workflow failures", () => {
	test("does not hide a failed run from unrelated landed chatter", () => {
		const failed = { runId: "failed", workflow: "pr-pipeline", activity: "failed", status: "failed", state: "failed", step: "watch", taskId: null, ticket: "T-failed", prNumber: 1, landed: false } satisfies WorkflowRow;
		expect(actionableWorkflowFailures(frame({ workflows: [failed] }))).toEqual([failed]);
	});

	test("hides landed, superseded, and push-pr-null failures but keeps real failures", () => {
		const real = { runId: "real", workflow: "pr-pipeline", activity: "failed", status: "failed", state: "failed", step: "watch", taskId: null, ticket: "T-real", prNumber: 1 } satisfies WorkflowRow;
		const landed = { ...real, runId: "landed", merged: true };
		const superseded = { ...real, runId: "old", ticket: "T-shared", startedAt: "2026-01-01" };
		const healthy: WorkflowRow = { ...real, runId: "new", ticket: "T-shared", existingPr: null, prNumber: 999, activity: "working", status: "running", startedAt: "2026-01-02" };
		const pushNull = { ...real, runId: "push-null", pushPrNull: true };
		expect(actionableWorkflowFailures(frame({ workflows: [real, landed, superseded, healthy, pushNull] }))).toEqual([real]);
		expect(
			actionableWorkflowFailures(
				frame({
					workflows: [
						{ ...real, runId: "old-relative", ticket: "T-relative", startedAt: "1h ago" },
						{ ...healthy, runId: "new-relative", ticket: "T-relative", startedAt: "2m ago" },
					],
				}),
			),
		).toHaveLength(0);
	});

	test("preflight refusal is hidden when a later healthy adopted run has the same PR", () => {
		const refusal: WorkflowRow = {
			runId: "preflight-refusal",
			workflow: "pr-pipeline",
			activity: "failed",
			status: "failed",
			state: "failed",
			step: "preflight-refusal",
			taskId: null,
			existingPr: 26866,
			startedAt: "2026-01-01",
		};
		const successor: WorkflowRow = {
			runId: "lindy-adopt-26866-v2",
			workflow: "pr-pipeline",
			activity: "working",
			status: "running",
			state: "running",
			step: "r0-watch-poll",
			taskId: null,
			existingPr: null,
			prNumber: 26866,
			startedAt: "2026-01-02",
		};
		expect(actionableWorkflowFailures(frame({ workflows: [refusal, successor] }))).toEqual([]);
	});
});

describe("footer attention counts", () => {
	test("asks are plain words and zero-count segments are omitted", () => {
		const f = frame();
		f.counters.openQuestions = 2;
		expect(renderFooterLines(f)[2]).toContain("Nq 2");
		f.counters.openQuestions = 0;
		expect(renderFooterLines(f)[2]).toContain("Nq 0");
	});

	test("active work is play and actionable failures are fail", () => {
		const f = frame({
			tasks: [task({ runState: "running", lastVerb: "working" })],
			workflows: [{
				runId: "failed", workflow: "pr-pipeline", status: "failed", state: "failed",
				step: "watch", taskId: null, activity: "failed",
			}],
		});
		expect(renderFooterLines(f)[2]).toBe("Nq 0 · 0 efforts · 0 agents");
	});

	test("paused and blocked work is pause, while terminal task events are not counts", () => {
		const f = frame({ tasks: [
			task({ taskId: "paused", runState: "running", lastVerb: "paused" }),
			task({ taskId: "blocked", runState: "running", lastVerb: "blocked" }),
			task({ taskId: "done", runState: "finished", lastVerb: "done" }),
		] });
		expect(renderFooterLines(f)[2]).toBe("Nq 0 · 0 efforts · 0 agents");
	});

	test("failed poll rows stay failed and terminal stamp rows do not ask", () => {
		const failed: WorkflowRow = {
			runId: "failed-poll", workflow: "pr-pipeline", status: "failed", state: "failed",
			step: "r0-watch-poll", taskId: null, activity: "failed", waitingFor: "ci-poll",
		};
		const cancelledStamp: WorkflowRow = {
			runId: "cancelled-stamp", workflow: "pr-pipeline", status: "cancelled", state: "cancelled",
			step: "r0-stamp", taskId: null, activity: "idle", waitingFor: "stamp", prNumber: 9,
		};
		const out = buildFleetText(frame({ workflows: [failed, cancelledStamp] }));
		expect(out).toContain("[failed]");
		expect(renderFooterLines(frame({ workflows: [cancelledStamp] }))[2]).toContain("Nq 0");
	});

	test("zombies do not increase fail", () => {
		const f = frame({ workflows: [{
			runId: "preflight", workflow: "pr-pipeline", status: "failed", state: "failed",
			step: "preflight-refusal", taskId: null, activity: "failed", existingPr: 42, startedAt: "2026-01-01",
		}, {
			runId: "successor", workflow: "pr-pipeline", status: "running", state: "running",
			step: "r0-watch-poll", taskId: null, activity: "working", prNumber: 42, startedAt: "2026-01-02",
		}] });
		expect(renderFooterLines(f)[2]).toBe("Nq 0 · 0 efforts · 0 agents");
	});

	test("theme colors attention counts", () => {
		const marked = { fg: (key: string, text: string) => `<${key}>${text}</${key}>`, bold: (text: string) => text };
		const f = frame({ tasks: [task({ runState: "running", lastVerb: "working" })] });
		expect(renderFooterLines(f, {}, marked)[2]).toBe("<warning>Nq 0 · 0 efforts · 0 agents</warning>");
	});

	test("the overlay header names /questions so the captain knows the next move", () => {
		const f = frame();
		f.counters.openQuestions = 3;
		expect(buildFleetText(f)).toContain("3 question(s) — /questions");
	});
});
