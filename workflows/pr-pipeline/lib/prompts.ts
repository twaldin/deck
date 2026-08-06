/**
 * Prompt builders for the pipeline's agent tasks. Pure string functions.
 * Every prompt ends with an explicit JSON-only output contract; smithers
 * validates the parsed output against the task's Zod schema.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Brief } from "./types.ts";
import type { StackCarSpec } from "./adopt.ts";

const RESULT_OBJECT_RULE =
	"Return a result object with these keys, NOT the schema. do not include $schema, type, properties, or required.";
const RLM_GUIDANCE =
	"Use Prime's native `rlm()` for bounded delegation when the seat is Prime. A non-Prime seat has no delegation primitive and performs the node directly. RLM depth is one: children are allowed and grandchildren are not. A bare child uses deck/gpt-5.6-luna at xhigh; escalation requires an explicit model pin. Reserve deck/claude-fable-5 at high for judgment and adversarial review because it consumes all three Anthropic quota buckets while ordinary models consume two. For stack work, land the schema/base PR first, then fan out RLM children for dependent pieces.";
const WORKER_MEMORY_CONTRACT =
	"Never run OptMem from a workflow seat or RLM child. Route decisions through the workflow's question result.";
const OUTPUT_FACING_BOUNDARY = [
	"OUTPUT-FACING BOUNDARY:",
	"- Internal paths, worktrees, workflow node names, run or task ids, model labels, and workflow or factory vocabulary are tool-context ONLY.",
	"- Translate every team-facing artifact into team terms. PR text, comments, review replies, and queued question text must never expose that tool context.",
].join("\n");
const ACTOR_BOUNDARY = [
	"ACTOR BOUNDARY (binding even when live standing rules predate actor labels):",
	"- [CHAT SESSION] Discharge build, review, and deploy obligations only through ship, adopt, status, and queued questions; never execute the delivery middle.",
	"- [WORKFLOW SEAT] Execute the delivery middle after dispatch; report decision needs through the structured workflow result.",
].join("\n");
const STANDING_RULES_HEADER =
	"--- STANDING-RULES (binding digest; source is live ~/.deck with committed fallback) ---";
const STANDING_RULES_FOOTER = "--- END STANDING-RULES ---";
const STANDING_RULES_MAX_BYTES = 8 * 1024;
const STANDING_RULES_SOURCE_MAX_BYTES =
	STANDING_RULES_MAX_BYTES -
	Buffer.byteLength(STANDING_RULES_HEADER, "utf8") -
	Buffer.byteLength(ACTOR_BOUNDARY, "utf8") -
	Buffer.byteLength(STANDING_RULES_FOOTER, "utf8") -
	4;
const STANDING_RULES_SECTION_PRIORITY = [
	"(document preamble)",
	"0. Actor boundary (binding precedence)",
	'1. The "make PR" flow (captain\'s target, binding)',
	"5. Decisions",
	"2. Merge authority & autonomy",
	"4. Comms (zero-tolerance set)",
	"3. Reviewers",
	"7. Evidence standards",
	"6. Dispatch & workers",
	"8. Prod-scale review gate (standing blind spot)",
	"9. Lindy north star & eval doctrine (short form)",
	"10. Linear & on-call",
	"11. Memory & homes",
	"12. Auth doctrine",
] as const;
const STANDING_RULES_FALLBACK = new URL("../seed/standing-rules.md", import.meta.url);

type StandingRulesSection = {
	title: string;
	body: string;
	sourceOrder: number;
};

function standingRulesSections(source: string): StandingRulesSection[] {
	const headings = [...source.matchAll(/^##\s+(.+?)\s*$/gm)];
	if (headings.length === 0) {
		return [{ title: "(unsectioned rules)", body: source.trim(), sourceOrder: 0 }];
	}

	const preamble = source.slice(0, headings[0]!.index).trim();
	const sourceOrderOffset = preamble.length > 0 ? 1 : 0;
	const sections = headings.map((heading, headingIndex) => {
		const start = heading.index!;
		const end = headings[headingIndex + 1]?.index ?? source.length;
		return {
			title: heading[1]!,
			body: source.slice(start, end).trim(),
			sourceOrder: headingIndex + sourceOrderOffset,
		};
	});
	return preamble.length > 0
		? [{ title: "(document preamble)", body: preamble, sourceOrder: 0 }, ...sections]
		: sections;
}

function truncationMarker(omitted: StandingRulesSection[]): string {
	const footer =
		omitted.length > 0
			? "Entire sections were omitted; no rule was cut mid-rule."
			: "Only section-boundary whitespace was omitted; no rule was cut mid-rule.";
	const abbreviatedNames = omitted.map((section) => {
		const characters = [...section.title];
		return characters.length <= 120 ? section.title : `${characters.slice(0, 120).join("")}…`;
	});

	for (let included = abbreviatedNames.length; included >= 0; included--) {
		const remaining = abbreviatedNames.length - included;
		const omittedNames =
			included > 0
				? `${abbreviatedNames.slice(0, included).join("; ")}${
						remaining > 0 ? `; … plus ${remaining} additional omitted section(s); see live source` : ""
					}`
				: omitted.length > 0
					? `${omitted.length} section(s); names exceed the prompt budget; see live source`
					: "none";
		const marker = [
			"TRUNCATED — live standing rules exceed the prompt-injection budget.",
			`Omitted sections: ${omittedNames}.`,
			footer,
		].join("\n");
		if (Buffer.byteLength(marker, "utf8") <= STANDING_RULES_SOURCE_MAX_BYTES) return marker;
	}

	throw new Error("standing-rules truncation marker cannot fit its fixed budget");
}

function curateStandingRules(source: string): string {
	const trimmed = source.trim();
	if (Buffer.byteLength(trimmed, "utf8") <= STANDING_RULES_SOURCE_MAX_BYTES) return trimmed;

	const sections = standingRulesSections(trimmed);
	const priority = new Map<string, number>(
		STANDING_RULES_SECTION_PRIORITY.map((title, index) => [title, index]),
	);
	const ordered = [...sections].sort((left, right) => {
		const leftPriority = priority.get(left.title) ?? STANDING_RULES_SECTION_PRIORITY.length;
		const rightPriority = priority.get(right.title) ?? STANDING_RULES_SECTION_PRIORITY.length;
		return leftPriority - rightPriority || left.sourceOrder - right.sourceOrder;
	});
	const selected: StandingRulesSection[] = [];

	for (const section of ordered) {
		const candidate = [...selected, section];
		const omitted = sections.filter((item) => !candidate.includes(item));
		const candidateDigest = [...candidate.map((item) => item.body), truncationMarker(omitted)].join("\n\n");
		if (Buffer.byteLength(candidateDigest, "utf8") <= STANDING_RULES_SOURCE_MAX_BYTES) {
			selected.push(section);
		}
	}

	const omitted = sections.filter((section) => !selected.includes(section));
	return [...selected.map((section) => section.body), truncationMarker(omitted)].join("\n\n");
}

/**
 * Resolve on every prompt build so updated operator doctrine reaches new seats
 * without restarting the workflow process. The committed seed keeps prompt
 * construction available when the operator home is absent.
 */
