/** @jsxImportSource smithers-orchestrator */
/** One run owns a prompt, its ordered PR stack, review loop, and delivery. */
import { Loop, PiAgent, Sequence, Task, Workflow, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { execOrThrow, bunExec } from "../pr-pipeline/lib/gh.ts";
import { executeReviewerRequest } from "../pr-pipeline/lib/reviewers.ts";
import { fetchChangedFiles, fetchCodeowners, fetchRecentAuthors, resolveReviewerLogin, isCollaborator, requestReviewers, fetchRequestedReviewers } from "../pr-pipeline/lib/gh.ts";
import { pollStack } from "./lib/poll.ts";
import { produceWakeConditions } from "../../v2/src/wake-producers.ts";

const inputSchema = z.object({
  repo: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1), prompt: z.string().min(1),
  dryRun: z.boolean().optional(), profile: z.enum(["yolo", "lindy-full"]).optional(), github: z.object({ gh: z.string().optional(), reviewers: z.array(z.string()).optional() }).optional(),
  limits: z.object({ adversarial: z.number().int().positive().optional(), polls: z.number().int().positive().optional(), pollSeconds: z.number().nonnegative().optional() }).optional(),
  fixtures: z.object({ prs: z.array(z.number().int().positive()).optional(), finding: z.string().optional(), ciFail: z.boolean().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  implementation: z.object({ changed: z.boolean(), prs: z.array(z.object({ number: z.number().int().positive(), branch: z.string() })), summary: z.string() }),
  review: z.object({ blockers: z.array(z.string()), summary: z.string() }),
  poll: z.object({ signal: z.enum(["ci-fail", "actionable-comment", "decision-ask", "idle", "complete"]), reason: z.string() }),
  result: z.object({ done: z.boolean(), summary: z.string() }),
};
const { outputs, smithers } = createSmithers(schemas);
const agent = (model: string) => new PiAgent({ provider: "deck", model, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, tools: ["read", "grep", "edit", "write", "bash"] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun === true; const gh = input.github?.gh ?? "gh";
  const maxRounds = input.limits?.adversarial ?? 6; const maxPolls = input.limits?.polls ?? 60;
  const implAgent = agent("gpt-5.6-luna"); const reviewAgent = agent("claude-fable-5");
  let lastFindingFingerprint = ""; let repeatedFinding = 0;
  const implementation = <Task id="implement-stack" output={outputs.implementation} agent={dryRun ? undefined : implAgent}>
    {dryRun ? () => ({ changed: true, prs: (input.fixtures?.prs ?? [1]).map((number) => ({ number, branch: input.branch })), summary: "dry-run implementation" }) : `Implement this prompt in ${input.worktree}: ${input.prompt}. You own the complete ordered PR stack. Split only when needed. Commit each branch and return JSON with changed, prs [{number:0,branch}] and summary. The numbers are placeholders; open-stack creates the PRs.`}
  </Task>;
  const review = <Task id="adversarial-review" output={outputs.review} agent={dryRun ? undefined : reviewAgent}>
    {dryRun ? () => ({ blockers: input.fixtures?.finding ? [input.fixtures.finding] : [], summary: "dry-run review" }) : `Review the entire current stack implementation in ${input.worktree}. Find only actionable blockers. Do not edit or push. Return JSON with blockers and summary.`}
  </Task>;
  const reviewLoop = <Loop id="adversarial-loop" maxIterations={maxRounds} onMaxReached="return-last" until={(ctx.latest(outputs.review, "adversarial-review")?.blockers?.length ?? 1) === 0}>
    <Sequence>{review}<Task id="fix-review" agent={dryRun ? undefined : agent("gpt-5.6-luna")}>
      {async () => {
        const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
        const fingerprint = blockers.join("\n");
        repeatedFinding = fingerprint !== "" && fingerprint === lastFindingFingerprint ? repeatedFinding + 1 : 0;
        lastFindingFingerprint = fingerprint;
        if (repeatedFinding >= 1 || blockers.length > 0 && maxRounds <= 1) produceWakeConditions({ taskId: `stack-owner:${input.repo}:${input.branch}`, maxAdversarial: true });
        if (dryRun) return { fixed: true };
        return `Fix every blocker in the latest adversarial review in ${input.worktree}. Run focused tests and commit. Do not open or merge PRs. If the same critical finding appears twice, stop and report it to the orchestrator.`;
      }}
    </Task></Sequence>
  </Loop>;
  const open = <Task id="open-stack" output={outputs.implementation} retries={1}>{async () => {
    const impl = ctx.latest(outputs.implementation, "implement-stack"); const planned = impl?.prs ?? [];
    if (dryRun) return { ...impl, summary: "dry-run PR stack opened" };
    const prs: Array<{ number: number; branch: string }> = [];
    let base = input.branch;
    for (const pr of planned) {
      const created = await execOrThrow(bunExec, [gh, "pr", "create", "--repo", input.repo, "--base", base, "--head", pr.branch, "--title", input.prompt.slice(0, 80), "--body", input.prompt], { cwd: input.worktree });
      const url = created.match(/https?:\/\/[^\\s]+\/pull\/\d+/)?.[0];
      const number = url ? Number(url.match(/\\d+$/)?.[0]) : Number(await execOrThrow(bunExec, [gh, "pr", "view", pr.branch, "--repo", input.repo, "--json", "number", "--jq", ".number"]));
      prs.push({ number, branch: pr.branch }); base = pr.branch;
    }
    if (prs.length) {
      const context = { gh, repo: input.repo, prNumber: prs[0].number, exec: bunExec };
      await executeReviewerRequest({ explicit: input.github?.reviewers ?? [], exclude: [], denylist: [], max: 2 }, {
        fetchChangedFiles: () => fetchChangedFiles(context, prs[0].number), fetchCodeowners: () => fetchCodeowners(context), fetchRecentAuthors: (files) => fetchRecentAuthors(context, files), resolveLogin: (name) => resolveReviewerLogin(context, name), isCollaborator: (login) => isCollaborator(context, login), requestReviewers: (logins) => requestReviewers(context, prs[0].number, logins), fetchRequestedReviewers: () => fetchRequestedReviewers(context, prs[0].number),
      });
    }
    return { changed: impl?.changed ?? true, prs, summary: "PR stack opened in dependency order" };
  }}</Task>;
  const poll = <Task id="poll-stack" output={outputs.poll} retries={2}>{async () => {
    const prs = ctx.latest(outputs.implementation, "implement-stack")?.prs ?? [];
    if (dryRun) { const signal = input.fixtures?.ciFail ? "ci-fail" : "complete"; return { signal, reason: signal === "ci-fail" ? "fixture CI failure" : "fixture complete" }; }
    const result = await pollStack(bunExec, input.repo, prs.map((p) => p.number), gh);
    produceWakeConditions({ taskId: `stack-owner:${input.repo}:${input.branch}`, ciFail: result.signal === "ci-fail", actionableComment: result.signal === "actionable-comment", decisionAsk: result.signal === "decision-ask" });
    return { signal: result.signal, reason: result.reason };
  }}</Task>;
  const watch = <Loop id="code-poll-loop" maxIterations={maxPolls} onMaxReached="return-last" until={ctx.latest(outputs.poll, "poll-stack")?.signal === "complete"}>
    <Sequence>{poll}<Task id="wake-fix" agent={undefined}>{async () => { const signal = ctx.latest(outputs.poll, "poll-stack")?.signal; if (signal === "idle") { if ((input.limits?.pollSeconds ?? 0) > 0) await wait((input.limits?.pollSeconds ?? 0) * 1000); return { action: "wait", signal }; } return { action: signal === "decision-ask" ? "escalate" : "fix", signal }; }}</Task></Sequence>
  </Loop>;
  return <Workflow name="lindy-stack-owner"><Sequence>{implementation}{reviewLoop}{open}{watch}<Task id="done" output={outputs.result}>{() => {
    const blockers = ctx.latest(outputs.review, "adversarial-review")?.blockers ?? [];
    const signal = ctx.latest(outputs.poll, "poll-stack")?.signal;
    const ok = blockers.length === 0 && signal === "complete";
    produceWakeConditions({ taskId: `stack-owner:${input.repo}:${input.branch}`, terminal: ok });
    return ok ? { done: true, summary: input.profile === "lindy-full" ? "green stack parked for captain stamp" : "green stack ready for yolo merge" } : { done: false, summary: `stack owner stopped with unresolved ${blockers.length ? "review blockers" : `${signal ?? "unknown"} poll signal`}` };
  }}</Task></Sequence></Workflow>;
});
