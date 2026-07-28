import type { DiffChange, IntakeState, PrItem } from "./schema";
import type { LinearSection } from "./linear";

const CI_BADGE: Record<PrItem["ci"], string> = {
	passing: "✅",
	failing: "❌",
	pending: "🟡",
	none: "⚪",
};

const DECISION_LABEL: Record<PrItem["reviewDecision"], string> = {
	approved: "approved",
	"changes-requested": "changes-requested",
	"review-required": "review-required",
	none: "—",
};

function renderRow(item: PrItem, extra = ""): string {
	const draft = item.isDraft ? " *(draft)*" : "";
	const reviewers = item.requestedReviewers.length > 0 ? ` · awaiting: ${item.requestedReviewers.join(", ")}` : "";
	return `- ${CI_BADGE[item.ci]} [${item.repo}#${item.number}](${item.url}) ${item.title}${draft} — ${DECISION_LABEL[item.reviewDecision]}${reviewers}${extra}`;
}

export interface RenderInput {
	state: IntakeState;
	login: string;
	/** URLs (normalized) present in the tracked-work file; null = no file given. */
	tracked: Set<string> | null;
	untracked: DiffChange[];
	/** Review-owed URLs that are NEW this run (high-signal call-out). */
	newReviewRequests: Set<string>;
	linear: LinearSection | null;
}

export function renderMarkdown(input: RenderInput): string {
	const items = Object.values(input.state.items).sort((a, b) =>
		a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo),
	);
	const mine = items.filter((item) => item.buckets.includes("my-pr"));
	const owed = items.filter((item) => item.buckets.includes("review-owed"));

	const lines: string[] = [
		"# PR intake",
		"",
		`_Generated ${input.state.generatedAt} for **${input.login}**. Do not edit; this file is written by \`deck-intake\`._`,
		"",
		`## My PRs (${mine.length})`,
		"",
	];
	if (mine.length === 0) {
		lines.push("_None open._");
	} else {
		for (const item of mine) {
			lines.push(renderRow(item));
		}
	}

	lines.push("", `## Reviews I owe (${owed.length})`, "");
	if (owed.length === 0) {
		lines.push("_None pending._");
	} else {
		for (const item of owed) {
			const isNew = input.newReviewRequests.has(item.url);
			lines.push(renderRow(item, isNew ? " — **🔔 NEW REVIEW REQUEST**" : ""));
		}
	}

	lines.push("", "## Not linked to tracked work", "");
	if (input.tracked === null) {
		lines.push("_No tracked-work file supplied (`--tracked <file>`)._");
	} else if (input.untracked.length === 0) {
		lines.push("_Everything is linked. Invariant holds: nothing untracked exists._");
	} else {
		for (const change of input.untracked) {
			if (change.kind === "untracked") {
				const item = input.state.items[change.url];
				lines.push(item !== undefined ? renderRow(item) : `- ${change.url}`);
			}
		}
	}

	lines.push("", "## Linear", "");
	if (input.linear === null) {
		lines.push("_Disabled (pass `--linear` once a Linear auth path is configured)._");
	} else {
		lines.push(...renderLinear(input.linear));
	}

	return `${lines.join("\n")}\n`;
}

function renderLinear(section: LinearSection): string[] {
	const lines: string[] = [];
	lines.push(`### Assigned to me (${section.assigned.length})`, "");
	for (const ticket of section.assigned) {
		lines.push(`- [${ticket.identifier}](${ticket.url}) ${ticket.title} — ${ticket.state}`);
	}
	if (section.assigned.length === 0) {
		lines.push("_None._");
	}
	lines.push("", `### Active with no tracked PR (${section.activeWithoutPr.length})`, "");
	for (const ticket of section.activeWithoutPr) {
		lines.push(`- [${ticket.identifier}](${ticket.url}) ${ticket.title} — ${ticket.state}`);
	}
	if (section.activeWithoutPr.length === 0) {
		lines.push("_None._");
	}
	return lines;
}
