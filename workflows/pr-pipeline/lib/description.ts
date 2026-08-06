export const PULL_REQUEST_GENERATION_INSTRUCTION = [
	"Write a Lindy pull request for a reviewer who has not read the task thread.",
	"Title: use `[TICKET-123] Title` when there is a ticket; otherwise use `feat(username): Title` or another conventional-commit type.",
	"Body: use `## Summary`, then `## Testing`; add `## Checklist`, `## Notes`, and `## Review` only when they have content.",
	"Lead with what changes or breaks and why it matters, not an insider label for the mechanism.",
	"Use concise, plain STE-100 English. Define any necessary product-specific term.",
	"Never include private documents, machine paths, effort names, run metadata, or workflow/factory vocabulary.",
	'Never add a "Test plan" section. Do not add agent attribution to a pull request description.',
].join("\n");

export interface PullRequestDescriptionInput {
	title: string;
	summary: string;
	acceptanceCriteria: string[];
	testing?: string;
	reviewOutcome?: string;
	changedFiles?: string[];
}

declare const teamFacingDescriptionInput: unique symbol;

export type TeamFacingPullRequestDescriptionInput = PullRequestDescriptionInput & {
	readonly formatInstruction: string;
	readonly [teamFacingDescriptionInput]: true;
};

const INTERNAL_CONTEXT_PATTERNS = [
	/\bDECISIONS-FOR-[^\s/\\)]*/i,
	/\b(?:CAPTAIN\s+)?DOCTRINE(?:\s+\d{4}-\d{2}-\d{2})?(?:\s*\([^)]+\))?/i,
	/\b(?:MEETING|DEBATE)\s+FOLD-IN(?:\s+\d{4}-\d{2}-\d{2})?/i,
	/\b(?:STANDING[- ]RULES|REPORT\.md)\b/i,
	/(?:\/Users\/|\/home\/|\/tmp\/|\/private\/var\/|\/opt\/|\/mnt\/|\/workspace\/|~\/|\.deck\/|(?<![A-Za-z])[A-Za-z]:[\\/])/i,
	/\$(?:DECK_HOME|HOME)\b/i,
	/\b(?:effort|implementation|decision)\s+dossier\b|(?:^|[/\\])(?:efforts?|dossiers?)(?:[/\\]|$)/i,
	/\bali-eval-fix-[a-z0-9-]*\b/i,
	/\b(?:eval-harness|factory|selfloop|retro)-[a-z0-9][a-z0-9-]*\b/i,
	/\b[a-z][a-z0-9]*-(?:eval|pipeline|retro|selfloop)-(?:fix|slice|spike|run|rewrite|hardening)-\d+\b/i,
	/\b(?:lane\s+[A-Z]\d*|lane-[a-z0-9][a-z0-9-]*)\b/i,
	/\b(?:run|execution|task)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/i,
	/\bworkflow\s+run\s+[A-Za-z0-9_-]{6,}\b/i,
	/\b[0-9a-f]{40}\b/i,
	/\b(?:captain|orch(?:estrator)?|fleet|stamp(?:able)?|yolo|smithers|worktree|implementer|adversar(?:y|ial)|factory)\b/i,
	/\b(?:workflow seat|watch-loop|push-pr|rebase-and-push|recut)\b/i,
	/\b(?:priority\s*#?\s*\d+|Spec\s*=|PR\s*\d+[A-Z]?\s+of|Managed by|Local review nits|review round|round[- ]?\d+)\b/i,
	/\b(?:implementation brief|task brief|brief acceptance criteria)\b/i,
	/(?:^|\n)--\s+[^ \n]+(?:'s)?\s+agent\s*$/im,
];

const MALFORMED_TEXT_PATTERNS = [
	/(?:^|[.!?]\s+|\n)[ \t]*[-–—,:;][ \t]*(?=\S)/,
	/(?:^|[\s:(])[-–—][ \t]*(?=(?:approved|decided|recorded|required|specified|stamped)\b)|\b(?:a|an|the|this|that|these|those)[ \t]*[,;:][ \t]+(?=(?:approved|decided|recorded|required|specified|stamped)\b)/i,
	/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:[-_]{2,}[A-Za-z0-9_-]*|[-_])\.[A-Za-z0-9]{1,10}\b/,
];
const INPUT_DENYLIST = [...INTERNAL_CONTEXT_PATTERNS, ...MALFORMED_TEXT_PATTERNS];

const REQUIRED_SECTIONS = ["## Summary", "## Testing"] as const;
const SECTION_ORDER = [...REQUIRED_SECTIONS, "## Checklist", "## Notes", "## Review"] as const;
const TITLE_FORMATS = [
	/^\[[A-Z][A-Z0-9]+-\d+\]\s+\S/,
	/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|test)\([a-z0-9._-]+\):\s+\S/i,
];

/** Drop private context at the input boundary before body generation sees it. */
export function sanitizeDescriptionInput(input: PullRequestDescriptionInput): TeamFacingPullRequestDescriptionInput {
	const filter = (value: string) =>
		value
			.split(/(?<=[.!?])\s+|\n+/)
			.map((segment) => segment.trim())
			.filter(
				(segment) =>
					segment.length > 0 && !INTERNAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(segment)),
			)
			.join(" ")
			.trim();

	return {
		title: filter(input.title),
		summary: filter(input.summary),
		acceptanceCriteria: input.acceptanceCriteria.map(filter).filter(Boolean),
		testing: input.testing === undefined ? undefined : filter(input.testing),
		reviewOutcome: input.reviewOutcome === undefined ? undefined : filter(input.reviewOutcome),
		changedFiles: input.changedFiles?.filter(
			(file) => !INTERNAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(file)),
		),
		formatInstruction: PULL_REQUEST_GENERATION_INSTRUCTION,
	} as TeamFacingPullRequestDescriptionInput;
}

