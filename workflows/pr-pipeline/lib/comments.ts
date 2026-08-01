import { AGENT_COMMENT_SIGNATURE, signatureProjects } from "../../../v2/src/signature.ts";

export { AGENT_COMMENT_SIGNATURE };

/** Match the same project forms used by every comment writer. */
export function isSignatureProject(project: string | undefined): boolean {
	if (project === undefined) return false;
	const configured = signatureProjects();
	const normalized = project.toLowerCase();
	const projectName = normalized.split("/").at(-1);
	return configured.has(project) || configured.has(normalized) ||
		(projectName !== undefined && configured.has(projectName));
}

/** Add the configured agent signature to a comment, once. */
export function signComment(project: string | undefined, body: string): string {
	if (!isSignatureProject(project) || body.trimEnd().endsWith(AGENT_COMMENT_SIGNATURE)) {
		return body;
	}
	return `${body.trimEnd()}\n\n${AGENT_COMMENT_SIGNATURE}`;
}

/** The only body transformation used by pipeline comment writers. */
export function signedCommentBody(project: string | undefined, body: string): string {
	return signComment(project, body);
}

/** Command agents must use for every issue comment. Body is supplied on stdin. */
export function commentCommand(project: string | undefined, repo: string, issueNumber: number, body: string): string {
	return `bun ${import.meta.dir}/post-comment.ts ${shellArg(project ?? "")} ${shellArg(repo)} ${issueNumber} <<'COMMENT'\n${body}\nCOMMENT`;
}

/** Command agents must use for every review-thread reply. Body is supplied on stdin. */
export function reviewReplyCommand(project: string | undefined, repo: string, commentId: number, body: string): string {
	return `bun ${import.meta.dir}/post-review-reply.ts ${shellArg(project ?? "")} ${shellArg(repo)} ${commentId} <<'COMMENT'\n${body}\nCOMMENT`;
}

function shellArg(value: string): string {
	return `'${value.replaceAll("'", "'\u0022'\u0022'")}'`;
}
