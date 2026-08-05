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
    expect(result.prs[0]).toMatchObject({ number: 1, url: "https://github.com/org/repo/pull/1", mergeStateStatus: "UNKNOWN", reviewState: "PENDING" });
    expect(calls.every((call) => call.includes("api"))).toBe(true);
  });
  test("workflow graph executes in dry-run mode", async () => {
    const sim = simulate((await import("../pipeline.tsx")).default, { input: baseInput });
    await sim.run();
    expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(true);
  });

  test("non-converging review stops with a max-adversarial wake", async () => {
    const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...baseInput, fixtures: { finding: "same blocker" } } });
    await sim.run();
    expect((sim.outputs.review ?? []).length).toBe(2);
    expect(sim.outputs.opened).toBeUndefined();
    expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
    expect(fs.readFileSync(wakeFiles().queue, "utf8")).toContain("max-adversarial");
  });

  test("rendered graph contains the open-to-poll dependency", async () => {
    const rendered = await renderWorkflow((await import("../pipeline.tsx")).default, { input: baseInput, workflowPath: new URL("../pipeline.tsx", import.meta.url).pathname });
    expect(rendered.tasks.some((task) => task.nodeId === "open-stack")).toBe(true);
    expect(rendered.tasks.some((task) => task.nodeId === "poll-stack")).toBe(true);
  });

  test("a green stack merges only through the approval gate", async () => {
    const sim = simulate((await import("../pipeline.tsx")).default, { input: baseInput });
    await sim.run();
    // The gate is the merge button: no merge row may exist without a decision.
    const decision = sim.outputs.approval?.[0] as { approved?: boolean } | undefined;
    expect(decision?.approved).toBe(true);
    const merge = sim.outputs.merge?.[0] as { merged?: boolean; receipts?: string[] } | undefined;
    expect(merge?.merged).toBe(true);
    expect(merge?.receipts?.length).toBeGreaterThan(0);
  });

  test("a stack that never goes green reaches neither the gate nor the merge", async () => {
    const sim = simulate((await import("../pipeline.tsx")).default, { input: { ...baseInput, fixtures: { ciFail: true } } });
    await sim.run();
    expect(sim.outputs.approval).toBeUndefined();
    expect(sim.outputs.merge).toBeUndefined();
    expect((sim.outputs.result?.[0] as { done?: boolean } | undefined)?.done).toBe(false);
  });

  test("terminal producer clears wakes, failed terminal preserves a wake", () => {
    const taskId = `stack-owner-test-${Date.now()}`;
    produceWakeConditions({ taskId, ciFail: true });
    const queue = wakeFiles().queue;
    expect(fs.readFileSync(queue, "utf8")).toContain("ci-fail");
    produceWakeConditions({ taskId, terminal: true, ciFail: true });
    const baseline = fs.readFileSync(wakeFiles().baseline, "utf8");
    expect(baseline).not.toContain(`${taskId}:ci-fail`);
    const before = fs.readFileSync(queue, "utf8").split("\n").filter(Boolean).length;
    produceWakeConditions({ taskId, terminal: false, ciFail: true });
    const after = fs.readFileSync(queue, "utf8").split("\n").filter(Boolean).length;
    expect(after).toBeGreaterThan(before);
  });
});
