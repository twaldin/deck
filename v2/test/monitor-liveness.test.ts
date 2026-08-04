import { describe, expect, test } from "bun:test";
import { buildFactoryView, effortLiveness, liveEffortCount, renderFooterLines, type FleetFrame, type PsRun } from "../src/monitor";

describe("shared effort liveness", () => {
 test("counts running and paused, archives terminal and old runs", () => {
  const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const runs: PsRun[] = [
   { id: "running", status: "running" },
   { id: "paused", state: "paused" },
   { id: "done", status: "finished" },
   { id: "dead", status: "unknown", started: old },
  ];
  expect(liveEffortCount(runs)).toBe(2);
  expect(effortLiveness(runs[2]!)).toBe("archived");
  expect(effortLiveness(runs[3]!)).toBe("archived");
 });
 test("statusline effort count matches rendered monitor rows", () => {
  const frame: FleetFrame = {
   generatedAt: new Date().toISOString(),
   tasks: [],
   workflows: [
    { runId: "live", workflow: "ship", status: "running", state: "running", step: null, taskId: null, phase: "implement", waitingFor: null, activity: "working" },
    { runId: "done", workflow: "ship", status: "finished", state: "succeeded", step: null, taskId: null, phase: null, waitingFor: "none", activity: "idle" },
   ],
   efforts: [
    { identity: "live", ticket: null, prNumber: null, prTitle: null, runId: "live", state: "running", waitingFor: null, failed: false },
    { identity: "done", ticket: null, prNumber: null, prTitle: null, runId: "done", state: "finished", waitingFor: null, failed: false },
   ],
   counters: { tasks: 0, running: 0, blocked: 0, openDecisions: 0, queuedMessages: 0, openQuestions: 0, internalOpen: 0, internalCap: 12, efforts: 2, agents: 0, unhealedFailures: 0 },
   sources: [],
  };
  const monitor = buildFactoryView(frame, undefined, { chrome: "bare" }).text;
  const renderedRows = monitor.split("\n").filter((line) => line.includes("run:live")).length;
  const statusline = renderFooterLines(frame)[2];
  expect(renderedRows).toBe(1);
  expect(statusline).toContain(`${renderedRows} efforts`);
 });
});
