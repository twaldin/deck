/**
 * Prompt builders for the pipeline's agent tasks. Pure string functions.
 * Every prompt ends with an explicit JSON-only output contract; smithers
 * validates the parsed output against the task's Zod schema.
 */

import { AGENT_COMMENT_SIGNATURE, commentCommand, isSignatureProject, reviewReplyCommand } from "./comments.ts";
import type { Brief } from "./types.ts";

const RESULT_OBJECT_RULE =
	"Return a result object with these keys, NOT the schema. do not include $schema, type, properties, or required.";
function resultContract(example: string): string[] {
	return [
		RESULT_OBJECT_RULE,
		`Concrete valid result example: ${example}`,
		"Reply with ONLY the result object.",
	];
}

export function reviewersDecisionPrompt(denylist: string[]): string {
	return [
		"Choose GitHub reviewer logins for this pull request.",
		"When given names instead of logins, use the gh-reviewer-lookup skill at ~/.pi/agent/skills/gh-reviewer-lookup.",
		"Never emit a denylisted login. The denylist is supplied by pipeline config.",
		`Configured denylist: ${denylist.join(", ")}`,
	].join("\n");
}

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
		"- Do not create branches, PRs, or use GitHub merge commands.",
		"",
		...resultContract('{"commits":["abc123"],"summary":"Implemented the brief.","testEvidence":"bun test workflows/pr-pipeline/tests/pipeline.test.tsx"}'),
	].join("\n");
}

export function localReviewPrompt(
	brief: Pick<Brief, "title" | "acceptanceCriteria">,
	worktree: string,
	baseBranch: string,
	round: number,
	previous?: {
		blockingFindings: string[];
		nits: string[];
		summary: string;
		lastFix?: { addressed: string[]; summary: string };
	},
): string {
	// NOTE: the JSON contract below must stay in lockstep with the localReview
	// Zod schema in pipeline.tsx (round, approved, blockingFindings, nits, summary).
	return [
		"You are an ADVERSARIAL REVIEWER with fresh context (you did NOT write this change).",
		"You are deliberately a different model family than the implementer - hunt for what it missed.",
		`Worktree: ${worktree}. Review round: ${round}.`,
		"",
		`Review the full diff: \`git fetch origin ${baseBranch} && git diff origin/${baseBranch}...HEAD\` plus the repo context you need.`,
		"Brief the change claims to implement:",
		JSON.stringify({ title: brief.title, acceptanceCriteria: brief.acceptanceCriteria }, null, 2),
		"",
		"Hunt for: acceptance criteria not actually met, missing/weak tests, correctness bugs,",
		"unhandled edge cases, migration hazards, blast-radius surprises, dead code.",
		...(previous
			? [
				"Previous review output and implementer receipt:",
				"Re-check each prior blocker against the current diff. Drop it only when the diff shows it is fixed; re-raise it with a reason when it is not.",
				JSON.stringify(previous, null, 2),
			]
			: []),
		"Classify every item as blocking or a nit.",
		"IMPORTANT: The JSON Schema shown by the runner is an instruction, not an answer. A schema echo is invalid, even if it is valid JSON. Never copy or return schema keywords such as $schema, type, properties, required, or additionalProperties. Return one filled RESULT object with the review values.",
		"If your previous response was the schema, discard it now and answer the review. Do not explain the correction.",
		"Blocking findings are correctness, security, data loss, broken tests, contract breaks, or missing required behavior from the brief.",
		"Naming preferences, optional polish, pre-existing style outside the diff, and 'consider later' items are nits, never blockers.",
		"From review round 4 onward, actively reclassify remaining items. If only nits remain, approve. Do not keep the loop alive on taste.",
		"",
		`Result fields: {"round": number, "approved": boolean, "blockingFindings": string[], "nits": string[], "summary": string}.`,
		...resultContract(`{"round":${round},"approved":true,"blockingFindings":[],"nits":[],"summary":"No blocking findings."}`),
		`The result "round" MUST be exactly ${round}. Set approved=true IFF "blockingFindings" is empty. If you see a schema-echo correction, discard it and return the filled result object again.`,
	].join("\n");
}

