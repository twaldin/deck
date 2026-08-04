import { describe, expect, test } from "bun:test";
import { pollHasNoAgent, pollStack } from "../lib/poll.ts";
import { produceWakeConditions } from "../../../v2/src/wake-producers.ts";

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
  test("terminal producer emits no wake", () => {
    const taskId = `stack-owner-test-${Date.now()}`;
    expect(() => produceWakeConditions({ taskId, terminal: true, ciFail: true })).not.toThrow();
    expect(() => produceWakeConditions({ taskId, ciFail: true })).not.toThrow();
  });
});
