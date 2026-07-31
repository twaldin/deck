/**
 * Prompt builders for the pipeline's agent tasks. Pure string functions.
 * Every prompt ends with an explicit JSON-only output contract; smithers
 * validates the parsed output against the task's Zod schema.
 */

import type { Brief } from "./types.ts";

export function implementPrompt(brief: Brief, worktree: string, branch: string): string {
	return [
		"You are the IMPLEMENTER inside an enforced PR pipeline for the lindy repo.",
		`Worktree: ${worktree}`,
		`Branch: ${branch} (already checked out; commit here, path-scoped commits only).`,
		"",
		"Brief:",
		JSON.stringify(brief, null, 2),
		"",
		"Rules:",
		"- Implement exactly the brief. No scope creep; open questions were resolved before dispatch.",
		"- Run the relevant tests locally and record what you ran.",
		"- Commit your work as one or more plain commits on this branch. DO NOT push.",
		"- Do not create branches, PRs, or use gt/graphite commands.",
		"",
		'Final output: ONLY a JSON object {"commits": string[] (shas), "summary": string, "testEvidence": string}.',
	].join("\n");
}

export function localReviewPrompt(brief: Brief, worktree: string, baseBranch: string, round: number): string {
	// NOTE: the JSON contract below must stay in lockstep with the localReview
	// Zod schema in pipeline.tsx (round, approved, findings, summary).
	return [
		"You are an ADVERSARIAL REVIEWER with fresh context (you did NOT write this change).",
		"You are deliberately a different model family than the implementer - hunt for what it missed.",
		`Worktree: ${worktree}. Review round: ${round}.`,
		"",
		`Review the full diff: \`git diff ${baseBranch}...HEAD\` plus the repo context you need.`,
		"Brief the change claims to implement:",
		JSON.stringify({ title: brief.title, acceptanceCriteria: brief.acceptanceCriteria }, null, 2),
		"",
		"Hunt for: acceptance criteria not actually met, missing/weak tests, correctness bugs,",
		"unhandled edge cases, migration hazards, blast-radius surprises, dead code.",
		"Only findings that materially matter; no style nits.",
		"",
		`Final output: ONLY a JSON object {"round": ${round}, "approved": boolean, "findings": string[], "summary": string}.`,
		`"round" MUST be exactly ${round}. Set approved=true ONLY if there are zero blocking findings.`,
	].join("\n");
}

export function localFixPrompt(findings: string[], worktree: string, afterRound: number): string {
	return [
		"You are the IMPLEMENTER. An adversarial reviewer produced blocking findings on your change.",
		`Worktree: ${worktree}. Fix them with plain commits on the current branch. DO NOT push.`,
		"",
		"Findings to resolve (all of them):",
		JSON.stringify(findings, null, 2),
		"",
		`Final output: ONLY a JSON object {"afterRound": ${afterRound}, "addressed": string[], "summary": string}.`,
		`"afterRound" MUST be exactly ${afterRound}.`,
	].join("\n");
}

export function watchFixPrompt(args: {
	worktree: string;
	branch: string;
	baseBranch: string;
	repo: string;
	prNumber: number;
	gh: string;
	pollJson: string;
	round: number;
	afterPoll: number;
}): string {
	return [
		"You are the WATCH-LOOP FIXER for an open PR. You own ALL feedback: review threads,",
		"actionable comments, reviewer re-requests, and CI.",
		`Worktree: ${args.worktree} | branch: ${args.branch} | base: ${args.baseBranch} | repo: ${args.repo} | PR #${args.prNumber}.`,
		`Use the \`${args.gh}\` CLI for every GitHub operation.`,
		"",
		"Current machine-checked poll state:",
		args.pollJson,
		"",
		"Do, in order:",
		`1. If mergeability is CONFLICTING, or mergeStateStatus is DIRTY, fetch origin/${args.baseBranch}, then rebase THIS PR branch onto origin/${args.baseBranch}.`,
		"   Resolve conflicts, run relevant tests, then force-with-lease push the existing PR branch. Do not merge.",
		"2. Every unresolved review thread: fix the code if warranted (plain commits on THIS branch),",
		"   reply in the thread, and resolve it (or reply why not, and resolve after agreement).",
		"3. Every unanswered actionable comment: answer it via the gh CLI.",
		"4. Hard-red CI: flake -> rerun; trivial/correctness fix -> commit + push. Product/decision-class",
		"   failures are NOT yours - describe them in the summary instead of guessing.",
		"5. If you pushed changes, re-request every prior human reviewer:",
		`   \`${args.gh} api repos/${args.repo}/pulls/${args.prNumber}/requested_reviewers -f 'reviewers[]=LOGIN'\``,
		"   (the requested_reviewers API is verified by the next poll - silent no-ops are caught).",
		"",
		"HARD RULES: plain commits on the existing PR branch ONLY. Never branch off the PR head,",
		"never run gt submit / gt create / gh pr create - that creates an accidental child PR.",
		"Never merge anything. After a rerun or push, return the receipt and exit immediately.",
		"Never sleep-poll CI or review state. The next persisted Smithers poll owns the wait.",

		"",
		`Final output: ONLY a JSON object {"round": ${args.round}, "afterPoll": ${args.afterPoll}, "actions": string[], "pushed": boolean, "reRequested": string[], "summary": string}.`,
		`"round" MUST be exactly ${args.round} and "afterPoll" MUST be exactly ${args.afterPoll}.`,
	].join("\n");
}

export function falloutPrompt(args: {
	breakSignal: string;
	killSwitch: string;
	repo: string;
	prNumber: number;
	landedSha: string;
	windowStart: string;
	windowEnd: string;
	probes: string[];
}): string {
	return [
		"You are the FALLOUT WATCHER after a deploy. Merged != done; your verdict gates done.",
		`Repo: ${args.repo} | PR #${args.prNumber} | landed sha: ${args.landedSha}.`,
		`Watch window (anchored to deploy): ${args.windowStart} .. ${args.windowEnd}.`,
		`NAMED break-signal from preflight (your primary probe): ${args.breakSignal}`,
		`Kill-switch: ${args.killSwitch}`,
		args.probes.length > 0
			? `Additional probe commands to run and interpret:\n${args.probes.map((probe) => `- ${probe}`).join("\n")}`
			: "No additional probe commands configured.",
		"",
		"Probe the break-signal (Sentry/#on-call-issues as it names) and run an OUTCOME probe,",
		"not just error rates: does the feature actually behave for users? [Evidence: #23965",
		"missed a live 169-user regression by watching error rates only.]",
		"",
		`Final output: ONLY a JSON object {"verdict": "clean"|"regression", "breakSignal": ${JSON.stringify(args.breakSignal)}, "probeResults": string[], "notes": string}.`,
		`"breakSignal" MUST be exactly ${JSON.stringify(args.breakSignal)}.`,
		'verdict="regression" whenever you find plausible fallout - escalation is cheap, missed regressions are not.',
	].join("\n");
}
