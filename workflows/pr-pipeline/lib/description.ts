export interface PullRequestDescriptionInput {
	title: string;
	summary: string;
	acceptanceCriteria: string[];
	testing?: string;
	reviewOutcome?: string;
	changedFiles?: string[];
}

/** Remove private workflow instructions before the body-generation step sees them. */
export function sanitizeDescriptionInput(input: PullRequestDescriptionInput): PullRequestDescriptionInput {
<<<<<<< HEAD
	const sanitize = (value: string) => {
		let s = value;
		// Remove whole sentences that contain brief-only control information first.
		s = s.replace(/[^.!?\n]*\bpriority\s*#?\s*\d+\b[^.!?\n]*[.!?]?/gi, " ");
		s = s.replace(/[^.!?\n]*\bSpec\s*=\b[^.!?\n]*[.!?]?/gi, " ");
		s = s.replace(/[^.!?\n]*\bPR\s*\d+[A-Z]?\s+of\b[^.!?\n]*[.!?]?/gi, " ");
		s = s.replace(/[^.!?\n]*\bimplementer\s+must\b[^.!?\n]*[.!?]?/gi, " ");
		s = s.replace(/[^.!?\n]*\bREPORT\.md\b[^.!?\n]*[.!?]?/gi, " ");
		// Remove local paths and private vocabulary. This is the primary protection;
		// clean() below remains a failing backstop for any missed input.
		s = s.replace(/(?:\/Users\/|\/home\/|~\/)[^\s\n)`\"']*/gi, "");
		s = s.replace(/\.deck\/[^\s\n)`\"']*/gi, "");
		s = s.replace(/[A-Za-z]:[\\\\/]+[^\s\n)`\"']+/g, "");
		s = s.replace(
			/\b(?:captain|orch(?:estrator)?|fleet|stamp(?:able)?|yolo|smithers|worktree|implementer|adversar(?:y|ial))\b/gi,
			"",
		);
		s = s.replace(/\b(?:must read|READ FIRST|DO NOT)\b[^.!?\n]*/gi, "");
		s = s.replace(/[\"']###[^\"']*[\"']/g, "");
		s = s.replace(/\b(?:run|execution)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/gi, "");
		s = s.replace(/\b[0-9a-f]{40}\b/gi, "");
		s = s.replace(/Managed by[^\n]*/gi, "");
		s = s.replace(/Local review nits[^\n]*(?:\n[-*].*)*/gi, "");
		return s
			.replace(/[ \t]{2,}/g, " ")
			.replace(/ ?([,.;:])/g, "$1")
			.replace(/\(\s*\)/g, "")
			.replace(/(?:^|\s)\.(?=\s|$)/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	};

=======
	const sanitize = (value: string) => value
		.replace(/(?:^|\s|\(|"|'|\[)\/(?:Users|home)\/[^\s\n)]*/gi, " the local worktree")
		.replace(/[A-Za-z]:[\\\\/]+[^\s\n)]+/g, "the local worktree")
		.replace(/~\/\.deck\S*/gi, "the local workflow directory")
		.replace(/\b(?:run|execution)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/gi, "")
		.replace(/\b[0-9a-f]{7,40}\b/gi, "")
		.replace(/Managed by[^\n]*/gi, "")
		.replace(/Local review nits[^\n]*(?:\n[-*].*)*/gi, "")
		.replace(/\b(?:READ|DO NOT)\b[^\n]*/gi, "")
		.replace(/\b(?:captain|orch(?:estrator)?|stamp|yolo)\b/gi, "")
		.trim();
>>>>>>> bb57dc7 (fix(pipeline): wire sanitized PR descriptions)
	return {
		title: sanitize(input.title),
		summary: sanitize(input.summary),
		acceptanceCriteria: input.acceptanceCriteria.map(sanitize),
		testing: input.testing === undefined ? undefined : sanitize(input.testing),
		reviewOutcome: input.reviewOutcome === undefined ? undefined : sanitize(input.reviewOutcome),
		changedFiles: input.changedFiles,
	};
}

const DENYLIST = [
<<<<<<< HEAD
	/\b(?:captain|orch(?:estrator)?|fleet|stamp(?:able)?|yolo|smithers|worktree|implementer|adversar(?:y|ial))\b/i,
	/\b(?:priority\s*#?\s*\d+|Spec\s*=|PR\s*\d+[A-Z]?\s+of|REPORT\.md)\b/i,
	/(?:\/Users\/|\/home\/|~\/|\.deck\/|[A-Za-z]:[\\\\/])/i,
	/\b(?:run|execution)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/i,
	/\b[0-9a-f]{40}\b/i,
	/\b(?:Managed by|Local review nits)\b/i,
=======
	/captain/i,
	/\borch(?:estrator)?\b/i,
	/\bstamp\b/i,
	/\byolo\b/i,
	/(?:^|\s|\(|"|'|\[)\/(?:Users|home)\/|(?:^|\s|\(|"|'|\[)[A-Za-z]:[\\\\/]/i,
	/~\/\.deck/i,
>>>>>>> bb57dc7 (fix(pipeline): wire sanitized PR descriptions)
];

/** Assert that sanitized text is safe. Never silently scrub generated output. */
function clean(value: string): string {
	const hit = DENYLIST.find((pattern) => pattern.test(value));
	if (hit !== undefined) throw new Error(`PR description contains internal vocabulary: ${hit}`);
	return value.trim();
}

function summarize(text: string): string {
	const cleaned = clean(text).replace(/^[\s.]+/, "").trim();
	if (!cleaned) return "This change updates product behavior.";
	const sentences = cleaned
		.split(/(?<=\.)\s+/)
		.map((x) => x.trim())
		.filter((x) => /[A-Za-z]{3,}/.test(x) && x.length > 15);
	const body = (sentences.length ? sentences : [cleaned]).join(" ");
	return body.length > 480 ? `${body.slice(0, 477)}...` : body;
}

export function generatePullRequestDescription(input: PullRequestDescriptionInput): string {
	const problem = summarize(input.summary || "");
	const acceptance = input.acceptanceCriteria
		.map((criterion) => clean(criterion))
		.filter((c) => c.length > 8 && /[A-Za-z]{4,}/.test(c))
		.filter((c) => !/^must approve\.?$/i.test(c))
		.map((c) => `- ${c}`)
		.join("\n");
	const testing = clean(input.testing ?? "");
	const testingLine = testing.length > 8 ? testing : "Relevant automated checks were run.";
	const pipelineNote = (input.changedFiles ?? []).some((file) => /(?:^|\/)pipeline\.tsx$/i.test(file))
		? "Editing pipeline.tsx can invalidate in-flight runs; the workflow must recut after merge."
		: "";

	return [
		"## Summary",
		problem,
		"",
		"## Testing",
		testingLine,
		acceptance ? `\n## Checklist\n${acceptance}` : "",
		pipelineNote ? `\n## Notes\n${pipelineNote}` : "",
		input.reviewOutcome ? `\n## Review\n${clean(input.reviewOutcome)}` : "",
	]
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
