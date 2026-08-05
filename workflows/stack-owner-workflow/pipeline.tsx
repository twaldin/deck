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
import { adoptionApprovalSummary, assertDeclaredChain, fetchAdoptedPrs, mergeAdoptedStack, restackAdoptedPrs, validateAdoptedStack } from "./lib/adopt.ts";
import { pollStack } from "./lib/poll.ts";
import { publishWakeProducer } from "../../v2/src/wake-producers.ts";
import { smithersWorkspaceCwd } from "../../v2/src/workspace.ts";

const inputSchema = z.object({
  repo: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1), baseBranch: z.string().optional(), prompt: z.string().min(1),
  dryRun: z.boolean().optional(), profile: z.enum(["yolo", "lindy-full"]).optional(), github: z.object({ gh: z.string().optional(), reviewers: z.array(z.string()).optional() }).optional(),
  limits: z.object({ adversarial: z.number().int().positive().optional(), polls: z.number().int().positive().optional(), pollSeconds: z.number().nonnegative().optional() }).optional(),
  fixtures: z.object({ prs: z.array(z.number().int().positive()).optional(), finding: z.string().optional(), ciFail: z.boolean().optional(), adoptBehind: z.boolean().optional(), adoptConflict: z.boolean().optional() }).optional(),
  adopt: z.object({ prs: z.array(z.object({ number: z.number().int().positive(), head: z.string().min(1), base: z.string().min(1) })).min(1) }).optional(),
});
const schemas = {
  input: inputSchema,
  implementation: z.object({ changed: z.boolean(), prs: z.array(z.object({ number: z.number().int().nonnegative(), branch: z.string() })), summary: z.string() }),
  opened: z.object({ changed: z.boolean(), prs: z.array(z.object({ number: z.number().int().positive(), branch: z.string() })), summary: z.string() }),
  review: z.object({ blockers: z.array(z.string()), summary: z.string() }),
  fix: z.object({ fixed: z.boolean() }),
  reviewGate: z.object({ ok: z.boolean() }),
  wake: z.object({ action: z.string(), signal: z.string() }),
  adoptValidation: z.object({ ok: z.boolean(), receiptPath: z.string(), prs: z.array(z.object({ number: z.number().int().positive(), head: z.string(), base: z.string(), url: z.string(), headSha: z.string(), landed: z.boolean() })) }),
  restack: z.object({ actions: z.array(z.string()), conflicts: z.array(z.string()) }),
  poll: z.object({
    signal: z.enum(["ci-fail", "actionable-comment", "decision-ask", "idle", "exhausted", "complete", "needs-rebase"]),
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
      state: z.string(),
      merged: z.boolean(),
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
  const adoptPrs = input.adopt?.prs ?? []; const adoption = adoptPrs.length > 0; const adoptBase = input.baseBranch ?? adoptPrs[0]?.base ?? "main";
  const openedNodeId = adoption ? "adopt-stack" : "open-stack";
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
  const adoptValidate = <Task id="adopt-validate" output={outputs.adoptValidation} retries={1}>{async () => {
    assertDeclaredChain(adoptBase, adoptPrs);
    const validated = dryRun
      ? adoptPrs.map((pr) => ({ ...pr, url: `https://github.com/${input.repo}/pull/${pr.number}`, headSha: "dryrun-head-sha", landed: false }))
      : validateAdoptedStack(input.repo, adoptBase, adoptPrs, await fetchAdoptedPrs(bunExec, input.repo, adoptPrs.map((pr) => pr.number), gh));
    // The captain may open the receipt from the ApprovalPanel long after this
    // task ran, so it lives in the durable Smithers workspace, not tmpdir.
    const receiptDir = path.join(smithersWorkspaceCwd(), "stack-adoption");
    fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(receiptDir, `adopt-${[input.repo, input.branch].join("-").replace(/[^A-Za-z0-9._-]/g, "-")}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({ repo: input.repo, baseBranch: adoptBase, dryRun, validatedAt: new Date().toISOString(), prs: validated }, null, 2));
    return { ok: true, receiptPath, prs: validated };
  }}</Task>;
  const adoptReview = <Task id="adversarial-review" output={outputs.review} agent={dryRun ? undefined : reviewAgent}>
    {dryRun ? () => ({ blockers: input.fixtures?.finding ? [input.fixtures.finding] : [], summary: "dry-run adoption review" }) : () => {
      const chain = adoptPrs.map((pr) => `#${pr.number} (${pr.head} <- ${pr.base})`).join(", ");
      return `Adoption review of the existing PR stack ${chain} in ${input.repo}. In ${input.worktree}, run "git fetch origin", then review the one combined semantic stack diff: "git diff origin/${adoptBase}...origin/${adoptPrs.at(-1)?.head}". Find only actionable blockers across the whole stack. Do not edit, push, or comment on the PRs. Return JSON with blockers and summary.`;
    }}
  </Task>;
  const adoptStack = <Task id="adopt-stack" output={outputs.opened} skipIf={ctx.latest(outputs.reviewGate, "review-gate")?.ok === false}>{() => {
    const validated = ctx.latest(outputs.adoptValidation, "adopt-validate")?.prs ?? [];
    return { changed: false, prs: validated.map((pr) => ({ number: pr.number, branch: pr.head })), summary: "adopted existing PR stack; no PR was created" };
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
    const prs = ctx.latest(outputs.opened, openedNodeId)?.prs ?? [];
    // A conflict the restack could not resolve will conflict again next round;
    // escalate it as a decision instead of retrying the same rebase for hours.
    const priorConflicts = ctx.latest(outputs.restack, "restack")?.conflicts ?? [];
    if (dryRun) {
      const restacked = (ctx.outputs.restack ?? []).length > 0;
      const behind = adoption && input.fixtures?.adoptBehind === true && !restacked;
      const signal = input.fixtures?.ciFail ? "ci-fail" : priorConflicts.length > 0 ? "decision-ask" : behind ? "needs-rebase" : "complete";
      const rows = prs.map((pr) => ({
        number: pr.number,
        url: `https://github.com/${input.repo}/pull/${pr.number}`,
        title: input.prompt,
        // A restack changes heads; the fixture SHA changes with it so the
        // re-poll after a head change is observable in dry-run.
        headSha: restacked ? "dryrun-restacked-sha" : "dryrun-head-sha",
        mergeable: signal === "complete",
        mergeStateStatus: signal === "complete" ? "clean" : signal === "needs-rebase" ? "behind" : "blocked",
        ci: (signal === "complete" ? "green" : signal === "needs-rebase" ? "pending" : "red") as "green" | "pending" | "red",
        reviewState: signal === "complete" ? "APPROVED" : "CHANGES_REQUESTED",
        actionableComments: 0,
        decisionAsk: false,
        state: "open",
        merged: false,
      }));
      return { signal, prs: rows, reason: signal === "ci-fail" ? "fixture CI failure" : signal === "decision-ask" ? `fixture rebase conflict: ${priorConflicts.join("; ")}` : signal === "needs-rebase" ? "fixture behind child" : "fixture complete" };
    }
    const pollNo = (ctx.outputs.poll ?? []).length;
    if (!dryRun && pollNo > 0) await wait(pollSeconds * 1000);
    const result = await pollStack(bunExec, input.repo, prs.map((p) => p.number), gh, { adoption });
    const exhausted = pollNo + 1 >= maxPolls && result.signal === "idle";
    const stuckConflict = result.signal === "needs-rebase" && priorConflicts.length > 0;
    const signal = exhausted ? "exhausted" : stuckConflict ? "decision-ask" : result.signal;
    publishWakeProducer({ dryRun, snapshot: { taskId, ciFail: signal === "ci-fail", actionableComment: signal === "actionable-comment", decisionAsk: signal === "decision-ask" } });
    return { signal, prs: result.prs, reason: exhausted ? "Poll limit reached without a wake condition" : stuckConflict ? `Rebase conflicts need a decision: ${priorConflicts.join("; ")}` : result.reason };
  }}</Task>;
  // Restack runs only on a needs-rebase poll, so up-to-date PRs are never
  // force-pushed and keep the approvals GitHub preserves.
  const restack = adoption ? <Task id="restack" output={outputs.restack} retries={1} skipIf={ctx.latest(outputs.poll, "poll-stack")?.signal !== "needs-rebase"}>{async () => {
    const flagged = (ctx.latest(outputs.poll, "poll-stack")?.prs ?? []).filter((pr) => !pr.merged && ["behind", "dirty"].includes(pr.mergeStateStatus)).map((pr) => pr.number);
    if (dryRun) {
      if (input.fixtures?.adoptConflict === true) return { actions: [], conflicts: flagged.map((number) => `dry-run: PR #${number} conflicts with its base`) };
      return { actions: flagged.map((number) => `dry-run: rebased PR #${number}`), conflicts: [] };
    }
    const result = await restackAdoptedPrs(bunExec, { worktree: input.worktree, prs: adoptPrs, needsRebase: flagged });
    if (result.conflicts.length > 0) publishWakeProducer({ dryRun, snapshot: { taskId, decisionAsk: true } });
    return result;
  }}</Task> : null;
  const watch = <Loop id="code-poll-loop" maxIterations={maxPolls} onMaxReached="return-last" skipIf={ctx.latest(outputs.reviewGate, "review-gate")?.ok === false} until={["complete", "ci-fail", "actionable-comment", "decision-ask", "exhausted"].includes(ctx.latest(outputs.poll, "poll-stack")?.signal ?? "")}>
    <Sequence>{poll}{restack}<Task id="wake-fix" output={outputs.wake} agent={undefined}>{async () => { const signal = ctx.latest(outputs.poll, "poll-stack")?.signal; if (signal === "idle" || signal === "exhausted") return { action: "wait", signal }; if (signal === "needs-rebase") return { action: "restack", signal }; return { action: signal === "decision-ask" ? "escalate" : "fix", signal }; }}</Task></Sequence>
  </Loop>;
  const opened = ctx.latest(outputs.opened, openedNodeId);
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
  const receiptPath = ctx.latest(outputs.adoptValidation, "adopt-validate")?.receiptPath ?? "";
  const approvalTitle = adoption ? `Approve adopted stack merge: ${input.repo} (${stack.length} PRs)` : `Approve ordered stack merge: ${input.repo} (${stack.length} PRs)`;
  const approvalSummary = adoption
    ? `Adopted ordered stack:\n${adoptionApprovalSummary(latestPoll?.prs ?? [], receiptPath)}\n\nEvery unlanded PR is CI-green, human-approved, mergeable, and has no unresolved actionable comment or decision ask. Approving lets the workflow re-check the whole stack and merge parent-first; landing is verified by the squash commit (#N) on each actual base. Denying stops the run.`
    : `Ordered stack:\n${stackSummary}\n\nEvery PR is CI-green and mergeable, with no unresolved review comment and no open decision ask. Approving submits the Gateway decision; the workflow then re-polls the stack and its own merge node submits each PR to the GitHub merge queue in order. Denying stops the run.`;
  const mergeApproval = stackReady ? (dryRun ? <Task id="merge-stack-approval" output={outputs.approval}>{() => ({ approved: true, note: "dry-run stack approval", decidedBy: "dry-run", decidedAt: new Date().toISOString() })}</Task> : <Approval id="merge-stack-approval" output={outputs.approval} request={{ title: approvalTitle, summary: approvalSummary }} onDeny="fail" />) : null;
  const merged = approval?.approved === true ? <Task id="merge-stack" output={outputs.merge} retries={1}>{async () => {
    if (dryRun) return { merged: true, receipts: stack.map((pr) => adoption ? `dry-run: PR #${pr.number} squash (#${pr.number}) verified on its base` : `dry-run: PR #${pr.number}`) };
    if (adoption) {
      const approved = (latestPoll?.prs ?? []).map((pr) => ({ number: pr.number, headSha: pr.headSha }));
      const receipts = await mergeAdoptedStack({ exec: bunExec, gh, repo: input.repo, worktree: input.worktree, baseBranch: adoptBase, prs: adoptPrs, approved, poll: () => pollStack(bunExec, input.repo, adoptPrs.map((pr) => pr.number), gh, { adoption: true }) });
      return { merged: true, receipts };
    }
    const verified = await pollStack(bunExec, input.repo, stack.map((pr) => pr.number), gh);
    if (verified.signal !== "complete") throw new Error(`stack changed after approval: ${verified.reason}`);
    const landed = new Set(verified.prs.filter((pr) => pr.merged).map((pr) => pr.number));
    const receipts: string[] = [];
    for (const pr of stack) {
      if (landed.has(pr.number)) { receipts.push(`PR #${pr.number}: already landed`); continue; }
      const result = await runMerge({ exec: bunExec, gh, prNumber: pr.number, cwd: input.worktree, args: ["--auto", "--squash"] });
      receipts.push(`PR #${pr.number}: ${result.output.slice(-1000)}`);
    }
    return { merged: true, receipts };
  }}</Task> : null;
  return <Workflow name="lindy-stack-owner"><Sequence>{adoption ? adoptValidate : implementation}{adoption ? adoptReview : reviewLoop}{reviewGate}{adoption ? adoptStack : open}{watch}{mergeApproval}{merged}<Task id="done" output={outputs.result}>{() => {
    const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
    const signal = ctx.latest(outputs.poll, "poll-stack")?.signal;
    const ok = blockers.length === 0 && signal === "complete" && ctx.latest(outputs.merge, "merge-stack")?.merged === true;
    publishWakeProducer({ dryRun, snapshot: { taskId, terminal: ok, maxAdversarial: !ok && blockers.length > 0, ciFail: !ok && signal === "ci-fail", actionableComment: !ok && signal === "actionable-comment", decisionAsk: !ok && (signal === "decision-ask" || signal === "needs-rebase") } });
    return ok ? { done: true, summary: input.profile === "lindy-full" ? "stack merged after captain approval" : "stack merged" } : { done: false, summary: `stack owner stopped with unresolved ${blockers.length ? "review blockers" : `${signal ?? "unknown"} poll signal`}` };
  }}</Task></Sequence></Workflow>;
});
