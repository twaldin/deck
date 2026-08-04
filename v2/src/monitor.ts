/**
 * Fleet view model: what agents and workflows are ACTUALLY doing.
 *
 * Primary view is runs and workflows, with the task list demoted — the captain's
 * ask. This module is the model only; the extension renders it as a full-screen
 * overlay and the CLI prints it. Both consume the same shape, so the two faces
 * cannot drift.
 *
 * Sources degrade independently and report their own health, the pattern the
 * existing fleet/ dashboard already uses: a frame still renders when Smithers or
 * herdr is unavailable, because deck never reads either for truth. Herdr being
 * down removes decoration, not function.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
const run = promisify(execFile);
import * as fs from "node:fs";
import * as path from "node:path";
import { lastEvent, openDecisions } from "./events";
import { internalSummary } from "./backlog";
import { stateDir } from "./home";
import {
  ask,
  askIfAbsent,
  openQuestions,
  queueFile,
  readQuestionHistory,
  readQuestions,
} from "./questions-store";
import { pending } from "./queue";
import { deckOwnedTasks } from "./wake";
import { readMeta } from "./meta";
import { unresolvedReceipts } from "./side-effects";
import { pidAlive } from "./spawn";
import {
  defaultModelPolicy,
  resolveAdversary,
} from "../../workflows/pr-pipeline/lib/models";

export type SourceHealth = {
  name: string;
  state: "ok" | "missing" | "skipped";
  detail: string;
};

export type WaitingFor =
  | "ci-poll"
  | "review-poll"
  | "fixing"
  | "ready-poll"
  | "stamp"
  | `gate:${string}`
  | "approval"
  | "migration"
  | "landing"
  | "deploy-evidence"
  | "fallout-window"
  | "none"
  | null;

export type FleetActivity = "idle" | "fixing" | "working" | "failed";

export type TaskRow = {
  taskId: string;
  kind: string;
  /** Selected worker model, when this effort was spawned outside a pipeline. */
  model?: string | null;
  project: string | null;
  /** Live process, finished run, or never started. */
  runState: "running" | "finished" | "none";
  lastVerb: string | null;
  lastNote: string | null;
  openDecisions: number;
  queuedMessages: number;
  unresolvedSideEffects: number;
  pr: string | null;
  /** Pipeline ticket and PR identity from the existing input, when known. */
  ticket?: string | null;
  prNumber?: number | null;
  prTitle?: string | null;
  phase?: string | null;
  waitingFor?: WaitingFor;
  activity?: FleetActivity;
  worktree: string | null;
  /** Smithers run id, when workflow-backed. */
  runId: string | null;
  /** Workflow stage, when known. */
  stage: string | null;
  /** herdr pane, when the run is visible. */
  pane: string | null;
  /** ms since the last status append, from the file's mtime. */
  statusAgeMs: number | null;
};

export function liveSpawnCount(
  tasks: Pick<TaskRow, "taskId" | "runState">[],
): number {
  return new Set(
    tasks
      .filter((task) => task.runState === "running")
      .map((task) => task.taskId),
  ).size;
}

export type AgentRow = {
  id: string;
  model: string | null;
  status: string;
  ageMs: number | null;
};

export type EffortRow = {
  /** Captain-facing factory metadata. */
  workflow?: string | null;
  step?: string | null;
  runtimeMs?: number | null;
  ciState?: string | null;
  mergeStateStatus?: string | null;
  headRefOid?: string | null;
  reviewState?: string | null;
  model?: string | null;
  prUrl?: string | null;
  identity: string;
  ticket: string | null;
  prNumber: number | null;
  prTitle: string | null;
  runId: string;
  state: string | null;
  waitingFor: string | null;
  failed: boolean;
};

export type WorkflowRow = {
  runId: string;
  workflow: string | null;
  status: string | null;
  /** smithers ps state, when reported (e.g. "succeeded" beside status "finished"). */
  state: string | null;
  step: string | null;
  /** Task correlated by run id or input worktree, when one matches. */
  taskId: string | null;
  ticket?: string | null;
  prNumber?: number | null;
  prTitle?: string | null;
  /** Existing PR identity used to detect superseded failed runs. */
  existingPr?: number | null;
  /** GitHub repository from the durable ship input. */
  repo?: string | null;
  /** Workflow workspace used to avoid cross-repo PR identity collisions. */
  rootDir?: string | null;
  /** Landing/supersession evidence supplied by the workflow status payload. */
  merged?: boolean;
  tipOnMain?: boolean;
  superseded?: boolean;
  pushPrNull?: boolean;
  /** A landing poll proved the content is already on the base branch. */
  landed?: boolean;
  phase?: string | null;
  waitingFor?: WaitingFor;
  activity?: FleetActivity;
  waitAgeMs?: number | null;
  startedAt?: string | null;
};

export type FleetFrame = {
  generatedAt: string;
  tasks: TaskRow[];
  workflows: WorkflowRow[];
  efforts?: EffortRow[];
  agents?: AgentRow[];
  counters: {
    tasks: number;
    running: number;
    /** Tasks whose last report is blocked. */
    blocked: number;
    openDecisions: number;
    queuedMessages: number;
    /** Captain questions waiting in the /questions queue. */
    openQuestions: number;
    internalOpen: number;
    internalCap: number;
    efforts?: number;
    agents?: number;
    unhealedFailures?: number;
  };
  sources: SourceHealth[];
};

export type PsRun = {
  id: string;
  /** Optional live external truth supplied by the workflow watcher. */
  ciState?: string;
  mergeStateStatus?: string;
  headRefOid?: string;
  reviewState?: string;
  ticket?: string;
  worktree?: string;
  prNumber?: number;
  prTitle?: string;
  started?: string;
  merged?: boolean;
  tipOnMain?: boolean;
  superseded?: boolean;
  pushPrNull?: boolean;
  landed?: boolean;
  pendingApprovals?: Array<{ nodeId?: string; status?: string }>;
  workflow?: string;
  status?: string;
  state?: string;
  step?: string;
  rootDir?: string;
  blockedNode?: string;
  waitingFor?: WaitingFor;
};
type ShipInput = {
  existingPr?: unknown;
  repo?: unknown;
  brief?: { title?: unknown; summary?: unknown };
  models?: {
    implementer?: unknown;
    reviewer?: unknown;
    watcher?: unknown;
    fallout?: unknown;
    familyOpposition?: unknown;
    oppositionDefaults?: unknown;
  };
  ticket?: unknown;
  worktree?: unknown;
};

type ShipIdentity = {
  repo: string | null;
  prNumber: number | null;
  prTitle: string | null;
  why: string | null;
  ticket: string | null;
  worktree: string | null;
  modelSeats: string | null;
};

function readShipInput(runId: string): ShipIdentity {
  try {
    const input = JSON.parse(
      fs.readFileSync(
        path.join(stateDir(), "ship", `${runId}.input.json`),
        "utf8",
      ),
    ) as ShipInput;
    return {
      repo: typeof input.repo === "string" ? input.repo : null,
      prNumber:
        typeof input.existingPr === "number" &&
        Number.isInteger(input.existingPr)
          ? input.existingPr
          : null,
      prTitle:
        typeof input.brief?.title === "string" ? input.brief.title : null,
      why:
        typeof input.brief?.summary === "string" ? input.brief.summary : null,
      ticket: typeof input.ticket === "string" ? input.ticket : null,
      worktree: typeof input.worktree === "string" ? input.worktree : null,
      modelSeats: (() => {
        const defaults = defaultModelPolicy();
        const models = input.models;
        const policy = {
          ...defaults,
          ...(typeof models?.implementer === "string"
            ? { implementer: models.implementer }
            : {}),
          ...(typeof models?.reviewer === "string"
            ? { reviewer: models.reviewer }
            : {}),
          ...(typeof models?.watcher === "string"
            ? { watcher: models.watcher }
            : {}),
          ...(typeof models?.fallout === "string"
            ? { fallout: models.fallout }
            : {}),
          ...(typeof models?.familyOpposition === "boolean"
            ? { familyOpposition: models.familyOpposition }
            : {}),
          oppositionDefaults: {
            ...defaults.oppositionDefaults,
            ...(models?.oppositionDefaults !== null &&
            typeof models?.oppositionDefaults === "object" &&
            !Array.isArray(models?.oppositionDefaults)
              ? Object.fromEntries(
                  Object.entries(models.oppositionDefaults).filter(
                    ([, value]) => typeof value === "string",
                  ),
                )
              : {}),
          },
        };
        return [
          `implement ${policy.implementer}`,
          `review ${resolveAdversary(policy.implementer, policy)}`,
          `watch ${policy.watcher}`,
          `fallout ${policy.fallout}`,
        ].join(" · ");
      })(),
    };
  } catch {
    return {
      repo: null,
      prNumber: null,
      prTitle: null,
      why: null,
      ticket: null,
      worktree: null,
      modelSeats: null,
    };
  }
}

