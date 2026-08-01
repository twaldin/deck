/** Pure quota-aware account selection. The gateway can use this without touching auth tokens. */
export type QuotaTier = "all-model-5h" | "all-model-7d" | "fable-7d" | "codex-chat" | "codex-spark" | "codex-shared" | "xai-shared";
export type AccountQuota = { credentialId: number; /** Exact pi-ai provider id, except explicit aliases such as xai-oauth. */ provider: string; /** AuthStorage provider id, when it differs from the routing identity. */ authProvider?: string; blocked: readonly QuotaTier[]; lastUsedAt?: number };
export type QuotaModel = { id: string; provider: string };
export type QuotaEvent = { type: "model-fallback"; requestedModel: string; selectedModel: string; provider: string; reason: "all-accounts-cooling" };

export class NoQuotaError extends Error {
	readonly code = "NO_QUOTA" as const;
	readonly provider: string;
	readonly retryAfterMs?: number;
	constructor(provider: string, retryAfterMs?: number) {
		super(`no quota is available for provider ${provider}`);
		this.name = "NoQuotaError";
		this.provider = provider;
		this.retryAfterMs = retryAfterMs;
	}
}

/** A fable consumes all three Anthropic windows; other Anthropic models use two. */
/** Provider aliases are explicit. Do not collapse unrelated catalog providers. */
export function routingProvider(provider: string): string {
	if (provider === "xai-oauth") return "xai";
	if (provider === "openai" || provider === "openai-codex") return "openai-codex";
	return provider;
}

export function tiersForModel(model: QuotaModel): readonly QuotaTier[] {
	const provider = routingProvider(model.provider);
	if (provider === "anthropic") return model.id.startsWith("claude-fable-") ? ["all-model-5h", "all-model-7d", "fable-7d"] : ["all-model-5h", "all-model-7d"];
	if (provider === "openai-codex") return model.id.includes("spark") ? ["codex-chat", "codex-spark", "codex-shared"] : ["codex-chat", "codex-shared"];
	if (provider === "xai") return ["xai-shared"];
	return ["all-model-5h"];
}

function usable(account: AccountQuota, needed: readonly QuotaTier[]): boolean {
	return needed.every(tier => !account.blocked.includes(tier));
}

/** Pick the least recently used warm account, which spreads load without herding. */
export function pickAccount(model: QuotaModel, accounts: readonly AccountQuota[]): AccountQuota {
	const provider = routingProvider(model.provider);
	const candidates = accounts.filter(account => routingProvider(account.provider) === provider && usable(account, tiersForModel(model)));
	if (candidates.length === 0) throw new NoQuotaError(model.provider);
	return [...candidates].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0]!;
}

export type RouteResult = { model: QuotaModel; account: AccountQuota; fallback?: QuotaEvent };

/** Route to a warm account, then to the first warm same-provider preference. */
export function routeModel(requested: QuotaModel, accounts: readonly AccountQuota[], preferences: readonly QuotaModel[] = [], emit?: (event: QuotaEvent) => void): RouteResult {
	try {
		return { model: requested, account: pickAccount(requested, accounts) };
	} catch (error) {
		if (!(error instanceof NoQuotaError)) throw error;
		for (const candidate of preferences) {
			if (routingProvider(candidate.provider) !== routingProvider(requested.provider)) continue;
			try {
				const account = pickAccount(candidate, accounts);
				const fallback: QuotaEvent = { type: "model-fallback", requestedModel: requested.id, selectedModel: candidate.id, provider: requested.provider, reason: "all-accounts-cooling" };
				emit?.(fallback);
				return { model: candidate, account, fallback };
			} catch (candidateError) {
				if (!(candidateError instanceof NoQuotaError)) throw candidateError;
			}
		}
		throw error;
	}
}

/** Convert pi-ai usage-limit block scopes into the normalized tier names. */
export function normalizeTier(scope: string): QuotaTier | undefined {
	const value = scope.toLowerCase().replace(/^tier:/, "");
	if (value.includes("fable")) return "fable-7d";
	if (value.includes("spark")) return "codex-spark";
	if (value === "chat" || value.includes("codex-chat")) return "codex-chat";
	if (value === "shared" || value.includes("codex-shared")) return "codex-shared";
	if (value.includes("xai") || value.includes("grok")) return "xai-shared";
	if (value.includes("7d")) return "all-model-7d";
	if (value.includes("5h") || value.includes("5hr") || value.includes("5-hour")) return "all-model-5h";
	return undefined;
}

/** pi-ai uses an empty scope for a provider-wide cooling block. */
export function normalizeBlockScopes(scope: string, provider?: string): readonly QuotaTier[] {
	if (scope.trim() === "") {
		const routed = provider === undefined ? "anthropic" : routingProvider(provider);
		if (routed === "openai-codex") return ["codex-chat", "codex-spark", "codex-shared"];
		if (routed === "xai") return ["xai-shared"];
		return ["all-model-5h", "all-model-7d", "fable-7d"];
	}
	const tier = normalizeTier(scope);
	return tier === undefined ? [] : [tier];
}
