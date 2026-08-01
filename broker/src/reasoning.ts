export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type NativeReasoning =
	| { provider: "openai"; reasoning: ReasoningEffort }
	| { provider: "anthropic"; thinking: { type: "enabled"; budget_tokens: number } }
	| { provider: "xai"; reasoning_effort: "low" | "high" };

const OPENAI_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Convert a user selector to one provider-native request field. */
export function nativeReasoning(provider: "openai" | "anthropic" | "xai", selector: string): NativeReasoning {
	if (provider === "anthropic") {
		const match = /^budget:(\d+)$/.exec(selector);
		if (!match || Number(match[1]) < 1024) {
			throw new Error(`Anthropic reasoning requires budget:<tokens> (integer >= 1024); received ${selector}`);
		}
		return { provider, thinking: { type: "enabled", budget_tokens: Number(match[1]) } };
	}
	if (!OPENAI_EFFORTS.has(selector as ReasoningEffort)) {
		throw new Error(`Unsupported ${provider} reasoning effort: ${selector}`);
	}
	if (provider === "xai") {
		if (selector !== "low" && selector !== "high") {
			throw new Error(`xAI reasoning_effort accepts only low or high; received ${selector}`);
		}
		return { provider, reasoning_effort: selector };
	}
	return { provider, reasoning: selector as ReasoningEffort };
}

/** Native capabilities advertised to seat/profile configuration. */
export const NATIVE_REASONING_LEVELS = {
	openai: ["minimal", "low", "medium", "high", "xhigh", "max"],
	anthropic: ["budget:<tokens> (>=1024)"],
	xai: ["low", "high"],
} as const;
