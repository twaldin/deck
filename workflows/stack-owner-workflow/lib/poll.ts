import { execOrThrow, type ExecFn } from "../../pr-pipeline/lib/gh.ts";

export type PollSignal = "ci-fail" | "actionable-comment" | "decision-ask" | "idle" | "complete";
export interface StackPr { number: number; headSha: string; mergeable: boolean; ci: "green" | "pending" | "red"; actionableComments: number; decisionAsk: boolean; }
export interface PollResult { signal: PollSignal; prs: StackPr[]; reason: string; }

/** Machine-only watch step. It performs one gh api read and never calls an agent. */
export async function pollStack(exec: ExecFn, repo: string, numbers: number[], gh = "gh"): Promise<PollResult> {
  const prs: StackPr[] = [];
  for (const number of numbers) {
    const raw = await execOrThrow(exec, [gh, "api", `repos/${repo}/pulls/${number}`]);
    const pr = JSON.parse(raw) as Record<string, unknown>;
    const checksRaw = await execOrThrow(exec, [gh, "api", `repos/${repo}/commits/${String(pr.head && typeof pr.head === "object" ? (pr.head as Record<string, unknown>).sha : "")}/check-runs`]);
    const checks = (JSON.parse(checksRaw) as { check_runs?: Array<{ status?: string; conclusion?: string }> }).check_runs ?? [];
    const ci = checks.some((c) => c.status === "completed" && ["failure", "timed_out"].includes(c.conclusion ?? "")) ? "red" : checks.some((c) => c.status !== "completed") ? "pending" : "green";
    const commentsRaw = await execOrThrow(exec, [gh, "api", `repos/${repo}/issues/${number}/comments`]);
    const comments = JSON.parse(commentsRaw) as Array<{ body?: string; user?: { login?: string } }>;
    const actionableComments = comments.filter((c) => !String(c.user?.login ?? "").endsWith("[bot]") && !String(c.body ?? "").includes("No blockers remain.")).length;
    prs.push({ number, headSha: String((pr.head as Record<string, unknown> | undefined)?.sha ?? ""), mergeable: pr.mergeable === true, ci, actionableComments, decisionAsk: false });
  }
  if (prs.some((p) => p.ci === "red")) return { signal: "ci-fail", prs, reason: "CI failed" };
  if (prs.some((p) => p.actionableComments > 0)) return { signal: "actionable-comment", prs, reason: "Actionable review comment found" };
  if (prs.some((p) => p.decisionAsk)) return { signal: "decision-ask", prs, reason: "Decision is required" };
  if (prs.length > 0 && prs.every((p) => p.ci === "green" && p.mergeable && p.actionableComments === 0)) return { signal: "complete", prs, reason: "Stack is green, clear, and mergeable" };
  return { signal: "idle", prs, reason: "No wake condition" };
}

export const pollHasNoAgent = true;
