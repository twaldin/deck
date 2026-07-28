import { describe, expect, test } from "bun:test";
import { age, renderModel, truncate } from "../src/render";
import type { FleetModel } from "../src/types";

function baseModel(overrides: Partial<FleetModel> = {}): FleetModel {
	return {
		fmHome: "/home/u/dev/fm2",
		generatedAtMs: 1_000_000,
		tasks: [],
		orphanRuns: [],
		diagnostics: [],
		...overrides,
	};
}

const RUN = {
	id: "oneshot-abc",
	workflow: "oneshot",
	status: "running",
	step: "implement",
	started: "2m ago",
	rootDir: "/tmp/a",
	workspace: "/ws",
	nodes: [
		{ id: "implement", state: "in-progress", attempt: 2, label: "implement" },
		{ id: "review", state: "pending", attempt: 0, label: "review" },
	],
};

describe("renderModel", () => {
	const model = baseModel({
		generatedAtMs: 5_000_000,
		tasks: [
			{
				id: "alpha",
				meta: {
					window: null,
					worktree: "/tmp/a",
					project: null,
					harness: "pi",
					kind: "ship",
					mode: null,
					model: "deck/gpt-5.6-sol",
					effort: "xhigh",
					backend: "herdr",
					raw: {},
				},
				status: { state: "working", message: "collectors done", mtimeMs: 4_940_000 },
				backlog: null,
				runs: [RUN],
			},
		],
		orphanRuns: [{ ...RUN, id: "pipeline-x", workflow: "pr-pipeline", status: "paused", nodes: [] }],
		diagnostics: [
			{ source: "FM_HOME (/home/u/dev/fm2)", ok: true, detail: "1 task" },
			{ source: "smithers:/ws", ok: false, detail: "ps failed" },
		],
	});

	test("renders header, task, run, nodes, workflows + sources sections (plain)", () => {
		const lines = renderModel(model, { width: 200, minWidth: 40, color: false });
		const text = lines.join("\n");
		expect(text).toContain("Fleet ·");
		expect(text).toContain("alpha");
		expect(text).toContain("gpt-5.6-sol/xhigh");
		expect(text).toContain("collectors done");
		expect(text).toContain("oneshot");
		expect(text).toContain("implement — in-progress (attempt 2)");
		expect(text).toContain("Workflows (uncorrelated · 1)");
		expect(text).toContain("Sources");
		expect(text).toContain("MISSING  smithers:/ws");
		// No ANSI codes when color is off.
		expect(text.includes("\x1b[")).toBe(false);
	});

	test("emits ANSI color codes when color is on", () => {
		const lines = renderModel(model, { width: 200, minWidth: 40, color: true });
		expect(lines.some((l) => l.includes("\x1b["))).toBe(true);
	});

	test("truncates every line to the width budget (visible length)", () => {
		const lines = renderModel(model, { width: 30, minWidth: 30, color: false });
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
	});

	test("terminal width remains a hard cap below the compact threshold", () => {
		const lines = renderModel(model, { width: 5, minWidth: 40, color: false });
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(5);
	});

	test("min-width is a compact-layout threshold, not a virtual terminal width", () => {
		const compact = renderModel(model, { width: 30, minWidth: 40, color: false }).join("\n");
		expect(compact).not.toContain("collectors done");
		expect(compact).not.toContain("attempt 2");
		expect(compact).not.toContain("oneshot-abc");
		expect(compact).toContain("oneshot");
	});

	test("uses backlog lifecycle state when no live status exists", () => {
		const lines = renderModel(
			baseModel({
				tasks: [
					{
						id: "queued-task",
						meta: null,
						status: null,
						backlog: {
							id: "queued-task",
							title: "Queued",
							state: "queued",
							repo: null,
							detail: null,
							since: null,
							hold: null,
						},
						runs: [],
					},
					{
						id: "held-task",
						meta: null,
						status: null,
						backlog: {
							id: "held-task",
							title: "Held",
							state: "held",
							repo: null,
							detail: null,
							since: null,
							hold: "captain",
						},
						runs: [],
					},
					{
						id: "done-task",
						meta: null,
						status: null,
						backlog: {
							id: "done-task",
							title: "Done",
							state: "done",
							repo: null,
							detail: null,
							since: null,
							hold: null,
						},
						runs: [],
					},
				],
			}),
			{ width: 100, minWidth: 40, color: false },
		);
		const text = lines.join("\n");
		expect(text).toContain("○ queued-task  queued");
		expect(text).toContain("❚ held-task  held");
		expect(text).toContain("✓ done-task  done");
	});

	test("renders Smithers finished states as successful", () => {
		const lines = renderModel(
			baseModel({
				orphanRuns: [{ ...RUN, status: "finished", nodes: [{ id: "final", state: "finished", attempt: 1, label: "final" }] }],
			}),
			{ width: 100, minWidth: 40, color: false },
		);
		const text = lines.join("\n");
		expect(text).toContain("✓ oneshot");
		expect(text).toContain("✓ final — finished");
	});

	test("finished-only runs do not inflate the active-task summary", () => {
		const lines = renderModel(
			baseModel({
				tasks: [
					{
						id: "done-task",
						meta: null,
						status: null,
						backlog: {
							id: "done-task",
							title: "Done",
							state: "done",
							repo: null,
							detail: null,
							since: null,
							hold: null,
						},
						runs: [{ ...RUN, status: "finished" }],
					},
				],
			}),
			{ width: 100, minWidth: 40, color: false },
		);
		expect(lines[0]).toContain("(0 active)");
	});

	test("empty model reports no-tasks hint", () => {
		const lines = renderModel(baseModel(), { width: 80, minWidth: 40, color: false });
		expect(lines.join("\n")).toContain("no tasks");
	});
});

