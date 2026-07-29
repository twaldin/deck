import { describe, expect, test } from "bun:test";
import { age, renderModel, truncate, wrap } from "../src/render";
import type { FleetModel, FleetTask } from "../src/types";

function baseModel(overrides: Partial<FleetModel> = {}): FleetModel {
	return { fmHome: "/home/u/dev/fm2", generatedAtMs: 5_000_000, tasks: [], orphanRuns: [], diagnostics: [], ...overrides };
}

function task(id: string, state: "working" | "queued" | "done" | "held", title: string, message?: string): FleetTask {
	const status = state === "working" && message ? { state, message, mtimeMs: 4_940_000 } : null;
	const backlogState = state === "working" ? "in_flight" : state;
	return {
		id,
		meta: { window: null, worktree: null, project: null, harness: "pi", kind: "ship", mode: null, model: "deck/gpt-5.6-sol", effort: "xhigh", backend: "herdr", raw: {} },
		status,
		backlog: { id, title, state: backlogState, repo: null, detail: null, since: null, hold: state === "held" ? "captain approval" : null },
		runs: [],
	};
}

describe("renderModel dense fleet layout", () => {
	test("renders a realistic 3 active, 7 queued, 8 done snapshot densely", () => {
		const active = [
			task("active-pr", "working", "open PR", "Root cause: collector passes a stale terminal width through the painter; PRs #120, #121 and #122 await captain review."),
			task("active-fix", "working", "fix capture", "Investigating a long root-cause summary that must remain readable instead of ending in an ellipsis."),
			task("active-test", "working", "validate", "Tests are running against the captured twenty-task fixture."),
		];
		const queued = Array.from({ length: 7 }, (_, i) => task(`queued-${i + 1}`, "queued", `Queued work item ${i + 1}`));
		const done = Array.from({ length: 8 }, (_, i) => task(`done-${i + 1}`, "done", `Completed work item ${i + 1}`));
		const lines = renderModel(baseModel({ tasks: [...active, ...queued, ...done] }), { width: 72, minWidth: 40, color: false });
		const text = lines.join("\n");
		expect(text).toContain("● active-pr  gpt-5.6-sol/xhigh · 1m");
		expect(text).toContain("PRs #120, #121 and #122 await captain review.");
		expect(text).not.toContain("…");
		expect(lines.filter((line) => line.includes("queued-")).length).toBe(7);
		expect(text).toContain("✓ 8 done — most recent: Completed work item 1");
		expect(text).not.toContain("done-2");
		expect(lines.every((line) => Bun.stringWidth(line) <= 72)).toBe(true);
	});

	test("keeps queued and held work to one line, with inline dim-semantic hold reason", () => {
		const lines = renderModel(baseModel({ tasks: [task("queued", "queued", "ready to run"), task("held", "held", "wait for captain")] }), { width: 100, minWidth: 40, color: true });
		const queued = lines.find((line) => line.includes("queued"))!;
		const held = lines.find((line) => line.includes("held"))!;
		expect(queued).toContain("○ queued");
		expect(queued.includes("\x1b[")).toBe(false);
		expect(held).toContain("❚ held");
		expect(held).toContain("hold: captain approval");
		expect(held).toContain("\x1b[90m");
	});

	test("collapses diagnostics by default and reveals raw detail only with verbose", () => {
		const model = baseModel({ diagnostics: [
			{ source: "FM_HOME (/home/u/dev/fm2)", ok: true, detail: "18 tasks" },
			{ source: "backlog:tasks-axi", ok: true, detail: "18 entries" },
			{ source: "smithers:/ws", ok: false, detail: "ps failed" },
			{ source: "broker", ok: false, level: "skipped", detail: "no auth" },
		] });
		const compact = renderModel(model, { width: 120, minWidth: 40, color: false }).join("\n");
		expect(compact).toContain("sources: fm ok · backlog ok · smithers failed · broker skipped");
		expect(compact).not.toContain("ps failed");
		const verbose = renderModel(model, { width: 120, minWidth: 40, color: false, verbose: true }).join("\n");
		expect(verbose).toContain("MISSING smithers:/ws — ps failed");
		const warning = renderModel(baseModel({ diagnostics: [{ source: "smithers:/ws", ok: true, level: "warning", detail: "partial results" }] }), { width: 120, minWidth: 40, color: false }).join("\n");
		expect(warning).toContain("smithers warn");
		const correlationWarning = renderModel(baseModel({ diagnostics: [{ source: "correlation", ok: true, level: "warning", detail: "ambiguous root" }] }), { width: 120, minWidth: 40, color: false }).join("\n");
		expect(correlationWarning).toContain("other warn");
	});

	test("wraps active payload at the physical terminal width without truncating it", () => {
		const model = baseModel({ tasks: [task("active", "working", "work", "one two three four five six seven eight nine ten")] });
		const lines = renderModel(model, { width: 20, minWidth: 40, color: false });
		expect(lines).toContain("  one two three four");
		expect(lines).toContain("  five six seven");
		expect(lines).toContain("  eight nine ten");
		expect(lines.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
	});

	test("retains compact Smithers state for active and orphan workflows", () => {
		const run = { id: "r1", workflow: "pr-pipeline", status: "running", step: "review", started: null, rootDir: null, workspace: "/ws", nodes: [] };
		const runOnly = { ...task("run-only", "queued", "run owner"), runs: [run] };
		const text = renderModel(baseModel({ tasks: [runOnly], orphanRuns: [{ ...run, id: "r2", workflow: "oneshot" }] }), { width: 100, minWidth: 40, color: false }).join("\n");
		expect(text).toContain("◐ pr-pipeline @review · running");
		expect(text).toContain("◐ oneshot @review · running");
	});

	test("annotates a status that disagrees with the live pane", () => {
		const stale = { ...task("stale", "working", "work", "still working"), paneState: "idle" as const };
		const text = renderModel(baseModel({ tasks: [stale] }), { width: 100, minWidth: 40, color: false }).join("\n");
		expect(text).toContain("status stale (pane: idle)");
	});

	test("never overflows a narrow pane on a double-width status grapheme", () => {
		const lines = renderModel(baseModel({ tasks: [task("active", "working", "work", "界")] }), { width: 3, minWidth: 40, color: false });
		expect(lines.every((line) => Bun.stringWidth(line) <= 3)).toBe(true);
	});
});

describe("helpers", () => {
	test("age formats compactly", () => {
		expect(age(5_000)).toBe("5s");
		expect(age(120_000)).toBe("2m");
		expect(age(3 * 3_600_000)).toBe("3h");
		expect(age(3 * 86_400_000)).toBe("3d");
	});
	test("truncate and wrap preserve grapheme boundaries", () => {
		expect(truncate("hello world", 5)).toBe("hell…");
		expect(truncate("界界界", 5)).toBe("界界…");
		expect(wrap("界界界", 4)).toEqual(["界界", "界"]);
		expect(truncate("👩‍👩‍👧‍👦 family", 4)).not.toContain("\uFFFD");
	});
});
