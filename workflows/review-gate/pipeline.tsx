/** @jsxImportSource smithers-orchestrator */
/** Operator review gate. Agents review and fix, but never approve or merge. */
/** NEVER run any GitHub approve command. */
import { Approval, Branch, ContinueAsNew, Loop, Parallel, Poller, Sequence, Task, Timer, Workflow, Worktree, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { askWorkflowQuestion, openQuestions, queueFile, readQuestionHistory, readQuestions } from "../../v2/src/questions-store.ts";
import { DECK_PROVIDER, defaultModelPolicy, modelReasoningPolicy } from "../pr-pipeline/lib/models.ts";
import { PrimeSeatAgent } from "../pr-pipeline/lib/engines/prime.ts";
import { shouldSubmitReview, reviewCommand } from "./decision.ts";

const inputSchema = z.object({
  repo: z.string().min(1).default(process.env.GITHUB_REPOSITORY ?? "local/repository"),
  worktree: z.string().min(1).default(process.cwd()),
  captainLogin: z.string().min(1).default(process.env.GITHUB_ACTOR ?? process.env.USER ?? "operator"),
  ticket: z.string().optional(),
  brief: z.object({ summary: z.string().optional() }).optional(),
  dryRun: z.boolean().optional(), github: z.object({ gh: z.string().optional() }).optional(),
  limits: z.object({ polls: z.number().int().positive().optional(), rounds: z.number().int().positive().optional(), intervalMs: z.number().int().positive().optional() }).optional(),
  fixtures: z.object({ prNumber: z.number().int().positive().optional(), title: z.string().optional(), requested: z.boolean().optional(), blockers: z.array(z.string()).optional(), pollCount: z.number().int().nonnegative().optional(), originalIssue: z.string().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  queue: z.object({ poll: z.number().int(), prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string(), headRefName: z.string().optional(), headRefOid: z.string().optional() })), at: z.string(), satisfied: z.boolean() }),
  prepare: z.object({ prepared: z.boolean(), headSha: z.string() }),
  review: z.object({ round: z.number().int(), prNumber: z.number().int(), approvable: z.boolean(), blockers: z.array(z.string()), findings: z.array(z.string()), summary: z.string(), headSha: z.string() }),
  fix: z.object({ round: z.number().int(), prNumber: z.number().int(), dispatched: z.boolean(), addressed: z.array(z.string()), summary: z.string() }),
  report: z.object({ round: z.number().int(), prNumber: z.number().int(), blockers: z.array(z.string()), draftBody: z.string(), draftFingerprint: z.string(), posted: z.boolean(), requestedChanges: z.boolean(), summary: z.string() }),
  state: z.object({ round: z.number().int(), prNumber: z.number().int(), headSha: z.string(), mergeable: z.boolean(), ciGreen: z.boolean(), ciPending: z.boolean(), mergeStateStatus: z.string(), summary: z.string() }),
  captainQuestion: z.object({ queued: z.boolean(), id: z.string().nullable(), prNumber: z.number().int(), summary: z.string() }),
  reviewApproval: z.object({ approved: z.boolean(), note: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable() }),
  submit: z.object({ submitted: z.boolean(), reason: z.string().optional(), verdict: z.enum(["comment", "request-changes"]).optional() }),
};
const { outputs, smithers } = createSmithers(schemas);
type Pr = { number: number; url: string; title: string; headRefName?: string; headRefOid?: string };
export function reviewGateKey(pr: Pick<Pr, "number" | "headRefOid">): string {
  const head = pr.headRefOid ?? "";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(head)) {
    throw new Error(`review-gate PR #${pr.number} needs a safe head identity`);
  }
  return `${pr.number}-${head}`;
}
export function readQueuedPrs(file: string): Pr[] {
  try {
    const parsed = z.array(schemas.queue).safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.at(-1)?.prs ?? [] : [];
  } catch {
    return [];
  }
}
const iso = () => new Date().toISOString();
async function ghJson(cli: string, args: string[]): Promise<any> {
  const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  return JSON.parse(await new Response(proc.stdout).text());
}
async function ghRun(cli: string, args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn([cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}
async function requested(cli: string, repo: string, login: string): Promise<Pr[]> { return ghJson(cli, ["pr", "list", "--repo", repo, "--search", `review-requested:${login}`, "--state", "open", "--json", "number,url,title,headRefName,headRefOid"]); }
export function assessCi(checks: Array<{ conclusion?: unknown; status?: unknown; state?: unknown }>): { ciGreen: boolean; ciPending: boolean } {
  const states = checks.map((check) => String(check.conclusion || check.status || check.state).toUpperCase());
  return {
    ciPending: checks.length === 0 || states.some((state) => ["PENDING", "QUEUED", "IN_PROGRESS"].includes(state)),
    ciGreen: checks.length > 0 && states.every((state) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state)),
  };
}
export function reviewDecisionBlockers(
  review: { approvable?: boolean; blockers?: string[]; headSha?: string; summary?: string } | undefined,
  current: { mergeable?: boolean; ciGreen?: boolean; ciPending?: boolean; mergeStateStatus?: string; headSha?: string; summary?: string } | undefined,
): string[] {
  const blockers = [...(review?.blockers ?? [])];
  if (review?.approvable !== true && blockers.length === 0) {
    blockers.push(`Automated review did not mark the PR approvable: ${review?.summary ?? "review unavailable"}`);
  }
  if (current === undefined) {
    blockers.push("Current PR state is unavailable.");
    return blockers;
  }
  if (review?.headSha !== current.headSha) {
    blockers.push(`PR head changed from ${review?.headSha ?? "unknown"} to ${current.headSha ?? "unknown"}.`);
  }
  if (current.mergeable !== true) {
    blockers.push(`PR is not mergeable (${current.mergeStateStatus ?? "UNKNOWN"}): ${current.summary ?? "state unavailable"}`);
  }
  if (current.ciPending === true) {
    blockers.push(`CI is still pending: ${current.summary ?? "state unavailable"}`);
  } else if (current.ciGreen !== true) {
    blockers.push(`CI is not green: ${current.summary ?? "state unavailable"}`);
  }
  return blockers;
}

async function state(cli: string, repo: string, pr: number) {
  const v = await ghJson(cli, ["pr", "view", String(pr), "--repo", repo, "--json", "mergeable,mergeStateStatus,statusCheckRollup,headRefOid"]);
  const checks = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  const mergeStateStatus = String(v.mergeStateStatus ?? "UNKNOWN");
  const { ciGreen, ciPending } = assessCi(checks);
  return { mergeable: v.mergeable === "MERGEABLE" && !["DIRTY", "BEHIND", "UNSTABLE"].includes(mergeStateStatus), ciGreen, ciPending, mergeStateStatus, headSha: String(v.headRefOid ?? ""), summary: `mergeable=${v.mergeable} mergeStateStatus=${mergeStateStatus} checks=${checks.length}` };
}
export function createReviewGateAgent(model: string, cwd: string, effortLabel = "review-gate"): PrimeSeatAgent {
  const policy = defaultModelPolicy();
  return new PrimeSeatAgent({
    provider: DECK_PROVIDER,
    model,
    cwd,
    effortLabel,
    timeoutMs: 30 * 60_000,
    thinking: modelReasoningPolicy(policy)[`${DECK_PROVIDER}/${model}`] ?? "xhigh",
    modelPolicy: policy,
  });
}
function reviewComment(pr: Pr, blockers: string[]): string {
  return [`Review found ${blockers.length} blocker(s) on PR #${pr.number}.`, ...blockers.map((item, i) => `${i + 1}. ${item}`), "Fix each blocker, then push the branch.", "— automated review"].join("\n");
}
function cleanComment(pr: Pr, summary: string): string {
  return [`Review checked the full diff, tests, security, failure modes, CI, and merge state for PR #${pr.number}.`, `Result: ${summary}`, "No blockers remain.", "The operator must approve this PR.", "— automated review"].join("\n");
}
type ReviewDecisionVerdict = "comment" | "request-changes";
export function reviewSubmissionMarker(
  prNumber: number,
  headSha: string,
  fingerprint: string,
  verdict: ReviewDecisionVerdict,
): string {
  if (headSha.trim() === "") throw new Error("review submission marker needs the reviewed head");
  return `submitted:${prNumber}:${headSha}:${fingerprint || "clean"}:${verdict}`;
}
type ReviewSnapshot = {
  approvable?: boolean;
  blockers?: string[];
  headSha?: string;
  summary?: string;
};
type StateSnapshot = {
  mergeable?: boolean;
  ciGreen?: boolean;
  ciPending?: boolean;
  mergeStateStatus?: string;
  headSha?: string;
  summary?: string;
};

export function planReviewSubmission(
  pr: Pr,
  review: ReviewSnapshot | undefined,
  approvedState: StateSnapshot | undefined,
  currentState: StateSnapshot | undefined,
  fingerprint = "",
):
  | { submitted: false; reason: string }
  | { submitted: true; verdict: ReviewDecisionVerdict; marker: string; body: string } {
  const approvedHead = approvedState?.headSha ?? "";
  const currentHead = currentState?.headSha ?? "";
  if (approvedHead === "" || currentHead !== approvedHead) {
    return { submitted: false, reason: "PR head changed since the approved review decision" };
  }
  if (currentState?.ciPending === true) {
    return { submitted: false, reason: "CI changed to pending since the approved review decision" };
  }
  const approvedBlockers = reviewDecisionBlockers(review, approvedState);
  const currentBlockers = reviewDecisionBlockers(review, currentState);
  const approvedVerdict: ReviewDecisionVerdict =
    approvedBlockers.length === 0 ? "comment" : "request-changes";
  const verdict: ReviewDecisionVerdict =
    currentBlockers.length === 0 ? "comment" : "request-changes";
  if (verdict !== approvedVerdict) {
    return { submitted: false, reason: "PR state changed since the approved review decision" };
  }
  return {
    submitted: true,
    verdict,
    marker: reviewSubmissionMarker(pr.number, currentHead, fingerprint, verdict),
    body: verdict === "comment"
      ? cleanComment(pr, review?.summary ?? "clean")
      : reviewComment(pr, currentBlockers),
  };
}



export function queueReviewGateDecision(file: string, request: {
  runId: string;
  repo: string;
  worktree: string;
  pr: Pr;
  headSha: string;
  originalIssue: string;
  draftBody: string;
  evidence: string;
  reviewSummary: string;
  mergeStateStatus: string;
  ciGreen: boolean;
  verdict: ReviewDecisionVerdict;
}) {
  const nodeId = `review-approval-gate-${reviewGateKey(request.pr)}`;
  const clean = request.verdict === "comment";
  return askWorkflowQuestion(file, {
    runId: request.runId,
    nodeId,
    answerLane: "smithers-approval",
    decisionKey: request.headSha,
    resumeHint:
      `Answer through deck-questions or the Smithers Gateway for run ${request.runId}, node ${nodeId}. ` +
      "Approving this workflow decision never submits a GitHub approval.",
    originalIssue: request.originalIssue,
    proposedAction: clean
      ? `Acknowledge the clean review evidence and post the non-approving review comment for PR #${request.pr.number}.`
      : `Submit the drafted request-changes review for PR #${request.pr.number}.`,
    blastRadius: `Only PR #${request.pr.number} at head ${request.headSha}; a changed head requires a new gate decision.`,
    cwd: request.worktree,
    prNumber: request.pr.number,
    prContext: {
      prUrl: request.pr.url,
      prRepo: request.repo,
      prNumber: request.pr.number,
      headSha: request.headSha,
      prTitle: request.pr.title,
      originalIssue: request.originalIssue,
      ourFix: request.draftBody,
      whyCorrect: request.reviewSummary,
      ciState: request.ciGreen ? "green" : "not-green",
      mergeStateStatus: request.mergeStateStatus,
      workflowDir: process.cwd(),
      workflowFile: fileURLToPath(import.meta.url),
      draftedVerdict: request.verdict,
      draftedComment: request.draftBody,
      evidence: request.evidence,
    },
    approvalValue: {
      prNumber: request.pr.number,
      headSha: request.headSha,
      verdict: request.verdict,
    },
    questionKind: "approve",
    options: clean
      ? ["Acknowledge evidence", "Hold", "Deny gate"]
      : ["Submit request changes", "Hold", "Deny gate"],
    actions: ["approve", "hold", "deny-gate"],
    recommendation: clean
      ? "Acknowledge only after reviewing the evidence; submit any GitHub approval manually."
      : "Submit request changes after confirming every listed blocker.",
    urgency: "high",
  });
}


export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun === true; const cli = input.github?.gh ?? "gh"; const fixtures = input.fixtures ?? {};
  const rounds = Math.min(input.limits?.rounds ?? 3, 3); const polls = input.limits?.polls ?? 8; const pollIntervalMs = input.limits?.intervalMs ?? (dryRun ? 1 : 60_000); const continuation = (input as any).__smithersContinuation?.payload ?? {};
  const queuePath = `${input.worktree}/.review-gate-queue.json`;
  const postedPath = `${input.worktree}/.review-gate-posted.json`;
  const posted = (() => { try { return existsSync(postedPath) ? JSON.parse(readFileSync(postedPath, "utf8")) as Record<string, string> : {}; } catch { return {}; } })();
  const saveJson = (file: string, value: unknown) => { const temp = `${file}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, file); };
  const pollCount = Number(continuation.pollCount ?? 0); const cycle = Number(continuation.cycle ?? 0); const pollerId = `review-requested-${cycle}`; const pollCheckId = `${pollerId}-check`; const completedPolls = ctx.iterationCount(outputs.queue, pollCheckId); const discovered = dryRun && fixtures.requested !== false ? [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/${fixtures.prNumber ?? 1}`, title: fixtures.title ?? "fixture PR", headRefName: `fixture-${fixtures.prNumber ?? 1}`, headRefOid: "fixture-head" }] : [];
  const latestPoll = ctx.latest(outputs.queue, pollCheckId); const prs = latestPoll?.prs ?? readQueuedPrs(queuePath); const reviewModel = createReviewGateAgent("gpt-5.6-sol", input.worktree, `${input.repo}-review-gate`); const fixModel = createReviewGateAgent("gpt-5.6-luna", input.worktree, `${input.repo}-review-gate`);
  // Fix every finding from Sathira's Gate review. The latest.blockers.length > 0 path reports and repairs each round.
  const alreadyQueuedForHead = (pr: Pr) => [...readQuestionHistory(queueFile()), ...readQuestions(queueFile())].some((question) => question.prContext?.prNumber === pr.number && question.prContext?.headSha === pr.headRefOid);
  const pathFor = (p: Pr) => `${input.worktree}/.review-gate-pr-${p.number}`;
  const ready = (r: any, s: any) => r?.approvable === true && r.blockers?.length === 0 && s?.mergeable === true && s?.ciGreen === true && r.headSha === s?.headSha;
  const pendingState = (s: any) => s?.ciPending === true;
  // GitHub review submission is downstream of this durable gate only. Blockers remain a request-changes draft.
  const reviewPath = (pr: Pr) => <Sequence><Loop id={`gate-loop-${reviewGateKey(pr)}`} until={ready(ctx.latest(outputs.review, `gate-review-${reviewGateKey(pr)}`), ctx.latest(outputs.state, `gate-state-${reviewGateKey(pr)}`))} maxIterations={rounds} onMaxReached="return-last"><Sequence>
    <Task id={`gate-prepare-${reviewGateKey(pr)}`} output={outputs.prepare} retries={1}>{async () => { if (dryRun) return { prepared: true, headSha: "fixture-head" }; const target = (await ghJson(cli, ["pr", "view", String(pr.number), "--repo", input.repo, "--json", "headRefOid"])).headRefOid; const p = Bun.spawn(["git", "-C", pathFor(pr), "fetch", "origin", `${target}:refs/remotes/origin/review-gate-${pr.number}`], { stdout: "pipe", stderr: "pipe" }); if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text()); const c = Bun.spawn(["git", "-C", pathFor(pr), "checkout", "-B", pr.headRefName ?? `review-gate-${pr.number}`, target], { stdout: "pipe", stderr: "pipe" }); if (await c.exited !== 0) throw new Error(await new Response(c.stderr).text()); return { prepared: true, headSha: target }; }}</Task>
    <Task id={`gate-review-${reviewGateKey(pr)}`} output={outputs.review} agent={dryRun ? undefined : reviewModel} retries={1}>{dryRun ? () => { const b = fixtures.blockers ?? []; return { round: 0, prNumber: pr.number, approvable: b.length === 0, blockers: b, findings: b, headSha: "fixture-head", summary: b.length ? "fixture blockers" : "fixture clean" }; } : `You are Sathira's Gate review engine. Load and follow ${process.cwd()}/.smithers/skills/sathiras-gate/SKILL.md and ${process.cwd()}/.smithers/skills/thermo-nuclear-code-quality-review/SKILL.md. Review only PR #${pr.number} at the exact checked-out head in ${pathFor(pr)}. Verify its SHA with gh before and after review. Inspect the full diff, tests, security, failure modes, and CI. Do not edit, commit, push, approve, or merge. Return JSON only with round, prNumber, approvable, blockers, findings, summary, headSha.`}</Task>
    <Task id={`gate-state-${reviewGateKey(pr)}`} output={outputs.state} retries={1}>{async () => { const s = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, ciPending: false, mergeStateStatus: "CLEAN", headSha: "fixture-head", summary: "fixture state" } : await state(cli, input.repo, pr.number); return { ...s, round: 0, prNumber: pr.number }; }}</Task>
    <Task id={`gate-report-${reviewGateKey(pr)}`} output={outputs.report} retries={1}>{async () => { const r = ctx.latest(outputs.review, `gate-review-${reviewGateKey(pr)}`); const blockers = r?.blockers ?? []; if (blockers.length === 0) return { round: r?.round ?? 0, prNumber: pr.number, blockers, draftBody: "", draftFingerprint: "", posted: false, requestedChanges: false, summary: "clean round" }; const body = reviewComment(pr, blockers); const fingerprint = `blockers:${pr.number}:${r?.headSha ?? "unknown"}:${blockers.join("\\n")}`;   return { round: r?.round ?? 0, prNumber: pr.number, blockers, draftBody: body, draftFingerprint: fingerprint, posted: false, requestedChanges: false, summary: body }; }}</Task>
    <Task id={`gate-fix-${reviewGateKey(pr)}`} output={outputs.fix} agent={dryRun ? undefined : fixModel} retries={1}>{dryRun ? () => ({ round: 0, prNumber: pr.number, dispatched: (fixtures.blockers ?? []).length > 0, addressed: fixtures.blockers ?? [], summary: "fixture repair" }) : `Read the latest Sathira Gate review and state for PR #${pr.number}. If latest.blockers.length > 0 or failed checks exist, fix all of them in ${pathFor(pr)}. Load both workflow-local gate skill files. Load the exact skills .agent/skills/sathiras-gate and .agent/skills/thermo-nuclear-code-quality-review. Prepare the exact writable branch ${pr.headRefName ?? `for PR ${pr.number}`}, rebase if needed, run focused tests, commit plain commits, and push only that PR branch. If clean, make no changes. Never approve or merge. Return JSON.`}</Task>
  </Sequence></Loop><Task id={`gate-final-state-${reviewGateKey(pr)}`} output={outputs.state} retries={1} dependsOn={[`gate-review-${reviewGateKey(pr)}`, `gate-state-${reviewGateKey(pr)}`]}>{async () => { const s = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, ciPending: false, mergeStateStatus: "CLEAN", headSha: "fixture-head", summary: "fixture final state" } : await state(cli, input.repo, pr.number); return { ...s, round: rounds, prNumber: pr.number }; }}</Task></Sequence>;
  const pollTask = async () => { const attempt = pollCount + completedPolls; const found = dryRun ? (attempt < (fixtures.pollCount ?? 0) ? [] : discovered) : await requested(cli, input.repo, input.captainLogin); const actionable = found.filter((pr) => pr.headRefOid && !alreadyQueuedForHead(pr)); const row = { poll: attempt, prs: actionable, at: iso(), satisfied: actionable.length > 0 }; saveJson(queuePath, [row]); return row; };
  const reviewPrs = prs.filter((pr) => pr.headRefOid !== undefined && pr.headRefOid !== "" && !alreadyQueuedForHead(pr));
  return <Workflow name="lindy-review-gate"><Sequence><Poller id={pollerId} check={pollTask} checkOutput={outputs.queue} maxAttempts={polls} intervalMs={pollIntervalMs} backoff="fixed" onTimeout="return-last" /><Parallel maxConcurrency={1}>{reviewPrs.map((pr) => <Worktree key={reviewGateKey(pr)} id={`gate-review-worktree-${reviewGateKey(pr)}`} path={pathFor(pr)} branch={pr.headRefName}><Sequence>{reviewPath(pr)}</Sequence></Worktree>)}</Parallel>{reviewPrs.map((pr) => <Sequence key={reviewGateKey(pr)}><Task id={`captain-question-${reviewGateKey(pr)}`} output={outputs.captainQuestion} retries={1} dependsOn={[`gate-final-state-${reviewGateKey(pr)}`]}>{async () => { const r = ctx.latest(outputs.review, `gate-review-${reviewGateKey(pr)}`); const s = ctx.latest(outputs.state, `gate-final-state-${reviewGateKey(pr)}`) ?? ctx.latest(outputs.state, `gate-state-${reviewGateKey(pr)}`); const blockers = r?.blockers ?? []; const fresh = dryRun ? s : await state(cli, input.repo, pr.number); const current = fresh?.headSha === s?.headSha && fresh?.mergeable === true; const clean = reviewDecisionBlockers(r, fresh).length === 0; const verdict = clean ? "comment" : "request-changes"; const comment = clean ? cleanComment(pr, r?.summary ?? "clean") : reviewComment(pr, reviewDecisionBlockers(r, fresh)); if (pendingState(fresh)) return { queued: false, id: null, prNumber: pr.number, summary: "CI is still running; waiting for a settled result." }; if (s?.headSha === undefined || s.headSha === "") return { queued: false, id: null, prNumber: pr.number, summary: "head SHA unavailable" };    const event = queueReviewGateDecision(queueFile(), { runId: ctx.runId, repo: input.repo, worktree: input.worktree, pr, headSha: s.headSha, originalIssue: fixtures.originalIssue ?? input.brief?.summary ?? input.ticket ?? pr.title, draftBody: comment, evidence: `${r?.summary ?? "review unavailable"}; ${fresh?.summary ?? "state unavailable"}`, reviewSummary: r?.summary ?? comment, mergeStateStatus: fresh?.mergeStateStatus ?? s.mergeStateStatus, ciGreen: fresh?.ciGreen === true, verdict }); return { queued: true, id: event.id, prNumber: pr.number, summary: comment }; }}</Task><Branch if={dryRun || ctx.latest(outputs.captainQuestion, `captain-question-${reviewGateKey(pr)}`)?.queued === true} then={dryRun ? <Task id={`review-approval-gate-${reviewGateKey(pr)}`} output={outputs.reviewApproval}>{() => ({ approved: true, note: "bypassApprovals (dry-run test mode)", decidedBy: "bypass", decidedAt: iso() })}</Task> : <Approval id={`review-approval-gate-${reviewGateKey(pr)}`} output={outputs.reviewApproval} onDeny="continue" request={{ title: `Captain review decision: PR #${pr.number} ${pr.title}`, summary: `URL: ${pr.url}\nThe captain decision is queued with the complete drafted verdict, comment, and evidence.` }} />} else={<Task id={`review-approval-gate-${reviewGateKey(pr)}`} output={outputs.reviewApproval}>{() => ({ approved: false, note: "captain question was not queued", decidedBy: "workflow", decidedAt: iso() })}</Task>} /> <Task id={`submit-review-${reviewGateKey(pr)}`} output={outputs.submit} retries={1} dependsOn={[`review-approval-gate-${reviewGateKey(pr)}`]}>{async () => { const decision = ctx.latest(outputs.reviewApproval, `review-approval-gate-${reviewGateKey(pr)}`); if (!shouldSubmitReview(decision)) return { submitted: false, reason: "captain denied" }; const report = ctx.latest(outputs.report, `gate-report-${reviewGateKey(pr)}`); const review = ctx.latest(outputs.review, `gate-review-${reviewGateKey(pr)}`); const approvedState = ctx.latest(outputs.state, `gate-final-state-${reviewGateKey(pr)}`); const currentState = dryRun ? approvedState : await state(cli, input.repo, pr.number); const plan = planReviewSubmission(pr, review, approvedState, currentState, report?.draftFingerprint ?? ""); if (!plan.submitted) return plan; if (posted[plan.marker] !== undefined) return { submitted: false, reason: "already submitted", verdict: plan.verdict }; const args = [...reviewCommand(pr.number, input.repo, plan.verdict === "comment"), "--body", plan.body]; if (!dryRun) { await ghRun(cli, args, input.worktree); posted[plan.marker] = iso(); saveJson(postedPath, posted); } return { submitted: true, verdict: plan.verdict }; }}</Task></Sequence>)}<Timer id="review-cycle-delay" duration={`${pollIntervalMs}ms`} /><ContinueAsNew state={{ cycle: cycle + 1, pollCount: pollCount + completedPolls }} /></Sequence></Workflow>;
});
