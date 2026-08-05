/** Ensure exactly one durable captain review-request poller is active. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_SMITHERS_WORKSPACE = "/Users/twaldin/.deck/state/smithers";

export const reviewGateLauncher = {
  workflow: fileURLToPath(new URL("./pipeline.tsx", import.meta.url)),
};

const packManifest = fileURLToPath(new URL("../.smithers/smithers.toon", import.meta.url));
const ACTIVE_STATUSES = ["running", "waiting-approval", "waiting-event", "waiting-timer"] as const;
const LOCK_STALE_MS = 5 * 60_000;

type CronEntry = { id?: string; workflow?: string; cronId?: string; workflowPath?: string };
export type RunEntry = {
  id?: string;
  runId?: string;
  workflow?: string;
  workflowId?: string;
  status?: string;
  dbStatus?: string;
  state?: string;
};
export type SmithersResult = { status: number | null; stdout: string; stderr: string };
export type SmithersRunner = (args: string[], cwd: string) => SmithersResult;

export type EnsureResult = {
  started: boolean;
  runId: string | null;
  removedLegacyCrons: number;
  cancelledDuplicatePollers: number;
  cancelledPostFailureRuns: number;
  removedStalePostFailureWorkflow: boolean;
  updatedInstalledManifest: boolean;
};

const defaultRunner: SmithersRunner = (args, cwd) => {
  const result = spawnSync("smithers", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function parseArrayEnvelope<T>(stdout: string, key: string, label: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    throw new Error(`smithers ${label} returned invalid JSON`);
  }
  if (Array.isArray(parsed)) return parsed as T[];
  if (
    parsed !== null
    && typeof parsed === "object"
    && key in parsed
    && Array.isArray((parsed as Record<string, unknown>)[key])
  ) {
    return (parsed as Record<string, T[]>)[key];
  }
  throw new Error(`smithers ${label} returned an unexpected JSON shape`);
}

export function parseCronEntries(stdout: string): CronEntry[] {
  return parseArrayEnvelope<CronEntry>(stdout, "crons", "cron list");
}

export function parseRuns(stdout: string): RunEntry[] {
  return parseArrayEnvelope<RunEntry>(stdout, "runs", "ps");
}

function isReviewGateRun(run: RunEntry): boolean {
  return run.workflow === "lindy-review-gate" || run.workflowId === "review-gate";
}

function isPostFailureRun(run: RunEntry): boolean {
  return run.workflow === "post-failure" || run.workflowId === "post-failure";
}

function runStatus(run: RunEntry): string {
  return run.status ?? run.dbStatus ?? run.state ?? "unknown";
}

function runId(run: RunEntry): string {
  const id = run.id ?? run.runId;
  if (!id) throw new Error("active Smithers run has no id");
  return id;
}

function checked(runner: SmithersRunner, args: string[], cwd: string, label: string): SmithersResult {
  const result = runner(args, cwd);
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`);
  }
  return result;
}

function activeRuns(runner: SmithersRunner, workspace: string): RunEntry[] {
  return ACTIVE_STATUSES.flatMap((status) => parseRuns(checked(
    runner,
    ["ps", "--status", status, "--limit", "10000", "--format", "json"],
    workspace,
    `smithers ps --status ${status}`,
  ).stdout));
}

export function summarizeRunCounts(runs: RunEntry[]): {
  reviewGate: number;
  activeReviewGate: number;
  continuedReviewGate: number;
  postFailure: number;
} {
  const reviewGate = runs.filter(isReviewGateRun);
  return {
    reviewGate: reviewGate.length,
    activeReviewGate: reviewGate.filter((run) => ACTIVE_STATUSES.includes(runStatus(run) as typeof ACTIVE_STATUSES[number])).length,
    continuedReviewGate: reviewGate.filter((run) => run.dbStatus === "continued" || run.status === "continued").length,
    postFailure: runs.filter(isPostFailureRun).length,
  };
}

function isLegacyReviewGateCron(entry: CronEntry): boolean {
  const workflow = (entry.workflow ?? entry.workflowPath ?? "").replaceAll("\\", "/");
  return workflow === "review-gate/pipeline.tsx" || workflow.endsWith("/review-gate/pipeline.tsx");
}

function gatewayHealthy(stdout: string, workspace: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { running?: unknown; workspace?: unknown };
    return parsed.running === true && parsed.workspace === workspace;
  } catch {
    return false;
  }
}

function acquireLock(workspace: string): string {
  const lock = join(workspace, ".review-gate-launch.lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lock);
      return lock;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true });
          continue;
        }
      } catch {
        continue;
      }
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, 100);
    }
  }
  throw new Error(`timed out waiting for review-gate launcher lock in ${workspace}`);
}

function removePostFailurePackSurface(workspace: string): {
  removedStalePostFailureWorkflow: boolean;
  updatedInstalledManifest: boolean;
} {
  const canonicalManifest = readFileSync(packManifest, "utf8");
  if (canonicalManifest.includes("post-failure")) {
    throw new Error("canonical Smithers pack still includes post-failure");
  }

  const staleWorkflow = join(workspace, ".smithers", "workflows", "post-failure.tsx");
  const installedManifest = join(workspace, ".smithers", "smithers.toon");
  const removedStalePostFailureWorkflow = existsSync(staleWorkflow);
  if (removedStalePostFailureWorkflow) rmSync(staleWorkflow);

  const installed = existsSync(installedManifest) ? readFileSync(installedManifest, "utf8") : "";
  const updatedInstalledManifest = installed !== canonicalManifest;
  if (updatedInstalledManifest) {
    mkdirSync(join(workspace, ".smithers"), { recursive: true });
    writeFileSync(installedManifest, canonicalManifest);
  }

  return { removedStalePostFailureWorkflow, updatedInstalledManifest };
}

export function ensureReviewGatePoller(options: {
  workspace?: string;
  runner?: SmithersRunner;
  workflowPath?: string;
} = {}): EnsureResult {
  const runner = options.runner ?? defaultRunner;
  const workspace = options.runner ? (options.workspace ?? LIVE_SMITHERS_WORKSPACE) : LIVE_SMITHERS_WORKSPACE;
  const workflowPath = options.workflowPath ?? reviewGateLauncher.workflow;
  if (!existsSync(workspace)) throw new Error(`Smithers workspace does not exist: ${workspace}`);
  if (!existsSync(workflowPath)) throw new Error(`review-gate workflow does not exist: ${workflowPath}`);

  const lock = acquireLock(workspace);
  try {
    const packCleanup = removePostFailurePackSurface(workspace);
    const cronRows = parseCronEntries(checked(
      runner,
      ["cron", "list", "--format", "json"],
      workspace,
      "smithers cron list",
    ).stdout);
    const legacyCrons = cronRows.filter(isLegacyReviewGateCron);
    for (const entry of legacyCrons) {
      const id = entry.id ?? entry.cronId;
      if (!id) throw new Error("legacy review-gate cron row has no id");
      checked(runner, ["cron", "rm", id], workspace, `smithers cron rm ${id}`);
    }

    const runs = activeRuns(runner, workspace);
    const postFailureRuns = runs.filter(isPostFailureRun);
    for (const run of postFailureRuns) {
      checked(runner, ["cancel", runId(run)], workspace, `smithers cancel ${runId(run)}`);
    }

    const pollers = runs.filter(isReviewGateRun);
    const keeper = pollers[0];
    const duplicates = pollers.slice(1);
    for (const run of duplicates) {
      checked(runner, ["cancel", runId(run)], workspace, `smithers cancel ${runId(run)}`);
    }

    const gateway = checked(
      runner,
      ["gateway", "status", "--format", "json"],
      workspace,
      "smithers gateway status",
    );
    if (!gatewayHealthy(gateway.stdout, workspace)) {
      throw new Error(`Smithers Gateway is not healthy for ${workspace}`);
    }

    if (keeper) {
      return {
        started: false,
        runId: runId(keeper),
        removedLegacyCrons: legacyCrons.length,
        cancelledDuplicatePollers: duplicates.length,
        cancelledPostFailureRuns: postFailureRuns.length,
        ...packCleanup,
      };
    }

    const launched = checked(
      runner,
      ["up", workflowPath, "--detach", "--no-post-failure", "--format", "json"],
      workspace,
      "smithers review-gate launch",
    );
    let launchedRunId: string | null = null;
    try {
      const parsed = JSON.parse(launched.stdout) as { runId?: unknown };
      if (typeof parsed.runId === "string") launchedRunId = parsed.runId;
    } catch {
      // A successful human-format launch is still admitted; the next ensure discovers it through ps.
    }
    return {
      started: true,
      runId: launchedRunId,
      removedLegacyCrons: legacyCrons.length,
      cancelledDuplicatePollers: 0,
      cancelledPostFailureRuns: postFailureRuns.length,
      ...packCleanup,
    };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(ensureReviewGatePoller())}\n`);
}
