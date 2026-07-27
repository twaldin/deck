/**
 * Model resolution + plan-eligibility enforcement (SPEC §6.5 point 7): only
 * models from providers deck brokers AND on the per-provider allowlist are
 * routable. pi-ai has no client-side OAuth eligibility gate and the bundled
 * catalog carries legacy/prerelease ids — exclusion happens HERE, locally:
 * a non-allowed id never resolves, so the gateway rejects it without an
 * upstream request.
 *
 * Defaults below are exact model ids, validated live 2026-07-22 against plan
 * grants; the §6.5 battery re-validates them. Operator overrides at
 * ~/.deck/broker/models.allow.json use exact ids by default and an explicit
 * trailing "*" for prefix matches ({ "<provider>": ["<id>", "<prefix>*"] }).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels, getBundledProviders, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { z } from "zod";
import { BROKER_DIR } from "./paths";

const ALLOWLIST_FILE = path.join(BROKER_DIR, "models.allow.json");

/**
 * Per-provider allowlist (PLAN §5.4 providers). Anthropic and OpenAI Codex
 * defaults are exact ids confirmed against the live plan accounts. Z.ai uses
 * the explicit trailing-"*" convention for its family prefix.
 */
export const DEFAULT_ALLOWLIST: Record<string, readonly string[]> = {
	anthropic: [
		"claude-fable-5",
		"claude-haiku-4-5",
		"claude-haiku-4-5-20251001",
		"claude-opus-4-1",
		"claude-opus-4-1-20250805",
		"claude-opus-4-5",
		"claude-opus-4-5-20251101",
		"claude-opus-4-6",
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929",
		"claude-sonnet-4-6",
		"claude-sonnet-5",
	],
	"openai-codex": [
		"gpt-5.3-codex-spark",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
	],
	zai: ["glm-*"],
};

const allowlistFile = z.record(z.string(), z.array(z.string()));

function loadAllowlist(): Record<string, readonly string[]> {
	try {
		const parsed = allowlistFile.parse(JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")));
		return { ...DEFAULT_ALLOWLIST, ...parsed };
	} catch {
		return DEFAULT_ALLOWLIST;
	}
}

export function isModelAllowed(allowlist: Record<string, readonly string[]>, provider: string, modelId: string): boolean {
	const patterns = allowlist[provider];
	if (!patterns) return false;
	return patterns.some(pattern => {
		if (pattern.endsWith("*")) return modelId.startsWith(pattern.slice(0, -1));
		return modelId === pattern;
	});
}

export interface ModelIndex {
	resolve(modelId: string): Model<Api> | undefined;
	list(): Iterable<Model<Api>>;
}

export function buildModelIndex(allowlist: Record<string, readonly string[]> = loadAllowlist()): ModelIndex {
	const byId = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		if (!allowlist[provider]) continue;
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			if (!isModelAllowed(allowlist, provider, model.id)) continue;
			byId.set(`${model.provider}/${model.id}`, model);
			if (!byId.has(model.id)) byId.set(model.id, model);
		}
	}
	return {
		resolve: id => byId.get(id),
		list: () => byId.values(),
	};
}
