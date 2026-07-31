export type IdleCompactionEngine = "client" | "native";
export type IdleCompactionProvider = "anthropic" | "openai" | "xai";

export interface IdleCompactionConfig {
	enabled: boolean;
	/** `native` is a reserved seam; pi 0.82 can execute only `client`. */
	engine: IdleCompactionEngine;
	cacheTtlMs: number;
	marginMs: number;
	contextFloorPercent: number;
	minGrowthTokens: number;
	minGrowthPercent: number;
	minimumCompactionIntervalMs: number;
	retryDelayMs: number;
	maxRetriesPerContext: number;
	notify: boolean;
}

export const DEFAULT_IDLE_COMPACTION_CONFIG: Readonly<IdleCompactionConfig> = {
	enabled: true,
	engine: "client",
	cacheTtlMs: 5 * 60_000,
	marginMs: 60_000,
	contextFloorPercent: 30,
	minGrowthTokens: 1_024,
	minGrowthPercent: 5,
	minimumCompactionIntervalMs: 4 * 60_000,
	retryDelayMs: 60_000,
	maxRetriesPerContext: 2,
	notify: true,
};

export interface IdleCompactionModel {
	provider: string;
	id: string;
}

export interface ParsedIdleCompactionConfig {
	config: IdleCompactionConfig;
	providerConfigs: Readonly<Partial<Record<IdleCompactionProvider, IdleCompactionConfig>>>;
	warnings: string[];
}

/**
 * Deck presents a single gateway provider to pi, so infer the broker's resolved
 * upstream cache policy from its model family. Direct provider routes are also
 * recognized. Unknown routes retain the legacy global timing for compatibility.
 */
export function cacheProviderForModel(model: IdleCompactionModel | undefined): IdleCompactionProvider | undefined {
	if (model === undefined) return undefined;
	if (model.provider === "anthropic") return "anthropic";
	if (model.provider === "openai" || model.provider === "openai-codex") return "openai";
	if (model.provider === "xai" || model.provider === "xai-oauth") return "xai";
	const modelId = model.id.slice(model.id.lastIndexOf("/") + 1);
	if (modelId.startsWith("claude-")) return "anthropic";
	if (modelId.startsWith("gpt-")) return "openai";
	if (modelId.startsWith("grok-")) return "xai";
	return undefined;
}

export function selectIdleCompactionConfig(
	parsed: ParsedIdleCompactionConfig,
	model: IdleCompactionModel | undefined,
): IdleCompactionConfig {
	const provider = cacheProviderForModel(model);
	return provider === undefined ? parsed.config : (parsed.providerConfigs[provider] ?? parsed.config);
}

export type IdleCompactionDecision =
	| { compact: true; idleForMs: number; floorTokens: number }
	| {
			compact: false;
			reason:
				| "disabled"
				| "unsupported-engine"
				| "busy"
				| "cache-still-fresh"
				| "usage-unknown"
				| "below-context-floor"
				| "no-context-growth"
				| "cooldown";
			waitMs?: number;
	  };

export interface IdleCompactionInput {
	config: IdleCompactionConfig;
	nowMs: number;
	lastCacheTouchMs: number;
	isIdle: boolean;
	hasPendingMessages: boolean;
	inFlightToolCalls: number;
	contextTokens: number | null;
	contextWindow: number;
	currentContextMarker: string | null;
	lastCompactedContextMarker: string | null;
	lastCompactedTokens: number | null;
	lastCompactedAtMs: number | null;
}

export function idleThresholdMs(config: IdleCompactionConfig): number {
	return config.cacheTtlMs - config.marginMs;
}

export function decideIdleCompaction(input: IdleCompactionInput): IdleCompactionDecision {
	const { config } = input;
	if (!config.enabled) return { compact: false, reason: "disabled" };
	if (config.engine !== "client") return { compact: false, reason: "unsupported-engine" };
	if (!input.isIdle || input.hasPendingMessages || input.inFlightToolCalls > 0) {
		return { compact: false, reason: "busy" };
	}

	const idleForMs = Math.max(0, input.nowMs - input.lastCacheTouchMs);
	const waitMs = idleThresholdMs(config) - idleForMs;
	if (waitMs > 0) {
		return { compact: false, reason: "cache-still-fresh", waitMs };
	}

	if (
		input.lastCompactedContextMarker !== null &&
		input.currentContextMarker === input.lastCompactedContextMarker
	) {
		return { compact: false, reason: "no-context-growth" };
	}

	if (input.lastCompactedAtMs !== null) {
		const cooldownWaitMs =
			input.lastCompactedAtMs + config.minimumCompactionIntervalMs - input.nowMs;
		if (cooldownWaitMs > 0) {
			return { compact: false, reason: "cooldown", waitMs: cooldownWaitMs };
		}
	}

	if (input.contextTokens === null || input.contextWindow <= 0) {
		return { compact: false, reason: "usage-unknown" };
	}

	const floorTokens = Math.ceil(input.contextWindow * (config.contextFloorPercent / 100));
	if (input.contextTokens < floorTokens) {
		return { compact: false, reason: "below-context-floor" };
	}

	const minimumGrowth = Math.max(
		config.minGrowthTokens,
		Math.ceil(input.contextWindow * (config.minGrowthPercent / 100)),
	);
	if (
		input.lastCompactedTokens !== null &&
		input.contextTokens < input.lastCompactedTokens + minimumGrowth
	) {
		return { compact: false, reason: "no-context-growth" };
	}

	return { compact: true, idleForMs, floorTokens };
}

