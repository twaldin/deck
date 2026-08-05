import { execOrThrow, type ExecFn } from "../../pr-pipeline/lib/gh.ts";

export type PollSignal = "ci-fail" | "actionable-comment" | "decision-ask" | "idle" | "complete";
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
}
export interface PollResult { signal: PollSignal; prs: StackPr[]; reason: string; }

type Comment = { body?: string; user?: { login?: string }; author_association?: string };
type Review = { body?: string; state?: string; submitted_at?: string; user?: { login?: string; type?: string } };
const botNoise = /^(?:lgtm|approved|approve|no blockers remain|status:?|ci (?:is )?(?:green|passed))/i;
const decision = /\b(?:decision|decide|need your|please choose|question|clarif(?:y|ication))\b/i;
function isActionable(comment: Comment, author: string): boolean {
  const login = String(comment.user?.login ?? "");
  const body = String(comment.body ?? "").trim();
  return login !== author && body.length > 20 && !botNoise.test(body) && !/^(?:github-actions|dependabot)\[bot\]$/i.test(login);
}

/** Machine-only watch step. It performs API reads and never calls an agent. */
export async function pollStack(exec: ExecFn, repo: string, numbers: number[], gh = "gh"): Promise<PollResult> {
  const prs: StackPr[] = [];
  for (const number of numbers) {
    const pr = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}`])) as Record<string, unknown>;
    const headSha = String((pr.head as Record<string, unknown> | undefined)?.sha ?? "");
    const title = String(pr.title ?? "");
    const url = String(pr.html_url ?? `https://github.com/${repo}/pull/${number}`);
    const mergeStateStatus = String(pr.mergeable_state ?? "UNKNOWN");
    const checksBody = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/commits/${headSha}/check-runs`])) as { check_runs?: Array<{ status?: string; conclusion?: string }> };
    const checks = checksBody.check_runs ?? [];
    const ci = checks.length === 0 ? "pending" : checks.some((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? "")) ? "red" : checks.some((c) => c.status !== "completed") ? "pending" : "green";
    const issueComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/issues/${number}/comments`])) as Comment[];
    const reviewComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/comments`])) as Comment[];
    const reviews = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/reviews`])) as Review[];
    const author = String((pr.user as Record<string, unknown> | undefined)?.login ?? "");
    const actionable = [...issueComments, ...reviewComments].filter((c) => isActionable(c, author));
    const decisionAsk = [...issueComments, ...reviewComments, ...reviews].some((c) => decision.test(String(c.body ?? ""))) || reviews.some((r) => r.state === "CHANGES_REQUESTED" && decision.test(String(r.body ?? "")));
    const humanReviews = reviews.filter((review) => String(review.user?.type ?? "").toLowerCase() !== "bot");
    const latestReview = [...humanReviews].sort((a, b) => String(b.submitted_at ?? "").localeCompare(String(a.submitted_at ?? "")))[0];
    const reviewState = latestReview?.state ?? "PENDING";
    prs.push({ number, url, title, headSha, mergeable: pr.mergeable === true, mergeStateStatus, ci, reviewState, actionableComments: actionable.length, decisionAsk });
  }
  if (prs.some((p) => p.ci === "red")) return { signal: "ci-fail", prs, reason: "CI failed" };
  if (prs.some((p) => p.decisionAsk)) return { signal: "decision-ask", prs, reason: "Decision is required" };
  if (prs.some((p) => p.actionableComments > 0)) return { signal: "actionable-comment", prs, reason: "Actionable review comment found" };
  if (prs.length > 0 && prs.every((p) => p.ci === "green" && p.mergeable && p.actionableComments === 0 && !p.decisionAsk)) return { signal: "complete", prs, reason: "Stack is green, clear, and mergeable" };
  return { signal: "idle", prs, reason: "No wake condition" };
}
export const pollHasNoAgent = true;
