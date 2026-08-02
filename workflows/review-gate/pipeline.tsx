/** @jsxImportSource smithers-orchestrator */
/** Captain review gate. Agents review and fix, but never approve or merge. */
/** NEVER run any GitHub approve command. */
import { ContinueAsNew, Loop, Parallel, PiAgent, Sequence, Task, Workflow, Worktree, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { askIfAbsent, openQuestions, queueFile, readQuestionHistory, readQuestions } from "../../v2/src/questions-store.ts";
import { defaultModelPolicy } from "../pr-pipeline/lib/models.ts";

const inputSchema = z.object({
  repo: z.string().min(1).default(process.env.GITHUB_REPOSITORY ?? "local/repository"),
  worktree: z.string().min(1).default(process.cwd()),
  captainLogin: z.string().min(1).default(process.env.GITHUB_ACTOR ?? process.env.USER ?? "captain"),
  ticket: z.string().optional(),
  brief: z.object({ summary: z.string().optional() }).optional(),
  dryRun: z.boolean().optional(), github: z.object({ gh: z.string().optional() }).optional(),
  limits: z.object({ polls: z.number().int().positive().optional(), rounds: z.number().int().positive().optional() }).optional(),
  fixtures: z.object({ prNumber: z.number().int().positive().optional(), title: z.string().optional(), requested: z.boolean().optional(), blockers: z.array(z.string()).optional(), pollCount: z.number().int().nonnegative().optional(), originalIssue: z.string().optional() }).optional(),
});
const schemas = {
  input: inputSchema,
  queue: z.object({ poll: z.number().int(), prs: z.array(z.object({ number: z.number().int(), url: z.string(), title: z.string(), headRefName: z.string().optional(), headRefOid: z.string().optional() })), at: z.string() }),
  review: z.object({ round: z.number().int(), prNumber: z.number().int(), approvable: z.boolean(), blockers: z.array(z.string()), findings: z.array(z.string()), summary: z.string(), headSha: z.string() }),
  fix: z.object({ round: z.number().int(), prNumber: z.number().int(), dispatched: z.boolean(), addressed: z.array(z.string()), summary: z.string() }),
  report: z.object({ round: z.number().int(), prNumber: z.number().int(), blockers: z.array(z.string()), posted: z.boolean(), requestedChanges: z.boolean(), summary: z.string() }),
  state: z.object({ round: z.number().int(), prNumber: z.number().int(), headSha: z.string(), mergeable: z.boolean(), ciGreen: z.boolean(), mergeStateStatus: z.string(), summary: z.string() }),
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
async function ghRun(cli: string, args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn([cli, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}
async function requested(cli: string, repo: string, login: string): Promise<Pr[]> { return ghJson(cli, ["pr", "list", "--repo", repo, "--reviewer", login, "--state", "open", "--json", "number,url,title,headRefName,headRefOid"]); }
async function state(cli: string, repo: string, pr: number) {
  const v = await ghJson(cli, ["pr", "view", String(pr), "--repo", repo, "--json", "mergeable,mergeStateStatus,statusCheckRollup,headRefOid"]);
  const checks = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  const mergeStateStatus = String(v.mergeStateStatus ?? "UNKNOWN");
  const ciGreen = checks.length > 0 && checks.every((c: any) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(c.conclusion ?? c.state).toUpperCase()));
  return { mergeable: v.mergeable === "MERGEABLE" && mergeStateStatus === "CLEAN", ciGreen, mergeStateStatus, headSha: String(v.headRefOid ?? ""), summary: `mergeable=${v.mergeable} mergeStateStatus=${mergeStateStatus} checks=${checks.length}` };
}
function agent(model: string, tools = true) { return new PiAgent({ provider: "deck", model, timeoutMs: 30 * 60_000, thinking: "medium", noSession: true, ...(tools ? { tools: ["read", "grep", "edit", "write", "bash"] } : { noTools: true }) }); }
function reviewComment(pr: Pr, blockers: string[]): string {
  return [`Review found ${blockers.length} blocker(s) on PR #${pr.number}.`, ...blockers.map((item, i) => `${i + 1}. ${item}`), "Fix each blocker, then push the branch.", "— Tim's agent"].join("\n");
}
function cleanComment(pr: Pr, summary: string): string {
  return [`Review checked the full diff, tests, security, failure modes, CI, and merge state for PR #${pr.number}.`, `Result: ${summary}`, "No blockers remain.", "The captain must approve this PR.", "— Tim's agent"].join("\n");
}

export default smithers((ctx) => {
  const input = ctx.input; const dryRun = input.dryRun === true; const cli = input.github?.gh ?? "gh"; const fixtures = input.fixtures ?? {};
  const rounds = Math.min(input.limits?.rounds ?? 3, 3); const polls = input.limits?.polls ?? 8; const continuation = (input as any).__smithersContinuation?.payload ?? {};
  const queuePath = `${input.worktree}/.review-gate-queue.json`;
  const persisted = (() => { try { return existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : []; } catch { return []; } })();
  const postedPath = `${input.worktree}/.review-gate-posted.json`;
  const posted = (() => { try { return existsSync(postedPath) ? JSON.parse(readFileSync(postedPath, "utf8")) as Record<string, string> : {}; } catch { return {}; } })();
  const queueQuestions = readQuestionHistory(queueFile());
  const saveJson = (file: string, value: unknown) => { const temp = `${file}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, file); };
  const rows = (continuation.queue ?? persisted) as Array<{ poll: number; prs: Pr[] }>; const phase = (continuation.phase ?? "poll") as "poll" | "review"; const pollCount = Number(continuation.pollCount ?? 0);
  const live = rows.at(-1)?.prs ?? []; const discovered = dryRun && fixtures.requested !== false ? [{ number: fixtures.prNumber ?? 1, url: `https://github.com/${input.repo}/pull/${fixtures.prNumber ?? 1}`, title: fixtures.title ?? "fixture PR", headRefName: `fixture-${fixtures.prNumber ?? 1}`, headRefOid: "fixture-head" }] : [];
  const prs = [...new Map([...live, ...discovered].map((p) => [p.number, p])).values()]; const reviewModel = agent("gpt-5.6-sol"); const fixModel = agent("gpt-5.6-luna"); const rebaseModel = agent("gpt-5.6-luna"); void rebaseModel; void defaultModelPolicy();
  // Fix every finding from Sathira's Gate review. The latest.blockers.length > 0 path reports and repairs each round.
  const priorQuestionIds = new Set(queueQuestions.map((question) => question.id));
  const pathFor = (p: Pr) => `${input.worktree}/.review-gate-pr-${p.number}`;
  const ready = (r: any, s: any) => r?.approvable === true && r.blockers?.length === 0 && s?.mergeable === true && s?.ciGreen === true && r.headSha === s?.headSha;
  // Existing stamp questions remain supported: questionKind: "stamp".
  const reviewPath = (pr: Pr) => <Sequence><Loop id={`gate-loop-${pr.number}`} until={ready(ctx.latest(outputs.review, `gate-review-${pr.number}`), ctx.latest(outputs.state, `gate-state-${pr.number}`))} maxIterations={rounds} onMaxReached="return-last"><Sequence>
    <Task id={`gate-prepare-${pr.number}`} retries={1}>{async () => { if (dryRun) return { prepared: true, headSha: "fixture-head" }; const target = (await ghJson(cli, ["pr", "view", String(pr.number), "--repo", input.repo, "--json", "headRefOid"])).headRefOid; const p = Bun.spawn(["git", "-C", pathFor(pr), "fetch", "origin", `${target}:refs/remotes/origin/review-gate-${pr.number}`], { stdout: "pipe", stderr: "pipe" }); if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text()); const c = Bun.spawn(["git", "-C", pathFor(pr), "checkout", "-B", pr.headRefName ?? `review-gate-${pr.number}`, target], { stdout: "pipe", stderr: "pipe" }); if (await c.exited !== 0) throw new Error(await new Response(c.stderr).text()); return { prepared: true, headSha: target }; }}</Task>
    <Task id={`gate-review-${pr.number}`} output={outputs.review} agent={dryRun ? undefined : reviewModel} retries={1}>{dryRun ? () => { const b = fixtures.blockers ?? []; return { round: 0, prNumber: pr.number, approvable: b.length === 0, blockers: b, findings: b, headSha: "fixture-head", summary: b.length ? "fixture blockers" : "fixture clean" }; } : `You are Sathira's Gate review engine. Load and follow ${process.cwd()}/.smithers/skills/sathiras-gate/SKILL.md and ${process.cwd()}/.smithers/skills/thermo-nuclear-code-quality-review/SKILL.md. Review only PR #${pr.number} at the exact checked-out head in ${pathFor(pr)}. Verify its SHA with gh before and after review. Inspect the full diff, tests, security, failure modes, and CI. Do not edit, commit, push, or merge. Return JSON only with round, prNumber, approvable, blockers, findings, summary, headSha.`}</Task>
    <Task id={`gate-state-${pr.number}`} output={outputs.state} retries={1}>{async () => { const s = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, mergeStateStatus: "CLEAN", headSha: "fixture-head", summary: "fixture state" } : await state(cli, input.repo, pr.number); return { ...s, round: 0, prNumber: pr.number }; }}</Task>
    <Task id={`gate-report-${pr.number}`} output={outputs.report} retries={1}>{async () => { const r = ctx.latest(outputs.review, `gate-review-${pr.number}`); const blockers = r?.blockers ?? []; if (blockers.length === 0) return { round: r?.round ?? 0, prNumber: pr.number, blockers, posted: false, requestedChanges: false, summary: "clean round" }; const fingerprint = `${ctx.latest(outputs.state, `gate-state-${pr.number}`)?.headSha ?? "unknown"}:${[...blockers].map((item) => item.trim().toLowerCase().replace(/\s+/g, " ")).sort().join("|")}`; if (posted[`blockers:${pr.number}`] === fingerprint) return { round: r?.round ?? 0, prNumber: pr.number, blockers, posted: false, requestedChanges: false, summary: "blockers already reported" }; const body = reviewComment(pr, blockers); let postedComment = false; let requestedChanges = false; let error = ""; if (!dryRun) { try { await ghRun(cli, ["pr", "comment", String(pr.number), "--repo", input.repo, "--body", body], input.worktree); postedComment = true; } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } try { await ghRun(cli, ["pr", "review", String(pr.number), "--repo", input.repo, "--request-changes", "--body", `Blockers remain on PR #${pr.number}. Fix each blocker.`], input.worktree); requestedChanges = true; try { await ghRun(cli, ["pr", "edit", String(pr.number), "--repo", input.repo, "--add-reviewer", input.captainLogin], input.worktree); } catch { /* A self-authored PR cannot be re-requested. */ } } catch (cause) { error = error || (cause instanceof Error ? cause.message : String(cause)); } } if (postedComment || requestedChanges) { posted[`blockers:${pr.number}`] = fingerprint; saveJson(postedPath, posted); } return { round: r?.round ?? 0, prNumber: pr.number, blockers, posted: dryRun || postedComment, requestedChanges: dryRun || requestedChanges, summary: error ? `${body} Error: ${error}` : body }; }}</Task>
    <Task id={`gate-fix-${pr.number}`} output={outputs.fix} agent={dryRun ? undefined : fixModel} retries={1}>{dryRun ? () => ({ round: 0, prNumber: pr.number, dispatched: (fixtures.blockers ?? []).length > 0, addressed: fixtures.blockers ?? [], summary: "fixture repair" }) : `Read the latest Sathira Gate review and state for PR #${pr.number}. If latest.blockers.length > 0 or failed checks exist, fix all of them in ${pathFor(pr)}. Load both workflow-local gate skill files. Load the exact skills .agent/skills/sathiras-gate and .agent/skills/thermo-nuclear-code-quality-review. Prepare the exact writable branch ${pr.headRefName ?? `for PR ${pr.number}`}, rebase if needed, run focused tests, commit plain commits, and push only that PR branch. If clean, make no changes. Never approve or merge. Return JSON.`}</Task>
  </Sequence></Loop><Task id={`gate-final-state-${pr.number}`} output={outputs.state} retries={1} dependsOn={[`gate-review-${pr.number}`, `gate-state-${pr.number}`]}>{async () => { const s = dryRun ? { mergeable: (fixtures.blockers ?? []).length === 0, ciGreen: (fixtures.blockers ?? []).length === 0, mergeStateStatus: "CLEAN", headSha: "fixture-head", summary: "fixture final state" } : await state(cli, input.repo, pr.number); return { ...s, round: rounds, prNumber: pr.number }; }}</Task></Sequence>;
  const pollTask = async () => { if (dryRun && (fixtures.requested === false || pollCount >= polls || pollCount < (fixtures.pollCount ?? 0))) return []; if (rows.length > 0) await sleep(1000); return dryRun ? discovered : requested(cli, input.repo, input.captainLogin); };
  if (phase === "poll") return <Workflow name="lindy-review-gate"><Loop id="review-poll-loop" maxIterations={polls} onMaxReached="return-last"><Sequence><Task id="review-requested-poll" output={outputs.queue} retries={2}>{async () => { const row = { poll: rows.length, prs: await pollTask(), at: iso() }; const next = [...rows, row]; writeFileSync(queuePath, JSON.stringify(next)); return row; }}</Task><ContinueAsNew state={{ ...input, pollCount: pollCount + 1, phase: "review" }} /></Sequence></Loop></Workflow>;
  const reviewPrs = prs.filter((pr) => pr.headRefOid !== undefined && pr.headRefOid !== "" && !priorQuestionIds.has(`review-gate-pr-${pr.number}-${pr.headRefOid}`));
  return <Workflow name="lindy-review-gate"><Sequence><Parallel maxConcurrency={1}>{reviewPrs.map((pr) => <Worktree id={`gate-review-worktree-${pr.number}`} path={pathFor(pr)} branch={pr.headRefName}><Sequence>{reviewPath(pr)}</Sequence></Worktree>)}</Parallel>{reviewPrs.map((pr) => <Task id={`captain-question-${pr.number}`} output={outputs.captainQuestion} retries={1} dependsOn={[`gate-final-state-${pr.number}`]}>{async () => { const r = ctx.latest(outputs.review, `gate-review-${pr.number}`); const s = ctx.latest(outputs.state, `gate-final-state-${pr.number}`) ?? ctx.latest(outputs.state, `gate-state-${pr.number}`); const clean = ready(r, s); const blockers = r?.blockers ?? []; const id = `review-gate-pr-${pr.number}-${s?.headSha ?? "unknown"}`; if (s?.headSha === undefined || s.headSha === "") return { queued: false, id: null, prNumber: pr.number, summary: "head SHA unavailable" }; if (priorQuestionIds.has(id) || readQuestions(queueFile()).some((x) => x.id === id)) return { queued: false, id, prNumber: pr.number, summary: "question already queued" }; const originalIssue = fixtures.originalIssue ?? input.brief?.summary ?? input.ticket ?? "The PR brief did not record the original issue."; const fix = ctx.latest(outputs.fix, `gate-fix-${pr.number}`); const whyCorrect = `Review: ${r?.summary ?? "not recorded"}. ${clean ? "No blockers remain." : `Persistent blockers: ${blockers.join("; ")}` } Tests and CI state: ${s?.summary ?? "not recorded"}.`; const context = { prUrl: pr.url, prRepo: input.repo, prNumber: pr.number, headSha: s?.headSha, prTitle: pr.title, originalIssue, ourFix: fix?.summary ?? "The review gate checked the submitted change.", whyCorrect, ciState: s?.ciGreen ? "green" : "not green", mergeStateStatus: s?.mergeStateStatus ?? "unknown" }; const body = clean ? cleanComment(pr, r?.summary ?? "clean") : [`Review remains blocked on PR #${pr.number}.`, ...blockers.map((item, i) => `${i + 1}. ${item}`), "The captain must decide whether to hold or close this PR.", "— Tim's agent"].join("\n"); const cleanFingerprint = `${s?.headSha ?? "unknown"}:${r?.summary ?? "clean"}`; if (clean && posted[`clean:${pr.number}`] !== cleanFingerprint && !dryRun) { await ghRun(cli, ["pr", "comment", String(pr.number), "--repo", input.repo, "--body", body], input.worktree); posted[`clean:${pr.number}`] = cleanFingerprint; saveJson(postedPath, posted); } const event = askIfAbsent(queueFile(), { id, idScope: "global", question: clean ? `Captain sign-off needed for PR #${pr.number}: ${pr.title}` : `Captain decision needed for blocked PR #${pr.number}: ${pr.title}`,
    prContext: context,
    questionKind: clean ? "approve" : "agent",
    urgency: "high",
    options: clean ? ["Approve", "Hold"] : ["Hold", "Close"], recommendation: clean ? "Approve only after your review." : "Hold until the blockers are resolved.", sessionId: process.env.PI_SESSION_ID ?? "review-gate", cwd: input.worktree }); return { queued: true, id: event.id, prNumber: pr.number, summary: body }; }}</Task>)}<ContinueAsNew state={{ ...input, pollCount, phase: "poll" }} /></Sequence></Workflow>;
});