export function standingRulesDigest(): string {
	const live = path.join(
		process.env.HOME ?? os.homedir(),
		".deck",
		"data",
		"ref",
		"distill",
		"STANDING-RULES.md",
	);
	let source: string;
	try {
		source = fs.readFileSync(live, "utf8");
	} catch {
		try {
			source = fs.readFileSync(STANDING_RULES_FALLBACK, "utf8");
		} catch {
			source = "Standing rules are unavailable. Fail closed on authority, merge, and destructive actions.";
		}
	}
	const digest = curateStandingRules(source);
	return [
		STANDING_RULES_HEADER,
		ACTOR_BOUNDARY,
		"",
		digest,
		STANDING_RULES_FOOTER,
	].join("\n");
}

function seatPrompt(lines: string[]): string {
	return [
		standingRulesDigest(),
		"",
		...lines,
		"",
		OUTPUT_FACING_BOUNDARY,
		"",
		`MEMORY/DECISION BOUNDARY: ${WORKER_MEMORY_CONTRACT}`,
	].join("\n");
}

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
		"When given names instead of logins, use the gh-reviewer-lookup skill in .agent/skills/gh-reviewer-lookup.",
		"Never emit a denylisted login. The denylist is supplied by pipeline config.",
		`Configured denylist: ${denylist.join(", ")}`,
	].join("\n");
}

