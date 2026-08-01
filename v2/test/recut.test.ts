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
		setup("run-v1", { ticket: "t1", existingPr: 42, worktree: "/tmp/wt" });
		const old = pipelineHash(pipeline);
		const starts: Array<[string, Record<string, unknown>]> = [];
		const result = await recutChangedRuns({
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline,
			inspect: async () => ({ metadata: { pipelineHash: old + "-old" } }),
			cancel: async () => {},
			start: async (id, input) => starts.push([id, input]),
			recordDir: ship,
		});
		expect(result[0]?.newRunId).toBe("run-v2");
		expect(starts[0]?.[1].existingPr).toBe(42);
		expect(JSON.parse(fs.readFileSync(path.join(ship, "recuts.jsonl"), "utf8")).oldRunId).toBe("run-v1");
	});
	test("matching hash is a no-op and a second cycle is rate limited", async () => {
		setup("run-v1", { ticket: "t1", existingPr: 42 });
		let count = 0;
		const options = {
			runs: [{ id: "run-v1", workflow: "pr-pipeline", status: "waiting-approval", step: "r0-stamp" }],
			pipelineDir: pipeline,
			inspect: async () => ({ metadata: { pipelineHash: "old" } }),
			cancel: async () => {}, start: async () => { count++; }, recordDir: ship,
		};
		await recutChangedRuns(options);
		await recutChangedRuns(options);
		expect(count).toBe(1);
		const noOp = await recutChangedRuns({ ...options, inspect: async () => ({ metadata: { pipelineHash: pipelineHash(pipeline) } }) });
		expect(noOp).toHaveLength(0);
	});
});
