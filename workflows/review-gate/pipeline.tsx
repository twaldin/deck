/** @jsxImportSource smithers-orchestrator */
/** Captain review gate. Agents review and fix, but never approve. NEVER run any GitHub approve command. */
import { ContinueAsNew, Loop, Parallel, PiAgent, Sequence, Task, Workflow, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { ask, openQuestions, queueFile, readQuestions } from "../../v2/src/questions-store.ts";
import { defaultModelPolicy } from "../pr-pipeline/lib/models.ts";

const inputSchema = z.object({
  repo: z.string().min(1), worktree: z.string().min(1), captainLogin: z.string().min(1),
  dryRun: z.boolean().optional(), github: z.object({ gh: z.string().optional() }).optional(),
  limits: z.object({ polls: z.number().int().positive().optional(), rounds: z.number().int().positive().optional() }).optional(),
  fixtures: z.object({ prNumber: z.number().int().positive().optional(), title: z.string().optional(), requested: z.boolean().optional(), blockers: z.array(z.string()).optional(), pollCount: z.number().int().nonnegative().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  queue: z.object({ poll: z.number().int(), prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string(), headRefName: z.string().optional() })), at: z.string() }),
  review: z.object({ round: z.number().int(), prNumber: z.number().int(), approvable: z.boolean(), blockers: z.array(z.string()), findings: z.array(z.string()), summary: z.string(), headSha: z.string() }),
  fix: z.object({ round: z.number().int(), prNumber: z.number().int(), dispatched: z.boolean(), addressed: z.array(z.string()), summary: z.string() }),
  rebase: z.object({ round: z.number().int(), prNumber: z.number().int(), rebased: z.boolean(), summary: z.string() }),
  state: z.object({ round: z.number().int(), prNumber: z.number().int(), headSha: z.string(), mergeable: z.boolean(), ciGreen: z.boolean(), summary: z.string() }),
  captainQuestion: z.object({ queued: z.boolean(), id: z.string().nullable(), prNumber: z.number().int(), summary: z.string() }),
};
const { outputs, smithers } = createSmithers(schemas);
type Pr = { number: number; url: string; title: string; headRefName?: string };
const iso = () => new Date().toISOString();
async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function ghJson(cli: string, args: string[]): Promise<any> {
  const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  return JSON.parse(await new Response(proc.stdout).text());
}
async function requested(cli: string, repo: string, login: string): Promise<Pr[]> {
  return ghJson(cli, ["pr", "list", "--repo", repo, "--reviewer", login, "--state", "open", "--json", "number,url,title,headRefName"]);
}
async function state(cli: string, repo: string, pr: number): Promise<{ mergeable: boolean; ciGreen: boolean; headSha: string; summary: string }> {
  const value = await ghJson(cli, ["pr", "view", String(pr), "--repo", repo, "--json", "mergeable,mergeStateStatus,statusCheckRollup,headRefOid"]);
  const checks = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const ciGreen = checks.length > 0 && checks.every((check: any) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(check.conclusion ?? check.state).toUpperCase()));
  const mergeable = value.mergeable === "MERGEABLE" && value.mergeStateStatus === "CLEAN";
  return { mergeable, ciGreen, headSha: String(value.headRefOid ?? ""), summary: `mergeable=${value.mergeable} mergeState=${value.mergeStateStatus} checks=${checks.length}` };
}
function agent(model: string, cwd: string, noTools = false): PiAgent {
  return new PiAgent({ provider: "deck", model, cwd, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, ...(noTools ? { noTools: true } : {}) });
}