function pipelinePhase(
  step: string | null | undefined,
  status: string | null | undefined,
): string | null {
  const value = (step ?? "").toLowerCase();
  if (value.includes("fallout") || value.includes("deploy")) return "deploy";
  if (value.includes("watch")) return "watch";
  if (value.includes("ready")) return "ready";
  if (/r\d+-stamp$/.test(value)) return "stamp";
  if (value.includes("review")) return "review";
  if (value.includes("implement")) return "implement";
  if (value.includes("migration")) return "migration";
  return value.length === 0 ? null : value;
}

export function waitingForFor(
  step: string | null | undefined,
  status: string | null | undefined,
): WaitingFor {
  const value = (step ?? "").toLowerCase();
  const runStatus = (status ?? "").toLowerCase();
  if (/r\d+-stamp$/.test(value)) return "stamp";
  if (value.includes("watch-poll")) return "ci-poll";
  if (value.includes("watch-fix")) return "fixing";
  if (value.includes("ready-poll")) return "ready-poll";
  if (value.includes("migration-gate")) return "migration";
  if (value.includes("landing-poll")) return "landing";
  if (value.includes("deploy-evidence")) return "deploy-evidence";
  if (value.includes("fallout-wait")) return "fallout-window";
  if (value.includes("escalation"))
    return `gate:${value.replace(/^r\d+-/, "")}`;
  if (runStatus === "waiting-approval") return "gate:approval";
  if (runStatus === "waiting-human") return "gate:human-review";
  return "none";
}

export function activityFor(
  step: string | null | undefined,
  status: string | null | undefined,
): FleetActivity {
  const value = (step ?? "").toLowerCase();
  const runStatus = (status ?? "").toLowerCase();
  if (["failed", "cancelled"].includes(runStatus)) return "failed";
  if (value.includes("watch-fix")) return "fixing";
  if (
    value.includes("poll") ||
    ["waiting-approval", "waiting-human", "paused"].includes(runStatus)
  )
    return "idle";
  return "working";
}

function prNumberFrom(value: string | null): number | null {
  if (value === null) return null;
  const match = /pull\/(\d+)(?:\/|$)|#(\d+)$/.exec(value.trim());
  const number = match?.[1] ?? match?.[2];
  return number === undefined ? null : Number(number);
}

function ageMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ago = /^(\d+)\s*(s|m|h|d) ago$/.exec(value.trim());
  if (ago?.[1] !== undefined && ago[2] !== undefined) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2]];
    return Number(ago[1]) * (unit ?? 1);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, Date.now() - timestamp);
}

function truncateTail(body: string, max: number): string {
  return body.length > max ? `…${body.slice(-(max - 1))}` : body;
}

function workflowRowActivity(wf: WorkflowRow): "wait" | FleetActivity {
  if (wf.activity === "failed" || wf.activity === "fixing") return wf.activity;
  const waiting = wf.waitingFor;
  return wf.activity === "idle" ||
    (waiting !== null && waiting !== undefined && waiting !== "none")
    ? "wait"
    : (wf.activity ?? "working");
}

function taskActivity(task: TaskRow): "active" | "waiting" | "none" {
  if (task.runState !== "running") return "none";
  if (task.lastVerb === "done" || task.lastVerb === "failed") return "none";
  return task.lastVerb === "blocked" ||
    task.lastVerb === "paused" ||
    task.lastVerb === "needs-decision"
    ? "waiting"
    : "active";
}

function workflowAttentionRank(wf: WorkflowRow): number {
  if (wf.waitingFor === "stamp" || wf.waitingFor?.startsWith("gate:")) return 0;
  if (wf.activity === "failed") return 1;
  if (wf.activity === "fixing") return 2;
  if (wf.activity === "idle") return 4;
  return 3;
}

/** smithers ps reports "no step" as an em-dash placeholder, not an absence. */
export function normalizeStep(step: string | null | undefined): string | null {
  if (step === undefined || step === null) return null;
  const trimmed = step.trim();
  return trimmed === "" || trimmed === "—" || trimmed === "-" ? null : trimmed;
}

/** Public read-only CLI only. Never the private db, never Gateway lifecycle. */
/** One cheap ps poll for the observer. Milestone observation enriches each row
 * with read-only `inspect` calls in observer.ts; this is deliberate because ps
 * does not expose node output, and the extension deduplicates concurrent polls. */
function isPsRun(value: unknown): value is PsRun {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (row.workflow === undefined || typeof row.workflow === "string") &&
    (row.status === undefined || typeof row.status === "string") &&
    (row.state === undefined || typeof row.state === "string") &&
    (row.step === undefined || typeof row.step === "string") &&
    (row.rootDir === undefined || typeof row.rootDir === "string")
  );
}

