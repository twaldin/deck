import { describe, expect, test } from "bun:test";
import { orphanedBunTests, parseProcessList } from "../src/orphan-reaper";

describe("orphan reaper decision", () => {
	test("selects only bun test processes adopted by launchd", () => {
		const rows = parseProcessList("101 1 bun test --watch\n102 1 bun run build\n103 8 bun test\n104 1 /usr/bin/node bun test");
		expect(orphanedBunTests(rows).map((row) => row.pid)).toEqual([101]);
	});

	test("does not match unrelated commands", () => {
		expect(orphanedBunTests([{ pid: 1, ppid: 1, command: "bunx test-helper" }])).toEqual([]);
	});
});
