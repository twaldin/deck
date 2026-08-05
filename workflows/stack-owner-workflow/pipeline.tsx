/** @jsxImportSource smithers-orchestrator */
/** One run owns a prompt, its ordered PR stack, review loop, and delivery. */
import { Approval, Loop, PiAgent, Sequence, Task, Workflow, approvalDecisionSchema, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execOrThrow, bunExec } from "../pr-pipeline/lib/gh.ts";
import { runMerge } from "../pr-pipeline/lib/merge.ts";
import { executeReviewerRequest } from "../pr-pipeline/lib/reviewers.ts";
import { fetchChangedFiles, fetchCodeowners, fetchRecentAuthors, resolveReviewerLogin, isCollaborator, requestReviewers, fetchRequestedReviewers } from "../pr-pipeline/lib/gh.ts";
import { createHostPiAgent } from "../pr-pipeline/lib/host-pi.ts";
import { pollStack } from "./lib/poll.ts";
import { publishWakeProducer } from "../../v2/src/wake-producers.ts";

const inputSchema = z.object({
  repo: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1), baseBranch: z.string().optional(), prompt: z.string().min(1),
  dryRun: z.boolean().optional(), profile: z.enum(["yolo", "lindy-full"]).optional(), github: z.object({ gh: z.string().optional(), reviewers: z.array(z.string()).optional() }).optional(),
  limits: z.object({ adversarial: z.number().int().positive().optional(), polls: z.number().int().positive().optional(), pollSeconds: z.number().nonnegative().optional() }).optional(),
  fixtures: z.object({ prs: z.array(z.number().int().positive()).optional(), finding: z.string().optional(), ciFail: z.boolean().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  implementation: z.object({ changed: z.boolean(), prs: z.array(z.object({ number: z.number().int().nonnegative(), branch: z.string() })), summary: z.string() }),
  opened: z.object({ changed: z.boolean(), prs: z.array(z.object({ number: z.number().int().positive(), branch: z.string() })), summary: z.string() }),
  review: z.object({ blockers: z.array(z.string()), summary: z.string() }),
  fix: z.object({ fixed: z.boolean() }),
  reviewGate: z.object({ ok: z.boolean() }),
  wake: z.object({ action: z.string(), signal: z.string() }),
  poll: z.object({
    signal: z.enum(["ci-fail", "actionable-comment", "decision-ask", "idle", "exhausted", "complete"]),
    reason: z.string(),
    prs: z.array(z.object({
      number: z.number().int().positive(),
      url: z.string(),
      title: z.string(),
      headSha: z.string(),
      mergeable: z.boolean(),
      mergeStateStatus: z.string(),
      ci: z.enum(["green", "pending", "red"]),
      reviewState: z.string(),
      actionableComments: z.number().int().nonnegative(),
      decisionAsk: z.boolean(),
    })).optional(),
  }),
  approval: approvalDecisionSchema,
  merge: z.object({ merged: z.boolean(), receipts: z.array(z.string()) }),
  result: z.object({ done: z.boolean(), summary: z.string() }),
};
const { outputs, smithers } = createSmithers(schemas);
const agent = (model: string) => {
  const configured = process.env.DECK_SUBAGENT_EXTENSION;
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../subagents/extension/index.ts");
  const extension = configured ?? (fs.existsSync(bundled) ? bundled : undefined);
  return createHostPiAgent(PiAgent, { provider: "deck", model, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, tools: ["read", "grep", "edit", "write", "bash"], ...(extension === undefined ? {} : { extension: [extension] }) });
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun === true; const gh = input.github?.gh ?? "gh";
  const maxRounds = input.limits?.adversarial ?? 6; const maxPolls = input.limits?.polls ?? 60; const pollSeconds = input.limits?.pollSeconds ?? 30;
  const implAgent = agent("gpt-5.6-luna"); const reviewAgent = agent("claude-fable-5");
  const taskId = `stack-owner:${input.repo}:${input.branch}`;
  const reviewHistory = () => (ctx.outputs.review ?? []).filter((row) => String((row as { nodeId?: string }).nodeId ?? "").startsWith("adversarial-review")).sort((a, b) => Number((a as { iteration?: number }).iteration ?? 0) - Number((b as { iteration?: number }).iteration ?? 0)).map((row) => row as { blockers?: string[] });
  const findingFingerprint = (review: { blockers?: string[] } | undefined) => (review?.blockers ?? []).map((item) => item.trim().toLowerCase().replace(/\s+/g, " ")).sort().join("|");
  const repeatedFinding = () => { const rows = reviewHistory(); const current = findingFingerprint(rows.at(-1)); const previous = findingFingerprint(rows.at(-2)); return current !== "" && current === previous; };
  const implementation = <Task id="implement-stack" output={outputs.implementation} agent={dryRun ? undefined : implAgent}>
    {dryRun ? () => ({ changed: true, prs: (input.fixtures?.prs ?? [0]).map((number) => ({ number, branch: input.branch })), summary: "dry-run implementation" }) : `Implement this prompt in ${input.worktree}: ${input.prompt}. You own the complete ordered PR stack. Split only when needed. Commit each branch and return JSON with changed, prs [{number:0,branch}] and summary. The number is a placeholder and is not a GitHub PR number; open-stack creates the PRs.`}
  </Task>;
  const review = <Task id="adversarial-review" output={outputs.review} agent={dryRun ? undefined : reviewAgent}>
    {dryRun ? () => ({ blockers: input.fixtures?.finding ? [input.fixtures.finding] : [], summary: "dry-run review" }) : `Review the entire current stack implementation in ${input.worktree}. Find only actionable blockers. Do not edit or push. Return JSON with blockers and summary.`}
  </Task>;
  const reviewLoop = <Loop id="adversarial-loop" maxIterations={maxRounds} onMaxReached="return-last" until={(ctx.latest(outputs.review, "adversarial-review")?.blockers?.length ?? 1) === 0 || repeatedFinding()}>
    <Sequence>{review}<Task id="fix-review" output={outputs.fix} agent={dryRun ? undefined : agent("gpt-5.6-luna")}>
      {async () => {
        const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
        if (repeatedFinding() || blockers.length > 0 && reviewHistory().length >= maxRounds) {
          publishWakeProducer({ dryRun, snapshot: { taskId, maxAdversarial: true } });
        }
        if (dryRun) return { fixed: true };
        return `Fix every blocker in the latest adversarial review in ${input.worktree}. Run focused tests and commit. Do not open or merge PRs. If the same critical finding appears twice, stop and report it to the orchestrator.`;
      }}
    </Task></Sequence>
  </Loop>;
  const reviewGate = <Task id="review-gate" output={outputs.reviewGate}>{() => {
    const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
    const ok = blockers.length === 0;
    if (!ok) publishWakeProducer({ dryRun, snapshot: { taskId, maxAdversarial: true } });
    return { ok };
  }}</Task>;
  const open = <Task id="open-stack" output={outputs.opened} retries={1} skipIf={ctx.latest(outputs.reviewGate, "review-gate")?.ok === false}>{async () => {
    const impl = ctx.latest(outputs.implementation, "implement-stack"); const planned = impl?.prs ?? [];
    if (dryRun) return { changed: impl?.changed ?? true, prs: (input.fixtures?.prs ?? [1]).map((number) => ({ number, branch: input.branch })), summary: "dry-run PR stack opened" };
    const prs: Array<{ number: number; branch: string }> = [];
    const defaultBranch = input.baseBranch ?? (await execOrThrow(bunExec, [gh, "repo", "view", input.repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { cwd: input.worktree })).trim();
    let base = defaultBranch;
    for (const pr of planned) {
      const created = await execOrThrow(bunExec, [gh, "pr", "create", "--repo", input.repo, "--base", base, "--head", pr.branch, "--title", input.prompt.slice(0, 80), "--body", input.prompt], { cwd: input.worktree });
      const url = created.match(/https?:\/\/[^\s]+\/pull\/(\d+)/);
      const number = url ? Number(url[1]) : Number(await execOrThrow(bunExec, [gh, "pr", "view", pr.branch, "--repo", input.repo, "--json", "number", "--jq", ".number"]));
      prs.push({ number, branch: pr.branch }); base = pr.branch;
    }
    for (const createdPr of prs) {
      const context = { gh, repo: input.repo, prNumber: createdPr.number, exec: bunExec };
      await executeReviewerRequest({ explicit: input.github?.reviewers ?? [], exclude: [], denylist: [], max: 2 }, {
        fetchChangedFiles: () => fetchChangedFiles(context, createdPr.number), fetchCodeowners: () => fetchCodeowners(context), fetchRecentAuthors: (files) => fetchRecentAuthors(context, files), resolveLogin: (name) => resolveReviewerLogin(context, name), isCollaborator: (login) => isCollaborator(context, login), requestReviewers: (logins) => requestReviewers(context, createdPr.number, logins), fetchRequestedReviewers: () => fetchRequestedReviewers(context, createdPr.number),
      });
    }
    return { changed: impl?.changed ?? true, prs, summary: "PR stack opened in dependency order" };
  }}</Task>;
  const poll = <Task id="poll-stack" output={outputs.poll} retries={2}>{async () => {
    const prs = ctx.latest(outputs.opened, "open-stack")?.prs ?? [];
    if (dryRun) {
      const signal = input.fixtures?.ciFail ? "ci-fail" : "complete";
      const prs = (ctx.latest(outputs.opened, "open-stack")?.prs ?? []).map((pr) => ({
        number: pr.number,
        url: `https://github.com/${input.repo}/pull/${pr.number}`,
        title: input.prompt,
        headSha: "dryrun-head-sha",
        mergeable: signal === "complete",
        mergeStateStatus: signal === "complete" ? "clean" : "blocked",
        ci: signal === "complete" ? "green" : "red" as const,
        reviewState: signal === "complete" ? "APPROVED" : "CHANGES_REQUESTED",
        actionableComments: 0,
        decisionAsk: false,
      }));
      return { signal, prs, reason: signal === "ci-fail" ? "fixture CI failure" : "fixture complete" };
    }
    const pollNo = (ctx.outputs.poll ?? []).length;
    if (!dryRun && pollNo > 0) await wait(pollSeconds * 1000);
    const result = await pollStack(bunExec, input.repo, prs.map((p) => p.number), gh);
    const exhausted = pollNo + 1 >= maxPolls && result.signal === "idle";
    const signal = exhausted ? "exhausted" : result.signal;
    publishWakeProducer({ dryRun, snapshot: { taskId, ciFail: signal === "ci-fail", actionableComment: signal === "actionable-comment", decisionAsk: signal === "decision-ask" } });
    return { signal, prs: result.prs, reason: exhausted ? "Poll limit reached without a wake condition" : result.reason };
  }}</Task>;
  const watch = <Loop id="code-poll-loop" maxIterations={maxPolls} onMaxReached="return-last" skipIf={ctx.latest(outputs.reviewGate, "review-gate")?.ok === false} until={["complete", "ci-fail", "actionable-comment", "decision-ask", "exhausted"].includes(ctx.latest(outputs.poll, "poll-stack")?.signal ?? "")}>
    <Sequence>{poll}<Task id="wake-fix" output={outputs.wake} agent={undefined}>{async () => { const signal = ctx.latest(outputs.poll, "poll-stack")?.signal; if (signal === "idle" || signal === "exhausted") return { action: "wait", signal }; return { action: signal === "decision-ask" ? "escalate" : "fix", signal }; }}</Task></Sequence>
  </Loop>;
  const opened = ctx.latest(outputs.opened, "open-stack");
  const latestPoll = ctx.latest(outputs.poll, "poll-stack");
  const approval = ctx.latest(outputs.approval, "merge-stack-approval");
  // The gate node stays rendered after it resolves: dropping it once a decision
  // exists would remove the node the merge below reads, and break resume.
  const stackReady = latestPoll?.signal === "complete";
  const stack = opened?.prs ?? [];
  // Only facts the "complete" poll signal actually establishes: every PR is
  // CI-green and mergeable, with no unresolved comment and no decision ask.
  const stackSummary = stack.map((pr) => {
    const evidence = latestPoll?.prs?.find((candidate) => candidate.number === pr.number);
    return [
      `PR #${pr.number} https://github.com/${input.repo}/pull/${pr.number}`,
      evidence ? `  CI: ${evidence.ci}; review: ${evidence.reviewState}; mergeability: ${evidence.mergeable ? "MERGEABLE" : "NOT MERGEABLE"} (${evidence.mergeStateStatus})` : "  Evidence: poll data unavailable",
    ].join("\n");
  }).join("\n");
  const mergeApproval = stackReady ? (dryRun ? <Task id="merge-stack-approval" output={outputs.approval}>{() => ({ approved: true, note: "dry-run stack approval", decidedBy: "dry-run", decidedAt: new Date().toISOString() })}</Task> : <Approval id="merge-stack-approval" output={outputs.approval} request={{ title: `Approve ordered stack merge: ${input.repo} (${stack.length} PRs)`, summary: `Ordered stack:\n${stackSummary}\n\nEvery PR is CI-green and mergeable, with no unresolved review comment and no open decision ask. Approving submits the Gateway decision; the workflow then re-polls the stack and its own merge node submits each PR to the GitHub merge queue in order. Denying stops the run.` }} onDeny="fail" />) : null;
  const merged = approval?.approved === true ? <Task id="merge-stack" output={outputs.merge} retries={1}>{async () => {
    if (dryRun) return { merged: true, receipts: stack.map((pr) => `dry-run: PR #${pr.number}`) };
    const verified = await pollStack(bunExec, input.repo, stack.map((pr) => pr.number), gh);
    if (verified.signal !== "complete") throw new Error(`stack changed after approval: ${verified.reason}`);
    const receipts: string[] = [];
    for (const pr of stack) {
      const result = await runMerge({ exec: bunExec, gh, prNumber: pr.number, cwd: input.worktree, args: ["--auto", "--squash"] });
      receipts.push(`PR #${pr.number}: ${result.output.slice(-1000)}`);
    }
    return { merged: true, receipts };
  }}</Task> : null;
  return <Workflow name="lindy-stack-owner"><Sequence>{implementation}{reviewLoop}{reviewGate}{open}{watch}{mergeApproval}{merged}<Task id="done" output={outputs.result}>{() => {
    const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
    const signal = ctx.latest(outputs.poll, "poll-stack")?.signal;
    const ok = blockers.length === 0 && signal === "complete" && ctx.latest(outputs.merge, "merge-stack")?.merged === true;
    publishWakeProducer({ dryRun, snapshot: { taskId, terminal: ok, maxAdversarial: !ok && blockers.length > 0, ciFail: !ok && signal === "ci-fail", actionableComment: !ok && signal === "actionable-comment", decisionAsk: !ok && signal === "decision-ask" } });
    return ok ? { done: true, summary: input.profile === "lindy-full" ? "stack merged after captain approval" : "stack merged" } : { done: false, summary: `stack owner stopped with unresolved ${blockers.length ? "review blockers" : `${signal ?? "unknown"} poll signal`}` };
  }}</Task></Sequence></Workflow>;
});
