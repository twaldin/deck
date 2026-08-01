import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipelineHash, recutChangedRuns } from "../src/recut";

let home: string;
let ship: string;
let pipeline: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "deckv2-recut-"));
	ship = path.join(home, "state", "ship");
	pipeline = path.join(home, "pipeline");
	fs.mkdirSync(ship, { recursive: true });
	fs.mkdirSync(pipeline, { recursive: true });
	fs.writeFileSync(path.join(pipeline, "pipeline.tsx"), "version 1");
	process.env.DECK_V2_HOME = home;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); delete process.env.DECK_V2_HOME; });

function setup(id: string, input: Record<string, unknown>): void {
	fs.writeFileSync(path.join(ship, `${id}.input.json`), JSON.stringify(input));
}

describe("pipeline recut", () => {
	test("recuts a stamp park and preserves input and existing PR", async () => {
		setup("run-v1", {
			ticket: "t1", existingPr: 42, worktree: "/tmp/wt",
			__smithersDurability: { entryWorkflowHash: "stale" },
		});
		const old = pipelineHash(pipeline);
		const starts: Array<[string, Record<string, unknown>]> = [];
		const result = await recutChangedRuns({
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline,
			// Smithers inspect does not expose the launch config. Detection must use input.json.
			inspect: async () => ({ run: { id: "run-v1", status: "waiting-approval" } }),
			cancel: async () => {},
			start: async (id, input) => { starts.push([id, input]); },
			recordDir: ship,
		});
		expect(result[0]?.newRunId).toBe("run-v2");
		expect(starts[0]?.[1].existingPr).toBe(42);
		expect((starts[0]?.[1].__smithersDurability as Record<string, unknown>).entryWorkflowHash).toBe(old);
		expect(JSON.parse(fs.readFileSync(path.join(ship, "recuts.jsonl"), "utf8")).oldRunId).toBe("run-v1");
	});
	test("does not recut the replacement on a second reconcile pass", async () => {
		setup("run-v1", { __smithersDurability: { entryWorkflowHash: "old" } });
		let starts = 0;
		const options = {
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline,
			inspect: async () => ({}),
			cancel: async () => {},
			start: async (id: string, input: Record<string, unknown>) => {
				starts++;
				setup(id, input);
			},
			recordDir: ship,
		};
		const first = await recutChangedRuns(options);
		const second = await recutChangedRuns({
			...options,
			runs: [{ id: first[0]!.newRunId, workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
		});
		expect(starts).toBe(1);
		expect(second).toHaveLength(0);
	});
	test("cancels a replacement when startup verification fails", async () => {
		setup("run-v1", { __smithersDurability: { entryWorkflowHash: "old" } });
		const cancelled: string[] = [];
		await recutChangedRuns({
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline, inspect: async () => ({}),
			cancel: async (id) => { cancelled.push(id); }, start: async () => {},
			verifyStart: async () => false, recordDir: ship,
		});
		expect(cancelled).toEqual(["run-v2"]);
	});
	test("records the replacement before a failed old-run cancellation", async () => {
	setup("run-v1", { __smithersDurability: { entryWorkflowHash: "old" } });
	let cancelCalls = 0;
	const result = await recutChangedRuns({
		runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
		pipelineDir: pipeline, inspect: async () => ({}),
		start: async () => {},
		cancel: async () => { cancelCalls++; throw new Error("not registered yet"); },
		recordDir: ship,
	});
	 expect(result).toHaveLength(1);
	 expect(fs.existsSync(path.join(ship, "run-v2.input.json"))).toBe(true);
	 expect(JSON.parse(fs.readFileSync(path.join(ship, ".recuts.json"), "utf8"))["run-v1"]).toBe(pipelineHash(pipeline));
	 expect(JSON.parse(fs.readFileSync(path.join(ship, ".recut-cancels.json"), "utf8"))).toEqual(["run-v1"]);
	 expect(cancelCalls).toBe(1);
	});
	test("keeps a late replacement recorded when startup verification times out", async () => {
	setup("run-v1", { __smithersDurability: { entryWorkflowHash: "old" } });
	const cancelled: string[] = [];
	const result = await recutChangedRuns({
		runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
		pipelineDir: pipeline, inspect: async () => ({}), start: async () => {},
		cancel: async (id) => { cancelled.push(id); }, verifyStart: async () => false, recordDir: ship,
	});
	 expect(result).toHaveLength(0);
	 expect(cancelled).toEqual(["run-v2"]);
	 expect(fs.existsSync(path.join(ship, "run-v2.input.json"))).toBe(true);
	 expect(JSON.parse(fs.readFileSync(path.join(ship, ".recuts.json"), "utf8"))["run-v1"]).toBe(pipelineHash(pipeline));
	});
	test("matching hash is a no-op and a second cycle is rate limited", async () => {
		setup("run-v1", { ticket: "t1", existingPr: 42 });
		let count = 0;
		const options = {
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline,
			inspect: async () => ({ config: { __smithersDurability: { entryWorkflowHash: "old" } } }),
			cancel: async () => {}, start: async () => { count++; }, recordDir: ship,
		};
		await recutChangedRuns(options);
		await recutChangedRuns(options);
		expect(count).toBe(1);
		const noOp = await recutChangedRuns({ ...options, inspect: async () => ({ config: { __smithersDurability: { entryWorkflowHash: pipelineHash(pipeline) } } }) });
		expect(noOp).toHaveLength(0);
	});
});
