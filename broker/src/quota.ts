/** Pure quota-aware account selection. The gateway can use this without touching auth tokens. */
export type QuotaTier = "all-model-5h" | "all-model-7d" | "fable-7d";
export type AccountQuota = { credentialId: number; provider: string; blocked: readonly QuotaTier[]; lastUsedAt?: number };
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
export function tiersForModel(model: QuotaModel): readonly QuotaTier[] {
	if (model.provider !== "anthropic") return [];
	return model.id.startsWith("claude-fable-") ? ["all-model-5h", "all-model-7d", "fable-7d"] : ["all-model-5h", "all-model-7d"];
}

function usable(account: AccountQuota, needed: readonly QuotaTier[]): boolean {
	return needed.every(tier => !account.blocked.includes(tier));
}

/** Pick the least recently used warm account, which spreads load without herding. */
export function pickAccount(model: QuotaModel, accounts: readonly AccountQuota[]): AccountQuota {
	const candidates = accounts.filter(account => account.provider === model.provider && usable(account, tiersForModel(model)));
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
			if (candidate.provider !== requested.provider) continue;
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
	const value = scope.toLowerCase();
	if (value.includes("fable") && value.includes("7d")) return "fable-7d";
	if (value.includes("7d")) return "all-model-7d";
	if (value.includes("5h") || value.includes("5hr") || value.includes("5-hour")) return "all-model-5h";
	return undefined;
}
