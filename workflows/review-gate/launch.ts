/** Durable launcher for the captain review-request mirror.
 * Install this command in the Smithers cron registry (one invocation per minute):
 * `bunx smithers-orchestrator@0.30.0 up review-gate/pipeline.tsx --input "$REVIEW_GATE_INPUT" --run-id review-gate-poll`
 * The run continues as new after each bounded poll window, so the cron entry is
 * the durable trigger when a captain review request appears.
 */
export const reviewGateLauncher = {
  workflow: "review-gate/pipeline.tsx",
  schedule: "* * * * *",
  runId: "review-gate-poll",
};
