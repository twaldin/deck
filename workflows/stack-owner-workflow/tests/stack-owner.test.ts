import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderWorkflow, simulate } from "smithers-orchestrator/testing";
import { pollHasNoAgent, pollStack } from "../lib/poll.ts";
import { produceWakeConditions } from "../../../v2/src/wake-producers.ts";
import { wakeFiles } from "../../../v2/src/home.ts";
import * as fs from "node:fs";

const baseInput = { repo: "org/repo", worktree: "/tmp/worktree", branch: "feature", prompt: "Add feature", dryRun: true };
const testHome = fs.mkdtempSync("/tmp/stack-owner-test-");
beforeEach(() => { process.env.DECK_V2_HOME = testHome; });

afterEach(() => {
  for (const file of Object.values(wakeFiles())) fs.rmSync(file, { force: true });
});

describe("stack owner", () => {
  test("poll loop is machine-only", () => expect(pollHasNoAgent).toBe(true));
  test("dry-run poll reads no LLM", async () => {
    const calls: string[][] = [];
    const exec = async (argv: string[]) => { calls.push(argv); const stdout = argv.some((arg) => arg.includes("/pulls/1") && !arg.includes("/comments") && !arg.includes("/reviews")) ? JSON.stringify({ number: 1, user: { login: "author" }, head: { sha: "x" }, mergeable: true }) : argv.some((arg) => arg.includes("/comments") || arg.includes("/reviews")) ? "[]" : JSON.stringify({ check_runs: [] }); return { code: 0, stdout, stderr: "" }; };
    const result = await pollStack(exec, "org/repo", [1]);
    expect(result.signal).toBe("idle");
    expect(result.prs[0]?.ci).toBe("pending");
    expect(calls.every((call) => call.includes("api"))).toBe(true);
  });
  test("workflow graph executes in dry-run mode", async () => {
    const sim = simulate((await import("../pipeline.tsx")).default, { input: baseInput });
    await sim.run();
    expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(true);
  });

  test("rendered graph contains the open-to-poll dependency", async () => {
    const rendered = await renderWorkflow((await import("../pipeline.tsx")).default, { input: baseInput, workflowPath: new URL("../pipeline.tsx", import.meta.url).pathname });
    expect(rendered.tasks.some((task) => task.nodeId === "open-stack")).toBe(true);
    expect(rendered.tasks.some((task) => task.nodeId === "poll-stack")).toBe(true);
  });

  test("terminal producer clears wakes, failed terminal preserves a wake", () => {
    const taskId = `stack-owner-test-${Date.now()}`;
    produceWakeConditions({ taskId, ciFail: true });
    const queue = wakeFiles().queue;
    expect(fs.readFileSync(queue, "utf8")).toContain("ci-fail");
    produceWakeConditions({ taskId, terminal: true, ciFail: true });
    const baseline = fs.readFileSync(wakeFiles().baseline, "utf8");
    expect(baseline).not.toContain(`${taskId}:ci-fail`);
    produceWakeConditions({ taskId, terminal: false, ciFail: true });
    expect(fs.readFileSync(queue, "utf8")).toContain("ci-fail");
  });
});
