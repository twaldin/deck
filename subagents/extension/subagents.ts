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
	const byLowerName = new Map(names.map((name) => [name.toLowerCase(), name]));
	const normalized = requested.toLowerCase();
	const exact = byLowerName.get(normalized);
	if (exact !== undefined) return { name: exact };
	const alias = AGENT_ALIASES[normalized as keyof typeof AGENT_ALIASES];
	if (alias !== undefined && byLowerName.has(alias.toLowerCase())) return { name: byLowerName.get(alias.toLowerCase()) };

	const candidates = [
		...names.map((name) => ({ candidate: name, resolved: name })),
		...Object.entries(AGENT_ALIASES).map(([name, resolved]) => ({ candidate: name, resolved })),
	];
	const candidate = candidates
		.map((item) => ({ ...item, distance: editDistance(normalized, item.candidate.toLowerCase()) }))
		.sort((a, b) => a.distance - b.distance)[0];
	if (candidate !== undefined && candidate.distance <= 2) {
		const resolved = byLowerName.get(candidate.resolved.toLowerCase());
		if (resolved !== undefined) return { name: resolved, suggestion: resolved };
	}
	return {};
}

export function validAgentNames(names: string[]): string[] {
	return [...new Set([...names, ...Object.keys(AGENT_ALIASES)])];
}

export function structuredSubagentError(kind: "unknown-agent" | "timeout" | "dead" | "aborted" | "exit", reason: string, details: Record<string, unknown> = {}): string {
	return JSON.stringify({ error: "subagent_failed", kind, reason, ...details });
}
