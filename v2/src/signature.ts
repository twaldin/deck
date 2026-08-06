export const AGENT_COMMENT_SIGNATURE = "-- tim's agent";

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
