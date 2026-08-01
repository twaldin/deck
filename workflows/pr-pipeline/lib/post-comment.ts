import { postComment, bunExec } from "./gh.ts";

const [, , project, repo, issueNumber, ...extra] = Bun.argv;
if (repo === undefined || issueNumber === undefined || extra.length > 0) {
	throw new Error("usage: cat BODY | post-comment.ts PROJECT REPO ISSUE_NUMBER");
}

const body = await new Response(Bun.stdin.stream()).text();
await postComment(
	{ gh: process.env.GH_BIN ?? "gh", repo, exec: bunExec },
	project === "" ? undefined : project,
	Number.parseInt(issueNumber, 10),
	body,
);
