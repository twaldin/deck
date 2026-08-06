import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";
import { openQuestions } from "../../../v2/src/questions-store.ts";
import { routeWorkflowQuestionAnswer } from "../../../v2/src/workflow-questions.ts";
import { reviewCommand, shouldSubmitReview } from "../decision.ts";
import workflow, { assessCi, createReviewGateAgent, queueReviewGateDecision, reviewSubmissionMarker } from "../pipeline.tsx";
import { PrimeSeatAgent } from "../../pr-pipeline/lib/engines/prime.ts";
import { DECK_PROVIDER } from "../../pr-pipeline/lib/models.ts";
import {
  ensureReviewGatePoller,
  LIVE_SMITHERS_WORKSPACE,
  parseCronEntries,
  parseRuns,
  reviewGateLauncher,
  summarizeRunCounts,
  type SmithersRunner,
} from "../launch.ts";

const source = readFileSync(new URL("../pipeline.tsx", import.meta.url), "utf8");
const launcherSource = readFileSync(new URL("../launch.ts", import.meta.url), "utf8");

test("parses legacy cron rows so the ensure-only launcher can remove all of them", () => {
  expect(parseCronEntries('{"crons":[{"cronId":"one","workflowPath":"review-gate/pipeline.tsx"}]}')).toEqual([
    { cronId: "one", workflowPath: "review-gate/pipeline.tsx" },
  ]);
  expect(parseCronEntries('[{"id":"two","workflow":"review-gate/pipeline.tsx"}]')).toEqual([
    { id: "two", workflow: "review-gate/pipeline.tsx" },
  ]);
});

test("rejects an unexpected cron list shape", () => {
  expect(() => parseCronEntries('{"crons":{}}')).toThrow("unexpected JSON shape");
});

