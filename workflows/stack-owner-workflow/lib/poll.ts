import { execOrThrow, type ExecFn } from "../../pr-pipeline/lib/gh.ts";

export type PollSignal = "ci-fail" | "actionable-comment" | "decision-ask" | "idle" | "complete";
export interface StackPr { number: number; headSha: string; mergeable: boolean; ci: "green" | "pending" | "red"; actionableComments: number; decisionAsk: boolean; }
export interface PollResult { signal: PollSignal; prs: StackPr[]; reason: string; }

type Comment = { body?: string; user?: { login?: string }; author_association?: string };
type Review = { body?: string; state?: string; user?: { login?: string } };
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
    const checksBody = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/commits/${headSha}/check-runs`])) as { check_runs?: Array<{ status?: string; conclusion?: string }> };
    const checks = checksBody.check_runs ?? [];
    const ci = checks.length === 0 ? "pending" : checks.some((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? "")) ? "red" : checks.some((c) => c.status !== "completed") ? "pending" : "green";
    const issueComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/issues/${number}/comments`])) as Comment[];
    const reviewComments = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/comments`])) as Comment[];
    const reviews = JSON.parse(await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}/reviews`])) as Review[];
    const author = String((pr.user as Record<string, unknown> | undefined)?.login ?? "");
    const actionable = [...issueComments, ...reviewComments].filter((c) => isActionable(c, author));
    const decisionAsk = [...issueComments, ...reviewComments, ...reviews].some((c) => decision.test(String(c.body ?? ""))) || reviews.some((r) => r.state === "CHANGES_REQUESTED" && decision.test(String(r.body ?? "")));
    prs.push({ number, headSha, mergeable: pr.mergeable === true, ci, actionableComments: actionable.length, decisionAsk });
  }
  if (prs.some((p) => p.ci === "red")) return { signal: "ci-fail", prs, reason: "CI failed" };
  if (prs.some((p) => p.decisionAsk)) return { signal: "decision-ask", prs, reason: "Decision is required" };
  if (prs.some((p) => p.actionableComments > 0)) return { signal: "actionable-comment", prs, reason: "Actionable review comment found" };
  if (prs.length > 0 && prs.every((p) => p.ci === "green" && p.mergeable && p.actionableComments === 0 && !p.decisionAsk)) return { signal: "complete", prs, reason: "Stack is green, clear, and mergeable" };
  return { signal: "idle", prs, reason: "No wake condition" };
}
export const pollHasNoAgent = true;