export async function collectPsSnapshot(
  cwd: string,
): Promise<{ runs: PsRun[]; health: SourceHealth }> {
  if (!fs.existsSync(cwd))
    return {
      runs: [],
      health: {
        name: "smithers",
        state: "skipped",
        detail: `no workspace at ${cwd} (run v2/install.sh)`,
      },
    };
  const baseUrl = process.env.SMITHERS_GATEWAY_URL ?? "http://127.0.0.1:7331";
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/v1/rpc/listRuns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.SMITHERS_GATEWAY_TOKEN
            ? { authorization: `Bearer ${process.env.SMITHERS_GATEWAY_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
    const frame = (await response.json()) as {
      ok?: boolean;
      payload?: unknown;
    };
    if (frame.ok !== true || !Array.isArray(frame.payload))
      throw new Error("invalid Gateway listRuns response");
    const runs = frame.payload.filter(isPsRun);
    return {
      runs,
      health: {
        name: "smithers-gateway",
        state: "ok",
        detail: `${runs.length} run(s)`,
      },
    };
  } catch (error) {
    return {
      runs: [],
      health: {
        name: "smithers-gateway",
        state: "missing",
        detail:
          error instanceof Error ? error.message : "Gateway request failed",
      },
    };
  }
}

const collectingRuns = new Map<
  string,
  Promise<{ runs: PsRun[]; health: SourceHealth }>
>();
export async function collectRuns(
  cwd: string,
): Promise<{ runs: PsRun[]; health: SourceHealth }> {
  const active = collectingRuns.get(cwd);
  if (active !== undefined) return active;
  const collection = collectPsSnapshot(cwd);
  collectingRuns.set(cwd, collection);
  try {
    return await collection;
  } finally {
    if (collectingRuns.get(cwd) === collection) collectingRuns.delete(cwd);
  }
}

type HerdrAgent = {
  agent?: string;
  agent_status?: string;
  pane_id?: string;
  foreground_cwd?: string;
};

/**
 * herdr, view-only. Correlation is on `foreground_cwd` == the task's worktree,
 * a unique exact absolute path — the same key fleet/ uses for Smithers rootDir.
 */
async function collectPanes(): Promise<{
  byWorktree: Map<string, string>;
  health: SourceHealth;
}> {
  const byWorktree = new Map<string, string>();
  try {
    const { stdout } = await run("herdr", ["agent", "list"], {
      timeout: 8_000,
    });
    const parsed: unknown = JSON.parse(stdout);
    const agents = ((parsed as { result?: { agents?: HerdrAgent[] } }).result
      ?.agents ?? []) as HerdrAgent[];
    for (const agent of agents) {
      if (agent.foreground_cwd !== undefined && agent.pane_id !== undefined) {
        byWorktree.set(agent.foreground_cwd, agent.pane_id);
      }
    }
    return {
      byWorktree,
      health: {
        name: "herdr",
        state: "ok",
        detail: `${agents.length} agent(s)`,
      },
    };
  } catch {
    // Headless is the default path, not a degraded one.
    return {
      byWorktree,
      health: {
        name: "herdr",
        state: "skipped",
        detail: "not running (headless is fine)",
      },
    };
  }
}

function questionForStamp(
  file: string,
  id: string,
): ReturnType<typeof readQuestionHistory>[number] | undefined {
  return readQuestionHistory(file).find(
    (question) => question.id === id || question.id === `deck-fleet:${id}`,
  );
}

function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function readMetaForWorktree(worktree: string): ReturnType<typeof readMeta> {
  for (const taskId of deckOwnedTasks()) {
    const meta = readMeta(taskId);
    if (meta?.worktree !== undefined && realpath(meta.worktree) === worktree) return meta;
  }
  return null;
}

function localTaskId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

function frameModelForTask(taskId: string, tasks: TaskRow[]): string | null {
  return tasks.find((task) => task.taskId === taskId)?.model ?? null;
}

export function effortLiveness(
  run: Pick<PsRun, "status" | "state" | "started" | "prNumber"> & {
    watchActive?: boolean;
  },
): "live" | "archived" {
  const status = (run.status ?? run.state ?? "").toLowerCase();
  if (
    ["running", "paused", "waiting-approval", "waiting-human"].includes(status)
  )
    return "live";
  if (run.prNumber !== undefined && run.watchActive === true) return "live";
  const started = run.started === undefined ? NaN : Date.parse(run.started);
  return ["finished", "succeeded", "completed", "complete", "done", "cancelled", "failed"].includes(status) ||
    (Number.isFinite(started) && Date.now() - started > 3 * 24 * 60 * 60 * 1000)
    ? "archived"
    : "live";
}
export function liveEffortCount(runs: readonly PsRun[]): number {
  return runs.filter((run) => effortLiveness(run) === "live").length;
}

export async function buildFrame(
  options: { workflowCwd?: string; psRuns?: PsRun[] } = {},
): Promise<FleetFrame> {
  const ids = [] as string[];
  const [{ runs, health: runHealth }, { byWorktree, health: paneHealth }] =
    await Promise.all([
      options.workflowCwd === undefined
        ? Promise.resolve({
            runs: options.psRuns ?? [],
            health: {
              name: "smithers-gateway",
              state: "skipped",
              detail: "no workflow dir configured",
            } as SourceHealth,
          })
        : options.psRuns === undefined
          ? collectRuns(options.workflowCwd)
          : Promise.resolve({
              runs: options.psRuns,
              health: {
                name: "smithers-gateway",
                state: "ok",
                detail: `${options.psRuns.length} run(s)`,
              } as SourceHealth,
            }),
      collectPanes(),
    ]);
  const taskByRoot = new Map<string, string>();
  const tasks: TaskRow[] = [];
  const taskIds = new Set<string>();
  for (const psRun of runs) {
    const input = readShipInput(psRun.id);
    const taskId = `run:${psRun.id}`;
    const rootDir = psRun.rootDir === undefined ? null : realpath(psRun.rootDir);
    const step = normalizeStep(psRun.step) ?? psRun.blockedNode ?? null;
    if (rootDir !== null) taskByRoot.set(rootDir, taskId);
    const meta = rootDir === null ? null : readMetaForWorktree(rootDir);
    const localId = meta?.id;
    const displayTaskId = localId !== undefined && !taskIds.has(localId) ? localId : taskId;
    taskIds.add(displayTaskId);
    tasks.push({
      taskId: displayTaskId,
      kind: input.kind ?? psRun.workflow ?? meta?.kind ?? "smithers",
      model: input.modelSeats ?? meta?.model ?? null,
      project: input.repo ?? meta?.project ?? null,
      runState: effortLiveness({ ...psRun, watchActive: step?.includes("watch") }) === "live" ? "running" : "finished",
      lastVerb: localId && localTaskId(localId) ? lastEvent(localId)?.verb ?? null : null,
      lastNote: localId && localTaskId(localId) ? lastEvent(localId)?.note ?? null : null,
      openDecisions: localId && localTaskId(localId) ? openDecisions(localId).size : 0,
      queuedMessages: localId && localTaskId(localId) ? pending(localId).length : 0,
      unresolvedSideEffects: localId && localTaskId(localId) ? unresolvedReceipts(localId).length : 0,
      pr: psRun.prNumber === undefined ? (meta?.pr ?? null) : String(psRun.prNumber),
      ticket: input.ticket,
      prNumber: psRun.prNumber ?? input.prNumber,
      prTitle: psRun.prTitle ?? input.prTitle,
      phase: pipelinePhase(step, psRun.status),
      waitingFor: waitingForFor(step, psRun.status),
      activity: activityFor(step, psRun.status),
      worktree: rootDir,
      runId: psRun.id,
      stage: step,
      pane: rootDir === null ? null : (byWorktree.get(rootDir) ?? null),
      statusAgeMs: ageMs(psRun.started),
    });
  }
  for (const taskId of deckOwnedTasks()) {
    if (taskIds.has(taskId)) continue;
    const meta = readMeta(taskId);
    const event = lastEvent(taskId);
    const worktree = meta?.worktree ? realpath(meta.worktree) : null;
    const pid = meta?.run_pid;
    tasks.push({
      taskId,
      kind: meta?.kind ?? "ship",
      model: meta?.model ?? null,
      project: meta?.project ?? null,
      runState: pid === undefined ? "none" : pidAlive(pid) ? "running" : "finished",
      lastVerb: event?.verb ?? null,
      lastNote: event?.note ?? null,
      openDecisions: openDecisions(taskId).size,
      queuedMessages: pending(taskId).length,
      unresolvedSideEffects: unresolvedReceipts(taskId).length,
      pr: meta?.pr ?? null,
      ticket: null,
      prNumber: prNumberFrom(meta?.pr ?? null),
      prTitle: null,
      phase: null,
      waitingFor: null,
      activity: undefined,
      worktree,
      runId: meta?.run_id ?? null,
      stage: null,
      pane: worktree === null ? null : (byWorktree.get(worktree) ?? null),
      statusAgeMs: null,
    });
  }

  const taskByRun = new Map(
    tasks.flatMap((task) =>
      task.runId === null ? [] : [[task.runId, task.taskId] as const],
    ),
  );
  const workflows: WorkflowRow[] = runs.map((psRun) => {
    const input = readShipInput(psRun.id);
    const step = normalizeStep(psRun.step) ?? psRun.blockedNode ?? null;
    return {
      runId: psRun.id,
      workflow: psRun.workflow ?? null,
      status: psRun.status ?? null,
      state: psRun.state ?? null,
      step,
      taskId:
        (psRun.rootDir !== undefined && psRun.rootDir.length > 0
          ? taskByRoot.get(realpath(psRun.rootDir))
          : undefined) ??
        taskByRun.get(psRun.id) ??
        null,
      ticket: input.ticket,
      prNumber: psRun.prNumber ?? input.prNumber,
      prTitle: psRun.prTitle ?? input.prTitle,
      repo: input.repo,
      rootDir: psRun.rootDir === undefined ? null : realpath(psRun.rootDir),
      existingPr: input.prNumber,
      merged: psRun.merged,
      tipOnMain: psRun.tipOnMain,
      superseded: psRun.superseded,
      pushPrNull: psRun.pushPrNull,
      landed: psRun.landed,
      phase: pipelinePhase(step, psRun.status),
      waitingFor: waitingForFor(step, psRun.status),
      activity: activityFor(step, psRun.status),
      waitAgeMs:
        waitingForFor(step, psRun.status) === "none"
          ? null
          : ageMs(psRun.started),
      startedAt: psRun.started ?? null,
    };
  });

  const internal = internalSummary();
  let questionsOpen = 0;
  try {
    questionsOpen = openQuestions(queueFile()).length;
  } catch {
    // an unreadable queue must not take the fleet view down with it
  }
  const liveRuns = [
    ...workflows.filter(
      (wf) =>
        !wf.superseded &&
        (!isTerminalWorkflow(wf) || isActionableWorkflowFailure(wf, workflows)),
    ),
  ].sort(
    (a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""),
  );
  const workflowIdentity = (wf: WorkflowRow): string =>
    wf.repo ?? wf.rootDir ?? "unknown-repo";
  const readOpenQuestions = (): ReturnType<typeof openQuestions> => {
    try {
      return openQuestions(queueFile());
    } catch {
      // The queue is optional. A broken queue must not break the fleet view.
      return [];
    }
  };
  const wfRunState = (
    wf: WorkflowRow,
    sourceRuns: PsRun[],
  ): PsRun | undefined => sourceRuns.find((source) => source.id === wf.runId);
  // Keep every live generation visible. A re-cut is a separate effort and can
  // have a different blocker even when it targets the same PR.
  const efforts: EffortRow[] = liveRuns.map((wf) => {
    const identity = `run:${wf.runId}`;
    const input = readShipInput(wf.runId);
    return {
      identity,
      workflow: wf.workflow,
      step: wf.step,
      runtimeMs: wf.startedAt ? ageMs(wf.startedAt) : null,
      ciState: wfRunState(wf, runs)?.ciState ?? null,
      mergeStateStatus: wfRunState(wf, runs)?.mergeStateStatus ?? null,
      headRefOid: wfRunState(wf, runs)?.headRefOid ?? null,
      reviewState: wfRunState(wf, runs)?.reviewState ?? null,
      model:
        input.modelSeats ??
        (wf.taskId ? frameModelForTask(wf.taskId, tasks) : null),
      prUrl:
        wf.repo && wf.prNumber
          ? `https://github.com/${wf.repo}/pull/${wf.prNumber}`
          : null,
      ticket: wf.ticket ?? null,
      prNumber: wf.prNumber ?? null,
      prTitle: wf.prTitle ?? null,
      runId: wf.runId,
      state: wf.state ?? wf.status,
      waitingFor:
        wf.waitingFor === "stamp" ? "stamp-question" : (wf.waitingFor ?? null),
      failed: wf.activity === "failed",
    };
  });
  for (const wf of liveRuns.filter((row) => row.waitingFor === "stamp")) {
    // Include the run so a later generation of the same PR gets a fresh
    // decision, while every render of this parked run uses one stable id.
    const input = readShipInput(wf.runId);
    const currentHead = efforts.find(
      (item) => item.runId === wf.runId,
    )?.headRefOid;
    if (
      currentHead === undefined ||
      currentHead === null ||
      currentHead === ""
    ) {
      try {
        const warningId = `stamp-head-unavailable:${wf.runId}`;
        if (
          readQuestionHistory(queueFile()).some(
            (question) => question.id === warningId,
          )
        )
          continue;
        askIfAbsent(queueFile(), {
          id: warningId,
          question: "Stamp is blocked: the PR head could not be verified.",
          questionKind: "agent",
          origin: "fleet",
          idScope: "global",
          deliverAnswer: false,
          options: ["Hold"],
          recommendation: "Restore GitHub access, then refresh the fleet view.",
          urgency: "high",
          sessionId: "deck-fleet",
          cwd: options.workflowCwd ?? process.cwd(),
        });
      } catch {
        /* A warning question must not break the fleet view. */
      }
      continue;
    }
    const id = `stamp:${wf.repo ?? wf.rootDir ?? "unknown"}:${wf.prNumber ?? input.prNumber ?? "unknown"}:stamp:${wf.runId}:${wf.step ?? "r0-stamp"}`;
    try {
      const existing = questionForStamp(queueFile(), id);
      if (existing !== undefined && existing.status === "answered") continue;
      const questionId =
        existing?.status === "dismissed"
          ? `stamp:v2:${id.slice("stamp:".length)}`
          : id;
      const nextExisting = questionForStamp(queueFile(), questionId);
      if (nextExisting !== undefined && nextExisting.status !== "answered")
        continue;
      {
        const effort = efforts.find((item) => item.runId === wf.runId);
        const repo = input.repo ?? workflowIdentity(wf);
        const pr = wf.prNumber ?? input.prNumber;
        const title = wf.prTitle ?? input.prTitle ?? "untitled PR";
        const prUrl =
          pr === null ? undefined : `https://github.com/${repo}/pull/${pr}`;
        const originalIssue =
          input.why ?? "No ship brief summary was recorded.";
        const reviewEvidence = `CI: ${effort?.ciState ?? "unknown"}; mergeStateStatus: ${effort?.mergeStateStatus ?? "unknown"}; review: ${effort?.reviewState ?? "unknown"}.`;
        ask(queueFile(), {
          id: questionId,
          questionKind: "stamp",
          origin: "fleet",
          question: `Stamp PR #${pr ?? "unknown"}: ${title}?`,
          context: wf.repo ?? wf.rootDir ?? undefined,
          prContext: {
            prUrl,
            prRepo: repo,
            prNumber: pr ?? undefined,
            headSha: currentHead ?? undefined,
            prTitle: title,
            originalIssue,
            ourFix:
              "The pipeline implemented the brief, ran adversarial review, and reached the stamp gate.",
            whyCorrect: `${reviewEvidence} Review history is recorded in the pipeline run history.`,
            ciState: effort?.ciState ?? "unknown",
            mergeStateStatus: effort?.mergeStateStatus ?? "unknown",
          },
          options: ["Stamp", "Hold", "Deny gate"],
          actions: ["stamp", "hold", "deny-gate"],
          deliverAnswer: false,
          recommendation: "Hold until reviewed.",
          urgency: "high",
          sessionId: "deck-fleet",
          cwd: wf.rootDir ?? process.cwd(),
        });
      }
    } catch {
      // Asking is best effort. A broken or unwritable queue must not break
      // this hot read path.
    }
  }
  questionsOpen = readOpenQuestions().length;
  const liveAgents = tasks.filter((task) => task.runState === "running");
  const agents: AgentRow[] = liveAgents.map((task) => ({
    id: task.taskId,
    model: task.model ?? null,
    status: `${task.lastVerb ?? "working"}: ${task.lastNote ?? ""}`.trim(),
    ageMs: task.statusAgeMs,
  }));
  const unhealedFailures = efforts.filter((effort) => effort.failed).length;
  return {
    generatedAt: new Date().toISOString(),
    tasks,
    workflows,
    efforts,
    agents,
    counters: {
      tasks: tasks.length,
      running: tasks.filter((task) => task.runState === "running").length,
      blocked: tasks.filter((task) => task.lastVerb === "blocked").length,
      openDecisions: tasks.reduce((sum, task) => sum + task.openDecisions, 0),
      queuedMessages: tasks.reduce((sum, task) => sum + task.queuedMessages, 0),
      openQuestions: questionsOpen,
      internalOpen: internal.open,
      internalCap: internal.cap,
      efforts: liveEffortCount(runs.map((run) => ({ ...run, watchActive: normalizeStep(run.step)?.includes("watch") }))),
      agents: liveSpawnCount(tasks),
      unhealedFailures,
    },
    sources: [
      runHealth,
      paneHealth,
      {
        name: "home",
        state: "ok",
        detail: `${stateDir()} (${tasks.length} task(s))`,
      },
    ],
  };
}

