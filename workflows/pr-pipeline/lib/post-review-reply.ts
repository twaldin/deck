import { bunExec, postReviewReply } from "./gh.ts";

const [, , project, repo, commentId, ...bodyParts] = Bun.argv;
if (repo === undefined || commentId === undefined || bodyParts.length > 0) {
	throw new Error("usage: cat BODY | post-review-reply.ts PROJECT REPO COMMENT_ID");
}

const body = await new Response(Bun.stdin.stream()).text();
await postReviewReply(
	{ gh: process.env.GH_BIN ?? "gh", repo, exec: bunExec },
	project === "" ? undefined : project,
	Number.parseInt(commentId, 10),
	body,
);