interface ConfigVariable {
	key: keyof IdleCompactionConfig;
	env: string;
	kind: "boolean" | "number" | "engine";
	minimum?: number;
	maximum?: number;
}

const PROVIDER_CACHE_PROFILES: readonly IdleCompactionProvider[] = ["anthropic", "openai", "xai"];

/**
 * xAI documents automatic prompt caching but no cache lifetime; the global
 * 5-minute profile fires too late for its short-lived cache, so xai gets a
 * built-in short profile that the paired XAI env vars still override.
 */
// ponytail: 2min TTL / 30s margin is a guess at xAI's undocumented cache life; recalibrate when xAI publishes one.
const DEFAULT_PROVIDER_TIMINGS: Readonly<
	Partial<Record<IdleCompactionProvider, Pick<IdleCompactionConfig, "cacheTtlMs" | "marginMs">>>
> = {
	xai: { cacheTtlMs: 2 * 60_000, marginMs: 30_000 },
};
/** Node clamps larger delays to 1ms, which would spin an idle timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const CONFIG_VARIABLES: ConfigVariable[] = [
	{ key: "enabled", env: "PI_IDLE_COMPACTION", kind: "boolean" },
	{ key: "engine", env: "PI_IDLE_COMPACTION_ENGINE", kind: "engine" },
	{
		key: "cacheTtlMs",
		env: "PI_IDLE_COMPACTION_TTL_MS",
		kind: "number",
		minimum: 1,
		maximum: MAX_TIMER_DELAY_MS,
	},
	{
		key: "marginMs",
		env: "PI_IDLE_COMPACTION_MARGIN_MS",
		kind: "number",
		minimum: 0,
		maximum: MAX_TIMER_DELAY_MS,
	},
	{
		key: "contextFloorPercent",
		env: "PI_IDLE_COMPACTION_FLOOR_PERCENT",
		kind: "number",
		minimum: 0,
		maximum: 100,
	},
	{
		key: "minGrowthTokens",
		env: "PI_IDLE_COMPACTION_MIN_GROWTH_TOKENS",
		kind: "number",
		minimum: 0,
	},
	{
		key: "minGrowthPercent",
		env: "PI_IDLE_COMPACTION_MIN_GROWTH_PERCENT",
		kind: "number",
		minimum: 0,
		maximum: 100,
	},
	{
		key: "minimumCompactionIntervalMs",
		env: "PI_IDLE_COMPACTION_MIN_INTERVAL_MS",
		kind: "number",
		minimum: 0,
		maximum: MAX_TIMER_DELAY_MS,
	},
	{
		key: "retryDelayMs",
		env: "PI_IDLE_COMPACTION_RETRY_MS",
		kind: "number",
		minimum: 1,
		maximum: MAX_TIMER_DELAY_MS,
	},
	{
		key: "maxRetriesPerContext",
		env: "PI_IDLE_COMPACTION_MAX_RETRIES",
		kind: "number",
		minimum: 0,
		maximum: 10,
	},
	{ key: "notify", env: "PI_IDLE_COMPACTION_NOTIFY", kind: "boolean" },
];

function parseConfigVariables(
	config: IdleCompactionConfig,
	variables: readonly ConfigVariable[],
	env: Record<string, string | undefined>,
	warnings: string[],
): void {
	for (const variable of variables) {
		const raw = env[variable.env];
		if (raw === undefined || raw.trim() === "") continue;
		if (variable.kind === "engine") {
			const normalized = raw.trim().toLowerCase();
			if (normalized === "client" || normalized === "native") {
				config.engine = normalized;
			} else {
				warnings.push(`${variable.env} must be client or native; ignoring it`);
			}
			continue;
		}
		if (variable.kind === "boolean") {
			const normalized = raw.trim().toLowerCase();
			if (["1", "true", "yes", "on"].includes(normalized)) {
				(config[variable.key] as boolean | number) = true;
			} else if (["0", "false", "no", "off"].includes(normalized)) {
				(config[variable.key] as boolean | number) = false;
			} else {
				warnings.push(`${variable.env} must be a boolean; ignoring it`);
			}
			continue;
		}

		const value = Number(raw);
		if (
			!Number.isFinite(value) ||
			(variable.minimum !== undefined && value < variable.minimum) ||
			(variable.maximum !== undefined && value > variable.maximum)
		) {
			warnings.push(`${variable.env} is out of range; ignoring it`);
			continue;
		}
		(config[variable.key] as boolean | number) = value;
	}
}

function normalizeTiming(
	config: IdleCompactionConfig,
	ttlEnv: string,
	marginEnv: string,
	capCooldown: boolean,
	warnings: string[],
): void {
	if (config.marginMs >= config.cacheTtlMs) {
		warnings.push(`${marginEnv} must be smaller than ${ttlEnv}; using a safe margin`);
		config.marginMs = Math.min(
			DEFAULT_IDLE_COMPACTION_CONFIG.marginMs,
			Math.floor(config.cacheTtlMs / 5),
		);
	}
	if (capCooldown) {
		config.minimumCompactionIntervalMs = Math.min(
			config.minimumCompactionIntervalMs,
			idleThresholdMs(config),
		);
	}
}

export function parseIdleCompactionConfig(
	env: Record<string, string | undefined>,
): ParsedIdleCompactionConfig {
	const config: IdleCompactionConfig = { ...DEFAULT_IDLE_COMPACTION_CONFIG };
	const warnings: string[] = [];
	parseConfigVariables(config, CONFIG_VARIABLES, env, warnings);
	normalizeTiming(
		config,
		"PI_IDLE_COMPACTION_TTL_MS",
		"PI_IDLE_COMPACTION_MARGIN_MS",
		env.PI_IDLE_COMPACTION_MIN_INTERVAL_MS?.trim() === "" ||
			env.PI_IDLE_COMPACTION_MIN_INTERVAL_MS === undefined,
		warnings,
	);

	const capCooldown =
		env.PI_IDLE_COMPACTION_MIN_INTERVAL_MS?.trim() === "" ||
		env.PI_IDLE_COMPACTION_MIN_INTERVAL_MS === undefined;
	const providerConfigs: Partial<Record<IdleCompactionProvider, IdleCompactionConfig>> = {};
	for (const provider of PROVIDER_CACHE_PROFILES) {
		const ttlEnv = `PI_IDLE_COMPACTION_${provider.toUpperCase()}_TTL_MS`;
		const marginEnv = `PI_IDLE_COMPACTION_${provider.toUpperCase()}_MARGIN_MS`;
		const ttlValue = env[ttlEnv]?.trim();
		const marginValue = env[marginEnv]?.trim();
		const defaultTiming = DEFAULT_PROVIDER_TIMINGS[provider];
		if ((ttlValue === undefined || ttlValue === "") && (marginValue === undefined || marginValue === "")) {
			if (defaultTiming === undefined) continue;
			const profile = { ...config, ...defaultTiming };
			normalizeTiming(profile, ttlEnv, marginEnv, capCooldown, warnings);
			providerConfigs[provider] = profile;
			continue;
		}
		if (ttlValue === undefined || ttlValue === "" || marginValue === undefined || marginValue === "") {
			warnings.push(`${ttlEnv}/${marginEnv} must both be set; ignoring the incomplete provider profile`);
			continue;
		}

		const profile = { ...config };
		const profileWarnings: string[] = [];
		parseConfigVariables(
			profile,
			[
				{
					key: "cacheTtlMs",
					env: ttlEnv,
					kind: "number",
					minimum: 1,
					maximum: MAX_TIMER_DELAY_MS,
				},
				{
					key: "marginMs",
					env: marginEnv,
					kind: "number",
					minimum: 0,
					maximum: MAX_TIMER_DELAY_MS,
				},
			],
			env,
			profileWarnings,
		);
		if (profileWarnings.length > 0) {
			warnings.push(`${ttlEnv}/${marginEnv} must be valid timing values; ignoring the provider profile`);
			continue;
		}
		normalizeTiming(profile, ttlEnv, marginEnv, capCooldown, warnings);
		providerConfigs[provider] = profile;
	}

	return { config, providerConfigs, warnings };
}
