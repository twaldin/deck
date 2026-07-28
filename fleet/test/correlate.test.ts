import { describe, expect, test } from "bun:test";
import { correlateRuns, normalizePath } from "../src/correlate";
import type { FleetTask, SmithersRun } from "../src/types";

function task(id: string, worktree: string | null): FleetTask {
	return {
		id,
		meta: worktree ? { ...emptyMeta(), worktree } : null,
		status: null,
		backlog: null,
		runs: [],
	};
}

function emptyMeta() {
	return {
		window: null,
		worktree: null,
		project: null,
		harness: null,
		kind: null,
		mode: null,
		model: null,
		effort: null,
		backend: null,
		raw: {},
	};
}

function run(id: string, rootDir: string | null): SmithersRun {
	return { id, workflow: "wf", status: "running", step: null, started: null, rootDir, workspace: "/ws", nodes: [] };
}

describe("correlateRuns", () => {
	test("attaches a run to a task by exact rootDir==worktree", () => {
		const tasks = [task("alpha", "/tmp/a"), task("beta", "/tmp/b")];
		const runs = [run("r1", "/tmp/a")];
		const { tasks: out, orphanRuns } = correlateRuns(tasks, runs);
		expect(out[0]!.runs.map((r) => r.id)).toEqual(["r1"]);
		expect(out[1]!.runs).toEqual([]);
		expect(orphanRuns).toEqual([]);
	});

	test("normalizes trailing slash before matching", () => {
		const { tasks: out } = correlateRuns([task("alpha", "/tmp/a/")], [run("r1", "/tmp/a")]);
		expect(out[0]!.runs).toHaveLength(1);
	});

	test("non-matching and rootDir-less runs become orphans (not falsely correlated)", () => {
		const tasks = [task("alpha", "/tmp/a")];
		const runs = [run("r1", "/tmp/other"), run("r2", null)];
		const { tasks: out, orphanRuns } = correlateRuns(tasks, runs);
		expect(out[0]!.runs).toEqual([]);
		expect(orphanRuns.map((r) => r.id)).toEqual(["r1", "r2"]);
	});

	test("task with no worktree never captures runs", () => {
		const { tasks: out, orphanRuns } = correlateRuns([task("alpha", null)], [run("r1", "/tmp/a")]);
		expect(out[0]!.runs).toEqual([]);
		expect(orphanRuns).toHaveLength(1);
	});

	test("relative paths are not treated as durable attribution", () => {
		const { tasks: out, orphanRuns } = correlateRuns(
			[task("alpha", "relative/worktree")],
			[run("r1", "relative/worktree")],
		);
		expect(out[0]!.runs).toEqual([]);
		expect(orphanRuns.map((entry) => entry.id)).toEqual(["r1"]);
		expect(normalizePath("relative/worktree")).toBeNull();
	});

	test("duplicate task worktrees are ambiguous, so matching runs stay orphaned with a diagnostic", () => {
		const { tasks: out, orphanRuns, diagnostics } = correlateRuns(
			[task("alpha", "/tmp/shared"), task("beta", "/tmp/shared/")],
			[run("r1", "/tmp/shared")],
		);
		expect(out.every((entry) => entry.runs.length === 0)).toBe(true);
		expect(orphanRuns.map((entry) => entry.id)).toEqual(["r1"]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.detail).toContain("alpha, beta");
		expect(diagnostics[0]?.detail).toContain("left uncorrelated");
	});

	test("normalizePath resolves and trims", () => {
		expect(normalizePath("/tmp/a/")).toBe("/tmp/a");
		expect(normalizePath(null)).toBeNull();
	});
});
