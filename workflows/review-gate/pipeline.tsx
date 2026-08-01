/** @jsxImportSource smithers-orchestrator */
/** Captain review gate. Agents review and fix, but never approve.
 * NEVER run any GitHub approval command. NEVER run any GitHub approve command.
 */
import { ContinueAsNew, Loop, Parallel, PiAgent, Sequence, Task, Workflow, Worktree, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { askIfAbsent, openQuestions, queueFile } from "../../v2/src/questions-store.ts";
import { defaultModelPolicy } from "../pr-pipeline/lib/models.ts";

const inputSchema = z.object({
  repo: z.string().min(1), worktree: z.string().min(1), captainLogin: z.string().min(1),
  dryRun: z.boolean().optional(), github: z.object({ gh: z.string().optional() }).optional(),
  limits: z.object({ polls: z.number().int().positive().optional(), rounds: z.number().int().positive().optional() }).optional(),
  fixtures: z.object({ prNumber: z.number().int().positive().optional(), title: z.string().optional(), requested: z.boolean().optional(), blockers: z.array(z.string()).optional(), pollCount: z.number().int().nonnegative().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  queue: z.object({ poll: z.number().int(), prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string(), headRefName: z.string().optional(), headRefOid: z.string().optional() })), at: z.string() }),
  review: z.object({ round: z.number().int(), prNumber: z.number().int(), approvable: z.boolean(), blockers: z.array(z.string()), findings: z.array(z.string()), summary: z.string(), headSha: z.string() }),
  fix: z.object({ round: z.number().int(), prNumber: z.number().int(), dispatched: z.boolean(), addressed: z.array(z.string()), summary: z.string() }),
  rebase: z.object({ round: z.number().int(), prNumber: z.number().int(), rebased: z.boolean(), summary: z.string() }),
  state: z.object({ round: z.number().int(), prNumber: z.number().int(), headSha: z.string(), mergeable: z.boolean(), ciGreen: z.boolean(), summary: z.string() }),
  captainQuestion: z.object({ queued: z.boolean(), id: z.string().nullable(), prNumber: z.number().int(), summary: z.string() }),
};
const { outputs, smithers } = createSmithers(schemas);
type Pr = { number: number; url: string; title: string; headRefName?: string; headRefOid?: string };
const iso = () => new Date().toISOString();
async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function ghJson(cli: string, args: string[]): Promise<any> {
  const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  return JSON.parse(await new Response(proc.stdout).text());
}
async function requested(cli: string, repo: string, login: string): Promise<Pr[]> {
  return ghJson(cli, ["pr", "list", "--repo", repo, "--reviewer", login, "--state", "open", "--json", "number,url,title,headRefName,headRefOid"]);
}
async function state(cli: string, repo: string, pr: number): Promise<{ mergeable: boolean; ciGreen: boolean; headSha: string; summary: string }> {
  const value = await ghJson(cli, ["pr", "view", String(pr), "--repo", repo, "--json", "mergeable,mergeStateStatus,statusCheckRollup,headRefOid"]);
  const checks = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const ciGreen = checks.length > 0 && checks.every((check: any) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(check.conclusion ?? check.state).toUpperCase()));
  const mergeable = value.mergeable === "MERGEABLE" && value.mergeStateStatus === "CLEAN";
  return { mergeable, ciGreen, headSha: String(value.headRefOid ?? ""), summary: `mergeable=${value.mergeable} mergeState=${value.mergeStateStatus} checks=${checks.length}` };
}
function agent(model: string, noTools = false): PiAgent {
  return new PiAgent({ provider: "deck", model, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, ...(noTools ? { noTools: true } : {}), tools: noTools ? undefined : ["read", "grep", "edit", "write", "bash"] });
}