/** Plain-text frame. Used by the CLI and as the extension's non-TUI fallback. */
export function renderFrame(frame: FleetFrame): string {
  const lines: string[] = [];
  const c = frame.counters;
  const counts = workflowCounts(frame);
  const workflowFailures = actionableWorkflowFailures(frame).length;
  const stampWaits = liveStampWaits(frame).length;
  lines.push(
    `Fleet · ${c.tasks} task(s), ${counts.active} active · ${c.openDecisions} decision(s) · ${c.openQuestions} question(s) · ${c.queuedMessages} queued · ${workflowFailures} workflow failure(s) · ${stampWaits} stamp · internal ${c.internalOpen}/${c.internalCap}`,
  );
  if (frame.tasks.length === 0) {
    lines.push("  (no tasks)");
  }
  const visibleWorkflows = [...frame.workflows]
    .filter(
      (wf) =>
        !isTerminalWorkflow(wf) ||
        isActionableWorkflowFailure(wf, frame.workflows),
    )
    .sort((a, b) => workflowAttentionRank(a) - workflowAttentionRank(b));
  for (const wf of visibleWorkflows) {
    const identity = [
      wf.prNumber === null || wf.prNumber === undefined
        ? null
        : `PR #${wf.prNumber}`,
      wf.prTitle === null || wf.prTitle === undefined
        ? null
        : `"${wf.prTitle}"`,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" ");
    const fallback = [
      wf.workflow,
      wf.status,
      wf.step === null ? null : `@${wf.step}`,
      wf.taskId,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" · ");
    const details = [
      identity || fallback,
      wf.ticket === null || wf.ticket === undefined
        ? null
        : `ticket=${wf.ticket}`,
      wf.phase === null || wf.phase === undefined ? null : `phase=${wf.phase}`,
      wf.waitingFor === null || wf.waitingFor === undefined
        ? null
        : `waitingFor=${wf.waitingFor}`,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" · ");
    const rowActivity = workflowRowActivity(wf);
    lines.push(
      `▸ [${rowActivity}] ${wf.prNumber === null || wf.prNumber === undefined ? `wf:${truncateTail(wf.runId, 16)}` : `PR #${wf.prNumber}`}  ${details}`,
    );
  }
  for (const task of frame.tasks) {
    const mark =
      task.runState === "running"
        ? "●"
        : task.runState === "finished"
          ? "✓"
          : "○";
    const bits: string[] = [task.kind];
    if (task.project !== null) bits.push(task.project);
    if (task.stage !== null) bits.push(`@${task.stage}`);
    if (task.pr !== null) bits.push(`PR ${task.pr}`);
    if (task.pane !== null) bits.push(task.pane);
    lines.push(`${mark} ${task.taskId}  ${bits.join(" · ")}`);
    if (task.lastVerb !== null) {
      lines.push(`    ${task.lastVerb}: ${(task.lastNote ?? "").slice(0, 90)}`);
    }
    const flags: string[] = [];
    if (task.openDecisions > 0)
      flags.push(`${task.openDecisions} decision(s) open`);
    if (task.queuedMessages > 0)
      flags.push(`${task.queuedMessages} message(s) queued`);
    if (task.unresolvedSideEffects > 0) {
      flags.push(`${task.unresolvedSideEffects} UNRESOLVED side effect(s)`);
    }
    if (flags.length > 0) lines.push(`    ! ${flags.join(" · ")}`);
  }
  lines.push("");
  lines.push(
    `Sources  ${frame.sources
      .map((source) => `${source.name}=${source.state}`)
      .join("  ")}`,
  );
  return lines.join("\n");
}

/**
 * Full status is the diagnostic complement to factory: it includes terminal
 * workflow rows so a captain can see the state transition that removed work
 * from the live view. The normal fleet frame stays attention-first.
 */
export function renderDeltaStatus(
  frame: FleetFrame,
  previous?: FleetFrame | null,
): string {
  if (previous === undefined || previous === null)
    return `Delta · baseline · ${frame.counters.running} running · ${frame.counters.openQuestions} questions`;
  const delta = (now: number, before: number): string =>
    `${now - before >= 0 ? "+" : ""}${now - before}`;
  return `Delta · running ${delta(frame.counters.running, previous.counters.running)} · blocked ${delta(frame.counters.blocked, previous.counters.blocked)} · questions ${delta(frame.counters.openQuestions, previous.counters.openQuestions)} · queued ${delta(frame.counters.queuedMessages, previous.counters.queuedMessages)}`;
}