export function implementPrompt(brief: Brief, worktree: string, branch: string): string {
	return seatPrompt([
		"You are the IMPLEMENTER inside an enforced PR pipeline for the lindy repo.",
		`Worktree: ${worktree}`,
		`Branch: ${branch} (already checked out; commit here, path-scoped commits only).`,
		"",
		"Brief:",
		JSON.stringify(brief, null, 2),
		"",
		"Rules:",
		`- ${RLM_GUIDANCE}`,
		"- Implement exactly the brief. No scope creep; open questions were resolved before dispatch.",
		"- Run the relevant tests locally and record what you ran.",
		"- Commit your work as one or more plain commits on this branch. DO NOT push.",
		"- Do not create branches, PRs, or use GitHub merge commands.",
		"",
		...resultContract('{"summary":"Implemented the brief.","testEvidence":"bun test workflows/pr-pipeline/tests/pipeline.test.tsx"}'),
	]);
}

export function stackImplementPrompt(
	brief: Brief,
	worktree: string,
	rootBaseBranch: string,
	specs: StackCarSpec[],
): string {
	return seatPrompt([
		"You are the IMPLEMENTER for one ordered native GitHub PR stack.",
		`Worktree: ${worktree}`,
		`Root base branch: ${rootBaseBranch}`,
		"Declared cars, parent first:",
		JSON.stringify(specs, null, 2),
		"",
		"Brief:",
		JSON.stringify(brief, null, 2),
		"",
		"Rules:",
		`- ${RLM_GUIDANCE}`,
		"- Implement exactly the brief across the declared cars in dependency order.",
		"- Use every declared branch exactly once and create no extra branches.",
		"- Each car must contain only its independently reviewable layer. Commit on that car with path-scoped commits.",
		"- Build the first car from the declared root, then each child from the preceding car.",
		"- Run focused tests for every layer and record the evidence per car.",
		"- Do not push, open PRs, invoke gh stack, or use GitHub merge commands. The deterministic pipeline owns publication.",
		"- Leave the worktree clean with the final/top car checked out.",
		"",
		...resultContract(
			'{"commits":[],"summary":"Implemented the ordered stack.","testEvidence":"All layer tests passed.","stackCars":[{"branch":"parent","commits":["abc123"],"testEvidence":"bun test parent"},{"branch":"child","commits":["def456"],"testEvidence":"bun test child"}]}',
		),
	]);
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
	return seatPrompt([
		"You are an ADVERSARIAL REVIEWER with fresh context (you did NOT write this change).",
		"You are deliberately a different model family than the implementer - hunt for what it missed.",
		`Worktree: ${worktree}. Review round: ${round}.`,
		"",
		`Review the full diff: \`git fetch origin ${baseBranch} && git diff origin/${baseBranch}...HEAD\` plus the repo context you need.`,
		"Brief the change claims to implement:",
		JSON.stringify({ title: brief.title, acceptanceCriteria: brief.acceptanceCriteria }, null, 2),
		"",
		RLM_GUIDANCE,
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
	]);
}

