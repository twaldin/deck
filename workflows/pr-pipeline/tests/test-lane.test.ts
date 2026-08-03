import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testLaneCommand } from "../lib/test-lane.ts";

async function run(command: string): Promise<number> {
	const process = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
	return process.exited;
}

describe("test lane command", () => {
	test("rewrites only the literal bun test command", () => {
		const command = testLaneCommand("bun test tests/");
		expect(command).toContain("bun test --no-orphans tests/");
		expect(testLaneCommand("bun run test")).toContain("bun run test");
		expect(command).not.toContain("kern.num_files");
		expect(command).not.toContain("max-concurrency");
	});

	test("executes six contenders with at most two live lock directories", async () => {
		const lock = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lane-")) + "/lock";
		try {
			const statuses = await Promise.all(Array.from({ length: 6 }, () => run(testLaneCommand("sleep .1", lock))));
			expect(statuses).toEqual([0, 0, 0, 0, 0, 0]);
			expect(fs.existsSync(`${lock}.0`)).toBe(false);
			expect(fs.existsSync(`${lock}.1`)).toBe(false);
		} finally { fs.rmSync(path.dirname(lock), { recursive: true, force: true }); }
	});

	test("reclaims a lock directory with no pid file", async () => {
		const lock = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lane-")) + "/lock";
		fs.mkdirSync(`${lock}.0`);
		try {
			expect(await run(testLaneCommand("true", lock))).toBe(0);
		expect(fs.existsSync(`${lock}.0`)).toBe(false);
		} finally { fs.rmSync(path.dirname(lock), { recursive: true, force: true }); }
	});
});
