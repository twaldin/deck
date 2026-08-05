import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const DECK_MODEL_IDS = [
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
	"claude-fable-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"grok-4.5",
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const OPENAI_MODEL_IDS: Record<string, true> = {
	"gpt-5.3-codex-spark": true,
	"gpt-5.4": true,
	"gpt-5.4-mini": true,
	"gpt-5.5": true,
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

const BROKER_MODEL_ID: Record<(typeof DECK_MODEL_IDS)[number], string> = {
	"claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
	"claude-haiku-4-5": "anthropic/claude-haiku-4-5",
	"claude-fable-5": "anthropic/claude-fable-5",
	"claude-opus-5": "anthropic/claude-opus-5",
	"claude-sonnet-5": "anthropic/claude-sonnet-5",
	"grok-4.5": "xai-oauth/grok-4.5",
	"gpt-5.3-codex-spark": "openai-codex/gpt-5.3-codex-spark",
	"gpt-5.4": "openai-codex/gpt-5.4",
	"gpt-5.4-mini": "openai-codex/gpt-5.4-mini",
	"gpt-5.5": "openai-codex/gpt-5.5",
	"gpt-5.6-luna": "openai-codex/gpt-5.6-luna",
	"gpt-5.6-sol": "openai-codex/gpt-5.6-sol",
	"gpt-5.6-terra": "openai-codex/gpt-5.6-terra",
};

export const MODEL_PICK_GUIDANCE = [
	"Model lanes: use deck/gpt-5.4-mini or deck/claude-haiku-4-5 for cheap, bounded reconnaissance; use deck/gpt-5.6-luna for a fast capable builder; use deck/gpt-5.6-sol, deck/claude-fable-5, or deck/claude-opus-5 for deep ambiguous reasoning.",
	"For review, pick the opposite family from the author: Claude reviews GPT work; GPT reviews Claude work. deck/grok-4.5 is a third-family tie-breaker.",
	"Reasoning: GPT 5.3–5.5 supports low..xhigh; GPT 5.6 supports low..max; Claude adaptive models support low..max; Grok supports low..high. Omit thinking to keep Pi's default.",
	"The :fast suffix is valid only for GPT models and buys lower latency at 2x cost; it is not the cheap lane.",
].join(" ");

export type ModelRegistryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelRegistryOptions {
	endpoint?: string;
	tokenPath?: string;
	fetch?: ModelRegistryFetch;
	timeoutMs?: number;
}

interface BrokerModelsResponse {
	data?: Array<{ id?: unknown }>;
}

export class ModelRegistryError extends Error {
	constructor(message: string, readonly validModels: readonly string[] = []) {
		super(message);
		this.name = "ModelRegistryError";
	}
}

function modelSelectors(modelIds: readonly string[]): string[] {
	const selectors = modelIds.map((id) => `deck/${id}`);
	for (const id of modelIds) {
		if (OPENAI_MODEL_IDS[id]) selectors.push(`deck/${id}:fast`);
	}
	return selectors;
}

export const CATALOG_MODEL_SELECTORS = modelSelectors(DECK_MODEL_IDS);

export async function loadAvailableDeckModels(options: ModelRegistryOptions = {}): Promise<string[]> {
	const endpoint = options.endpoint ?? process.env.DECK_BROKER_MODELS_URL ?? "http://127.0.0.1:8377/v1/models";
	const tokenPath = options.tokenPath ?? process.env.DECK_BROKER_TOKEN_FILE ?? path.join(os.homedir(), ".deck", "broker", "gateway.token");
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 2_000;
	let token: string;
	try {
		token = (await readFile(tokenPath, "utf8")).trim();
	} catch (error) {
		throw new ModelRegistryError(`cannot read Deck broker token at ${tokenPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!token) throw new ModelRegistryError(`Deck broker token at ${tokenPath} is empty`);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(endpoint, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!response.ok) throw new ModelRegistryError(`Deck broker model registry returned HTTP ${response.status}`);
		const body = (await response.json()) as BrokerModelsResponse;
		if (!Array.isArray(body.data)) throw new ModelRegistryError("Deck broker model registry returned an invalid response");
		const brokerIds = new Set(body.data.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []));
		const availableIds = DECK_MODEL_IDS.filter((id) => brokerIds.has(BROKER_MODEL_ID[id]));
		if (availableIds.length === 0) {
			throw new ModelRegistryError("Deck broker model registry contains none of the Deck provider catalog models");
		}
		return modelSelectors(availableIds);
	} catch (error) {
		if (error instanceof ModelRegistryError) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new ModelRegistryError(`cannot reach Deck broker model registry: ${reason}`);
	} finally {
		clearTimeout(timeout);
	}
}

export function validateModelName(requested: string, available: readonly string[]): string {
	if (available.includes(requested)) return requested;
	throw new ModelRegistryError(
		`Unknown Deck model ${JSON.stringify(requested)}. Valid models: ${available.join(", ") || "none"}. Model names are exact; aliases and typo correction are disabled.`,
		available,
	);
}

export function validateThinkingLevel(model: string, thinking: ThinkingLevel | undefined): void {
	if (thinking === undefined || thinking === "off") return;
	const modelId = model.slice("deck/".length).replace(/:fast$/, "");
	const valid = (() => {
		if (modelId === "grok-4.5") return ["low", "medium", "high"];
		if (["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"].includes(modelId)) {
			return ["low", "medium", "high", "xhigh"];
		}
		if (["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"].includes(modelId)) {
			return ["low", "medium", "high", "xhigh", "max"];
		}
		if (modelId === "claude-haiku-4-5") return ["minimal", "low", "medium", "high", "xhigh"];
		return ["low", "medium", "high", "xhigh"];
	})();
	if (!valid.includes(thinking)) {
		throw new ModelRegistryError(`Thinking level ${JSON.stringify(thinking)} is not supported by ${model}. Valid levels: off, ${valid.join(", ")}.`);
	}
}
