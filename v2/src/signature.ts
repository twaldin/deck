/**
 * Agent comment signature configuration.
 *
 * Both the signature text and the projects it applies to are operator
 * configuration, never repository content: the signature names a specific
 * person's agent, and the project list names private repositories. The public
 * repo therefore ships NO signature and NO projects, and a deployment opts in
 * through the environment (see ~/.deck config / the home bootstrap).
 *
 *   DECK_AGENT_SIGNATURE   e.g. "-- someone's agent"
 *   DECK_SIGNATURE_PROJECTS  comma-separated project ids, e.g. "lindy"
 *
 * Reading through functions (not module constants) keeps configuration
 * late-bound, so a process that sets the environment after import — including
 * every test — observes the value it just configured.
 */

/** Configured signature text, or undefined when signing is not configured. */
export function agentCommentSignature(): string | undefined {
	const configured = process.env.DECK_AGENT_SIGNATURE?.trim();
	return configured !== undefined && configured.length > 0 ? configured : undefined;
}

/** Project ids whose comments carry the signature. Empty unless configured. */
export function signatureProjects(): Set<string> {
	const configured = process.env.DECK_SIGNATURE_PROJECTS;
	if (configured === undefined) return new Set();
	return new Set(
		configured
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.length > 0),
	);
}