export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun === true; const cli = input.github?.gh ?? "gh";
  const fixtures = input.fixtures ?? {}; const rounds = input.limits?.rounds ?? 8; const polls = input.limits?.polls ?? 8;
  // ContinueAsNew stores the user state in this envelope. Read it before outputs:
  // outputs from the predecessor are not part of the new run.
  const continuation = (input as any).__smithersContinuation?.payload ?? {};
  const queuePath = `${input.worktree}/.review-gate-queue.json`;
  const persistedRows = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : [];
  const carriedRows = (continuation.queue ?? persistedRows) as Array<{ poll: number; prs: Pr[] }>;
  const queueRows = [...carriedRows, ...((ctx.outputs.queue ?? []) as Array<{ poll: number; prs: Pr[] }>)];
  // Only the newest poll is live. Historical rows are audit data, not work.
  const liveRows = queueRows.at(-1)?.prs ?? [];
  const discovered = dryRun && fixtures.requested !== false ? [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/${fixtures.prNumber ?? 1}`, title: fixtures.title ?? "fixture PR", headRefName: `fixture-${fixtures.prNumber ?? 1}`, headRefOid: "fixture-head" }] : [];
  const prs = [...new Map([...liveRows, ...discovered].map((pr) => [pr.number, pr])).values()];
  const policy = defaultModelPolicy();
  const reviewModel = new PiAgent({ provider: "deck", model: "gpt-5.6-sol", cwd: input.worktree, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, tools: ["read", "grep", "bash"] }); const fixModel = agent("gpt-5.6-luna"); const rebaseModel = agent("gpt-5.6-luna");
  void policy;
  const poll = async (): Promise<Pr[]> => {
    if (dryRun) return fixtures.requested === false || pollCount >= polls || pollCount < (fixtures.pollCount ?? 0) ? [] : [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/${fixtures.prNumber ?? 1}`, title: fixtures.title ?? "fixture PR", headRefName: `fixture-${fixtures.prNumber ?? 1}`, headRefOid: "fixture-head" }];
    return requested(cli, input.repo, input.captainLogin);
  };
  const reviewPrompt = (pr: Pr, round: number) => `You are Sathira's Gate review engine. Load and follow ${process.cwd()}/.smithers/skills/sathiras-gate/SKILL.md and ${process.cwd()}/.smithers/skills/thermo-nuclear-code-quality-review/SKILL.md before reviewing. Load the exact skills .agent/skills/sathiras-gate and .agent/skills/thermo-nuclear-code-quality-review. Review PR #${pr.number} (${pr.url}) in the prepared PR-head worktree ${isolatedWorktree(pr)}. Verify the exact head SHA ${pr.headRefOid ?? "from GitHub"} with the GitHub CLI before reviewing. Use bash to inspect only this PR's actual diff, tests, security, failure modes, and CI. You have read-only authority: do not edit, commit, push, or approve. NEVER run any GitHub approval command. Return JSON only: {"round":${round},"prNumber":${pr.number},"approvable":boolean,"blockers":string[],"findings":string[],"summary":string,"headSha":"the PR head SHA you reviewed"}. The workflow independently verifies mergeability and CI.`;
  const isolatedWorktree = (pr: Pr) => `${input.worktree}/.review-gate-pr-${pr.number}`;
  const gateReady = (review: any, checked: any) => review?.approvable === true && review?.blockers?.length === 0 && checked?.mergeable === true && checked?.ciGreen === true && review?.headSha === checked?.headSha;
  const failedChecks = (checked: any) => checked?.ciGreen === false ? `CI is red. Inspect failed checks and logs for PR #${checked.prNumber}, diagnose the failure, and repair it.` : "";
  // Legacy gate invariant: latest.blockers.length > 0 dispatches the fix path.
  // Load the exact skills .agent/skills/sathiras-gate and thermo-nuclear-code-quality-review.
  const blockerDispatch = (latest: any) => (latest?.blockers?.length ?? 0) > 0;
  // The rebaseModel remains available for future isolated rebase-only policy.
  const reviewPath = (pr: Pr) => {
    const reviews = (ctx.outputs.review ?? []) as Array<any>; const latest = reviews.filter((x) => x.prNumber === pr.number).at(-1);
    const states = (ctx.outputs.state ?? []) as Array<any>; const checked = states.filter((x) => x.prNumber === pr.number).at(-1);
    return <Sequence><Loop id={`gate-loop-${pr.number}`} until={ctx.latest(outputs.review, `gate-review-${pr.number}`)?.approvable === true && (ctx.latest(outputs.review, `gate-review-${pr.number}`)?.blockers?.length ?? 1) === 0 && ctx.latest(outputs.state, `gate-state-${pr.number}`)?.mergeable === true && ctx.latest(outputs.state, `gate-state-${pr.number}`)?.ciGreen === true && ctx.latest(outputs.review, `gate-review-${pr.number}`)?.headSha === ctx.latest(outputs.state, `gate-state-${pr.number}`)?.headSha} maxIterations={rounds} onMaxReached="fail"><Sequence>
      <Task id={`gate-prepare-${pr.number}`} retries={1}>{async () => { if (dryRun) return { prepared: true, headSha: "fixture-head" }; const target = pr.headRefOid ?? (await ghJson(cli, ["pr", "view", String(pr.number), "--repo", input.repo, "--json", "headRefOid"])).headRefOid; const proc = Bun.spawn(["git", "-C", isolatedWorktree(pr), "fetch", "origin", `${target}:refs/remotes/origin/review-gate-${pr.number}`], { stdout: "pipe", stderr: "pipe" }); if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text()); const checkout = Bun.spawn(["git", "-C", isolatedWorktree(pr), "checkout", "--detach", target], { stdout: "pipe", stderr: "pipe" }); if (await checkout.exited !== 0) throw new Error(await new Response(checkout.stderr).text()); return { prepared: true, headSha: target }; }}</Task>
      <Task id={`gate-review-${pr.number}`} output={outputs.review} agent={dryRun ? undefined : reviewModel} retries={1}>{dryRun ? () => { const blockers = fixtures.blockers ?? []; return { round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number, approvable: blockers.length === 0, blockers, findings: blockers, headSha: "fixture-head", summary: blockers.length ? "fixture blockers" : "fixture clean" }; } : reviewPrompt(pr, reviews.filter((x) => x.prNumber === pr.number).length)}</Task>
      <Task id={`gate-state-${pr.number}`} output={outputs.state} retries={1}>{async () => { const result = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, headSha: "fixture-head", summary: "fixture state" } : await state(cli, input.repo, pr.number); return { ...result, headSha: result.headSha ?? "fixture-head", round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number }; }}</Task>
      {((ctx.latest(outputs.review, `gate-review-${pr.number}`)?.blockers?.length ?? 0) > 0 || ctx.latest(outputs.state, `gate-state-${pr.number}`)?.ciGreen === false || ctx.latest(outputs.state, `gate-state-${pr.number}`)?.mergeable === false) ? <Worktree id={`gate-repair-worktree-${pr.number}`} path={isolatedWorktree(pr)} branch={pr.headRefName}><Task id={`gate-fix-${pr.number}`} output={outputs.fix} agent={dryRun ? undefined : fixModel} retries={1}>{dryRun ? () => ({ round: (ctx.outputs.review ?? []).filter((x: any) => x.prNumber === pr.number).length, prNumber: pr.number, dispatched: (fixtures.blockers ?? []).length > 0, addressed: fixtures.blockers ?? [], summary: "fixture repair" }) : `Fix every finding from Sathira's Gate review. Load ${process.cwd()}/.smithers/skills/sathiras-gate/SKILL.md and ${process.cwd()}/.smithers/skills/thermo-nuclear-code-quality-review/SKILL.md. Dispatch only for blockers or failed checks. Read the latest review and state for PR #${pr.number} (${pr.url}) in ${isolatedWorktree(pr)}. Repair CI and blockers. If branch state is behind or conflicting, rebase it with plain commits. Verify the exact PR head. Never touch ${input.worktree}. Commit and push only this PR branch. Do not approve. Return JSON.`}</Task></Worktree> : null}
    </Sequence></Loop><Task id={`gate-final-state-${pr.number}`} output={outputs.state} retries={1}>{async () => { const result = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, headSha: "fixture-head", summary: "fixture final state" } : await state(cli, input.repo, pr.number); const finalReview = (ctx.outputs.review ?? []).filter((x: any) => x.prNumber === pr.number).at(-1); const final = { ...result, round: reviews.filter((x) => x.prNumber === pr.number).length, prNumber: pr.number }; if (!gateReady(finalReview, final)) { throw new Error(`review gate unresolved for PR #${pr.number}: ${final.summary}`); } return final; }}</Task></Sequence>;
  };
  // Poll loop is bounded by the configured maxIterations={polls} across continuations.
  const phase = (continuation.phase ?? "poll") as "poll" | "review";
  const pollCount = Number(continuation.pollCount ?? 0);
  const nextState = { ...input, queue: queueRows, pollCount: pollCount + (phase === "poll" ? 1 : 0), phase: phase === "poll" ? "review" : "poll", trigger: "review-request-change", launcher: "review-gate/launch.ts" };
  return <Workflow name="lindy-review-gate">{phase === "poll" ? <Sequence>
    <Task id="review-requested-poll" output={outputs.queue} retries={2}>{async () => { const n = queueRows.length; if (n > 0) await sleep(1000); const row = { poll: n, prs: await poll(), at: iso() }; const rows = [...queueRows, row]; writeFileSync(queuePath, JSON.stringify(rows)); return row; }}</Task>
    <ContinueAsNew state={nextState} />
  </Sequence> : <Parallel maxConcurrency={1}>
    {prs.map((pr) => <Worktree id={`gate-review-worktree-${pr.number}`} path={isolatedWorktree(pr)} branch={pr.headRefName}><Sequence>{reviewPath(pr)}</Sequence></Worktree>)}
    {prs.map((pr) => <Task id={`captain-question-${pr.number}`} output={outputs.captainQuestion} retries={1}>{async () => { const latest = ctx.latest(outputs.review, `gate-review-${pr.number}`); const checked = ctx.latest(outputs.state, `gate-state-${pr.number}`); if (!gateReady(latest, checked)) return { queued: false, id: null, prNumber: pr.number, summary: "gate not ready" }; const fresh = dryRun ? { mergeable: true, ciGreen: true, headSha: "fixture-head" } : await state(cli, input.repo, pr.number); if (!gateReady(latest, fresh)) return { queued: false, id: null, prNumber: pr.number, summary: "head or gate state changed; review required" }; const id = `review-gate-pr-${pr.number}-${fresh.headSha}`; if (openQuestions(queueFile()).some((x) => x.id === id)) return { queued: false, id, prNumber: pr.number, summary: "question already queued" }; const summary = [`PR: ${pr.url}`, `Title: ${pr.title}`, `What it does: ${latest!.summary}`, `Gate findings: ${JSON.stringify(latest!.findings)}`, `CI + review state: verified mergeable and green at ${fresh.headSha}`, `Only the captain may make the review decision.`].join("\n"); if (dryRun) return { queued: true, id: "dry-run:captain-question", prNumber: pr.number, summary }; const event = askIfAbsent(queueFile(), { id, idScope: "global", question: `Captain approval needed for PR #${pr.number}: ${pr.title}`, context: summary, questionKind: "stamp", urgency: "high", sessionId: process.env.PI_SESSION_ID ?? "review-gate", cwd: input.worktree }); return { queued: true, id: event.id, prNumber: pr.number, summary }; }}</Task>)}
    <ContinueAsNew state={nextState} />
  </Parallel>}</Workflow>;
});
