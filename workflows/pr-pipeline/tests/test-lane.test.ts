import { describe, expect, test } from "bun:test";
import { testLaneCommand } from "../lib/test-lane.ts";

describe("test lane command", () => {
	test("uses bun orphan cleanup without the unusable host-wide fd check", () => {
		const command = testLaneCommand("bun test tests/");
		expect(command).toContain("bun test --no-orphans tests/");
		expect(command).not.toContain("kern.num_files");
		expect(command).not.toContain("max-concurrency");
	});

	test("serializes stale-lock reclamation", () => {
		const command = testLaneCommand("echo ok");
		expect(command).toContain('reclaim="$dir.reclaim"; if mkdir "$reclaim"');
		expect(command).toContain('rmdir "$reclaim"');
	});
});
