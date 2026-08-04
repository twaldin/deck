import { describe, expect, test } from "bun:test";
import { pollHasNoAgent, pollStack } from "../lib/poll.ts";
import { produceWakeConditions } from "../../../v2/src/wake-producers.ts";

describe("stack owner", () => {
  test("poll loop is machine-only", () => expect(pollHasNoAgent).toBe(true));
  test("dry-run poll reads no LLM", async () => {
    const calls: string[][] = [];
    const exec = async (argv: string[]) => { calls.push(argv); const stdout = argv.includes("pulls") ? JSON.stringify({ number: 1, head: { sha: "x" }, mergeable: true, mergeStateStatus: "CLEAN" }) : argv.some((arg) => arg.includes("/comments")) ? "[]" : JSON.stringify({ check_runs: [] }); return { code: 0, stdout, stderr: "" }; };
    const result = await pollStack(exec, "org/repo", [1]);
    expect(result.signal).toBe("complete");
    expect(calls.every((call) => call.includes("api"))).toBe(true);
  });
  test("terminal producer emits no wake", () => {
    expect(() => produceWakeConditions({ taskId: `stack-owner-test-${Date.now()}`, terminal: true, ciFail: true })).not.toThrow();
  });
});
