import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { orphanedBunTests, parseProcessList, reapOrphanedBunTests } from "../src/orphan-reaper";

describe("orphan reaper decision", () => {
	test("selects only bun test processes adopted by launchd", () => {
		const rows = parseProcessList("101 1 bun test --watch\n102 1 bun run build\n103 8 bun test\n104 1 /usr/bin/node bun test\n105 1 bun smithers up pipeline.tsx --resume true\n106 1 bun smithers up --run-id fix-test-flake-123");
		expect(orphanedBunTests(rows).map((row) => row.pid)).toEqual([101]);
	});

	test("does not match unrelated commands", () => {
		expect(orphanedBunTests([{ pid: 1, ppid: 1, command: "bunx test-helper" }])).toEqual([]);
	});

	test("kills selected shards and returns their pids", async () => {
		const killed: number[] = [];
		const result = await reapOrphanedBunTests({
			list: async () => "101 1 bun test --watch",
			kill: async (pid) => { killed.push(pid); },
		});
		expect(killed).toEqual([101]);
		expect(result).toEqual([101]);
	});

	test("writes an observer log after a successful kill", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-reaper-"));
		const prior = process.env.DECK_V2_HOME;
		process.env.DECK_V2_HOME = home;
		try {
			await reapOrphanedBunTests({ list: async () => "202 1 bun test", kill: async () => {} });
			expect(fs.readFileSync(path.join(home, "state", "orphan-reaper.log"), "utf8")).toContain("pid=202 ppid=1");
		} finally {
			if (prior === undefined) delete process.env.DECK_V2_HOME;
			else process.env.DECK_V2_HOME = prior;
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
