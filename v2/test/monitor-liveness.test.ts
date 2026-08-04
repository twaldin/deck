import { describe, expect, test } from "bun:test";
import { effortLiveness, liveEffortCount, type PsRun } from "../src/monitor";

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
 test("the statusline selector and monitor selector are the same function", () => {
  const run: PsRun = { id: "one", status: "paused" };
  expect(liveEffortCount([run])).toBe([run].filter((r) => effortLiveness(r) === "live").length);
 });
});
