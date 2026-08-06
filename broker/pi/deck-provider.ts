interface DeckModel {
	id: string;
	name: string;
	api?: "openai-completions" | "anthropic-messages";
	reasoning: boolean;
	/** Pi-native reasoning selector. Pi uses this map at runtime. */
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat?: { supportsReasoningEffort?: boolean };
}

interface PiExtensionApi {
	registerProvider(
		name: string,
		config: {
			name: string;
			baseUrl: string;
			apiKey: string;
			authHeader: boolean;
			api: "openai-completions" | "anthropic-messages";
			models: DeckModel[];
		},
	): void;
}
import { z } from "zod";

const GATEWAY_ORIGIN = "http://127.0.0.1:8377";

const extensionEnv = z
	.looseObject({
		DECK_PI_MAX_TOKENS: z.coerce.number().int().positive().optional(),
		DECK_GATEWAY_API_KEY: z.string().min(1).optional(),
	})
	.parse(process.env);

const GATEWAY_API_KEY = extensionEnv.DECK_GATEWAY_API_KEY ?? "!cat ~/.deck/broker/gateway.token";

function maxTokens(supportedMaxTokens: number): number {
	return Math.min(extensionEnv.DECK_PI_MAX_TOKENS ?? supportedMaxTokens, supportedMaxTokens);
}

// Keep all named levels explicit so Pi passes the requested native selector
// to the broker. The broker owns the per-model support table and emits the
// requested/effective warning when the provider does not support a level.
const NATIVE_REASONING: Record<string, string> = {
	minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};
const CLAUDE_SONNET_4_5 = NATIVE_REASONING;
const CLAUDE_HAIKU_4_5 = NATIVE_REASONING;
const CLAUDE_FABLE_5 = NATIVE_REASONING;
const GROK_4_5 = NATIVE_REASONING;
const GPT_5_6_SOL = NATIVE_REASONING;
const GPT_5_XHIGH = NATIVE_REASONING;

export const models: DeckModel[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: CLAUDE_SONNET_4_5,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(64_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: CLAUDE_HAIKU_4_5,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: maxTokens(64_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FABLE_5,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GROK_4_5,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: maxTokens(32_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_6_SOL,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 372_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FABLE_5,
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: CLAUDE_FABLE_5,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_XHIGH,
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_XHIGH,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_XHIGH,
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_XHIGH,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_6_SOL,
		input: ["text", "image"],
		cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 372_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: GPT_5_6_SOL,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
		contextWindow: 372_000,
		maxTokens: maxTokens(128_000),
		compat: { supportsReasoningEffort: true },
	},
];

export default function registerDeckProvider(pi: PiExtensionApi): void {
	pi.registerProvider("deck", {
		name: "Deck Broker",
		baseUrl: `${GATEWAY_ORIGIN}/v1`,
		apiKey: GATEWAY_API_KEY,
		authHeader: true,
		api: "openai-completions",
		models,
	});
}
