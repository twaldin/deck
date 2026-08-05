export const AGENT_ALIASES = {
	claude: "reviewer-claude",
	codex: "worker-gpt",
	gpt: "worker-gpt",
} as const;

function editDistance(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = row[0]!;
		row[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[right.length]!;
}

export function resolveAgentName(names: string[], requested: string): { name?: string; suggestion?: string } {
	const available = new Set(names);
	const alias = AGENT_ALIASES[requested.toLowerCase() as keyof typeof AGENT_ALIASES];
	if (alias !== undefined && available.has(alias)) return { name: alias };
	if (available.has(requested)) return { name: requested };
	const candidate = names
		.map((name) => ({ name, distance: editDistance(requested.toLowerCase(), name.toLowerCase()) }))
		.sort((a, b) => a.distance - b.distance)[0];
	return candidate !== undefined && candidate.distance <= 2
		? { name: candidate.name, suggestion: candidate.name }
		: {};
}

export function validAgentNames(names: string[]): string[] {
	return [...new Set([...names, ...Object.keys(AGENT_ALIASES)])];
}

export function structuredSubagentError(kind: "unknown-agent" | "timeout" | "dead" | "aborted" | "exit", reason: string, details: Record<string, unknown> = {}): string {
	return JSON.stringify({ error: "subagent_failed", kind, reason, ...details });
}