export function localFixPrompt(blockingFindings: string[], worktree: string, afterRound: number): string {
	return [
		"You are the IMPLEMENTER. An adversarial reviewer produced blocking findings on your change.",
		`Worktree: ${worktree}. Fix them with plain commits on the current branch. DO NOT push.`,
		"",
		"Blocking findings to resolve (all of them):",
		JSON.stringify(blockingFindings, null, 2),
		"",
		`Result fields: {"afterRound": number, "addressed": string[], "summary": string}.`,
		...resultContract(`{"afterRound":${afterRound},"addressed":[],"summary":"All blocking findings addressed."}`),
		`The result "afterRound" MUST be exactly ${afterRound}.`,
	].join("\n");
}

export function watchFixPrompt(args: {
	worktree: string;
	branch: string;
	baseBranch: string;
	repo: string;
	prNumber: number;
	project?: string;
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
		`1. If mergeability is CONFLICTING, or mergeStateStatus is DIRTY or BEHIND, run the deterministic rebase helper: fetch origin/${args.baseBranch}, rebase THIS PR branch onto origin/${args.baseBranch}, run relevant tests, then force-with-lease push. If the helper is unavailable, run exactly those git commands yourself.`,
		"   Resolve conflicts, run relevant tests, then force-with-lease push the existing PR branch. Do not merge.",
		"2. Every unresolved review thread: fix the code if warranted (plain commits on THIS branch),",
		"   reply in the thread, and resolve it (or reply why not, and resolve after agreement).",
		`3. Every unanswered actionable issue comment: pipe the answer to this signing helper, not a raw gh comment command: ${commentCommand(args.project, args.repo, args.prNumber, "YOUR ANSWER")}. For review-thread replies use: ${reviewReplyCommand(args.project, args.repo, 0, "YOUR ANSWER")}.${isSignatureProject(args.project) ? ` The helper adds ${AGENT_COMMENT_SIGNATURE}.` : ""} Use a heredoc or stdin so shell metacharacters stay literal. Use the helper for every issue comment and review reply. Do not add it to the PR description.`,


		"4. Hard-red CI: flake -> rerun; trivial/correctness fix -> commit + push. Product/decision-class",
		"   failures are NOT yours - describe them in the summary instead of guessing.",
		"5. If you pushed changes, re-request ONLY the logins in the machine poll state's reviewersNeedingReRequest list.",
		"   Never re-request a reviewer whose latest state is APPROVED, COMMENTED, or DISMISSED; do not use a blanket prior-reviewer list.",
		`   For each eligible login, run: \`${args.gh} api repos/${args.repo}/pulls/${args.prNumber}/requested_reviewers -f 'reviewers[]=LOGIN'\``,
		"   (the requested_reviewers API is verified by the next poll - silent no-ops are caught).",
		"",
		"HARD RULES: plain commits on the existing PR branch ONLY. Never branch off the PR head,",
		"never run gh pr create - that creates an accidental child PR.",
		"Never merge anything. After a rerun or push, return the receipt and exit immediately.",
		"Never sleep-poll CI or review state. The next persisted Smithers poll owns the wait.",
		"The JSON Schema is not a response. Never return $schema, type, properties, required, or additionalProperties. Return one filled RESULT object only.",
		`Result fields: {"round": number, "afterPoll": number, "actions": string[], "pushed": boolean, "reRequested": string[], "summary": string}.`,
		...resultContract(`{"round":${args.round},"afterPoll":${args.afterPoll},"actions":[],"pushed":false,"reRequested":[],"summary":"No action required."}`),
		`The result "round" MUST be exactly ${args.round} and "afterPoll" MUST be exactly ${args.afterPoll}.`,
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
		"Result fields (JSON object):",
		"```json",
		JSON.stringify({ verdict: "clean|regression", breakSignal: "string", probeResults: ["string"], notes: "string" }),
		"```",
		"Return a result object with these keys, NOT the schema. do not include $schema, type, properties, or required.",
		"Concrete valid result example (JSON):",
		"```json",
		JSON.stringify({ verdict: "clean", breakSignal: args.breakSignal, probeResults: [], notes: "No fallout detected." }),
		"```",
		"Reply with ONLY the result object.",
		`The result "breakSignal" MUST be exactly ${JSON.stringify(args.breakSignal)}.`,
		'verdict="regression" whenever you find plausible fallout - escalation is cheap, missed regressions are not.',
	].join("\n");
}