export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun !== false; const cli = input.github?.gh ?? "gh";
  const fixtures = input.fixtures ?? {}; const rounds = input.limits?.rounds ?? 8; const polls = input.limits?.polls ?? 8;
  const queueRows = (ctx.outputs.queue ?? []) as Array<{ poll: number; prs: Pr[] }>;
  const prs = [...new Map(queueRows.flatMap((row) => row.prs).map((pr) => [pr.number, pr])).values()];
  const policy = defaultModelPolicy();
  const reviewModel = agent("gpt-5.6-sol", input.worktree, true); const fixModel = agent("gpt-5.6-luna", input.worktree); const rebaseModel = agent("gpt-5.6-luna", input.worktree);
  void policy;
  const poll = async (): Promise<Pr[]> => {
    if (dryRun) return fixtures.requested === false || queueRows.length < (fixtures.pollCount ?? 0) ? [] : [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/${fixtures.prNumber ?? 1}`, title: fixtures.title ?? "fixture PR" }];
    return requested(cli, input.repo, input.captainLogin);
  };
  const reviewPrompt = (pr: Pr, round: number) => `You are Sathira's Gate review engine. Review PR #${pr.number} (${pr.url}) in ${input.repo} at ${input.worktree}. You have no tools and must not make GitHub changes. Load the exact skills .agent/skills/sathiras-gate and .agent/skills/thermo-nuclear-code-quality-review before reviewing. Review only this PR's actual diff and CI. Return JSON only: {"round":${round},"prNumber":${pr.number},"approvable":boolean,"blockers":string[],"findings":string[],"summary":string,"headSha":"the PR head SHA you reviewed"}. The workflow independently verifies mergeability and CI; do not claim those checks prove anything.`;
  const isolatedWorktree = (pr: Pr) => `${input.worktree}/.review-gate-pr-${pr.number}`;
  const gateReady = (review: any, checked: any) => review?.approvable === true && review?.blockers?.length === 0 && checked?.mergeable === true && checked?.ciGreen === true && review?.headSha === checked?.headSha;
  const reviewPath = (pr: Pr) => {
    const reviews = (ctx.outputs.review ?? []) as Array<any>; const latest = reviews.filter((x) => x.prNumber === pr.number).at(-1);
    const fixes = (ctx.outputs.fix ?? []) as Array<any>; const fixed = fixes.filter((x) => x.prNumber === pr.number).at(-1);
    const states = (ctx.outputs.state ?? []) as Array<any>; const checked = states.filter((x) => x.prNumber === pr.number).at(-1);
    const question = (ctx.outputs.captainQuestion ?? []) as Array<any>;
    return <Sequence><Loop id={`gate-loop-${pr.number}`} until={gateReady(latest, checked)} maxIterations={rounds} onMaxReached="return-last"><Sequence>
      <Task id={`gate-review-${pr.number}`} output={outputs.review} agent={dryRun ? undefined : reviewModel} retries={1}>{dryRun ? () => { const blockers = fixtures.blockers ?? []; return { round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number, approvable: blockers.length === 0, blockers, findings: blockers, headSha: "fixture-head", summary: blockers.length ? "fixture blockers" : "fixture clean" }; } : reviewPrompt(pr, reviews.filter((x) => x.prNumber === pr.number).length)}</Task>
      <Task id={`gate-state-${pr.number}`} output={outputs.state} retries={1}>{async () => { const result = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, headSha: "fixture-head", summary: "fixture state" } : await state(cli, input.repo, pr.number); return { ...result, headSha: result.headSha ?? "fixture-head", round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number }; }}</Task>
      {latest && (!latest.approvable || latest.blockers.length > 0) && (fixed === undefined || fixed.round < latest.round) ? <Task id={`gate-fix-${pr.number}`} output={outputs.fix} agent={dryRun ? undefined : fixModel} retries={1}>{dryRun ? () => ({ round: latest.round, prNumber: pr.number, dispatched: true, addressed: latest.blockers, summary: "fixture fix dispatched" }) : `Fix every finding from Sathira's Gate review for PR #${pr.number} (${pr.url}) only in the dedicated worktree ${isolatedWorktree(pr)}. First create or verify that worktree is checked out at PR head branch ${pr.headRefName ?? "the PR branch"}; never edit or push ${input.worktree}. Make the smallest safe changes, run targeted tests, and push only that PR branch. Return JSON {"round":${latest.round},"prNumber":${pr.number},"dispatched":true,"addressed":string[],"summary":string}. Do not approve the PR.`}</Task> : null}
      {latest && checked && (!checked.mergeable || !checked.ciGreen) ? <Task id={`gate-rebase-${pr.number}`} output={outputs.rebase} agent={dryRun ? undefined : rebaseModel} retries={1}>{dryRun ? () => ({ round: latest.round, prNumber: pr.number, rebased: true, summary: "fixture rebase checked" }) : `Inspect PR #${pr.number} (${pr.url}) only in dedicated worktree ${isolatedWorktree(pr)}. Verify its branch is ${pr.headRefName ?? "the PR branch"} before any change. If it is behind or conflicting, rebase that branch onto the base branch and push only that branch. Never edit or push ${input.worktree}. Return JSON {"round":${latest.round},"prNumber":${pr.number},"rebased":boolean,"summary":string}. Never approve the PR.`}</Task> : null}
    </Sequence></Loop><Task id={`gate-final-state-${pr.number}`} output={outputs.state} retries={1}>{async () => { const result = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, headSha: "fixture-head", summary: "fixture final state" } : await state(cli, input.repo, pr.number); return { ...result, round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number }; }}</Task></Sequence>;
  };
  return <Workflow name="lindy-review-gate"><Parallel maxConcurrency={1}>
    <Loop id="review-request-polls" until={false} maxIterations={polls} onMaxReached="return-last"><Task id="review-requested-poll" output={outputs.queue} retries={2}>{async () => { const n = queueRows.length; if (n > 0) await sleep(1000); return { poll: n, prs: await poll(), at: iso() }; }}</Task></Loop>
    {prs.map(reviewPath)}
    {prs.map((pr) => { const latest = (ctx.outputs.review ?? []).filter((x: any) => x.prNumber === pr.number).at(-1); const checked = (ctx.outputs.state ?? []).filter((x: any) => x.prNumber === pr.number).at(-1); const durable = readQuestions(queueFile()).some((x) => x.id === `review-gate-pr-${pr.number}` || x.id.endsWith(`:review-gate-pr-${pr.number}`)); return gateReady(latest, checked) && !durable ? <Task id={`captain-question-${pr.number}`} output={outputs.captainQuestion} retries={1}>{async () => { const review = latest!; const fresh = dryRun ? { mergeable: true, ciGreen: true, headSha: "fixture-head" } : await state(cli, input.repo, pr.number); if (!gateReady(review, fresh)) return { queued: false, id: null, prNumber: pr.number, summary: "head or gate state changed; review required" }; const summary = [`PR: ${pr.url}`, `Title: ${pr.title}`, `What it does: ${review.summary}`, `Gate findings: ${JSON.stringify(review.findings)}`, `CI + review state: verified mergeable and green at ${fresh.headSha}`, `Only the captain may approve it.`].join("\n"); if (dryRun) return { queued: true, id: "dry-run:captain-question", prNumber: pr.number, summary }; const event = ask(queueFile(), { id: `review-gate-pr-${pr.number}`, idScope: "global", question: `Captain approval needed for PR #${pr.number}: ${pr.title}`, context: summary, questionKind: "stamp", urgency: "high", sessionId: process.env.PI_SESSION_ID ?? "review-gate", cwd: input.worktree }); return { queued: true, id: event.id, prNumber: pr.number, summary }; }}</Task> : null; })}
  </Parallel><ContinueAsNew state={{ trigger: "review-request-change" }} /></Workflow>;
});
