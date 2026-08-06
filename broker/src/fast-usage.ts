import type { Api, Model, Provider, UsageCostHistoryEntry } from "@oh-my-pi/pi-ai";

export const FAST_USAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_FAST_USAGE_TARGET = 0.3;
export const FAST_USAGE_TARGET_ENV = "DECK_FAST_USAGE_TARGET";

export type AttributedServiceTier = "default" | "priority";

export interface FastUsageSummary {
	windowMs: number;
	windowStartedAt: number;
	targetFraction: number;
	fastFraction: number | null;
	fastStandardCostUsd: number;
	totalStandardCostUsd: number;
	fastRequests: number;
	totalRequests: number;
	exceedsTarget: boolean;
	multipliers: number[];
}

export interface FastUsageAttribution {
	provider: string;
	model: string;
	sessionId?: string;
	credentialId?: number;
	requestedServiceTier?: string;
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

interface AttributedUsageCostEntry extends UsageCostHistoryEntry {
	model?: string;
	serviceTier?: AttributedServiceTier;
}

interface FastUsageStorage {
	recordUsageCost(
		provider: Provider,
		costUsd: number,
		options?: {
			sessionId?: string;
			recordedAt?: number;
			credentialId?: number;
			baseUrl?: string;
			model?: string;
			serviceTier?: AttributedServiceTier;
		},
	): boolean;
	listUsageCosts(query?: { provider?: string; accountKey?: string; sinceMs?: number }): AttributedUsageCostEntry[];
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function tokenCount(source: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNonNegative(source[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Parse either OpenAI wire-token names or pi-ai's normalized usage names. */
export function extractTokenUsage(payload: unknown): TokenUsage | undefined {
	const root = object(payload);
	if (root === undefined) return undefined;
	const message = object(root.message);
	const data = object(root.data);
	const response = object(root.response) ?? object(data?.response);
	const usage = object(root.usage) ?? object(message?.usage) ?? object(data?.usage) ?? object(response?.usage);
	if (usage === undefined) return undefined;

	const promptDetails = object(usage.prompt_tokens_details);
	const inputDetails = object(usage.input_tokens_details);
	const anthropicCacheRead = tokenCount(usage, "cache_read_input_tokens");
	const anthropicCacheWrite = tokenCount(usage, "cache_creation_input_tokens");
	const cacheReadTokens = tokenCount(usage, "cache_read_tokens", "cacheReadTokens", "cacheRead")
		?? anthropicCacheRead
		?? tokenCount(promptDetails ?? {}, "cached_tokens")
		?? tokenCount(inputDetails ?? {}, "cached_tokens")
		?? 0;
	const cacheWriteTokens = tokenCount(usage, "cache_write_tokens", "cacheWriteTokens", "cacheWrite")
		?? anthropicCacheWrite
		?? tokenCount(promptDetails ?? {}, "cache_write_tokens")
		?? tokenCount(inputDetails ?? {}, "cache_write_tokens")
		?? 0;
	const wireInputTokens = tokenCount(usage, "input_tokens", "prompt_tokens");
	const normalizedInputTokens = tokenCount(usage, "inputTokens", "input");
	const disjointInput = normalizedInputTokens !== undefined
		|| anthropicCacheRead !== undefined
		|| anthropicCacheWrite !== undefined;
	const inputTokens = (wireInputTokens ?? normalizedInputTokens ?? 0)
		+ (disjointInput ? cacheReadTokens + cacheWriteTokens : 0);
	const outputTokens = tokenCount(usage, "output_tokens", "completion_tokens", "outputTokens", "output") ?? 0;
	if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return undefined;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function bareModelId(model: string): string {
	const qualified = model.split("/").at(-1) ?? model;
	return qualified.endsWith(":fast") ? qualified.slice(0, -":fast".length) : qualified;
}

/** ChatGPT Fast credit multiplier for Deck's supported OAuth model set. */
export function fastCreditMultiplier(provider: string, model: string): number | undefined {
	if (provider !== "openai-codex") return undefined;
	const id = bareModelId(model);
	if (id === "gpt-5.4") return 2;
	if (id === "gpt-5.5" || id === "gpt-5.6" || id.startsWith("gpt-5.6-")) return 2.5;
	return undefined;
}

/** Standard-rate estimated cost; the Fast multiplier is deliberately not applied. */
export function estimateStandardCost(model: Model<Api>, usage: TokenUsage): number {
	const cacheRead = Math.min(usage.inputTokens, usage.cacheReadTokens);
	const cacheWrite = Math.min(Math.max(0, usage.inputTokens - cacheRead), usage.cacheWriteTokens);
	const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	return (
		uncachedInput * model.cost.input
		+ cacheRead * model.cost.cacheRead
		+ cacheWrite * model.cost.cacheWrite
		+ usage.outputTokens * model.cost.output
	) / 1_000_000;
}

export function parseFastUsageTarget(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_FAST_USAGE_TARGET;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(`${FAST_USAGE_TARGET_ENV} must be a fraction between 0 and 1`);
	}
	return parsed;
}

export function summarizeFastUsage(
	entries: readonly AttributedUsageCostEntry[],
	now: number,
	targetFraction: number,
): FastUsageSummary {
	const windowStartedAt = now - FAST_USAGE_WINDOW_MS;
	const tracked = entries.filter(entry =>
		entry.recordedAt >= windowStartedAt
		&& (entry.serviceTier === "default" || entry.serviceTier === "priority")
		&& Number.isFinite(entry.costUsd)
		&& entry.costUsd > 0,
	);
	let fastStandardCostUsd = 0;
	let totalStandardCostUsd = 0;
	let fastRequests = 0;
	const multipliers = new Set<number>();
	for (const entry of tracked) {
		totalStandardCostUsd += entry.costUsd;
		if (entry.serviceTier !== "priority") continue;
		fastStandardCostUsd += entry.costUsd;
		fastRequests += 1;
		const multiplier = fastCreditMultiplier(entry.provider, entry.model ?? "");
		if (multiplier !== undefined) multipliers.add(multiplier);
	}
	const fastFraction = totalStandardCostUsd > 0 ? fastStandardCostUsd / totalStandardCostUsd : null;
	return {
		windowMs: FAST_USAGE_WINDOW_MS,
		windowStartedAt,
		targetFraction,
		fastFraction,
		fastStandardCostUsd,
		totalStandardCostUsd,
		fastRequests,
		totalRequests: tracked.length,
		exceedsTarget: fastFraction !== null && fastFraction > targetFraction,
		multipliers: [...multipliers].sort((a, b) => a - b),
	};
}

export class FastUsageMonitor {
	constructor(
		private readonly storage: FastUsageStorage,
		private readonly resolveModel: (id: string) => Model<Api> | undefined,
		private readonly targetFraction = DEFAULT_FAST_USAGE_TARGET,
		private readonly now: () => number = Date.now,
	) {}

	record(attribution: FastUsageAttribution, usage: TokenUsage): boolean {
		const modelId = bareModelId(attribution.model);
		const model = this.resolveModel(`${attribution.provider}/${modelId}`) ?? this.resolveModel(modelId);
		if (model === undefined) return false;
		const costUsd = estimateStandardCost(model, usage);
		if (!Number.isFinite(costUsd) || costUsd <= 0) return false;
		const serviceTier: AttributedServiceTier = attribution.requestedServiceTier === "priority"
			&& fastCreditMultiplier(attribution.provider, modelId) !== undefined
			? "priority"
			: "default";
		return this.storage.recordUsageCost(attribution.provider as Provider, costUsd, {
			credentialId: attribution.credentialId,
			sessionId: attribution.sessionId,
			recordedAt: this.now(),
			model: modelId,
			serviceTier,
		});
	}

	summary(): FastUsageSummary {
		const now = this.now();
		return summarizeFastUsage(this.storage.listUsageCosts({ sinceMs: now - FAST_USAGE_WINDOW_MS }), now, this.targetFraction);
	}
}

export class FastUsageResponseObserver {
	private latest: TokenUsage | undefined;
	private finished = false;
	private readonly decoder = new TextDecoder();
	private sseBuffer = "";

	constructor(
		private readonly monitor: FastUsageMonitor,
		private readonly attribution: FastUsageAttribution,
	) {}

	observe(payload: unknown): void {
		this.latest = extractTokenUsage(payload) ?? this.latest;
	}

	observeSseFrames(bytes: Uint8Array): void {
		this.sseBuffer += this.decoder.decode(bytes, { stream: true });
		const frames = this.sseBuffer.split(/\r?\n\r?\n/);
		this.sseBuffer = frames.pop() ?? "";
		for (const frame of frames) this.observeSseFrame(frame);
	}

	complete(): void {
		if (this.finished) return;
		this.finished = true;
		this.sseBuffer += this.decoder.decode();
		if (this.sseBuffer !== "") this.observeSseFrame(this.sseBuffer);
		this.sseBuffer = "";
		if (this.latest !== undefined) this.monitor.record(this.attribution, this.latest);
	}

	private observeSseFrame(frame: string): void {
		for (const line of frame.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice("data:".length).trim();
			if (data === "" || data === "[DONE]") continue;
			try {
				this.observe(JSON.parse(data));
			} catch {
				// A non-JSON provider event cannot carry normalized usage.
			}
		}
	}
}