export function renderStatus(frame: FleetFrame): string {
  const lines = [
    `Status · ${frame.workflows.length} workflow row(s) · ${frame.tasks.length} task(s)`,
  ];
  for (const workflow of frame.workflows) {
    const identity =
      workflow.prNumber === null || workflow.prNumber === undefined
        ? `wf:${truncateTail(workflow.runId, 16)}`
        : `PR #${workflow.prNumber}`;
    const details = [
      workflow.state ?? workflow.status ?? "unknown",
      workflow.step === null ? null : `@${workflow.step}`,
      workflow.ticket === null || workflow.ticket === undefined
        ? null
        : `ticket=${workflow.ticket}`,
      workflow.waitingFor === null || workflow.waitingFor === undefined
        ? null
        : `waitingFor=${workflow.waitingFor}`,
    ]
      .filter((value): value is string => value !== null)
      .join(" · ");
    lines.push(`▸ ${identity}  ${details}`);
  }
  if (frame.workflows.length === 0) lines.push("  (no workflows)");
  return lines.join("\n");
}

// ---- themed overlay renderer ----------------------------------------------
//
// Pure text: the theme is injected as two functions, so these helpers run under
// bun tests with PLAIN_FLEET_THEME and inside pi with the real theme. The
// extension wraps this text in a pi-tui Box; nothing here imports pi-tui.

export interface FleetTheme {
  fg: (key: string, text: string) => string;
  bold: (text: string) => string;
}

export const PLAIN_FLEET_THEME: FleetTheme = {
  fg: (_key, text) => text,
  bold: (text) => text,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Printable width. ANSI-aware; fleet text carries no wide glyph classes. */
export function textWidth(line: string): number {
  return line.replace(ANSI_RE, "").length;
}

export type Chip = { label: string; color: string };

/**
 * One status chip per task. Severity order: a captain decision outranks a
 * blocked run, which outranks the fact that a process happens to be alive.
 */
export function chipFor(task: TaskRow): Chip {
  if (task.openDecisions > 0 || task.lastVerb === "needs-decision") {
    return { label: "decision", color: "warning" };
  }
  if (task.lastVerb === "blocked" || task.lastVerb === "failed") {
    return { label: task.lastVerb, color: "error" };
  }
  if (task.runState === "running")
    return { label: "running", color: "success" };
  if (task.lastVerb === "done") return { label: "done", color: "dim" };
  if (task.queuedMessages > 0) return { label: "queued", color: "accent" };
  return { label: "idle", color: "dim" };
}

/** "3h7m" / "12m" / "41s" — compact age, matching the usage overlay. */
export function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours}h${rest}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function truncate(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, Math.max(0, max - 1))}…` : body;
}

/**
 * Attention rank: lower renders first. A done task is terminal no matter what
 * else it carries — a stale queued message or open decision on finished work
 * must not resurrect it into the default view. Failed stays visible: the
 * captain hides only done.
 */
export function attentionRank(task: TaskRow): number {
  if (task.lastVerb === "done") return 7;
  if (task.openDecisions > 0 || task.lastVerb === "needs-decision") return 0;
  if (task.lastVerb === "blocked" || task.lastVerb === "failed") return 1;
  if (task.unresolvedSideEffects > 0) return 2;
  if (task.runState === "running") return 3;
  if (task.lastVerb === "paused") return 4;
  if (task.queuedMessages > 0) return 5;
  return 6;
}

/** Terminal workflow: finished one way or another. Unknown/null status stays visible. */
const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "succeeded",
  "finished",
  "done",
  "complete",
];

function workflowPrIds(wf: WorkflowRow): number[] {
  return [wf.existingPr, wf.prNumber].filter(
    (value): value is number => value !== null && value !== undefined,
  );
}

function workflowTicket(wf: WorkflowRow): string | null {
  return wf.ticket ?? null;
}

export function isTerminalWorkflow(wf: WorkflowRow): boolean {
  return (
    TERMINAL_STATUSES.includes((wf.status ?? "").toLowerCase()) ||
    TERMINAL_STATUSES.includes((wf.state ?? "").toLowerCase())
  );
}

/**
 * A failed terminal run is attention only while it can still change the
 * outcome. Workflow status can retain explicit landing/supersession evidence;
 * a newer healthy run for the same adopted PR or ticket is also enough.
 */
export function isActionableWorkflowFailure(
  wf: WorkflowRow,
  workflows: WorkflowRow[] = [],
): boolean {
  if (wf.activity !== "failed") return false;
  if (
    wf.merged === true ||
    wf.tipOnMain === true ||
    wf.superseded === true ||
    wf.pushPrNull === true ||
    wf.landed === true
  )
    return false;
  const failedPrIds = workflowPrIds(wf);
  const failedTicket = workflowTicket(wf);
  const newerHealthy = workflows.some((candidate) => {
    if (candidate.runId === wf.runId || candidate.activity === "failed")
      return false;
    if (
      wf.rootDir !== null &&
      wf.rootDir !== undefined &&
      candidate.rootDir !== null &&
      candidate.rootDir !== undefined &&
      wf.rootDir !== candidate.rootDir
    )
      return false;
    const samePr = failedPrIds.some((id) =>
      workflowPrIds(candidate).includes(id),
    );
    const sameTicket =
      failedTicket !== null && workflowTicket(candidate) === failedTicket;
    if (!samePr && !sameTicket) return false;
    if (
      wf.startedAt === null ||
      wf.startedAt === undefined ||
      candidate.startedAt === null ||
      candidate.startedAt === undefined
    )
      return false;
    const failedAt = Date.parse(wf.startedAt);
    const candidateAt = Date.parse(candidate.startedAt);
    if (!Number.isNaN(failedAt) && !Number.isNaN(candidateAt))
      return candidateAt > failedAt;
    const failedAge = ageMs(wf.startedAt);
    const candidateAge = ageMs(candidate.startedAt);
    return (
      failedAge !== null && candidateAge !== null && candidateAge < failedAge
    );
  });
  return !newerHealthy;
}

export function actionableWorkflowFailures(frame: FleetFrame): WorkflowRow[] {
  return frame.workflows.filter((wf) =>
    isActionableWorkflowFailure(wf, frame.workflows),
  );
}

function liveStampWaits(frame: FleetFrame): WorkflowRow[] {
  return frame.workflows.filter(
    (wf) => wf.waitingFor === "stamp" && !isTerminalWorkflow(wf),
  );
}

/** Attention-first order; terminal done/failed rows drop unless showAll. */
export function visibleTasks(
  tasks: TaskRow[],
  showAll: boolean,
): { shown: TaskRow[]; hidden: number } {
  const sorted = [...tasks].sort((a, b) => attentionRank(a) - attentionRank(b));
  if (showAll) return { shown: sorted, hidden: 0 };
  const shown = sorted.filter((task) => attentionRank(task) < 7);
  return { shown, hidden: sorted.length - shown.length };
}

/**
 * Wrap the body in a titled border so the overlay reads as a panel — the same
 * frame the usage overlay draws (deck-usage.ts framed()).
 */
export function framed(
  title: string,
  body: string,
  footer: string,
  theme: FleetTheme,
): string {
  const lines = body.split("\n");
  const inner =
    Math.max(textWidth(title) + 4, ...lines.map(textWidth), textWidth(footer)) +
    2;
  // borderAccent, not border: with the panel fill gone (terminal-default
  // background), the border IS the separator, so it must read clearly.
  const top =
    theme.fg("borderAccent", "╭─ ") +
    theme.bold(theme.fg("accent", title)) +
    theme.fg(
      "borderAccent",
      ` ${"─".repeat(Math.max(0, inner - textWidth(title) - 3))}╮`,
    );
  const bottom = theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`);
  const padded = lines.map((line) => {
    const pad = " ".repeat(Math.max(0, inner - textWidth(line) - 1));
    return `${theme.fg("borderAccent", "│")} ${line}${pad}${theme.fg("borderAccent", "│")}`;
  });
  return [top, ...padded, bottom, "", footer].join("\n");
}

/**
 * Pure scroll window: which slice of `lines` fits in `max` rows at `offset`.
 * Marker rows (above/below) are budgeted INSIDE max, so
 * visible.length + (above>0) + (below>0) <= max always holds. When the budget
 * is too small for a marker, its count is 0 and the hidden lines degrade
 * silently — the border staying on screen beats the hint. Returns the clamped
 * offset so callers can keep their scroll state in bounds.
 */
export function sliceVisible(
  lines: string[],
  offset: number,
  max: number,
): { visible: string[]; offset: number; above: number; below: number } {
  if (max >= lines.length)
    return { visible: lines, offset: 0, above: 0, below: 0 };
  // Furthest useful offset: the last line sits on the last row, with one
  // above-marker row reserved.
  const maxOffset = Math.max(0, lines.length - Math.max(1, max - 1));
  const off = Math.min(Math.max(0, offset), maxOffset);
  let above = off > 0 ? 1 : 0;
  let below = 0;
  let cap = max - above;
  if (off + Math.max(1, cap) < lines.length) below = 1;
  cap = max - above - below;
  // Tiny budgets: content wins over markers — drop below first, then above.
  if (cap < 1) {
    below = 0;
    cap = max - above;
  }
  if (cap < 1) {
    above = 0;
    cap = max;
  }
  const visible = lines.slice(off, off + cap);
  return {
    visible,
    offset: off,
    above: above === 0 ? 0 : off,
    below: below === 0 ? 0 : lines.length - off - visible.length,
  };
}

