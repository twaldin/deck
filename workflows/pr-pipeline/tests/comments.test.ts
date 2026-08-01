import { describe, expect, test } from "bun:test";
import { AGENT_COMMENT_SIGNATURE, signComment } from "../lib/comments.ts";
import { postComment, type ExecFn } from "../lib/gh.ts";
import { generatePullRequestDescription } from "../lib/description.ts";

describe("agent comment signatures", () => {
	test("adds the signature for a configured signature project", () => {
		expect(signComment("lindy", "A useful answer")).toBe(`A useful answer\n\n${AGENT_COMMENT_SIGNATURE}`);
	});

	test("does not add a second signature", () => {
		const body = `Already signed\n\n${AGENT_COMMENT_SIGNATURE}`;
		expect(signComment("lindy", body)).toBe(body);
	});

	test("leaves non-signature projects unchanged", () => {
		expect(signComment("deck", "A useful answer")).toBe("A useful answer");
	});

	test("routes issue comments through the signing helper", async () => {
		const calls: string[][] = [];
		const exec: ExecFn = async (argv) => {
			calls.push(argv);
			return { code: 0, stdout: "", stderr: "" };
		};
		await postComment({ gh: "gh", repo: "lindy-ai/lindy", exec }, "lindy", 42, "A reply");
		expect(calls[0]).toContain(`body=A reply\n\n${AGENT_COMMENT_SIGNATURE}`);
	});

	test("does not sign pull request descriptions", () => {
		const body = generatePullRequestDescription({
			brief: { summary: "A change", acceptanceCriteria: ["It works"] },
		});
		expect(body).not.toContain(AGENT_COMMENT_SIGNATURE);
	});
});
