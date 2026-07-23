import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	composePrompt,
	countPromptLines,
	PROMPT_LINE_BUDGETS,
	promptRoleSchema,
	type PromptRole,
} from "../compose";

const promptFileSchema = z.string().trim().min(1);
const ROLE_PATHS: Record<PromptRole, string> = {
	owner: "../roles/owner.md",
	worker: "../roles/worker.md",
	reviewer: "../roles/reviewer.md",
};

function readPrompt(relativePath: string): string {
	return promptFileSchema.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

describe("prompt composition", () => {
	test("all shipped components satisfy their line budgets", () => {
		const base = readPrompt("../base.md");
		expect(countPromptLines(base)).toBeLessThanOrEqual(PROMPT_LINE_BUDGETS.base);

		for (const rolePath of Object.values(ROLE_PATHS)) {
			const roleBlock = readPrompt(rolePath);
			expect(countPromptLines(roleBlock)).toBeLessThanOrEqual(PROMPT_LINE_BUDGETS.role);
		}
	});

	test("orders base, selected role, and brief and hashes each component", () => {
		const base = readPrompt("../base.md");
		const brief = "Implement the dispatched change and return command evidence.";

		for (const role of promptRoleSchema.options) {
			const roleBlock = readPrompt(ROLE_PATHS[role]);
			const composed = composePrompt({ role, brief });
			const expected = `${base}\n\n${roleBlock}\n\n${brief}`;

			expect(composed.prompt).toBe(expected);
			expect(composed.contentHash).toBe(sha256(expected));
			expect(composed.componentHashes).toEqual({
				base: sha256(base),
				role: sha256(roleBlock),
				brief: sha256(brief),
			});
		}
	});
});