/**
 * The overlay's whole text plus scroll state: counters header, chip-per-task
 * rows, workflow rows, source health, key footer. Pure, so tests assert on it
 * directly. Returns the clamped scrollOffset so the caller's state cannot
 * drift past the end of the body.
 */
export function buildFleetView(
  frame: FleetFrame,
  theme: FleetTheme = PLAIN_FLEET_THEME,
  options: {
    showAll?: boolean;
    maxBodyLines?: number;
    scrollOffset?: number;
    maxRowWidth?: number;
    /** "frame" draws the unicode border (CLI); "bare" is plain text for callers
     * that supply their own chrome, like the extension's pi-tui Box. */
    chrome?: "frame" | "bare";
  } = {},
): { text: string; scrollOffset: number; scrollable: boolean } {
  const showAll = options.showAll ?? false;
  // Row budget: the caller passes the overlay's usable columns so wide
  // terminals show whole notes and PR URLs instead of a fixed 64-col clamp.
  const rowWidth = Math.max(80, Math.min(options.maxRowWidth ?? 110, 200));
  const noteMax = rowWidth - 24;
  const prMax = rowWidth - 16;
  const c = frame.counters;
  const counts = workflowCounts(frame);
  const lines: string[] = [];
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(frame.generatedAt)) / 1000),
  );
  const header = [
    `${theme.bold(String(counts.active))} active`,
    `as of ${ageSeconds}s ago`,
    `${c.tasks} task(s)`,
    c.blocked > 0 ? theme.fg("error", `${c.blocked} blocked`) : null,
    c.openDecisions > 0
      ? theme.fg("warning", `${c.openDecisions} decision(s)`)
      : null,
    c.openQuestions > 0
      ? theme.fg("warning", `${c.openQuestions} question(s) — /questions`)
      : null,
    c.queuedMessages > 0
      ? theme.fg("accent", `${c.queuedMessages} queued`)
      : null,
    `internal ${c.internalOpen}/${c.internalCap}`,
  ].filter((bit): bit is string => bit !== null);
  lines.push(header.join(theme.fg("dim", "  ·  ")));
  lines.push("");

  const sorted = [...frame.tasks].sort(
    (a, b) => attentionRank(a) - attentionRank(b),
  );
  const activeTasks = sorted.filter((task) => attentionRank(task) < 7);
  const doneTasks = sorted.filter((task) => attentionRank(task) >= 7);
  const activeWorkflows = frame.workflows
    .filter((wf) => !isTerminalWorkflow(wf) && !wf.superseded)
    .sort((a, b) => workflowAttentionRank(a) - workflowAttentionRank(b));
  const effortRows = frame.efforts ?? [];
  const failedWorkflows = actionableWorkflowFailures(frame);
  const doneWorkflows = frame.workflows.filter(
    (wf) =>
      isTerminalWorkflow(wf) &&
      (wf.activity !== "failed" ||
        !isActionableWorkflowFailure(wf, frame.workflows)),
  );

  const renderTask = (task: TaskRow): void => {
    const chip = chipFor(task);
    const age =
      task.statusAgeMs === null
        ? ""
        : theme.fg("dim", ` ${humanAge(task.statusAgeMs)}`);
    // Every dynamic field is clamped: the Text component word-wraps rather
    // than corrupting the TUI, but an unclamped URL or task id would still
    // wrap across the frame border and break the panel visually.
    const bits: string[] = [theme.fg("dim", task.kind)];
    if (task.project !== null)
      bits.push(theme.fg("text", truncate(task.project, 20)));
    if (task.stage !== null)
      bits.push(theme.fg("accent", `@${truncate(task.stage, 20)}`));
    if (task.pane !== null) bits.push(theme.fg("dim", truncate(task.pane, 12)));
    if (task.prNumber !== null && task.prNumber !== undefined)
      bits.push(theme.fg("accent", `PR #${task.prNumber}`));
    else if (task.ticket !== null && task.ticket !== undefined)
      bits.push(theme.fg("accent", task.ticket));
    lines.push(
      `${theme.fg(chip.color, `[${chip.label.padEnd(8)}]`)} ${theme.bold(truncate(task.taskId, 24).padEnd(24))}${bits.join(theme.fg("dim", " · "))}${age}`,
    );
    if (task.lastVerb !== null) {
      lines.push(
        `           ${theme.fg("dim", `${task.lastVerb}:`)} ${theme.fg("text", truncate(task.lastNote ?? "", noteMax))}`,
      );
    }
    const prNumber = task.prNumber ?? prNumberFrom(task.pr);
    if (
      prNumber !== null ||
      (task.prTitle !== null && task.prTitle !== undefined)
    ) {
      const label = [
        prNumber === null ? null : `PR #${prNumber}`,
        task.prTitle === null || task.prTitle === undefined
          ? null
          : `"${task.prTitle}"`,
      ]
        .filter((bit): bit is string => bit !== null)
        .join(" ");
      lines.push(`           ${theme.fg("accent", truncate(label, prMax))}`);
    }
    if (task.pr !== null && !/^\d+$/.test(task.pr))
      lines.push(`           ${theme.fg("accent", truncate(task.pr, prMax))}`);
    const flags: string[] = [];
    if (task.openDecisions > 0)
      flags.push(`${task.openDecisions} decision(s) open`);
    if (task.queuedMessages > 0)
      flags.push(`${task.queuedMessages} message(s) queued`);
    if (task.unresolvedSideEffects > 0)
      flags.push(`${task.unresolvedSideEffects} UNRESOLVED side effect(s)`);
    if (task.phase !== null && task.phase !== undefined)
      flags.push(`phase=${task.phase}`);
    if (task.waitingFor !== null && task.waitingFor !== undefined)
      flags.push(`waitingFor=${task.waitingFor}`);
    if (task.activity === "fixing") flags.push("fixing");
    if (flags.length > 0)
      lines.push(`           ${theme.fg("warning", `! ${flags.join(" · ")}`)}`);
  };
  const renderWorkflow = (wf: WorkflowRow): void => {
    const legacy = [
      wf.workflow,
      wf.status,
      wf.step === null ? null : `@${wf.step}`,
      wf.taskId,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" · ");
    const enriched =
      (wf.prNumber !== null && wf.prNumber !== undefined) ||
      (wf.prTitle !== null && wf.prTitle !== undefined) ||
      (wf.phase !== null && wf.phase !== undefined) ||
      (wf.waitingFor !== null && wf.waitingFor !== undefined);
    const details = [
      wf.activity === "failed" ? (wf.state ?? wf.status ?? "failed") : null,
      wf.prNumber === null || wf.prNumber === undefined
        ? null
        : `PR #${wf.prNumber}`,
      wf.prTitle === null || wf.prTitle === undefined
        ? null
        : `"${truncate(wf.prTitle, 20)}"`,
      wf.phase === null || wf.phase === undefined ? null : `phase=${wf.phase}`,
      wf.waitingFor === null || wf.waitingFor === undefined
        ? null
        : `waitingFor=${wf.waitingFor}`,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" · ");
    const content = enriched ? details : legacy;
    const compact = [
      wf.activity === "failed" ? (wf.state ?? wf.status ?? "failed") : null,
      wf.prNumber === null || wf.prNumber === undefined
        ? null
        : `PR #${wf.prNumber}`,
      wf.prTitle === null || wf.prTitle === undefined
        ? null
        : `"${truncate(wf.prTitle, 14)}"`,
      wf.ticket === null || wf.ticket === undefined
        ? null
        : `ticket=${wf.ticket}`,
      wf.phase === null || wf.phase === undefined ? null : `phase=${wf.phase}`,
    ]
      .filter((bit): bit is string => bit !== null)
      .join(" · ");
    const action =
      wf.waitingFor === null || wf.waitingFor === undefined
        ? null
        : `waitingFor=${wf.waitingFor}`;
    const rowActivity = workflowRowActivity(wf);
    lines.push(
      `  ${theme.fg(wf.activity === "fixing" || wf.activity === "failed" ? "warning" : "accent", `[${rowActivity}]`)} ${theme.fg("accent", wf.prNumber === null || wf.prNumber === undefined ? `wf:${truncateTail(wf.runId, 16)}` : `PR #${wf.prNumber}`)}  ${theme.fg("text", truncate(action === null ? content : compact, Math.max(1, noteMax - 12)))}${action === null ? "" : ` ${theme.fg("warning", action)}${wf.waitAgeMs === null || wf.waitAgeMs === undefined ? "" : theme.fg("dim", ` ${humanAge(wf.waitAgeMs)}`)}`}`,
    );
  };

  if (frame.tasks.length === 0) lines.push(theme.fg("dim", "  (no tasks)"));
  for (const task of activeTasks) renderTask(task);
  if (effortRows.length > 0) {
    lines.push("");
    lines.push(theme.bold(theme.fg("toolTitle", "efforts")));
    for (const effort of effortRows) {
      const label =
        effort.prNumber === null
          ? (effort.ticket ?? effort.identity)
          : `PR #${effort.prNumber}`;
      const blocker =
        effort.waitingFor === null ? "" : ` waitingFor=${effort.waitingFor}`;
      lines.push(
        `  ${theme.fg(effort.failed ? "warning" : "accent", `[${effort.failed ? "failed" : "active"}]`)} ${theme.fg("text", truncate(`${label}${blocker}`, Math.max(1, noteMax)))}`,
      );
    }
  }
  if (activeWorkflows.length > 0 || (!showAll && failedWorkflows.length > 0)) {
    lines.push("");
    lines.push(theme.bold(theme.fg("toolTitle", "workflows")));
    for (const wf of [...activeWorkflows, ...(!showAll ? failedWorkflows : [])])
      renderWorkflow(wf);
  }

  const terminal = doneTasks.length + doneWorkflows.length;
  if (terminal > 0 && !showAll) {
    lines.push(
      theme.fg("dim", `  ${terminal} done/failed hidden — [a] shows all`),
    );
  } else if (terminal > 0) {
    for (const task of doneTasks) renderTask(task);
    if (doneWorkflows.length > 0) {
      lines.push("");
      lines.push(theme.bold(theme.fg("toolTitle", "finished workflows")));
      for (const wf of doneWorkflows) renderWorkflow(wf);
    }
  }

  lines.push("");
  lines.push(
    frame.sources
      .map((source) =>
        theme.fg(
          source.state === "ok"
            ? "success"
            : source.state === "missing"
              ? "error"
              : "dim",
          `${source.name}=${source.state}`,
        ),
      )
      .join("  "),
  );

  // Clamp the body so the framed panel never draws taller than the viewport:
  // the border must close on screen, not below it. sliceVisible windows the
  // body at scrollOffset and reserves rows for the above/below markers.
  let body = lines;
  let scrollOffset = 0;
  let scrollable = false;
  if (
    options.maxBodyLines !== undefined &&
    body.length > options.maxBodyLines
  ) {
    scrollable = true;
    const win = sliceVisible(
      lines,
      options.scrollOffset ?? 0,
      options.maxBodyLines,
    );
    scrollOffset = win.offset;
    body = [
      ...(win.above > 0
        ? [theme.fg("dim", `  … +${win.above} line(s) above`)]
        : []),
      ...win.visible,
      ...(win.below > 0
        ? [theme.fg("dim", `  … +${win.below} more line(s)`)]
        : []),
    ];
  }

  const scrollHint = scrollable
    ? `${theme.fg("accent", "[j/k]")} ${theme.fg("dim", "scroll")}   `
    : "";
  const footer = `${theme.fg("accent", "[q/Esc]")} ${theme.fg("dim", "close")}   ${theme.fg("accent", "[r]")} ${theme.fg("dim", "refresh")}   ${theme.fg("accent", "[a]")} ${theme.fg("dim", showAll ? "attention only" : "show all")}   ${scrollHint}${theme.fg("dim", "live · refreshes every 5s")}`;
  if ((options.chrome ?? "frame") === "bare") {
    // The caller draws the panel (pi-tui Box); double chrome garbles the TUI.
    const title = theme.bold(theme.fg("accent", "deck fleet"));
    return {
      text: [title, "", ...body, "", footer].join("\n"),
      scrollOffset,
      scrollable,
    };
  }
  return {
    text: framed("deck fleet", body.join("\n"), footer, theme),
    scrollOffset,
    scrollable,
  };
}

