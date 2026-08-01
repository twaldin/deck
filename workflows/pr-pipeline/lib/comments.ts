import { AGENT_COMMENT_SIGNATURE, signatureProjects } from "../../../v2/src/signature.ts";

export { AGENT_COMMENT_SIGNATURE };

/** Add the configured agent signature to a comment, once. */
export function signComment(project: string | undefined, body: string): string {
	const configured = signatureProjects();
	const projectName = project?.split("/").at(-1)?.toLowerCase();
	const isSignatureProject = project !== undefined &&
		(configured.has(project) || configured.has(project.toLowerCase()) || (projectName !== undefined && configured.has(projectName)));
	if (!isSignatureProject || body.trimEnd().endsWith(AGENT_COMMENT_SIGNATURE)) {
		return body;
	}
	return `${body.trimEnd()}\n\n${AGENT_COMMENT_SIGNATURE}`;
}

/** The only body transformation used by pipeline comment writers. */
export function signedCommentBody(project: string | undefined, body: string): string {
	return signComment(project, body);
}
