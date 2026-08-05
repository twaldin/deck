import { execOrThrow, type ExecFn } from "../../pr-pipeline/lib/gh.ts";

export type PollSignal = "ci-fail" | "actionable-comment" | "decision-ask" | "idle" | "complete" | "needs-rebase";
export interface StackPr {
  number: number;
  url: string;
  title: string;
  headSha: string;
  mergeable: boolean;
  mergeStateStatus: string;
  ci: "green" | "pending" | "red";
  reviewState: string;
  actionableComments: number;
  decisionAsk: boolean;
  state: string;
  merged: boolean;
}
export interface PollResult { signal: PollSignal; prs: StackPr[]; reason: string; }

type Comment = { body?: string; user?: { login?: string }; author_association?: string };
type Review = { body?: string; state?: string; submitted_at?: string; commit_id?: string; user?: { login?: string; type?: string } };
const botNoise = /^(?:lgtm|approved|approve|no blockers remain|status:?|ci (?:is )?(?:green|passed))/i;
const decision = /\b(?:decision|decide|need your|please choose|question|clarif(?:y|ication))\b/i;
function isActionable(comment: Comment, author: string): boolean {
  const login = String(comment.user?.login ?? "");
  const body = String(comment.body ?? "").trim();
  return login !== author && body.length > 20 && !botNoise.test(body) && !/^(?:github-actions|dependabot)\[bot\]$/i.test(login);
}

/** Machine-only watch step. It performs API reads and never calls an agent. */
export async function pollStack(exec: ExecFn, repo: string, numbers: number[], gh = "gh", opts: { adoption?: boolean } = {}): Promise<PollResult> {
  const prs: StackPr[] = [];
  for (const number of numbers) {
    const pr = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}`])) as Record<string, unknown>;
    const headSha = String((pr.head as Record<string, unknown> | undefined)?.sha ?? "");
    const title = String(pr.title ?? "");
    const url = String(pr.html_url ?? `https://github.com/${repo}/pull/${number}`);
    const state = String(pr.state ?? "unknown");
    if (pr.merged === true) {
      // A landed PR needs no watching; keep it visible without extra API reads.
      prs.push({ number, url, title, headSha, mergeable: true, mergeStateStatus: "landed", ci: "green", reviewState: "APPROVED", actionableComments: 0, decisionAsk: false, state, merged: true });
      continue;
    }
    const mergeStateStatus = String(pr.mergeable_state ?? "UNKNOWN");
    const checksBody = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`])) as { check_runs?: Array<{ status?: string; conclusion?: string }> };
    const checks = checksBody.check_runs ?? [];
    const ci = checks.length === 0 ? "pending" : checks.some((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? "")) ? "red" : checks.some((c) => c.status !== "completed") ? "pending" : "green";
    const issueComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/issues/${number}/comments?per_page=100`])) as Comment[];
    const reviewComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/comments?per_page=100`])) as Comment[];
    const reviews = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/reviews?per_page=100`])) as Review[];
    const author = String((pr.user as Record<string, unknown> | undefined)?.login ?? "");
    const actionable = [...issueComments, ...reviewComments].filter((c) => isActionable(c, author));
    const decisionAsk = [...issueComments, ...reviewComments, ...reviews].some((c) => decision.test(String(c.body ?? ""))) || reviews.some((r) => r.state === "CHANGES_REQUESTED" && decision.test(String(r.body ?? "")));
    const humanReviews = reviews.filter((review) => String(review.user?.type ?? "").toLowerCase() !== "bot");
    const chronological = [...humanReviews].sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")));
    // One decision per reviewer: their latest APPROVED/CHANGES_REQUESTED. A
    // later COMMENTED note must not erase an approval, and an approval only
    // counts for the head commit it actually reviewed.
    const latestDecisionByReviewer = new Map<string, Review>();
    for (const review of chronological) {
      if (!["APPROVED", "CHANGES_REQUESTED"].includes(String(review.state ?? ""))) continue;
      latestDecisionByReviewer.set(String(review.user?.login ?? ""), review);
    }
    const decisions = [...latestDecisionByReviewer.values()];
    const changesRequested = decisions.some((review) => review.state === "CHANGES_REQUESTED");
    const approvedAtHead = decisions.some((review) => review.state === "APPROVED" && String(review.commit_id ?? "") === headSha);
    const reviewState = changesRequested ? "CHANGES_REQUESTED" : approvedAtHead ? "APPROVED" : decisions.length > 0 ? "STALE_APPROVAL" : chronological.at(-1)?.state ?? "PENDING";
    prs.push({ number, url, title, headSha, mergeable: pr.mergeable === true, mergeStateStatus, ci, reviewState, actionableComments: actionable.length, decisionAsk, state, merged: false });
  }
  const active = prs.filter((p) => !p.merged);
  // A closed-unmerged PR breaks the stack. Escalate; never treat its stale
  // "dirty" mergeable state as a rebase and never force-push its branch.
  if (active.some((p) => p.state === "closed")) return { signal: "decision-ask", prs, reason: "A stack PR was closed without merging" };
  if (active.some((p) => p.ci === "red")) return { signal: "ci-fail", prs, reason: "CI failed" };
  if (active.some((p) => p.decisionAsk)) return { signal: "decision-ask", prs, reason: "Decision is required" };
  if (active.some((p) => p.actionableComments > 0)) return { signal: "actionable-comment", prs, reason: "Actionable review comment found" };
  if (opts.adoption && active.some((p) => ["behind", "dirty"].includes(p.mergeStateStatus))) return { signal: "needs-rebase", prs, reason: "A stack PR is behind its base or conflicting" };
  const ready = (p: StackPr) => p.ci === "green" && p.mergeable && p.actionableComments === 0 && !p.decisionAsk && (opts.adoption !== true || p.reviewState === "APPROVED");
  if (prs.length > 0 && active.every(ready)) return { signal: "complete", prs, reason: opts.adoption ? "Stack is green, human-approved, clear, and mergeable" : "Stack is green, clear, and mergeable" };
  return { signal: "idle", prs, reason: "No wake condition" };
}
export const pollHasNoAgent = true;
