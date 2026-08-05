/** Ensure exactly one durable captain review-request poller is active. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const reviewGateLauncher = {
  workflow: "review-gate/pipeline.tsx",
};

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
type GatewayStarter = (cwd: string) => void;

const ACTIVE_STATUSES = new Set(["running", "waiting-approval", "waiting-event", "waiting-timer"]);
const LOCK_STALE_MS = 5 * 60_000;

const defaultRunner: SmithersRunner = (args, cwd) => {
  const result = spawnSync("smithers", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const defaultGatewayStarter: GatewayStarter = (cwd) => {
  const child = spawn("smithers", ["gateway", "--idle-timeout", "0"], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
};

function parseArrayEnvelope<T>(stdout: string, key: string, label: string): T[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout || "[]"); } catch { throw new Error(`smithers ${label} returned invalid JSON`); }
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed !== null && typeof parsed === "object" && key in parsed && Array.isArray((parsed as Record<string, unknown>)[key])) {
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

function runStatus(run: RunEntry): string {
  return run.status ?? run.dbStatus ?? run.state ?? "unknown";
}

function activeRuns(runner: SmithersRunner, workspace: string): RunEntry[] {
  return [...ACTIVE_STATUSES].flatMap((status) => parseRuns(checked(
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
    activeReviewGate: reviewGate.filter((run) => ACTIVE_STATUSES.has(runStatus(run))).length,
    continuedReviewGate: reviewGate.filter((run) => run.dbStatus === "continued" || run.status === "continued").length,
    postFailure: runs.filter((run) => run.workflow === "post-failure" || run.workflowId === "post-failure").length,
  };
}

export function reviewGateWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const deckHome = env.DECK_V2_HOME?.trim() || join(userHome, ".deck");
  return join(deckHome, "state", "smithers");
}

function isLegacyReviewGateCron(entry: CronEntry): boolean {
  const workflow = (entry.workflow ?? entry.workflowPath ?? "").replaceAll("\\", "/");
  return workflow === "review-gate/pipeline.tsx" || workflow.endsWith("/review-gate/pipeline.tsx");
}

function checked(runner: SmithersRunner, args: string[], cwd: string, label: string): SmithersResult {
  const result = runner(args, cwd);
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`);
  }
  return result;
}

function gatewayRunning(stdout: string, workspace: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { running?: unknown; workspace?: unknown };
    return parsed.running === true && (parsed.workspace === undefined || parsed.workspace === workspace);
  } catch {
    return false;
  }
}

function waitBriefly(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function ensureGateway(
  workspace: string,
  runner: SmithersRunner,
  startGateway: GatewayStarter,
): void {
  const statusArgs = ["gateway", "status", "--format", "json"];
  const initial = runner(statusArgs, workspace);
  if (initial.status === 0 && gatewayRunning(initial.stdout, workspace)) return;
  startGateway(workspace);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    waitBriefly(100);
    const status = runner(statusArgs, workspace);
    if (status.status === 0 && gatewayRunning(status.stdout, workspace)) return;
  }
  throw new Error(`smithers gateway did not become healthy for ${workspace}`);
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
      waitBriefly(100);
    }
  }
  throw new Error(`timed out waiting for review-gate launcher lock in ${workspace}`);
}

export function ensureReviewGatePoller(options: {
  workspace?: string;
  runner?: SmithersRunner;
  startGateway?: GatewayStarter;
} = {}): { started: boolean; runId: string | null; removedLegacyCrons: number } {
  const workspace = options.workspace ?? reviewGateWorkspace();
  const runner = options.runner ?? defaultRunner;
  const startGateway = options.startGateway ?? defaultGatewayStarter;
  if (!existsSync(workspace)) throw new Error(`Smithers workspace does not exist: ${workspace}`);
  const lock = acquireLock(workspace);
  try {
    const cronRows = parseCronEntries(checked(runner, ["cron", "list", "--format", "json"], workspace, "smithers cron list").stdout);
    const legacyCrons = cronRows.filter(isLegacyReviewGateCron);
    for (const entry of legacyCrons) {
      const id = entry.id ?? entry.cronId;
      if (!id) throw new Error("legacy review-gate cron row has no id");
      checked(runner, ["cron", "rm", id], workspace, `smithers cron rm ${id}`);
    }

    ensureGateway(workspace, runner, startGateway);
    const runs = activeRuns(runner, workspace);
    const healthy = runs.find((run) => isReviewGateRun(run) && ACTIVE_STATUSES.has(runStatus(run)));
    if (healthy) {
      return { started: false, runId: healthy.id ?? healthy.runId ?? null, removedLegacyCrons: legacyCrons.length };
    }

    const launched = checked(
      runner,
      ["up", join(workspace, reviewGateLauncher.workflow), "--detach", "--no-post-failure", "--format", "json"],
      workspace,
      "smithers review-gate launch",
    );
    let runId: string | null = null;
    try {
      const parsed = JSON.parse(launched.stdout) as { runId?: unknown };
      if (typeof parsed.runId === "string") runId = parsed.runId;
    } catch {
      // A successful human-format launch is still admitted; the next ensure reads it through ps.
    }
    return { started: true, runId, removedLegacyCrons: legacyCrons.length };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(ensureReviewGatePoller())}\n`);
}
