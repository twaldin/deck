/** Register the durable captain review-request poll with the Smithers scheduler. */
import { spawnSync } from "node:child_process";

export const reviewGateLauncher = {
  workflow: "review-gate/pipeline.tsx",
  schedule: "* * * * *",
};

export function installReviewGateCron(): void {
  const cwd = new URL("..", import.meta.url).pathname;
  const listed = spawnSync("smithers", ["cron", "list", "--format", "json"], { encoding: "utf8", cwd, timeout: 10_000 });
  if (listed.status !== 0) throw new Error(`smithers cron list failed: ${listed.status ?? "unknown"}`);
  let entries: Array<{ id?: string; workflow?: string }>;
  try { entries = JSON.parse(listed.stdout || "[]"); } catch { throw new Error("smithers cron list returned invalid JSON"); }
  for (const entry of entries) {
    if (entry.workflow === reviewGateLauncher.workflow && entry.id) {
      const removed = spawnSync("smithers", ["cron", "rm", entry.id], { stdio: "inherit", cwd, timeout: 10_000 });
      if (removed.status !== 0) throw new Error(`smithers cron removal failed: ${removed.status ?? "unknown"}`);
    }
  }
  const result = spawnSync("smithers", ["cron", "add", reviewGateLauncher.schedule, reviewGateLauncher.workflow], {
    stdio: "inherit", cwd, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(`smithers cron registration failed: ${result.status ?? "unknown"}`);
}

if (import.meta.main) installReviewGateCron();
