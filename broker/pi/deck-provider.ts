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
const GATEWAY_API_KEY = "!cat ~/.deck/broker/gateway.token";

const extensionEnv = z
	.looseObject({
		DECK_PI_MAX_TOKENS: z.coerce.number().int().positive().optional(),
	})
	.parse(process.env);

function maxTokens(supportedMaxTokens: number): number {
	return Math.min(extensionEnv.DECK_PI_MAX_TOKENS ?? supportedMaxTokens, supportedMaxTokens);
}

const models: DeckModel[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(64_000),
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: maxTokens(64_000),
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: maxTokens(128_000),
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5 (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "low", high: "high", xhigh: "high", max: "high" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: maxTokens(32_000),
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol (Deck)",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 372_000,
		maxTokens: maxTokens(128_000),
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