export type FactoryViewOptions = {
  maxBodyLines?: number;
  scrollOffset?: number;
  maxRowWidth?: number;
  chrome?: "frame" | "bare";
};

function factoryRows(
  frame: FleetFrame,
): Array<{ effort: EffortRow; workflow: WorkflowRow }> {
  const workflows = new Map(
    frame.workflows.map((workflow) => [workflow.runId, workflow]),
  );
  const rows = (frame.efforts ?? []).flatMap((effort) => {
    const workflow = workflows.get(effort.runId);
    return workflow === undefined ||
      workflow.superseded ||
      (effortLiveness({ status: workflow.status, state: workflow.state }) === "archived" &&
        !isActionableWorkflowFailure(workflow, frame.workflows)) ||
      (effortLiveness({ status: effort.state }) === "archived" &&
        !isActionableWorkflowFailure(workflow, frame.workflows)) ||
      (isTerminalWorkflow(workflow) &&
        !isActionableWorkflowFailure(workflow, frame.workflows))
      ? []
      : [{ effort, workflow }];
  });
  const represented = new Set(rows.map(({ workflow }) => workflow.runId));
  for (const task of frame.tasks) {
    const terminal = ["done", "cancelled"].includes(task.lastVerb ?? "");
    const gatewayTerminal = task.runId !== null && isTerminalWorkflow(frame.workflows.find((wf) => wf.runId === task.runId) ?? { runId: "", workflow: null, status: null, state: null, step: null, taskId: null });
    const actionableFailure =
      task.lastVerb === "failed" &&
      (task.openDecisions > 0 ||
        task.queuedMessages > 0 ||
        task.unresolvedSideEffects > 0 ||
        task.waitingFor !== null ||
        task.lastNote !== null);
    if (
      terminal ||
      gatewayTerminal ||
      (task.lastVerb === "failed" && !actionableFailure) ||
      ((task.runId !== null && represented.has(task.runId)) ||
        represented.has(task.taskId.startsWith("run:") ? task.taskId.slice(4) : ""))
    )
      continue;
    const runId = task.runId ?? `task:${task.taskId}`;
    const wakeReason = task.waitingFor ?? task.lastNote ?? task.lastVerb;
    const workflow: WorkflowRow = {
      runId,
      workflow: null,
      status: task.lastVerb,
      state: task.runState,
      step: task.stage,
      taskId: task.taskId,
      ticket: task.ticket,
      prNumber: task.prNumber,
      prTitle: task.prTitle,
      phase: task.phase,
      waitingFor: wakeReason as WaitingFor,
      activity: task.activity,
      startedAt: null,
    };
    rows.push({
      effort: {
        identity: task.taskId,
        ticket: task.ticket ?? null,
        prNumber: task.prNumber ?? null,
        prTitle: task.prTitle ?? null,
        runId,
        state: task.runState,
        waitingFor: wakeReason,
        failed: task.lastVerb === "failed",
        workflow: task.kind,
        step: task.stage,
        runtimeMs: task.statusAgeMs,
        model: task.model ?? null,
      },
      workflow,
    });
  }
  return rows;
}

function factoryState(
  workflow: WorkflowRow,
): "STAMPABLE" | "IMPLEMENTING" | "WATCHING" {
  if (workflow.waitingFor === "stamp") return "STAMPABLE";
  if (workflow.activity === "fixing" || workflow.phase === "implement")
    return "IMPLEMENTING";
  return "WATCHING";
}

/**
 * Captain's one-pane factory view. Completed, cancelled, and superseded work is
 * omitted. Failed work stays visible when it still requires recovery.
 */
export function buildFactoryView(
  frame: FleetFrame,
  theme: FleetTheme = PLAIN_FLEET_THEME,
  options: FactoryViewOptions = {},
): { text: string; scrollOffset: number; scrollable: boolean } {
  const rowWidth = Math.max(40, Math.min(options.maxRowWidth ?? 110, 200));
  const rows = factoryRows(frame);
  const sections: Record<
    ReturnType<typeof factoryState>,
    Array<{ effort: EffortRow; workflow: WorkflowRow }>
  > = {
    STAMPABLE: [],
    WATCHING: [],
    IMPLEMENTING: [],
  };
  for (const row of rows) sections[factoryState(row.workflow)].push(row);

  const lines = [
    `${theme.bold(theme.fg("accent", "deck factory"))}  ${rows.length} live effort(s) · ${frame.counters.openQuestions} question(s)`,
  ];
  for (const state of ["STAMPABLE", "WATCHING", "IMPLEMENTING"] as const) {
    const entries = sections[state];
    if (entries.length === 0) continue;
    lines.push(
      "",
      theme.bold(
        theme.fg(
          state === "STAMPABLE"
            ? "success"
            : state === "WATCHING"
              ? "accent"
              : "warning",
          `${state} (${entries.length})`,
        ),
      ),
    );
    for (const { effort, workflow } of entries) {
      const identity =
        effort.prUrl ??
        (effort.prNumber === null
          ? (effort.ticket ?? `run:${truncateTail(effort.runId, 12)}`)
          : `PR #${effort.prNumber}`);
      const details = [
        workflow.step ?? "step ?",
        effort.runtimeMs === null || effort.runtimeMs === undefined
          ? "runtime ?"
          : humanAge(effort.runtimeMs),
        effort.waitingFor === null ? null : `waiting ${effort.waitingFor}`,
        `CI ${effort.ciState ?? "unknown"}`,
        `review ${effort.reviewState ?? "unknown"}`,
        `model ${effort.model ?? "?"}`,
      ]
        .filter((value): value is string => value !== null)
        .join(" · ");
      lines.push(`  ${truncate(identity, rowWidth)}`);
      lines.push(`    ${truncate(details, rowWidth - 4)}`);
    }
  }
  if (rows.length === 0)
    lines.push("", theme.fg("dim", "No live efforts. The factory is quiet."));

  let body = lines;
  let scrollOffset = 0;
  let scrollable = false;
  if (
    options.maxBodyLines !== undefined &&
    body.length > options.maxBodyLines
  ) {
    scrollable = true;
    const visible = sliceVisible(
      body,
      options.scrollOffset ?? 0,
      options.maxBodyLines,
    );
    scrollOffset = visible.offset;
    body = [
      ...(visible.above > 0
        ? [theme.fg("dim", `  … +${visible.above} line(s) above`)]
        : []),
      ...visible.visible,
      ...(visible.below > 0
        ? [theme.fg("dim", `  … +${visible.below} more line(s)`)]
        : []),
    ];
  }
  const scrollHint = scrollable
    ? `${theme.fg("accent", "[j/k]")} ${theme.fg("dim", "scroll")}   `
    : "";
  const footer = `${theme.fg("accent", "[q/Esc]")} ${theme.fg("dim", "close")}   ${theme.fg("accent", "[r]")} ${theme.fg("dim", "refresh")}   ${scrollHint}${theme.fg("dim", "live · refreshes every 5s")}`;
  if ((options.chrome ?? "frame") === "bare") {
    return { text: [...body, "", footer].join("\n"), scrollOffset, scrollable };
  }
  return {
    text: framed("deck factory", body.join("\n"), footer, theme),
    scrollOffset,
    scrollable,
  };
}

