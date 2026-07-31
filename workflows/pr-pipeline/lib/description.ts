import type { Brief } from "./types.ts";

export interface PullRequestDescriptionInput {
	brief: Pick<Brief, "summary" | "acceptanceCriteria">;
	testing?: string;
	reviewOutcome?: string;
}

function clean(value: string): string {
	return value
		.replace(/(?:\/Users\/|\/home\/)[^\s\n)]+/gi, "the local worktree")
		.replace(/[A-Za-z]:[\\\\/]+[^\s\n)]+/g, "the local worktree")
		.replace(/\b(?:run|execution)[-_ ]?id[:= ]+?[A-Za-z0-9_-]{6,}\b/gi, "")
		.replace(/\b[0-9a-f]{7,40}\b/gi, "")
		.replace(/Managed by[^\n]*/gi, "")
		.replace(/Local review nits[^\n]*(?:\n[-*].*)*/gi, "")
		.replace(/\b(?:READ|DO NOT)\b[^\n]*/gi, "")
		.trim();
}

export function generatePullRequestDescription(input: PullRequestDescriptionInput): string {
	const acceptance = input.brief.acceptanceCriteria.map((criterion) => `- ${clean(criterion)}`).join("\n");
	return [
		"## Problem",
		clean(input.brief.summary),
		"",
		"## Fix",
		"Implemented the requested change and its acceptance criteria.",
		"",
		"## Testing",
		clean(input.testing ?? "Relevant tests were run locally."),
		"",
		"## Notes",
		acceptance || "No additional notes.",
		input.reviewOutcome ? `\n${clean(input.reviewOutcome)}` : "",
	].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
