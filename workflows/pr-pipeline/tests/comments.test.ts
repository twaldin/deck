import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commentCommand, reviewReplyCommand, signComment } from "../lib/comments.ts";
import { postComment, postReviewReply, type ExecFn } from "../lib/gh.ts";
import { generatePullRequestDescription, sanitizeDescriptionInput } from "../lib/description.ts";

const TEST_SIGNATURE = "-- configured test signature";
const originalAgentSignature = process.env.DECK_AGENT_SIGNATURE;
const originalSignatureProjects = process.env.DECK_SIGNATURE_PROJECTS;

beforeEach(() => {
	process.env.DECK_AGENT_SIGNATURE = TEST_SIGNATURE;
	process.env.DECK_SIGNATURE_PROJECTS = "lindy";
});

afterEach(() => {
	if (originalAgentSignature === undefined) delete process.env.DECK_AGENT_SIGNATURE;
	else process.env.DECK_AGENT_SIGNATURE = originalAgentSignature;
	if (originalSignatureProjects === undefined) delete process.env.DECK_SIGNATURE_PROJECTS;
	else process.env.DECK_SIGNATURE_PROJECTS = originalSignatureProjects;
});
describe("agent comment signatures", () => {
	test("adds the signature for a configured signature project", () => {
		expect(signComment("lindy", "A useful answer")).toBe(`A useful answer\n\n${TEST_SIGNATURE}`);
	});

	test("does not add a second signature", () => {
		const body = `Already signed\n\n${TEST_SIGNATURE}`;
		expect(signComment("lindy", body)).toBe(body);
	});

	test("leaves non-signature projects unchanged", () => {
		expect(signComment("deck", "A useful answer")).toBe("A useful answer");
	});

	test("leaves every project unsigned when no signature project is configured", () => {
		process.env.DECK_SIGNATURE_PROJECTS = "";
		expect(signComment("lindy", "A useful answer")).toBe("A useful answer");
	});

	test("routes issue comments through the signing helper", async () => {
		const calls: { argv: string[]; stdin?: string }[] = [];
		const exec: ExecFn = async (argv, options) => {
			calls.push({ argv, stdin: options?.stdin });
			return { code: 0, stdout: "", stderr: "" };
		};
		await postComment({ gh: "gh", repo: "lindy-ai/lindy", exec }, "lindy", 42, "A reply");
		expect(calls[0].argv).toContain("-F");
		expect(calls[0].argv).toContain("body=@-");
		expect(calls[0].stdin).toBe(`A reply\n\n${TEST_SIGNATURE}`);
	});

	test("routes review replies through the signing helper", async () => {
		let received: { argv: string[]; stdin?: string } | undefined;
		const exec: ExecFn = async (argv, options) => {
			received = { argv, stdin: options?.stdin };
			return { code: 0, stdout: "", stderr: "" };
		};
		await postReviewReply({ gh: "gh", repo: "lindy-ai/lindy", exec }, "lindy", 7, "A reply");
		expect(received?.argv).toContain("repos/lindy-ai/lindy/pulls/comments/7/replies");
		expect(received?.argv).toContain("-F");
		expect(received?.stdin).toContain(TEST_SIGNATURE);
	});

	test("comment commands keep body out of shell arguments", () => {
		const command = commentCommand("lindy-ai/lindy", "owner/repo", 42, "A $body `literal`\n!");
		expect(command).toContain("<<'COMMENT'");
		expect(command).toContain("A $body `literal`\n!");
		expect(reviewReplyCommand("lindy", "owner/repo", 7, "answer")).toContain("post-review-reply.ts");
	});

	test("does not sign pull request descriptions", () => {
		const body = generatePullRequestDescription(
			sanitizeDescriptionInput({
				title: "fix(deck): Change behavior",
				summary: "A change",
				acceptanceCriteria: ["It works"],
			}),
		);
		expect(body).not.toContain(TEST_SIGNATURE);
	});
});
