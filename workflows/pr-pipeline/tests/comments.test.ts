import { describe, expect, test } from "bun:test";
import { AGENT_COMMENT_SIGNATURE, commentCommand, reviewReplyCommand, signComment } from "../lib/comments.ts";
import { postComment, postReviewReply, type ExecFn } from "../lib/gh.ts";
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
		const calls: { argv: string[]; stdin?: string }[] = [];
		const exec: ExecFn = async (argv, options) => {
			calls.push({ argv, stdin: options?.stdin });
			return { code: 0, stdout: "", stderr: "" };
		};
		await postComment({ gh: "gh", repo: "lindy-ai/lindy", exec }, "lindy", 42, "A reply");
		expect(calls[0].argv).toContain("body=@-");
		expect(calls[0].stdin).toBe(`A reply\n\n${AGENT_COMMENT_SIGNATURE}`);
	});

	test("routes review replies through the signing helper", async () => {
		let received: { argv: string[]; stdin?: string } | undefined;
		const exec: ExecFn = async (argv, options) => {
			received = { argv, stdin: options?.stdin };
			return { code: 0, stdout: "", stderr: "" };
		};
		await postReviewReply({ gh: "gh", repo: "lindy-ai/lindy", exec }, "lindy", 7, "A reply");
		expect(received?.argv).toContain("repos/lindy-ai/lindy/pulls/comments/7/replies");
		expect(received?.stdin).toContain(AGENT_COMMENT_SIGNATURE);
	});

	test("comment commands keep body out of shell arguments", () => {
		const command = commentCommand("lindy-ai/lindy", "owner/repo", 42, "A $body `literal`\n!");
		expect(command).toContain("<<'COMMENT'");
		expect(command).toContain("A $body `literal`\n!");
		expect(reviewReplyCommand("lindy", "owner/repo", 7, "answer")).toContain("post-review-reply.ts");
	});

	test("does not sign pull request descriptions", () => {
		const body = generatePullRequestDescription({
			brief: { summary: "A change", acceptanceCriteria: ["It works"] },
		});
		expect(body).not.toContain(AGENT_COMMENT_SIGNATURE);
	});
});
