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
	/** Send a tiny request instead of compacting at the cache deadline. */
	keepWarm: boolean;
	/** Context percentage at which pre-miss compaction may run. */
	keepWarmContextPercent: number;
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
	keepWarm: false,
	keepWarmContextPercent: 50,
	retryDelayMs: 60_000,
	maxRetriesPerContext: 2,
	notify: true,
};

export interface IdleCompactionModel {
	provider: string;
	id: string;
}

/** Native compaction is available only on direct provider routes today. */
export function hasProviderNativeCompaction(model: IdleCompactionModel | undefined): boolean {
	if (model === undefined) return false;
	if (model.provider === "xai" || model.provider === "xai-oauth") return false;
	if (model.provider === "anthropic" || model.provider === "openai" || model.provider === "openai-codex") return true;
	// Deck resolves to provider-native Anthropic/OpenAI routes by model family.
	// Keep unknown broker models on the legacy path until capability is advertised.
	if (model.provider === "deck") {
		const id = model.id.slice(model.id.lastIndexOf("/") + 1);
		return id.startsWith("claude-") || id.startsWith("gpt-") || id.startsWith("glm-");
	}
	return false;
}

/**
 * Built-in timing profiles are keyed by cache ROUTE, not provider family:
 * the same family has different cache lifetimes depending on which client
 * stack carries the request (deck broker vs a direct pi provider) and which
 * model generation serves it. Env overrides stay keyed by family.
 */
export type IdleCompactionCacheRoute = IdleCompactionProvider | "anthropic-long" | "openai-long";

export interface ParsedIdleCompactionConfig {
	config: IdleCompactionConfig;
	/** Undefined means the operator did not set the keep-warm override. */
	keepWarmOverride: boolean | undefined;
	providerConfigs: Readonly<Partial<Record<IdleCompactionProvider, IdleCompactionConfig>>>;
	builtinConfigs: Readonly<Partial<Record<IdleCompactionCacheRoute, IdleCompactionConfig>>>;
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

/** GPT-5.6 is the first family with the documented 30m prompt-cache minimum. */
function isGpt56OrNewer(modelId: string): boolean {
	const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelId);
	if (match === null) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 5 || (major === 5 && minor >= 6);
}

/**
 * Route-sensitive cache lifetime resolution:
 * - deck claude-* goes through the broker, whose pi-ai layer requests
 *   `cache_control.ttl: "1h"` (Claude Code behavior) -> anthropic-long.
 * - direct pi anthropic providers default to plain 5m ephemeral
 *   (`PI_CACHE_RETENTION=long` is an operator opt-in; pair the ANTHROPIC env
 *   override with it) -> plain family, no built-in long profile.
 * - GPT-5.6+ carries the documented 30m minimum on any route -> openai-long;
 *   older gpt-* stay on the conservative global timing.
 */
function cacheRouteForModel(model: IdleCompactionModel | undefined): IdleCompactionCacheRoute | undefined {
	const provider = cacheProviderForModel(model);
	if (provider === undefined || model === undefined) return provider;
	const modelId = model.id.slice(model.id.lastIndexOf("/") + 1);
	if (provider === "anthropic" && model.provider === "deck") return "anthropic-long";
	if (provider === "openai" && isGpt56OrNewer(modelId)) return "openai-long";
	return provider;
}

export function selectIdleCompactionConfig(
	parsed: ParsedIdleCompactionConfig,
	model: IdleCompactionModel | undefined,
): IdleCompactionConfig {
	const provider = cacheProviderForModel(model);
	if (provider === undefined) return parsed.config;
	const route = cacheRouteForModel(model);
	const envProfile = parsed.providerConfigs[provider];
	if (envProfile !== undefined) {
		return route === "anthropic-long" || route === "openai-long"
			? { ...envProfile, keepWarm: parsed.keepWarmOverride ?? true }
			: envProfile;
	}
	return route === undefined ? parsed.config : (parsed.builtinConfigs[route] ?? parsed.config);
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
				| "keep-warm"
				| "cooldown"
				| "provider-native-unavailable";
			waitMs?: number;
	  };

export interface IdleCompactionInput {
	config: IdleCompactionConfig;
	nowMs: number;
	lastCacheTouchMs: number;
	isIdle: boolean;
	hasPendingMessages: boolean;
	inFlightToolCalls: number;
	/** When the current tool burst started; null when no tool is in flight. */
	toolsInFlightSinceMs?: number | null;
	contextTokens: number | null;
	contextWindow: number;
	currentContextMarker: string | null;
	lastCompactedContextMarker: string | null;
	lastCompactedTokens: number | null;
	lastCompactedAtMs: number | null;
	/** True only when the resolved provider route exposes native compaction. */
	providerNativeCompactionAvailable?: boolean;
}

export function idleThresholdMs(config: IdleCompactionConfig): number {
	return config.cacheTtlMs - config.marginMs;
}

/**
 * A tool call still in flight past this ceiling counts as hung. Past it the
 * cache deadline is re-evaluated without waiting for a `tool_execution_end`
 * that may never arrive; a wedged tool must not starve keep-warm for the run.
 */
export function toolHangCeilingMs(config: IdleCompactionConfig): number {
	return 2 * idleThresholdMs(config);
}