function assertTeamFacingInput(value: string): string {
	const hit = INPUT_DENYLIST.find((pattern) => pattern.test(value));
	if (hit !== undefined) throw new Error(`PR description contains internal vocabulary or malformed text: ${hit}`);
	return value.trim();
}

function summarize(text: string): string {
	const cleaned = assertTeamFacingInput(text).replace(/^[\s.]+/, "").trim();
	if (!cleaned) return "This change updates product behavior.";
	const sentences = cleaned
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => /[A-Za-z]{3,}/.test(sentence) && sentence.length > 15);
	const body = (sentences.length > 0 ? sentences : [cleaned]).join(" ");
	if (body.length <= 480) return body;

	const completeSentences: string[] = [];
	let completeLength = 0;
	for (const sentence of sentences) {
		const candidateLength = completeLength + (completeLength > 0 ? 1 : 0) + sentence.length;
		if (candidateLength > 480) break;
		completeSentences.push(sentence);
		completeLength = candidateLength;
	}
	if (completeSentences.length > 0) return completeSentences.join(" ");

	const prefix = body.slice(0, 477);
	const wordBoundary = prefix.lastIndexOf(" ");
	return `${prefix.slice(0, wordBoundary > 0 ? wordBoundary : prefix.length).trimEnd()}...`;
}

export function assertTeamFacingPullRequestDescription(body: string): string {
	const normalized = body.trim();
	const leak = INTERNAL_CONTEXT_PATTERNS.find((pattern) => pattern.test(normalized));
	if (leak !== undefined) throw new Error(`PR description contains internal context: ${leak}`);
	if (/^## Test[- ]plan\b/im.test(normalized)) throw new Error('PR description must not include a "Test plan" section.');

	const sections: Array<{ heading: string; content: string[] }> = [];
	for (const line of normalized.split("\n")) {
		if (line.startsWith("## ")) {
			sections.push({ heading: line, content: [] });
		} else if (sections.length === 0) {
			if (line.trim().length > 0) throw new Error("PR description must start with a required section.");
		} else {
			sections.at(-1)?.content.push(line);
		}
	}

	const headings = sections.map((section) => section.heading);
	for (const required of REQUIRED_SECTIONS) {
		if (headings.filter((heading) => heading === required).length !== 1) {
			throw new Error(`PR description is missing required section: ${required}`);
		}
	}
	const sectionPositions = headings.map((heading) =>
		SECTION_ORDER.indexOf(heading as (typeof SECTION_ORDER)[number]),
	);
	if (sectionPositions.some((position) => position < 0)) {
		throw new Error("PR description contains an unsupported section.");
	}
	if (sectionPositions.some((position, index) => index > 0 && position <= sectionPositions[index - 1])) {
		throw new Error("PR description sections are duplicated or out of order.");
	}
	if (sections.some((section) => section.content.join("\n").trim().length === 0)) {
		throw new Error("PR description contains an empty section.");
	}
	const malformedSection = sections.find(
		(section) =>
			section.heading !== "## Checklist" &&
			MALFORMED_TEXT_PATTERNS.some((pattern) => pattern.test(section.content.join("\n"))),
	);
	if (malformedSection !== undefined) throw new Error("PR description contains malformed text.");
	return normalized;
}

export function generatePullRequestDescription(input: TeamFacingPullRequestDescriptionInput): string {
	if (input.formatInstruction !== PULL_REQUEST_GENERATION_INSTRUCTION) {
		throw new Error("PR description generation format contract is missing.");
	}
	const title = assertTeamFacingInput(input.title);
	if (!TITLE_FORMATS.some((pattern) => pattern.test(title))) {
		throw new Error("PR title must use `[TICKET-123] Title` or `feat(username): Title` format.");
	}

	const summarySource = input.summary || input.acceptanceCriteria.find(Boolean) || "";
	const problem = summarize(summarySource);
	const acceptance = input.acceptanceCriteria
		.map((criterion) => assertTeamFacingInput(criterion))
		.filter((criterion) => criterion.length > 8 && /[A-Za-z]{4,}/.test(criterion))
		.filter((criterion) => !/^must approve\.?$/i.test(criterion))
		.map((criterion) => `- ${criterion}`)
		.join("\n");
	const testing = assertTeamFacingInput(input.testing ?? "");
	const testingLine = testing.length > 8 ? testing : "Relevant automated checks were run.";
	const pipelineNote = (input.changedFiles ?? []).some((file) => /(?:^|\/)pipeline\.tsx$/i.test(file))
		? "This changes the pull-request automation. Start new runs after merge instead of resuming runs started on the previous version."
		: "";
	const review = input.reviewOutcome === undefined ? "" : assertTeamFacingInput(input.reviewOutcome);

	const body = [
		"## Summary",
		problem,
		"",
		"## Testing",
		testingLine,
		acceptance ? `\n## Checklist\n${acceptance}` : "",
		pipelineNote ? `\n## Notes\n${pipelineNote}` : "",
		review ? `\n## Review\n${review}` : "",
	]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return assertTeamFacingPullRequestDescription(body);
}
