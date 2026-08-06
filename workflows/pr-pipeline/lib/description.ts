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
	/(?:^|[^A-Za-z0-9])(?:CAPTAIN[\s_-]+DOCTRINE(?=$|[\s_,.();:/-])|DOCTRINE(?=$|[\s_,.();:/-])(?:[\s_-]+\d{4}-\d{2}-\d{2})?)(?:\s*\([^)]+\))?/,
	/\b(?:MEETING|DEBATE)[\s_-]+FOLD[\s_-]+IN(?:[\s_-]+\d{4}-\d{2}-\d{2})?/i,
	/\b(?:STANDING[- _]RULES|REPORT\.md)\b/i,
	/(?:^|[^A-Za-z0-9])\.deck(?:[\\/]|$)/i,
	/\$(?:DECK_HOME|HOME)\b/i,
	/\b(?:effort|implementation|decision)\s+dossier\b|(?:^|[/\\])(?:efforts?|dossiers?)(?:[/\\]|$)/i,
	/\bali-eval-fix-[a-z0-9-]*\b/i,
	/\b(?:eval-harness|factory|selfloop|retro)-[a-z0-9][a-z0-9-]*\b/i,
	/\b[a-z][a-z0-9]*-(?:eval|pipeline|retro|selfloop)-(?:fix|slice|spike|run|rewrite|hardening)-\d+\b/i,
	/\b(?:lane\s+[A-Z]\d*|lane-[a-z0-9][a-z0-9-]*)\b/i,
	/\b(?:run|execution|task|effort|lane)[-_ ]?id[:= ]+?[A-Za-z0-9_-]+\b/i,
	/\bworkflow\s+run\s+[A-Za-z0-9_-]{6,}\b/i,
	/\b[0-9a-f]{40}\b/i,
	/\b(?:captain|orch(?:estrator)?|fleet|stamp(?:able)?|yolo|smithers|worktree|implementer|adversar(?:y|ial)|factory)\b/i,
	/\b(?:workflow seat|watch-loop|push-pr|rebase-and-push|recut)\b/i,
	/\b(?:priority\s*#?\s*\d+|Spec\s*[:=]|PR\s*\d+[A-Z]?\s+of|Managed by|Local review nits|review round|round[- ]?\d+|must approve)\b/i,
	/\b(?:implementation brief|task brief|brief acceptance criteria)\b/i,
	/(?:^|\n)--\s+[^ \n]+(?:'s)?\s+agent[.!]?\s*$/im,
	/\b(?:this(?:\s+(?:change|description|pull request|pr(?:\s+body)?|body))?|the\s+(?:description|pull request|pr(?:\s+body)?|body))\s+(?:was\s+)?(?:generated|written|authored|prepared)\s+by\s+[^.\n]{0,80}\bagent\b/i,
	/(?:^|\n)(?:generated|written|authored|prepared)\s+by\s+[^.\n]{1,80}[.!]?\s*$/im,
];

const MACHINE_PATH_PATTERN =
	/(?:file:\/\/\/(?:Users|home|tmp|private|var|opt|mnt|workspace|srv|etc|root|usr|Volumes|data|Library|System|Applications|dev|proc|sys|run)\/|(?<![A-Za-z0-9./])\/(?:Users|home|tmp|private|var|opt|mnt|workspace|srv|etc|root|usr|Volumes|data|Library|System|Applications|dev|proc|sys|run)\/|(?<![A-Za-z0-9])~\/|(?<![A-Za-z0-9])[A-Za-z]:[\\/])/i;

const MALFORMED_TEXT_PATTERNS = [
	/(?:^|[.!?]\s+|\n)[ \t]*[-–—,:;][ \t]*(?=\S)/,
	/(?:^|[\s:(])[-–—][ \t]*(?=(?:approved|decided|recorded|required|specified|stamped)\b)|\b(?:a|an|the|this|that|these|those)[ \t]*[,;:][ \t]+(?=(?:approved|decided|recorded|required|specified|stamped)\b)/i,
	/\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:[-_]{2,}[A-Za-z0-9_-]*|[-_])\.[A-Za-z0-9]{1,10}\b/,
];

const PUBLIC_URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/gi;
const SUMMARY_SENTENCE_END_PATTERN = /[.!?](?=(?:["'”’)\]]+)?(?:\s|$))/g;
const REQUIRED_SECTIONS = ["## Summary", "## Testing"] as const;
const SECTION_ORDER = [...REQUIRED_SECTIONS, "## Checklist", "## Notes", "## Review"] as const;
const TITLE_FORMATS = [
	/^\[[A-Z][A-Z0-9]+-\d+\]\s+[^\r\n]+$/,
	/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|test)\([a-z0-9._-]+\):\s+[^\r\n]+$/i,
];

function findInternalContext(value: string): RegExp | undefined {
	const namedArtifact = INTERNAL_CONTEXT_PATTERNS.find((pattern) => pattern.test(value));
	if (namedArtifact !== undefined) return namedArtifact;
	const publicUrlsRemoved = value.replace(PUBLIC_URL_PATTERN, "");
	return MACHINE_PATH_PATTERN.test(publicUrlsRemoved) ? MACHINE_PATH_PATTERN : undefined;
}

export function formatPullRequestTitle(ticket: string, title: string): string {
	const ticketId = assertTeamFacingInput(ticket, "ticket", true);
	if (!/^[A-Z][A-Z0-9]+-\d+$/.test(ticketId)) {
		throw new Error("PR ticket must use `TICKET-123` format.");
	}
	const teamTitle = assertTeamFacingInput(title, "title", true);
	if (/[\r\n]/.test(teamTitle)) throw new Error("PR title must be a single line.");
	const existingTicket = teamTitle.match(/^\[([A-Z][A-Z0-9]+-\d+)\]\s+[^\r\n]+$/);
	if (existingTicket !== null && existingTicket[1] !== ticketId) {
		throw new Error(`PR title ticket ${existingTicket[1]} does not match ${ticketId}.`);
	}
	return existingTicket === null ? `[${ticketId}] ${teamTitle}` : teamTitle;
}

/** Validate and brand team-facing input before body generation can receive it. */
export function sanitizeDescriptionInput(input: PullRequestDescriptionInput): TeamFacingPullRequestDescriptionInput {
	return {
		title: assertTeamFacingInput(input.title, "title", true),
		summary: assertTeamFacingInput(input.summary, "summary", true),
		acceptanceCriteria: input.acceptanceCriteria.map((criterion, index) =>
			assertTeamFacingInput(criterion, `acceptance criterion ${index + 1}`, true),
		),
		testing:
			input.testing === undefined ? undefined : assertTeamFacingInput(input.testing, "testing evidence"),
		reviewOutcome:
			input.reviewOutcome === undefined
				? undefined
				: assertTeamFacingInput(input.reviewOutcome, "review outcome"),
		changedFiles: input.changedFiles?.map((file, index) =>
			assertTeamFacingInput(file, `changed file ${index + 1}`, true),
		),
		formatInstruction: PULL_REQUEST_GENERATION_INSTRUCTION,
	} as TeamFacingPullRequestDescriptionInput;
}

function assertTeamFacingInput(value: string, field = "generated text", required = false): string {
	const hit = findInternalContext(value) ?? MALFORMED_TEXT_PATTERNS.find((pattern) => pattern.test(value));
	if (hit !== undefined) {
		throw new Error(
			`PR description ${field} contains internal context or malformed text; regenerate it in team-facing English: ${hit}`,
		);
	}
	const trimmed = value.trim();
	if (required && trimmed.length === 0) {
		throw new Error(`PR description ${field} is empty; regenerate it in team-facing English.`);
	}
	return trimmed;
}

function assertTeamFacingSummary(text: string): string {
	const summary = assertTeamFacingInput(text, "summary", true);
	const wordCount = summary.split(/\s+/).length;
	const sentenceCount = summary.match(SUMMARY_SENTENCE_END_PATTERN)?.length ?? 1;
	if (sentenceCount < 2 || sentenceCount > 4 || wordCount > 80) {
		throw new Error(
			`PR description summary must contain 2-4 sentences and at most 80 words; regenerate it in team-facing English (received ${sentenceCount} sentences and ${wordCount} words).`,
		);
	}
	return summary;
}

function buildTeamFacingSummary(summary: string, acceptanceCriteria: string[]): string {
	const source = assertTeamFacingInput(summary, "summary", true);
	const sourceSentenceCount = source.match(SUMMARY_SENTENCE_END_PATTERN)?.length ?? 1;
	if (sourceSentenceCount !== 1) return assertTeamFacingSummary(source);
	const secondSentence = acceptanceCriteria[0];
	if (secondSentence === undefined) {
		throw new Error(
			"PR description summary has one sentence and no acceptance criterion to preserve as a second sentence; regenerate it in team-facing English.",
		);
	}
	const first = /[.!?](?:["'”’)\]]+)?$/.test(source) ? source : `${source}.`;
	const criterion = /[.!?](?:["'”’)\]]+)?$/.test(secondSentence)
		? secondSentence
		: `${secondSentence}.`;
	return assertTeamFacingSummary(`${first} It must satisfy this acceptance criterion: ${criterion}`);
}

export function assertTeamFacingPullRequestDescription(body: string): string {
	const normalized = body.trim();
	const leak = findInternalContext(normalized);
	if (leak !== undefined) throw new Error(`PR description contains internal context: ${leak}`);
	if (/^[ \t]*#{1,6}\s+Test[- ]plan\b/im.test(normalized)) {
		throw new Error('PR description must not include a "Test plan" section.');
	}
	if (/^[ \t]*Test[- ]plan[ \t]*\n[ \t]*(?:=+|-+)[ \t]*$/im.test(normalized)) {
		throw new Error('PR description must not include a "Test plan" section.');
	}
	if (/^[^\n]+\n[ \t]*(?:=+|-+)[ \t]*$/m.test(normalized)) {
		throw new Error("PR description contains an unsupported Setext heading.");
	}
	const markdownHeadings = normalized.match(/^[ \t]*#{1,6}(?:[ \t]+.*)?$/gm) ?? [];
	if (markdownHeadings.some((heading) => !heading.startsWith("## "))) {
		throw new Error("PR description contains an unsupported heading level.");
	}

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
	assertTeamFacingSummary(
		sections.find((section) => section.heading === "## Summary")?.content.join("\n") ?? "",
	);
	const malformedSection = sections.find((section) => {
		const content =
			section.heading === "## Checklist"
				? section.content
						.map((line) => line.replace(/^[ \t]*[-*+][ \t]+/, ""))
						.join("\n")
				: section.content.join("\n");
		return MALFORMED_TEXT_PATTERNS.some((pattern) => pattern.test(content));
	});
	if (malformedSection !== undefined) throw new Error("PR description contains malformed text.");
	return normalized;
}

export function generatePullRequestDescription(input: TeamFacingPullRequestDescriptionInput): string {
	if (input.formatInstruction !== PULL_REQUEST_GENERATION_INSTRUCTION) {
		throw new Error("PR description generation format contract is missing.");
	}
	const title = assertTeamFacingInput(input.title, "title", true);
	if (!TITLE_FORMATS.some((pattern) => pattern.test(title))) {
		throw new Error("PR title must use `[TICKET-123] Title` or `feat(username): Title` format.");
	}

	const acceptanceCriteria = input.acceptanceCriteria.map((criterion) =>
		assertTeamFacingInput(criterion, "acceptance criterion", true),
	);
	const problem = buildTeamFacingSummary(input.summary, acceptanceCriteria);
	const acceptance = acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
	const testing = assertTeamFacingInput(input.testing ?? "", "testing evidence");
	const testingLine = testing || "No test evidence was provided.";
	const changedFiles = (input.changedFiles ?? []).map((file, index) =>
		assertTeamFacingInput(file, `changed file ${index + 1}`, true),
	);
	const pipelineNote = changedFiles.some((file) => /(?:^|\/)pipeline\.tsx$/i.test(file))
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
