import { describe, expect, test } from "bun:test";
import { runMergeWithFallback } from "../lib/merge.ts";
import type { ExecResult } from "../lib/gh.ts";

const result = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });

describe("merge fallback", () => {
	test("falls back to gh for an untracked Graphite branch", async () => {
		const calls: string[][] = [];
		const merged = await runMergeWithFallback({
			runGraphite: async () => result(1, "", "ERROR: Cannot perform this operation on untracked branch x"),
			exec: async (argv) => {
				calls.push(argv);
				return result(0, "queued");
			},
			gh: "gh",
			prNumber: 42,
			cwd: "/tmp/wt",
			fallbackArgs: ["--auto"],
		});
		expect(merged.path).toBe("gh-fallback");
		expect(calls).toEqual([["gh", "pr", "merge", "42", "--auto"]]);
	});

	test("does not call gh after Graphite succeeds", async () => {
		let ghCalled = false;
		const merged = await runMergeWithFallback({
			runGraphite: async () => result(0, "queued"),
		exec: async () => {
			ghCalled = true;
			return result(0);
		},
		gh: "gh",
		prNumber: 42,
		cwd: "/tmp/wt",
		fallbackArgs: ["--squash"],
	});
		expect(merged.path).toBe("graphite");
		expect(ghCalled).toBe(false);
	});

	test("does not fall back for unrelated not-found Graphite errors", async () => {
		let ghCalled = false;
		await expect(
			runMergeWithFallback({
				runGraphite: async () => result(1, "", "no pull request found for branch x"),
				exec: async () => {
					ghCalled = true;
					return result(0);
				},
				gh: "gh",
				prNumber: 42,
				cwd: "/tmp/wt",
				fallbackArgs: ["--squash"],
			}),
		).rejects.toThrow("no pull request found for branch x");
		expect(ghCalled).toBe(false);
	});

	test("fails other Graphite errors without fallback", async () => {
		let ghCalled = false;
		await expect(
			runMergeWithFallback({
				runGraphite: async () => result(2, "", "authentication failed"),
			exec: async () => {
				ghCalled = true;
				return result(0);
			},
			gh: "gh",
			prNumber: 42,
			cwd: "/tmp/wt",
			fallbackArgs: ["--squash"],
		}),
		).rejects.toThrow("authentication failed");
		expect(ghCalled).toBe(false);
	});

	test("surfaces both errors when fallback fails", async () => {
		await expect(
			runMergeWithFallback({
				runGraphite: async () => result(1, "", "untracked branch"),
				exec: async () => result(1, "", "pull request is not mergeable"),
			gh: "gh",
			prNumber: 42,
			cwd: "/tmp/wt",
			fallbackArgs: ["--squash"],
		}),
		).rejects.toThrow(/untracked branch[\s\S]*not mergeable/);
	});
});