export function buildFactoryText(
  frame: FleetFrame,
  theme: FleetTheme = PLAIN_FLEET_THEME,
  options: FactoryViewOptions = {},
): string {
  return buildFactoryView(frame, theme, options).text;
}

export function buildUsageText(
  roster: import("./usage-roster").UsageRoster | null,
  theme: FleetTheme = PLAIN_FLEET_THEME,
): string {
  if (roster === null) return "deck usage\n\nNo broker roster available.";
  const age = roster.generatedAt
    ? Math.max(
        0,
        Math.round((Date.now() - Date.parse(roster.generatedAt)) / 1000),
      )
    : null;
  const lines = [
    theme.bold(theme.fg("accent", "deck usage")),
    ...(age === null ? [] : [theme.fg("dim", `as of ${age}s ago`)]),
  ];
  for (const account of roster.accounts ?? []) {
    if (account.status === "not logged in")
      lines.push("", `${account.provider ?? "?"} · not logged in`);
    else if (account.status === "no usage API")
      lines.push(
        "",
        `${account.email ?? account.accountId ?? account.provider ?? "unknown account"} · ${account.provider ?? "?"}: no usage API`,
      );
  }
  for (const report of roster.reports ?? []) {
    const identity =
      report.metadata?.email ??
      report.metadata?.accountId ??
      report.metadata?.account;
    const account = (roster.accounts ?? []).find(
      (candidate) =>
        candidate.email === identity ||
        candidate.accountId === identity ||
        candidate.provider === report.provider,
    );
    const label = identity ?? "unknown account";
    lines.push("", `${label} · ${report.provider ?? "?"}`);
    for (const limit of report.limits ?? []) {
      const free =
        limit.amount?.remainingFraction ??
        (limit.amount?.usedFraction === undefined
          ? null
          : 1 - limit.amount.usedFraction);
      const value =
        free === null || !Number.isFinite(free)
          ? "?"
          : `${Math.round(Math.max(0, Math.min(1, free)) * 100)}% free`;
      const tier =
        typeof limit.scope?.tier === "string"
          ? ` · tier ${limit.scope.tier}`
          : "";
      const blocks = report.blocks ?? [];
      const cooling =
        report.metadata?.cooling === true ||
        report.metadata?.blocked === true ||
        limit.status === "exhausted" ||
        blocks.some(
          (block) =>
            typeof block.blockedUntilMs === "number" &&
            block.blockedUntilMs > Date.now(),
        ) ||
        (account?.blocks ?? []).some(
          (block) =>
            typeof block.blockedUntilMs === "number" &&
            block.blockedUntilMs > Date.now(),
        );
      const temperature = cooling ? " · cooling" : " · warm";
      lines.push(
        `  ${limit.window?.id ?? limit.label ?? limit.id ?? "limit"}${tier}: ${value}${temperature}`,
      );
    }
  }
  // Dead accounts have no usage report at all — without this block they simply
  // disappear from the roster and their missing quota looks like bad luck.
  for (const dead of roster.dead ?? []) {
    const label =
      dead.email ?? dead.accountId ?? `credential ${dead.id ?? "?"}`;
    lines.push(
      "",
      theme.fg("error", `REAUTH NEEDED: ${label} · ${dead.provider ?? "?"}`),
    );
    lines.push(`  auth dead: ${dead.cause ?? "oauth refresh failed"}`);
  }
  return lines.join("\n");
}

/** Text-only convenience over buildFleetView. */
export function buildFleetText(
  frame: FleetFrame,
  theme: FleetTheme = PLAIN_FLEET_THEME,
  options: Parameters<typeof buildFleetView>[2] = {},
): string {
  return buildFleetView(frame, theme, options).text;
}

/**
 * Compact statusline. Costs no turn; the captain glances instead of being told.
 * Zero counts are noise, not signal: `0▶` reads as a broken glyph, so a quiet
 * fleet says `idle` and only live signals (running, blocked, questions,
 * decisions, queued) earn a segment. No total task count — the graveyard is
 * not a signal. Task-scoped counts (decisions, queued) come from live tasks
 * only, so stale leftovers on done work stay silent; questions are global.
 * Failed gets its own segment: visible in the overlay must mean visible here.
 */
export type FooterSessionBits = {
  cwd?: string;
  branch?: string | null;
  model?: string | null;
  contextPercent?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  usageLine?: string;
};

function compactNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function compactCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return "cwd?";
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home !== undefined && (cwd === home || cwd.startsWith(`${home}/`))
    ? `~${cwd.slice(home.length)}`
    : cwd;
}

function footerIdentity(bits: FooterSessionBits): string {
  const context =
    bits.contextPercent === null || bits.contextPercent === undefined
      ? "ctx?"
      : `ctx${Math.round(bits.contextPercent)}%`;
  const input = bits.inputTokens ?? 0;
  const cacheRead = bits.cacheReadTokens ?? 0;
  const cacheTotal = input + cacheRead;
  const cacheHit =
    cacheTotal > 0 ? ` CH${Math.round((cacheRead / cacheTotal) * 100)}%` : "";
  const cache = `R${compactNumber(bits.cacheReadTokens)} W${compactNumber(bits.cacheWriteTokens)}${cacheHit}`;
  const cost = `$${(bits.cost ?? 0).toFixed(2)}`;
  return [
    compactCwd(bits.cwd),
    bits.branch === null || bits.branch === undefined ? null : bits.branch,
    bits.model ?? "no-model",
    context,
    `↑${compactNumber(bits.inputTokens)} ↓${compactNumber(bits.outputTokens)}`,
    cache,
    cost,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
}

function workflowCounts(frame: FleetFrame): {
  active: number;
  waiting: number;
} {
  const correlatedTasks = new Set(
    frame.workflows
      .filter((wf) => !isTerminalWorkflow(wf) && wf.taskId !== null)
      .map((wf) => wf.taskId),
  );
  const active =
    frame.workflows.filter(
      (wf) => !isTerminalWorkflow(wf) && workflowRowActivity(wf) !== "wait",
    ).length +
    frame.tasks.filter(
      (task) =>
        !correlatedTasks.has(task.taskId) && taskActivity(task) === "active",
    ).length;
  const waiting =
    frame.workflows.filter(
      (wf) => !isTerminalWorkflow(wf) && workflowRowActivity(wf) === "wait",
    ).length +
    frame.tasks.filter(
      (task) =>
        !correlatedTasks.has(task.taskId) && taskActivity(task) === "waiting",
    ).length;
  return { active, waiting };
}

/** Exactly three width-safe lines for pi's custom footer. */
export function renderFooterLines(
  frame: FleetFrame,
  bits: FooterSessionBits = {},
  theme: FleetTheme = PLAIN_FLEET_THEME,
  width = 120,
): string[] {
  const attention = [
    `Nq ${frame.counters.openQuestions}`,
    `${frame.efforts === undefined ? frame.counters.efforts ?? 0 : frame.efforts.filter((effort) => effortLiveness({ status: effort.state }) === "live").length} efforts`,
    `${frame.counters.agents ?? frame.agents?.length ?? 0} agents`,
    (frame.counters.unhealedFailures ??
      frame.efforts?.filter((effort) => effort.failed).length ??
      0) > 0
      ? `fail ${frame.counters.unhealedFailures ?? frame.efforts?.filter((effort) => effort.failed).length ?? 0}`
      : null,
  ].filter((value): value is string => value !== null);
  const lines = [
    footerIdentity(bits),
    bits.usageLine ?? "",
    attention.join(" · "),
  ];
  return lines.map((line, index) => {
    const colored = theme.fg(index === 2 ? "warning" : "dim", line);
    return truncateToWidth(colored, Math.max(1, width));
  });
}