export function localFixPrompt(blockingFindings: string[], worktree: string, afterRound: number): string {
	return seatPrompt([
		"You are the IMPLEMENTER. An adversarial reviewer produced blocking findings on your change.",
		`Worktree: ${worktree}. Fix them with plain commits on the current branch. DO NOT push.`,
		RLM_GUIDANCE,
		"",
		"Blocking findings to resolve (all of them):",
		JSON.stringify(blockingFindings, null, 2),
		"",
		`Result fields: {"afterRound": number, "addressed": string[], "summary": string}.`,
		...resultContract(`{"afterRound":${afterRound},"addressed":[],"summary":"All blocking findings addressed."}`),
		`The result "afterRound" MUST be exactly ${afterRound}.`,
	]);
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
	briefJson?: string;
	triggerJson?: string;
	round: number;
	afterPoll: number;
}): string {
	return seatPrompt([
		"You are the WATCH-LOOP SEAT for an open PR. A real event woke you; do not poll or invent work.",
		`Worktree: ${args.worktree} | branch: ${args.branch} | base: ${args.baseBranch} | repo: ${args.repo} | PR #${args.prNumber}.`,
		"",
		"Original effort brief and decision context (authoritative):",
		args.briefJson ?? "{}",
		"",
		"Specific trigger payloads that woke this seat:",
		args.triggerJson ?? "[]",
		"",
		"Current machine-checked exact-head poll evidence:",
		args.pollJson,
		"",
		RLM_GUIDANCE,
		"Handle every trigger, in this order:",
		"1. Failed CI: read the linked real job/check logs first. Fix a genuine diff-related failure and commit locally; rerun only a proven transient failure. Do not guess from a status placeholder.",
		"   Never change a CI runner platform/image, workflow trigger, or provider configuration as a test fix. If the evidence suggests that policy is wrong, return a DECISION route for that failed_ci trigger; configuration blast radius belongs to the captain.",
		"2. Human or configured review-bot comments: classify each independently as exactly one of:",
		"   FIX_NOW — scoped and actionable. Fix it, commit locally, and provide replyBody explaining the fix for the deterministic publisher to post on the thread.",
		"   NOT_VALID — invalid, stale, already fixed, or inapplicable. Do not change code. Provide replyBody explaining why; the publisher posts it and the workflow tells the captain.",
		"   DECISION — product/design/API choice or material the captain should argue back on. Do not guess or change code. Provide the concrete question for the captain's queue. This route does not block unrelated work.",
		"3. Include one route for every human_comment or bot_comment trigger. Each route.triggerId must exactly match its trigger id.",
		"4. handledTriggerIds contains every trigger id you actually completed or routed. Never mark an unexamined trigger handled.",
		"5. Return every commit created by this seat as a full 40- or 64-character SHA in commits, oldest first.",
		"",
		"The deterministic publisher owns rebase, tests, force-with-lease push, signed PR replies, and reviewer re-requests.",
		"Never rebase, push, approve, stamp, merge, create a branch, or open a PR. Return pushed=false and reRequested=[].",
		"Never post a raw GitHub comment. Return replyBody; the publisher signs and posts it only after any FIX_NOW commit is safely published.",
		"Never sleep-poll CI or reviews. The persisted Smithers loop owns all waiting.",
		"The JSON Schema is not a response. Return one filled result object only.",
		`Result fields: {"round": number, "afterPoll": number, "actions": string[], "commits": string[], "pushed": false, "reRequested": [], "summary": string, "routes": [{"triggerId": string, "outcome": "FIX_NOW"|"NOT_VALID"|"DECISION", "rationale": string, "replyBody"?: string, "question"?: string}], "handledTriggerIds": string[]}.`,
		...resultContract(
			`{"round":${args.round},"afterPoll":${args.afterPoll},"actions":[],"commits":[],"pushed":false,"reRequested":[],"summary":"All supplied triggers classified.","routes":[],"handledTriggerIds":[]}`,
		),
		`The result "round" MUST be exactly ${args.round} and "afterPoll" MUST be exactly ${args.afterPoll}.`,
	]);
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
	return seatPrompt([
		"You are the FALLOUT WATCHER after a deploy. Merged != done; your verdict gates done.",
		`Repo: ${args.repo} | PR #${args.prNumber} | landed sha: ${args.landedSha}.`,
		`Watch window (anchored to deploy): ${args.windowStart} .. ${args.windowEnd}.`,
		`NAMED break-signal from preflight (your primary probe): ${args.breakSignal}`,
		`Kill-switch: ${args.killSwitch}`,
		RLM_GUIDANCE,
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
	]);
}
