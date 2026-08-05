export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningLevel = Exclude<ReasoningEffort, "minimal">;

export type NativeReasoning =
	| { provider: "openai"; reasoning_effort: ReasoningEffort }
	| { provider: "anthropic"; thinking: { type: "enabled"; budget_tokens: number } }
	| { provider: "xai"; reasoning_effort: ReasoningEffort };

const ORDER: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Anthropic's budget-token API requires at least 1024 tokens. These named
// budgets are the broker's stable mapping for models that use that API.
const ANTHROPIC_BUDGETS: Record<ReasoningEffort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 65536,
};

export function clampReasoning(level: string, supported: readonly ReasoningEffort[]): ReasoningEffort {
	if (!ORDER.includes(level as ReasoningEffort)) throw new Error(`Unsupported reasoning effort: ${level}`);
	if (supported.includes(level as ReasoningEffort)) return level as ReasoningEffort;
	const requested = ORDER.indexOf(level as ReasoningEffort);
	// Pi clamps downward: choose the highest supported level that does not
	// exceed the request. If none is low enough, use the lowest supported level.
	const ordered = [...supported].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
	return [...ordered].reverse().find(candidate => ORDER.indexOf(candidate) <= requested) ?? ordered[0] ?? "minimal";
}

/**
 * Ground truth for the Deck aliases. OpenAI Codex 5.6 models support max;
 * earlier Codex models stop at xhigh. Claude and Grok entries follow the
 * provider capabilities used by the broker's model catalog.
 *
 * Vendor references:
 * - OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
 * - Anthropic extended thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 * - xAI Grok 4.5 reasoning: https://docs.x.ai/developers/model-capabilities/text/reasoning
 * - Baseten Kimi K3 reasoning: https://docs.baseten.co/inference/model-apis/reasoning
 */
export const MODEL_REASONING_LEVELS: Record<string, readonly ReasoningEffort[]> = {
	"claude-sonnet-4-5": ["low", "medium", "high", "xhigh"],
	"claude-haiku-4-5": ["low", "medium", "high", "xhigh"],
	"claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
	"claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
	"claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
	"grok-4.5": ["low", "medium", "high"],
	"gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
	"gpt-5.4": ["low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
	"gpt-5.5": ["low", "medium", "high", "xhigh"],
	"gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
};

export function supportedReasoning(
	modelId: string,
	provider: "openai" | "anthropic" | "xai",
	capabilities?: readonly ReasoningEffort[],
): readonly ReasoningEffort[] {
	// Deck requests use bare model ids after Pi serializes them. Prefer the
	// Deck/vendor table for known aliases; the bundled catalog may describe a
	// different provider route for the same bare id.
	if (MODEL_REASONING_LEVELS[modelId] !== undefined) return MODEL_REASONING_LEVELS[modelId];
	if (capabilities !== undefined) return capabilities;
	return provider === "xai" ? ["low", "high"] : ["low", "high"];
}

const OPENAI_EFFORTS = new Set<ReasoningEffort>(ORDER);

/** Convert a user selector to one provider-native request field. */
export function nativeReasoning(provider: "openai" | "anthropic" | "xai", selector: string): NativeReasoning {
	if (provider === "anthropic") {
		const match = /^budget:(\d+)$/.exec(selector);
		if (match) {
			if (Number(match[1]) < 1024) throw new Error(`Anthropic reasoning budget must be >= 1024; received ${selector}`);
			return { provider, thinking: { type: "enabled", budget_tokens: Number(match[1]) } };
		}
		if (!(selector in ANTHROPIC_BUDGETS)) throw new Error(`Unsupported anthropic reasoning level: ${selector}`);
		return { provider, thinking: { type: "enabled", budget_tokens: ANTHROPIC_BUDGETS[selector as ReasoningEffort] } };
	}
	if (!OPENAI_EFFORTS.has(selector as ReasoningEffort)) {
		throw new Error(`Unsupported ${provider} reasoning effort: ${selector}`);
	}
	return { provider, reasoning_effort: selector as ReasoningEffort };
}

/** Native capabilities advertised to seat/profile configuration. */
export const NATIVE_REASONING_LEVELS = {
	openai: ["low", "medium", "high", "xhigh", "max"],
	anthropic: ["budget:<tokens> (>=1024)"],
	xai: ["low", "medium", "high"],
} as const;
