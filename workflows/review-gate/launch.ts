/** Register the durable captain review-request poll with the Smithers scheduler. */
import { spawnSync } from "node:child_process";

export const reviewGateLauncher = {
  workflow: "review-gate/pipeline.tsx",
  schedule: "* * * * *",
};

type CronEntry = { id?: string; workflow?: string; cronId?: string; workflowPath?: string };

export function parseCronEntries(stdout: string): CronEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout || "[]"); } catch { throw new Error("smithers cron list returned invalid JSON"); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object" && "crons" in parsed && Array.isArray(parsed.crons)) {
    return parsed.crons;
  }
  throw new Error("smithers cron list returned an unexpected JSON shape");
}

export function installReviewGateCron(): void {
  const cwd = new URL("..", import.meta.url).pathname;
  const listed = spawnSync("smithers", ["cron", "list", "--format", "json"], { encoding: "utf8", cwd, timeout: 10_000 });
  if (listed.status !== 0) throw new Error(`smithers cron list failed: ${listed.status ?? "unknown"}`);
  const entries = parseCronEntries(listed.stdout);
  for (const entry of entries) {
    const workflow = entry.workflow ?? entry.workflowPath;
    const id = entry.id ?? entry.cronId;
    if (workflow === reviewGateLauncher.workflow && id) {
      const removed = spawnSync("smithers", ["cron", "rm", id], { stdio: "inherit", cwd, timeout: 10_000 });
      if (removed.status !== 0) throw new Error(`smithers cron removal failed: ${removed.status ?? "unknown"}`);
    }
  }
  const result = spawnSync("smithers", ["cron", "add", reviewGateLauncher.schedule, reviewGateLauncher.workflow], {
    stdio: "inherit", cwd, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(`smithers cron registration failed: ${result.status ?? "unknown"}`);
}

if (import.meta.main) installReviewGateCron();