export function areToolsHung(
	input: Pick<
		IdleCompactionInput,
		"config" | "nowMs" | "inFlightToolCalls" | "toolsInFlightSinceMs"
	>,
): boolean {
	const since = input.toolsInFlightSinceMs;
	if (input.inFlightToolCalls <= 0 || since === null || since === undefined) return false;
	return input.nowMs - since >= toolHangCeilingMs(input.config);
}

/** How long the caller should wait before re-checking a busy session. */
function busyWaitMs(input: IdleCompactionInput): number {
	const since = input.toolsInFlightSinceMs;
	if (input.inFlightToolCalls > 0 && since !== null && since !== undefined) {
		return Math.max(1, since + toolHangCeilingMs(input.config) - input.nowMs);
	}
	return input.config.retryDelayMs;
}

export function decideIdleCompaction(input: IdleCompactionInput): IdleCompactionDecision {
	const { config } = input;
	if (!config.enabled) return { compact: false, reason: "disabled" };
	if (config.engine !== "client") return { compact: false, reason: "unsupported-engine" };
	const toolsHung = areToolsHung(input);
	if (!toolsHung && (!input.isIdle || input.hasPendingMessages || input.inFlightToolCalls > 0)) {
		return { compact: false, reason: "busy", waitMs: busyWaitMs(input) };
	}

	const idleForMs = Math.max(0, input.nowMs - input.lastCacheTouchMs);
	const waitMs = idleThresholdMs(config) - idleForMs;
	if (waitMs > 0) {
		return { compact: false, reason: "cache-still-fresh", waitMs };
	}

	if (toolsHung) {
		return config.keepWarm
			? { compact: false, reason: "keep-warm" }
			: { compact: false, reason: "busy", waitMs: config.retryDelayMs };
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

	const keepWarmThreshold = Math.ceil(
		input.contextWindow * (config.keepWarmContextPercent / 100),
	);
	const nativeAvailable = input.providerNativeCompactionAvailable ?? true;
	// Pre-miss compaction requires both native support and at least 50% usage.
	// Keep-warm remains an explicit opt-in, including for non-native routes.
	if (input.contextTokens < keepWarmThreshold) {
		return {
			compact: false,
			reason: config.keepWarm ? "keep-warm" : "below-context-floor",
		};
	}
	if (!nativeAvailable) {
		return { compact: false, reason: "provider-native-unavailable" };
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
 * Calibrated built-in cache lifetimes per cache route; the paired
 * per-family env vars still override every route of that family.
 *
 * - anthropic-long: the deck broker requests `cache_control.ttl: "1h"` on its
 *   anthropic oauth path (Claude Code behavior). Anthropic drops oauth to 5m
 *   only on usage-credit overage; override with the ANTHROPIC env pair if
 *   that state persists. Direct anthropic routes keep the global 5m timing.
 * - openai-long: GPT-5.6+ `prompt_cache_options.ttl` default (and only
 *   value) is a 30-minute minimum lifetime per OpenAI's prompt-caching docs.
 *   Older models cache in-memory ~5-10 minutes and keep the global timing.
 * - xai: documents automatic prompt caching but no cache lifetime.
 */
// ponytail: xai 2min TTL / 30s margin is a guess at an undocumented cache life; recalibrate when xAI publishes one.
const DEFAULT_ROUTE_TIMINGS: Readonly<
	Partial<Record<IdleCompactionCacheRoute, Pick<IdleCompactionConfig, "cacheTtlMs" | "marginMs">>>
> = {
	"anthropic-long": { cacheTtlMs: 60 * 60_000, marginMs: 5 * 60_000 },
	"openai-long": { cacheTtlMs: 30 * 60_000, marginMs: 5 * 60_000 },
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
	{ key: "keepWarm", env: "PI_IDLE_COMPACTION_KEEP_WARM", kind: "boolean" },
	{
		key: "keepWarmContextPercent",
		env: "PI_IDLE_COMPACTION_KEEP_WARM_CONTEXT_PERCENT",
		kind: "number",
		minimum: 0,
		maximum: 100,
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
	const rawKeepWarm = env.PI_IDLE_COMPACTION_KEEP_WARM?.trim().toLowerCase();
	const keepWarmOverride =
		rawKeepWarm === undefined || rawKeepWarm === ""
			? undefined
			: ["1", "true", "yes", "on"].includes(rawKeepWarm)
				? true
				: ["0", "false", "no", "off"].includes(rawKeepWarm)
					? false
					: undefined;
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
		if ((ttlValue === undefined || ttlValue === "") && (marginValue === undefined || marginValue === "")) {
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

	const builtinConfigs: Partial<Record<IdleCompactionCacheRoute, IdleCompactionConfig>> = {};
	for (const [route, timing] of Object.entries(DEFAULT_ROUTE_TIMINGS) as Array<
		[IdleCompactionCacheRoute, Pick<IdleCompactionConfig, "cacheTtlMs" | "marginMs">]
	>) {
		const profile = {
			...config,
			...timing,
			keepWarm: keepWarmOverride ?? (route === "anthropic-long" || route === "openai-long"),
		};
		normalizeTiming(profile, "builtin ttl", "builtin margin", capCooldown, warnings);
		builtinConfigs[route] = profile;
	}

	return { config, keepWarmOverride, providerConfigs, builtinConfigs, warnings };
}