describe("state color semantics", () => {
	const SGR = { gray: "\x1b[90m", reset: "\x1b[0m" };

	function heldQueuedModel(): FleetModel {
		return baseModel({
			tasks: [
				{
					id: "queued-task",
					meta: null,
					status: null,
					backlog: {
						id: "queued-task",
						title: "waiting for a slot",
						state: "queued",
						repo: null,
						detail: null,
						since: null,
						hold: null,
					},
					runs: [],
				},
				{
					id: "held-task",
					meta: null,
					status: null,
					backlog: {
						id: "held-task",
						title: "waiting on captain",
						state: "held",
						repo: null,
						detail: null,
						since: null,
						hold: "captain",
					},
					runs: [],
				},
			],
		});
	}

	test("queued tasks render with no color (default/white), held tasks render gray", () => {
		const lines = renderModel(heldQueuedModel(), { width: 100, minWidth: 40, color: true });
		const queuedLine = lines.find((l) => l.includes("queued-task"));
		const heldLine = lines.find((l) => l.includes("held-task"));
		expect(queuedLine).toBeDefined();
		expect(heldLine).toBeDefined();
		expect(queuedLine).not.toContain(SGR.gray);
		expect(heldLine).toContain(SGR.gray);
	});

	test("held task's detail and hold-reason continuation lines are also gray", () => {
		const lines = renderModel(heldQueuedModel(), { width: 100, minWidth: 40, color: true });
		const detailLine = lines.find((l) => l.includes("waiting on captain"));
		const holdLine = lines.find((l) => l.includes("hold: captain"));
		expect(detailLine).toBeDefined();
		expect(holdLine).toBeDefined();
		expect(detailLine).toContain(SGR.gray);
		expect(holdLine).toContain(SGR.gray);
	});

	test("queued task's detail continuation line has no color", () => {
		const lines = renderModel(heldQueuedModel(), { width: 100, minWidth: 40, color: true });
		const detailLine = lines.find((l) => l.includes("waiting for a slot"));
		expect(detailLine).toBeDefined();
		expect(detailLine).not.toContain(SGR.gray);
		expect(detailLine?.includes("\x1b[")).toBe(false);
	});

	test("plain (no-color) render is unaffected by the color swap", () => {
		const lines = renderModel(heldQueuedModel(), { width: 100, minWidth: 40, color: false });
		const text = lines.join("\n");
		expect(text).toContain("○ queued-task  queued");
		expect(text).toContain("❚ held-task  held");
		expect(text).toContain("hold: captain");
	});
});

describe("helpers", () => {
	test("age formats compactly", () => {
		expect(age(5_000)).toBe("5s");
		expect(age(120_000)).toBe("2m");
		expect(age(3 * 3_600_000)).toBe("3h");
		expect(age(3 * 86_400_000)).toBe("3d");
	});

	test("truncate adds ellipsis only when needed", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello world", 5)).toBe("hell…");
	});

	test("truncate measures terminal cells and preserves grapheme clusters", () => {
		expect(truncate("界界界", 5)).toBe("界界…");
		expect(truncate("😀😀", 3)).toBe("😀…");
		expect(truncate("e\u0301e\u0301e\u0301", 3)).toBe("e\u0301e\u0301e\u0301");
		expect(truncate("👩‍👩‍👧‍👦 family", 4)).not.toContain("\uFFFD");
	});
});
