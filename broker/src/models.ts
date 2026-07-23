/**
 * Model resolution + plan-eligibility enforcement (SPEC §6.5 point 7): only
 * models from providers deck brokers AND on the per-provider allowlist are
 * routable. pi-ai has no client-side OAuth eligibility gate and the bundled
 * catalog carries legacy/prerelease ids — exclusion happens HERE, locally:
 * a non-allowed id never resolves, so the gateway rejects it without an
 * upstream request.
 *
 * Defaults below are prefix matches, tuned by the §6.5 conformance battery
 * against the live plan accounts; operator override at
 * ~/.deck/broker/models.allow.json ({ "<provider>": ["<id-prefix>", …] }).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels, getBundledProviders, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { BROKER_DIR } from "./paths";

const ALLOWLIST_FILE = path.join(BROKER_DIR, "models.allow.json");

/**
 * Per-provider allowed model-id prefixes (PLAN §5.4 providers).
 * anthropic: modern plan-covered families only — legacy 3.x excluded (API-key
 * billing territory, not plan inference).
 */
const DEFAULT_ALLOWLIST: Record<string, readonly string[]> = {
	anthropic: ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4", "claude-fable-5", "claude-mythos-5", "claude-sonnet-5", "claude-opus-5"],
	"openai-codex": ["gpt-5"],
	zai: ["glm-"],
};

function loadAllowlist(): Record<string, readonly string[]> {
	try {
		const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")) as Record<string, readonly string[]>;
		return { ...DEFAULT_ALLOWLIST, ...parsed };
	} catch {
		return DEFAULT_ALLOWLIST;
	}
}

export function isModelAllowed(allowlist: Record<string, readonly string[]>, provider: string, modelId: string): boolean {
	const prefixes = allowlist[provider];
	if (!prefixes) return false;
	return prefixes.some(prefix => modelId.startsWith(prefix));
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
