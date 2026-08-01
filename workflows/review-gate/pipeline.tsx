/** @jsxImportSource smithers-orchestrator */
/** Captain review gate. Agents review and fix, but never approve. */
import { Loop, Parallel, PiAgent, Sequence, Task, Workflow, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { ask, queueFile } from "../../v2/src/questions-store.ts";

const inputSchema = z.object({
  repo: z.string().min(1),
  worktree: z.string().min(1),
  captainLogin: z.string().min(1),
  dryRun: z.boolean().optional(),
  github: z.object({ gh: z.string().optional() }).optional(),
  limits: z.object({ polls: z.number().int().positive().optional(), rounds: z.number().int().positive().optional() }).optional(),
  fixtures: z.object({
    prNumber: z.number().int().positive().optional(),
    title: z.string().optional(),
    requested: z.boolean().optional(),
    blockers: z.array(z.string()).optional(),
    pollCount: z.number().int().nonnegative().optional(),
  }).optional(),
});

const schemas = {
  input: inputSchema,
  queue: z.object({ poll: z.number().int(), prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string() })), at: z.string() }),
  review: z.object({ round: z.number().int(), approvable: z.boolean(), blockers: z.array(z.string()), findings: z.array(z.string()), summary: z.string() }),
  fix: z.object({ round: z.number().int(), dispatched: z.boolean(), addressed: z.array(z.string()), summary: z.string() }),
  rebase: z.object({ rebased: z.boolean(), summary: z.string() }),
  captainQuestion: z.object({ queued: z.boolean(), id: z.string().nullable(), prNumber: z.number().int(), summary: z.string() }),
};
const { outputs, smithers } = createSmithers(schemas);

type Pr = { number: number; url: string; title: string };
const iso = () => new Date().toISOString();

async function shell(gh: string, repo: string, captainLogin: string): Promise<Pr[]> {
  const proc = Bun.spawn([gh, "pr", "list", "--repo", repo, "--reviewer", captainLogin, "--state", "open", "--json", "number,url,title"], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  return JSON.parse(await new Response(proc.stdout).text()) as Pr[];
}
function agent(model: string, cwd: string): PiAgent { return new PiAgent({ provider: "deck", model, cwd, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true }); }

export default smithers((ctx) => {
  const input = ctx.input;
  const dryRun = input.dryRun !== false;
  const gh = input.github?.gh ?? "gh";
  const fixtures = input.fixtures ?? {};
  const queue = ctx.latest(outputs.queue, "review-requested-poll");
  const pr = queue?.prs[0];
  const reviewRows = (ctx.outputs.review ?? []) as Array<{ round: number; approvable: boolean; blockers: string[] }>;
  const latestReview = ctx.latest(outputs.review, "gate-review");
  const latestFix = ctx.latest(outputs.fix, "gate-fix");
  const latestRebase = ctx.latest(outputs.rebase, "gate-rebase");
  const question = ctx.latest(outputs.captainQuestion, "captain-question");
  const pollCount = (ctx.outputs.queue ?? []).length;
  const rounds = input.limits?.rounds ?? 8;
  const reviewModel = agent("claude-fable-5", input.worktree);
  const fixModel = agent("claude-fable-5", input.worktree);
  const requestedPoll = async (): Promise<Pr[]> => {
    if (dryRun) return fixtures.requested === false ? [] : [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/1`, title: fixtures.title ?? "fixture PR" }];
    return shell(gh, input.repo, input.captainLogin);
  };
  const gatePrompt = (round: number) => `You are Sathira's Gate review engine. Review the captain's requested PR in ${input.repo} at ${input.worktree}. Read the sathira-gate/thermo-nuclear quality review skill. Review the actual diff and CI. NEVER run any GitHub approve command and NEVER issue an APPROVE review. You may post COMMENT or REQUEST_CHANGES only. Return JSON only: {"round":${round},"approvable":boolean,"blockers":string[],"findings":string[],"summary":string}. Easy findings must be handed to the fix coworker by the workflow, not left for the captain. A PR is approvable only when it has no blockers, is mergeable, and CI is green.`;
  return <Workflow name="lindy-review-gate"><Parallel maxConcurrency={1}>
    <Task id="review-requested-poll" output={outputs.queue} retries={2}>{async () => ({ poll: pollCount, prs: await requestedPoll(), at: iso() })}</Task>
    {pr ? <Loop id="gate-loop" until={latestReview?.approvable === true} maxIterations={rounds} onMaxReached="return-last"><Sequence>
      <Task id="gate-review" output={outputs.review} agent={dryRun ? undefined : reviewModel} retries={1}>{dryRun ? () => { const blockers = fixtures.blockers ?? []; return { round: reviewRows.length, approvable: blockers.length === 0, blockers, findings: blockers, summary: blockers.length ? "fixture blockers" : "fixture clean" }; } : gatePrompt(reviewRows.length)}</Task>
      {latestReview && !latestReview.approvable && latestReview.blockers.length > 0 && (latestFix === undefined || latestFix.round < latestReview.round) ? <Task id="gate-fix" output={outputs.fix} agent={dryRun ? undefined : fixModel} retries={1}>{dryRun ? () => ({ round: latestReview.round, dispatched: true, addressed: latestReview.blockers, summary: "fixture fix dispatched" }) : `Fix every finding from Sathira's Gate review in ${input.worktree}. Work as the coworker fix agent. Make the smallest safe changes, run targeted tests, push the branch, and return JSON {"round":${latestReview.round},"dispatched":true,"addressed":string[],"summary":string}. Do not approve the PR.`}</Task> : null}
      {latestFix?.dispatched === true && latestRebase === undefined ? <Task id="gate-rebase" output={outputs.rebase} retries={1}>{dryRun ? () => ({ rebased: true, summary: "fixture rebase checked" }) : `Check whether the captain PR needs a rebase in ${input.worktree}. Rebase and push only when required. Return JSON {"rebased":boolean,"summary":string}. Never approve the PR.`}</Task> : null}
    </Sequence></Loop> : null}
    {pr && latestReview?.approvable === true && question === undefined ? <Task id="captain-question" output={outputs.captainQuestion} retries={1}>{() => { const summary = [`PR: ${pr.url}`, `Title: ${pr.title}`, `What it does: ${latestReview.summary}`, `Gate findings: ${JSON.stringify(latestReview.findings)}`, `CI + review state: no blockers, mergeable, green`, `Why ready: Sathira's Gate judged this PR approvable.`, `Only the captain may approve it.`].join("\n"); if (dryRun) return { queued: true, id: "dry-run:captain-question", prNumber: pr.number, summary }; const event = ask(queueFile(), { id: `review-gate-pr-${pr.number}`, question: `Captain approval needed for PR #${pr.number}: ${pr.title}`, context: summary, questionKind: "stamp", urgency: "high", sessionId: process.env.PI_SESSION_ID ?? "review-gate", cwd: input.worktree }); return { queued: true, id: event.id, prNumber: pr.number, summary }; }}</Task> : null}
  </Parallel></Workflow>;
});
