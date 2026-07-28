import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../src/collectors/backlog";
import type { FleetConfig } from "../src/config";
import { buildModel } from "../src/model";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const FM_HOME = path.join(FIXTURES, "fm-home");

async function fixture(rel: string): Promise<string> {
	return Bun.file(path.join(FIXTURES, rel)).text();
}

const config: FleetConfig = {
	fmHome: FM_HOME,
	smithersWorkspaces: ["/ws"],
	intervalMs: 2000,
	color: false,
	once: true,
	minWidth: 48,
};

describe("buildModel", () => {
	test("assembles tasks, enriches with backlog, correlates a run to alpha's worktree", async () => {
		const ps = await fixture("smithers/ps.json");
		const oneshot = await fixture("smithers/inspect-oneshot.json");
		const pipeline = await fixture("smithers/inspect-pipeline.json");
		const listOut = await fixture("tasks-axi-list.txt");

		const run: CommandRunner = async (cmd, args) => {
			if (cmd === "tasks-axi") return { stdout: listOut, exitCode: 0 };
			if (args[1] === "ps") return { stdout: ps, exitCode: 0 };
			if (args[2] === "oneshot-abc123") return { stdout: oneshot, exitCode: 0 };
			if (args[2] === "pr-pipeline-def456") return { stdout: pipeline, exitCode: 0 };
			return null;
		};

		const model = await buildModel(config, { run, now: () => 9_000_000 });
		expect(model.generatedAtMs).toBe(9_000_000);

		const alpha = model.tasks.find((t) => t.id === "alpha")!;
		expect(alpha.meta?.worktree).toBe("/tmp/fleet-fixture/alpha");
		expect(alpha.status?.state).toBe("working");
		expect(alpha.backlog?.state).toBe("in_flight");
		// oneshot run rootDir == alpha worktree -> correlated
		expect(alpha.runs.map((r) => r.id)).toEqual(["oneshot-abc123"]);

		// pipeline run rootDir is unrelated -> orphan workflows section
		expect(model.orphanRuns.map((r) => r.id)).toEqual(["pr-pipeline-def456"]);

		// backlog-only task (delta) still appears even without a state file
		expect(model.tasks.some((t) => t.id === "delta")).toBe(true);

		// diagnostics cover every source
		const sources = model.diagnostics.map((d) => d.source);
		expect(sources.some((s) => s.startsWith("FM_HOME"))).toBe(true);
		expect(sources.some((s) => s.startsWith("backlog:"))).toBe(true);
		expect(sources).toContain("broker");
	});

	test("attention states sort ahead of the rest", async () => {
		const run: CommandRunner = async () => null; // markdown fallback, no smithers
		const model = await buildModel(config, { run, now: () => 1 });
		// beta is needs-decision -> must precede done/queued tasks
		const ids = model.tasks.map((t) => t.id);
		expect(ids.indexOf("beta")).toBeLessThan(ids.indexOf("epsilon"));
	});

	test("surfaces ambiguous correlation diagnostics and leaves the run uncorrelated", async () => {
		const tempHome = await fs.mkdtemp(path.join(FIXTURES, "model-"));
		try {
			const stateDir = path.join(tempHome, "state");
			await fs.mkdir(stateDir);
			const sharedMeta = "worktree=/tmp/fleet-fixture/alpha\nharness=pi\n";
			await fs.writeFile(path.join(stateDir, "alpha.meta"), sharedMeta);
			await fs.writeFile(path.join(stateDir, "beta.meta"), sharedMeta);

			const ps = await fixture("smithers/ps.json");
			const oneshot = await fixture("smithers/inspect-oneshot.json");
			const pipeline = await fixture("smithers/inspect-pipeline.json");
			const run: CommandRunner = async (cmd, args) => {
				if (cmd === "tasks-axi") return null;
				if (args[1] === "ps") return { stdout: ps, exitCode: 0 };
				if (args[2] === "oneshot-abc123") return { stdout: oneshot, exitCode: 0 };
				if (args[2] === "pr-pipeline-def456") return { stdout: pipeline, exitCode: 0 };
				return null;
			};
			const model = await buildModel({ ...config, fmHome: tempHome }, { run, now: () => 1 });
			expect(model.orphanRuns.map((entry) => entry.id)).toContain("oneshot-abc123");
			expect(model.tasks.find((entry) => entry.id === "alpha")?.runs).toEqual([]);
			expect(model.tasks.find((entry) => entry.id === "beta")?.runs).toEqual([]);
			expect(model.diagnostics.some((diagnostic) => diagnostic.source === "correlation" && !diagnostic.ok)).toBe(
				true,
			);
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
		}
	});
});
