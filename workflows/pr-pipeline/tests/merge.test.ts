import { describe, expect, test } from "bun:test";
import { runMerge } from "../lib/merge.ts";
import type { ExecResult } from "../lib/gh.ts";

const result = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });

describe("GitHub merge queue", () => {
	test("submits an auto-squash merge", async () => {
		const calls: string[][] = [];
		const merged = await runMerge({
			exec: async (argv) => { calls.push(argv); return result(0, "queued"); },
			gh: "gh", prNumber: 42, cwd: "/tmp/wt", args: ["--auto", "--squash"],
		});
		expect(merged.path).toBe("github-merge-queue");
		expect(calls).toEqual([["gh", "pr", "merge", "42", "--auto", "--squash"]]);
	});

	test("surfaces GitHub merge errors", async () => {
		await expect(runMerge({
			exec: async () => result(1, "", "pull request is not mergeable"),
			gh: "gh", prNumber: 42, cwd: "/tmp/wt", args: ["--auto", "--squash"],
		})).rejects.toThrow("pull request is not mergeable");
	});
});
