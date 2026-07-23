import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DeckError } from "@deck/core";
import { z } from "zod";

export const promptRoleSchema = z.enum(["owner", "worker", "reviewer"]);
export type PromptRole = z.infer<typeof promptRoleSchema>;

const composePromptInputSchema = z
	.object({
		role: promptRoleSchema,
		brief: z.string().trim().min(1),
	})
	.strict();

const promptFileSchema = z.string().trim().min(1);

// SPEC §9 fixes these component budgets; exceeding one rejects rather than truncates (D-H).
export const PROMPT_LINE_BUDGETS = {
	base: 50,
	role: 40,
} as const;

const ROLE_FILES: Record<PromptRole, string> = {
	owner: "owner.md",
	worker: "worker.md",
	reviewer: "reviewer.md",
};

export interface ComposePromptInput {
	role: PromptRole;
	brief: string;
}

export interface ComponentHashes {
	base: string;
	role: string;
	brief: string;
}

export interface ComposedPrompt {
	prompt: string;
	contentHash: string;
	componentHashes: ComponentHashes;
}

export function countPromptLines(content: string): number {
	if (content.length === 0) {
		return 0;
	}

	let lines = 1;
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10 && index < content.length - 1) {
			lines += 1;
		}
	}
	return lines;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function loadPromptFile(relativePath: string): string {
	const raw = readFileSync(new URL(relativePath, import.meta.url), "utf8");
	return promptFileSchema.parse(raw);
}

function assertLineBudget(field: string, content: string, limit: number): void {
	const length = countPromptLines(content);
	if (length > limit) {
		throw new DeckError("E_TOO_LONG", `${field} is ${length} lines; limit ${limit}. Compress and retry.`, {
			field,
			limit,
			length,
			unit: "lines",
		});
	}
}

/** Compose immutable substrate rules, a role contract, then the dispatch brief (SPEC §9). */
export function composePrompt(input: ComposePromptInput): ComposedPrompt {
	const { role, brief } = composePromptInputSchema.parse(input);
	const base = loadPromptFile("./base.md");
	const roleFile = `./roles/${ROLE_FILES[role]}`;
	const roleBlock = loadPromptFile(roleFile);

	assertLineBudget("base.md", base, PROMPT_LINE_BUDGETS.base);
	assertLineBudget(roleFile.slice(2), roleBlock, PROMPT_LINE_BUDGETS.role);

	const prompt = `${base}\n\n${roleBlock}\n\n${brief}`;
	return {
		prompt,
		contentHash: hashContent(prompt),
		componentHashes: {
			base: hashContent(base),
			role: hashContent(roleBlock),
			brief: hashContent(brief),
		},
	};
}
