/** Register the durable captain review-request poll with the Smithers scheduler. */
import { spawnSync } from "node:child_process";

export const reviewGateLauncher = {
  workflow: "review-gate/pipeline.tsx",
  schedule: "* * * * *",
  runId: "review-gate-poll",
};

export function installReviewGateCron(): void {
  // Replace the known run instead of adding duplicate cron entries on every install.
  spawnSync("smithers", ["cron", "remove", reviewGateLauncher.runId], { stdio: "ignore" });
  const result = spawnSync("smithers", ["cron", "add", reviewGateLauncher.schedule, reviewGateLauncher.workflow, "--id", reviewGateLauncher.runId], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`smithers cron registration failed: ${result.status ?? "unknown"}`);
}

if (import.meta.main) installReviewGateCron();
