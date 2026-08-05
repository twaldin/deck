import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveAgentName, structuredSubagentError, validAgentNames } from "../src/subagents";
import { activityAdvanced, type ActivitySnapshot } from "../src/activity";
import { startSubagentWatchdog } from "../../subagents/extension/watchdog";

const children: ReturnType<typeof spawn>[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagent primitive", () => {
	const agents = ["worker", "worker-gpt", "reviewer", "reviewer-claude", "scout"];

	test("aliases resolve and unknown ids list valid ids with a near-miss", () => {
		expect(resolveAgentName(agents, "claude").name).toBe("reviewer-claude");
		expect(resolveAgentName(agents, "reviewr")).toEqual({ name: "reviewer", suggestion: "reviewer" });
		expect(validAgentNames(agents)).toContain("codex");
		expect(resolveAgentName(agents, "not-an-agent").name).toBeUndefined();
	});

	test("liveness treats CPU, transcript, and worktree growth as activity", () => {
		const before: ActivitySnapshot = { worktreeMtimeMs: 10, worktreeTruncated: false, transcriptMtimeMs: 10, transcriptBytes: 10, cpuTimeMs: 100 };
		expect(activityAdvanced(before, { ...before, cpuTimeMs: 101 })).toBe(true);
		expect(activityAdvanced(before, { ...before, transcriptBytes: 11 })).toBe(true);
		expect(activityAdvanced(before, { ...before, worktreeMtimeMs: 11 })).toBe(true);
		expect(activityAdvanced(before, { ...before, cpuTimeMs: 100 })).toBe(false);
	});

	test("timeout kills the child and returns a structured failure", async () => {
		const worktree = mkdtempSync(path.join(tmpdir(), "deck-subagent-timeout-"));
		tempDirs.push(worktree);
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: worktree });
		children.push(child);
		const failure = await new Promise<unknown>((resolve) => {
			const watchdog = startSubagentWatchdog(child, { worktree, timeoutMs: 50, livenessMs: 5000, onFailure: resolve });
			child.once("close", () => watchdog.stop());
		});
		expect(failure).toMatchObject({ kind: "timeout", pid: child.pid });
	});

	test("a zero-CPU, no-output child is detected, killed, and reported", async () => {
		const worktree = mkdtempSync(path.join(tmpdir(), "deck-subagent-dead-"));
		tempDirs.push(worktree);
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: worktree });
		children.push(child);
		const failure = await new Promise<unknown>((resolve) => {
			const watchdog = startSubagentWatchdog(child, { worktree, timeoutMs: 10000, livenessMs: 1000, onFailure: resolve });
			child.once("close", () => watchdog.stop());
		});
		expect(failure).toMatchObject({ kind: "dead" });
	});

	test("failure payloads stay structured for parent fallback", () => {
		const error = structuredSubagentError("timeout", "child exceeded wall-clock timeout", { pid: 42, timeoutMs: 1000 });
		expect(JSON.parse(error)).toEqual({ error: "subagent_failed", kind: "timeout", reason: "child exceeded wall-clock timeout", pid: 42, timeoutMs: 1000 });
	});
});
