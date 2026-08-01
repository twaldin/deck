export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningLevel = Exclude<ReasoningEffort, "minimal">;

export type NativeReasoning =
	| { provider: "openai"; reasoning_effort: ReasoningEffort }
	| { provider: "anthropic"; thinking: { type: "enabled"; budget_tokens: number } }
	| { provider: "xai"; reasoning_effort: "low" | "high" };

const ORDER: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const ANTHROPIC_BUDGETS: Record<ReasoningLevel, number> = {
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 65536,
};

export function clampReasoning(level: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort {
	if (supported.includes(level)) return level;
	const requested = ORDER.indexOf(level);
	return [...supported].sort((a, b) => Math.abs(ORDER.indexOf(a) - requested) - Math.abs(ORDER.indexOf(b) - requested))[0] ?? "minimal";
}

export const MODEL_REASONING_LEVELS: Record<string, readonly ReasoningEffort[]> = {
	"grok-4.5": ["low", "high"],
	"gpt-5.6-sol": ["low", "medium", "high", "xhigh"],
};

export function supportedReasoning(modelId: string, provider: "openai" | "anthropic" | "xai"): readonly ReasoningEffort[] {
	if (provider === "anthropic") return ["low", "medium", "high", "xhigh", "max"];
	return MODEL_REASONING_LEVELS[modelId] ?? (provider === "xai" ? ["low", "high"] : ORDER);
}

const OPENAI_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** Convert a user selector to one provider-native request field. */
export function nativeReasoning(provider: "openai" | "anthropic" | "xai", selector: string): NativeReasoning {
	if (provider === "anthropic") {
		const match = /^budget:(\d+)$/.exec(selector);
		if (match) {
			if (Number(match[1]) < 1024) throw new Error(`Anthropic reasoning budget must be >= 1024; received ${selector}`);
			return { provider, thinking: { type: "enabled", budget_tokens: Number(match[1]) } };
		}
		if (!(selector in ANTHROPIC_BUDGETS)) throw new Error(`Unsupported anthropic reasoning level: ${selector}`);
		return { provider, thinking: { type: "enabled", budget_tokens: ANTHROPIC_BUDGETS[selector as ReasoningLevel] } };
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
	return { provider, reasoning_effort: selector as ReasoningEffort };
}

/** Native capabilities advertised to seat/profile configuration. */
export const NATIVE_REASONING_LEVELS = {
	openai: ["minimal", "low", "medium", "high", "xhigh", "max"],
	anthropic: ["budget:<tokens> (>=1024)"],
	xai: ["low", "high"],
} as const;