test("a healthy durable poller is ensure-only and legacy cron rows are removed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-gate-workspace-"));
  mkdirSync(join(workspace, ".smithers", "workflows"), { recursive: true });
  writeFileSync(join(workspace, ".smithers", "smithers.toon"), "post-failure\n");
  writeFileSync(join(workspace, ".smithers", "workflows", "post-failure.tsx"), "stale\n");
  const calls: string[][] = [];
  const runner: SmithersRunner = (args) => {
    calls.push(args);
    if (args[0] === "cron" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify({
          crons: [
            { cronId: "duplicate-a", workflowPath: "review-gate/pipeline.tsx" },
            { cronId: "duplicate-b", workflowPath: "/old/deck/workflows/review-gate/pipeline.tsx" },
          ],
        }),
        stderr: "",
      };
    }
    if (args[0] === "cron" && args[1] === "rm") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "cancel") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "gateway" && args[1] === "status") {
      return { status: 0, stdout: JSON.stringify({ running: true, workspace }), stderr: "" };
    }
    if (args[0] === "ps") {
      const status = args[2];
      return {
        status: 0,
        stdout: JSON.stringify({
          runs: status === "running"
            ? [{ id: "poller", workflow: "lindy-review-gate", status }]
            : status === "waiting-approval"
              ? [{ id: "autopsy", workflow: "post-failure", status }]
              : status === "waiting-timer"
                ? [{ id: "duplicate-poller", workflow: "lindy-review-gate", status }]
                : [],
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected smithers invocation: ${args.join(" ")}`);
  };

  expect(ensureReviewGatePoller({ workspace, runner })).toEqual({
    started: false,
    runId: "poller",
    removedLegacyCrons: 2,
    cancelledDuplicatePollers: 1,
    cancelledPostFailureRuns: 1,
    removedStalePostFailureWorkflow: true,
    updatedInstalledManifest: true,
  });
  expect(calls.filter((args) => args[0] === "cron" && args[1] === "rm")).toHaveLength(2);
  expect(calls.filter((args) => args[0] === "cancel")).toEqual([
    ["cancel", "autopsy"],
    ["cancel", "duplicate-poller"],
  ]);
  expect(calls.filter((args) => args[0] === "ps").map((args) => args[2])).toEqual([
    "running",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
  ]);
  expect(calls.some((args) => args[0] === "cron" && args[1] === "add")).toBe(false);
  expect(calls.some((args) => args[0] === "up")).toBe(false);
});

test("an unhealthy workspace launches one poller from the live Smithers workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-gate-workspace-"));
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: SmithersRunner = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "cron") return { status: 0, stdout: JSON.stringify({ crons: [] }), stderr: "" };
    if (args[0] === "cancel") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "gateway") return { status: 0, stdout: JSON.stringify({ running: true, workspace }), stderr: "" };
    if (args[0] === "ps") return { status: 0, stdout: JSON.stringify({ runs: [] }), stderr: "" };
    if (args[0] === "up") return { status: 0, stdout: JSON.stringify({ runId: "new-poller" }), stderr: "" };
    throw new Error(`unexpected smithers invocation: ${args.join(" ")}`);
  };

  expect(ensureReviewGatePoller({ workspace, runner })).toEqual({
    started: true,
    runId: "new-poller",
    removedLegacyCrons: 0,
    cancelledDuplicatePollers: 0,
    cancelledPostFailureRuns: 0,
    removedStalePostFailureWorkflow: false,
    updatedInstalledManifest: true,
  });
  const launches = calls.filter(({ args }) => args[0] === "up");
  expect(launches).toHaveLength(1);
  expect(launches[0]?.cwd).toBe(workspace);
  expect(launches[0]?.args[1]).toBe(reviewGateLauncher.workflow);
  expect(launches[0]?.args).toContain("--no-post-failure");
});
test("the production launcher uses the configured Deck home instead of opening Smithers through a database shortcut", () => {
  expect(LIVE_SMITHERS_WORKSPACE).toBe(
    process.env.DECK_SMITHERS_WORKSPACE ??
      join(process.env.DECK_V2_HOME ?? join(homedir(), ".deck"), "state", "smithers"),
  );
});

test("the production launcher uses public Smithers commands instead of opening its database", () => {
  expect(launcherSource).not.toMatch(/sqlite|smithers\.db|openSmithersStore|findAndOpenDb/);
  expect(launcherSource).toContain('["cron", "list", "--format", "json"]');
  expect(launcherSource).toContain('["ps", "--status", status, "--limit", "10000", "--format", "json"]');
  expect(launcherSource).not.toContain('["cron", "add"');
  expect(launcherSource).not.toContain('spawn("smithers", ["gateway"');
});

test("run-count evidence distinguishes the old per-poll explosion from one active poller", () => {
  const before = parseRuns(JSON.stringify({
    runs: [
      { id: "poll-1", workflow: "lindy-review-gate", status: "finished", dbStatus: "continued" },
      { id: "poll-2", workflow: "lindy-review-gate", status: "finished", dbStatus: "continued" },
      { id: "poll-3", workflow: "lindy-review-gate", status: "failed" },
      { id: "autopsy", workflow: "post-failure", status: "waiting-approval" },
    ],
  }));
  const after = parseRuns(JSON.stringify({
    runs: [{ id: "poller", workflow: "lindy-review-gate", status: "waiting-timer" }],
  }));

  expect(summarizeRunCounts(before)).toEqual({ reviewGate: 3, activeReviewGate: 0, continuedReviewGate: 2, postFailure: 1 });
  expect(summarizeRunCounts(after)).toEqual({ reviewGate: 1, activeReviewGate: 1, continuedReviewGate: 0, postFailure: 0 });
});

test("review-gate queues one Smithers approval and closes it only after Gateway accepts it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
  const file = join(dir, "queue.jsonl");
  const request = {
    runId: "run-review-gate",
    repo: "owner/repo",
    worktree: dir,
    pr: { number: 7, url: "https://github.test/owner/repo/pull/7", title: "Prime gate", headRefOid: "head-7" },
    headSha: "head-7",
    originalIssue: "Review PR 7.",
    draftBody: "No blockers remain.",
    evidence: "CI green.",
    reviewSummary: "Clean.",
    mergeStateStatus: "CLEAN",
    ciGreen: true,
    verdict: "comment" as const,
  };
  const first = queueReviewGateDecision(file, request);
  const second = queueReviewGateDecision(file, request);
  expect(first.id).toBe(second.id);
  expect(openQuestions(file)).toHaveLength(1);
  expect(first.workflow).toMatchObject({
    runId: "run-review-gate",
    nodeId: "review-approval-gate-7-head-7",
    answerLane: "smithers-approval",
    decisionKey: "head-7",
    approvalValue: { prNumber: 7, headSha: "head-7", verdict: "comment" },
  });

  let submitted: unknown;
  const routed = await routeWorkflowQuestionAnswer(file, openQuestions(file)[0]!, "Acknowledge evidence", {
    env: {
      SMITHERS_GATEWAY_TOKEN: "review-gate-token",
      SMITHERS_GATEWAY_URL: "http://gateway.test/",
    },
    fetch: async (_url, init) => {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        ok: true,
        payload: {
          runId: "run-review-gate",
          nodeId: "review-approval-gate-7-head-7",
          iteration: 0,
          approved: true,
        },
      }), { status: 200 });
    },
  }, "approve");
  expect(routed).toEqual({ lane: "smithers-approval", choice: "approve", applied: true });
  expect(submitted).toMatchObject({
    runId: "run-review-gate",
    nodeId: "review-approval-gate-7-head-7",
    approved: true,
    decision: {
      approved: true,
      value: { prNumber: 7, headSha: "head-7", verdict: "comment" },
    },
  });
  expect(openQuestions(file)).toEqual([]);
  const nextHead = queueReviewGateDecision(file, {
    ...request,
    pr: { ...request.pr, headRefOid: "head-8" },
    headSha: "head-8",
  });
  expect(nextHead.id).not.toBe(first.id);
  expect(nextHead.workflow).toMatchObject({
    nodeId: "review-approval-gate-7-head-8",
    decisionKey: "head-8",
    approvalValue: { headSha: "head-8" },
  });
});

test("polls the captain review-request queue programmatically", () => {
  expect(source).toContain("review-requested:${login}");
  expect(source).toContain("<Poller id={pollerId}");
  expect(source).toContain("const proc = Bun.spawn"); // polling is a programmatic GH call
  for (const model of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
    const agent = createReviewGateAgent(model, "/tmp/review-gate", "review-gate-test");
    expect(agent).toBeInstanceOf(PrimeSeatAgent);
    expect(agent.cliEngine).toBe("prime");
    expect(agent.opts.provider).toBe(DECK_PROVIDER);
    expect(agent.opts.model).toBe(model);
    expect(agent.opts.rlmChildModel).toBe("deck/gpt-5.6-luna");
  }
});


test("renders one durable Poller with timer pacing and a bounded continuation recycle", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "review-gate-render-"));
  const rendered = await renderWorkflow(workflow, {
    workflowPath: new URL("../pipeline.tsx", import.meta.url).pathname,
    input: {
      repo: "owner/repo",
      worktree,
      captainLogin: "captain",
      dryRun: true,
      limits: { polls: 8, intervalMs: 1 },
      fixtures: { requested: false },
    },
  });

  expect(rendered.tasks.map((task) => task.nodeId)).toContain("review-requested-0-check");
  expect(source).toContain("<Poller id={pollerId}");
  expect(source).toContain("intervalMs={pollIntervalMs}");
  expect(source).toContain('onTimeout="return-last"');
  expect(source).toContain('<Timer id="review-cycle-delay"');
  expect(source.match(/<ContinueAsNew/g)).toHaveLength(1);
  expect(source).not.toContain("maxIterations={polls}");
  expect(source).not.toContain("async function sleep");
});

test("a recycled run gets a fresh poller id instead of reusing carried poll output", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "review-gate-recycle-"));
  const rendered = await renderWorkflow(workflow, {
    workflowPath: new URL("../pipeline.tsx", import.meta.url).pathname,
    input: {
      repo: "owner/repo",
      worktree,
      captainLogin: "captain",
      dryRun: true,
      limits: { polls: 8, intervalMs: 1 },
      fixtures: { requested: false },
      __smithersContinuation: { payload: { cycle: 1, pollCount: 8 } },
    } as any,
    outputs: {
      queue: [{
        nodeId: "review-requested-0-check",
        iteration: 0,
        poll: 7,
        prs: [{ number: 7, url: "https://example.test/7", title: "old", headRefOid: "old-head" }],
        at: "2026-01-01T00:00:00.000Z",
        satisfied: true,
      }],
    },
  });

  expect(rendered.tasks.map((task) => task.nodeId)).toContain("review-requested-1-check");
  expect(rendered.tasks.some((task) => task.nodeId === "gate-review-7")).toBe(false);
  expect(source).toContain("state={{ cycle: cycle + 1, pollCount: pollCount + completedPolls }}");
});

test("gate has a hard no-approval rule and verifies state before queueing", () => {
  expect(source).toContain("NEVER run any GitHub approve command");
  expect(source).toContain("<Approval");
  expect(source).toContain("review-approval-gate-");
  expect(source).not.toMatch(/"pr",\s*"merge"/);
  expect(source).not.toContain("--approve");
  expect(source).toContain("mergeStateStatus");
  expect(assessCi([])).toEqual({ ciGreen: false, ciPending: true });
  expect(assessCi([{ conclusion: "SUCCESS" }])).toEqual({ ciGreen: true, ciPending: false });
  expect(source).toContain('answerLane: "smithers-approval"');
  expect(source).toContain('workflowFile: fileURLToPath(import.meta.url)');
});

test("blockers dispatch a fix and rebase is an agent task", () => {
  expect(source).toContain("latest.blockers.length > 0");
  expect(source).toContain("gate-fix-");
  expect(source).toContain("Fix every finding from Sathira's Gate review");
  expect(source).toContain("rebase if needed");
  expect(source).toContain("Load the exact skills .agent/skills/sathiras-gate");
});

test("blocker reports draft findings and submit only follows captain approval", () => {
  expect(source).toContain("reviewCommand(pr.number, input.repo, blockers.length === 0)");
  expect(source).toContain('request-changes');
  expect(source).toContain("draftFingerprint");
  expect(source).toContain("draftBody");
  expect(source).toContain("— automated review");
  expect(source).toContain("posted: false, requestedChanges: false");
  expect(source).not.toContain('posted[`comment:${fingerprint}`]');
});

test("clean and exhausted rounds use different captain decisions without self-approval", () => {
  expect(source).toContain('maxIterations={rounds}');
  expect(source).toContain('Math.min(input.limits?.rounds ?? 3, 3)');
  expect(source).toContain('const clean = request.verdict === "comment"');
  expect(source).toContain('["Acknowledge evidence", "Hold", "Deny gate"]');
  expect(source).toContain('reviewCommand(pr.number, input.repo, blockers.length === 0)');
  expect(source).toContain('shouldSubmitReview(decision)');
});

test("captain decision is required before exactly one review command", () => {
  expect(shouldSubmitReview(undefined)).toBe(false);
  expect(shouldSubmitReview({ approved: false })).toBe(false);
  expect(shouldSubmitReview({ approved: true })).toBe(true);
  expect(reviewCommand(7, "owner/repo", true)).toEqual(["pr", "comment", "7", "--repo", "owner/repo"]);
  expect(reviewCommand(7, "owner/repo", false)).toEqual(["pr", "review", "7", "--repo", "owner/repo", "--request-changes"]);
  expect(reviewSubmissionMarker(7, "head-a", "", "comment")).toBe(
    "submitted:7:head-a:clean:comment",
  );
  expect(reviewSubmissionMarker(7, "head-b", "", "comment")).not.toBe(
    reviewSubmissionMarker(7, "head-a", "", "comment"),
  );
  expect(() => reviewSubmissionMarker(7, "", "", "comment")).toThrow(
    "review submission marker needs the reviewed head",
  );
});

test("polling and every requested PR are durable workflow paths", () => {
  expect(source).toContain("maxAttempts={polls}");
  expect(source).toContain("reviewPrs.map((pr) =>");
  expect(source).toContain("pr.url");
});

test("the installed pack does not ship the approval-spamming post-failure workflow", () => {
  const workflowPath = join(import.meta.dir, "..", "..", ".smithers", "workflows", "post-failure.tsx");
  const manifest = readFileSync(join(import.meta.dir, "..", "..", ".smithers", "smithers.toon"), "utf8");
  expect(existsSync(workflowPath)).toBe(false);
  expect(manifest).not.toContain("post-failure");
});
