export type IdleCompactionEngine = "client" | "native";

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

const CONFIG_VARIABLES: ConfigVariable[] = [
	{ key: "enabled", env: "PI_IDLE_COMPACTION", kind: "boolean" },
	{ key: "engine", env: "PI_IDLE_COMPACTION_ENGINE", kind: "engine" },
	{ key: "cacheTtlMs", env: "PI_IDLE_COMPACTION_TTL_MS", kind: "number", minimum: 1 },
	{ key: "marginMs", env: "PI_IDLE_COMPACTION_MARGIN_MS", kind: "number", minimum: 0 },
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
	},
	{
		key: "retryDelayMs",
		env: "PI_IDLE_COMPACTION_RETRY_MS",
		kind: "number",
		minimum: 1,
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

export interface ParsedIdleCompactionConfig {
	config: IdleCompactionConfig;
	warnings: string[];
}

export function parseIdleCompactionConfig(
	env: Record<string, string | undefined>,
): ParsedIdleCompactionConfig {
	const config: IdleCompactionConfig = { ...DEFAULT_IDLE_COMPACTION_CONFIG };
	const warnings: string[] = [];

	for (const variable of CONFIG_VARIABLES) {
		const raw = env[variable.env];
		if (raw === undefined || raw.trim() === "") continue;
		if (variable.kind === "engine") {
			const normalized = raw.trim().toLowerCase();
			if (normalized === "client" || normalized === "native") {
				config.engine = normalized;
			} else {
				warnings.push(`${variable.env} must be client or native; using the default`);
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
				warnings.push(`${variable.env} must be a boolean; using the default`);
			}
			continue;
		}

		const value = Number(raw);
		if (
			!Number.isFinite(value) ||
			(variable.minimum !== undefined && value < variable.minimum) ||
			(variable.maximum !== undefined && value > variable.maximum)
		) {
			warnings.push(`${variable.env} is out of range; using the default`);
			continue;
		}
		(config[variable.key] as boolean | number) = value;
	}

	if (config.marginMs >= config.cacheTtlMs) {
		warnings.push("PI_IDLE_COMPACTION_MARGIN_MS must be smaller than the TTL; using the default margin");
		config.marginMs = Math.min(
			DEFAULT_IDLE_COMPACTION_CONFIG.marginMs,
			Math.max(0, config.cacheTtlMs - 1),
		);
	}

	return { config, warnings };
}
