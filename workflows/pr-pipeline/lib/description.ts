import type { Brief } from "./types.ts";

export interface PullRequestDescriptionInput {
	brief: Pick<Brief, "summary" | "acceptanceCriteria">;
	testing?: string;
	reviewOutcome?: string;
	changedFiles?: string[];
}

/** Strip internal fleet/agent brief residue from team-facing PR text. */
function clean(value: string): string {
	let s = value;
	// Drop whole sentences that are pure brief-ops residue first
	s = s.replace(/[^.!\n]*\bpriority\s*#?\s*\d+\b[^.!\n]*[.!?]?/gi, " ");
	s = s.replace(/[^.!\n]*\bSpec\s*=\b[^.!\n]*[.!?]?/gi, " ");
	s = s.replace(/[^.!\n]*\bPR\s*\d+[A-Z]?\s+of\b[^.!\n]*[.!?]?/gi, " ");
	s = s.replace(/[^.!\n]*\bimplementer must\b[^.!\n]*[.!?]?/gi, " ");
	s = s.replace(/[^.!\n]*\bREPORT\.md\b[^.!\n]*[.!?]?/gi, " ");
	// paths
	s = s.replace(/(?:\/Users\/|\/home\/|~\/)[^\s\n)`"']*/gi, "");
	s = s.replace(/\.deck\/[^\s\n)`"']*/gi, "");
	s = s.replace(/[A-Za-z]:[\\\\/]+[^\s\n)`"']+/g, "");
	// internal vocabulary
	s = s.replace(
		/\b(?:captain|orch(?:estrator)?|fleet|stamp(?:able)?|yolo|smithers|worktree|implementer|adversar(?:y|ial))\b/gi,
		"",
	);
	s = s.replace(/\b(?:must read|READ FIRST|DO NOT)\b[^.!\n]*/gi, "");
	s = s.replace(/['"]###[^'"]*['"]/g, "");
	s = s.replace(/\b(?:run|execution)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/gi, "");
	s = s.replace(/\b[0-9a-f]{40}\b/gi, "");
	s = s.replace(/Managed by[^\n]*/gi, "");
	s = s.replace(/Local review nits[^\n]*(?:\n[-*].*)*/gi, "");
	s = s.replace(/[ \t]{2,}/g, " ");
	s = s.replace(/ ?([,.;:])/g, "$1");
	s = s.replace(/\(\s*\)/g, "");
	s = s.replace(/(?:^|\s)\.(?=\s|$)/g, " ");
	s = s.replace(/[ \t]+\n/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
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
	const problem = summarize(input.brief.summary || "");
	const acceptance = input.brief.acceptanceCriteria
		.map((criterion) => clean(criterion))
		.filter((c) => c.length > 8 && /[A-Za-z]{4,}/.test(c))
		.filter((c) => !/^must approve\.?$/i.test(c))
		.map((c) => `- ${c}`)
		.join("\n");
	const testing = clean(input.testing ?? "");
	const testingLine = testing.length > 8 ? testing : "Relevant automated checks were run.";
	const pipelineNote = (input.changedFiles ?? []).some((file) => /(?:^|\/)pipeline\.tsx$/i.test(file))
		? "Editing pipeline.tsx invalidates resume of in-flight workflow runs (RESUME_METADATA_MISMATCH). Recut those runs after merge."
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
