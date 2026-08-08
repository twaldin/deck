import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type UsageTheme = {
	fg: (key: string, text: string) => string;
	bold: (text: string) => string;
};

type UsageAmount = {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	unit?: string;
};

type UsageLimit = {
	id?: string;
	label?: string;
	window?: {
		id?: string;
		label?: string;
		resetsAt?: number;
		resetLabel?: string;
	};
	scope?: Record<string, unknown>;
	amount?: UsageAmount;
	status?: "ok" | "warning" | "exhausted" | "unknown";
	notes?: string[];
};

type UsageReport = {
	provider?: string;
	fetchedAt?: number;
	limits?: UsageLimit[];
	metadata?: Record<string, unknown>;
	notes?: string[];
	resetCredits?: { availableCount?: number };
};

export type FastTierUsage = {
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
};

export type UsageRoster = {
	generatedAt?: number | string;
	reports: UsageReport[];
	fastTier?: FastTierUsage;
};

type UsageContext = {
	ui?: {
		theme?: unknown;
		setStatus?: (id: string, value: string | undefined) => void;
		notify?: (message: string, level?: "info") => void;
		/** Host select dialog; the portable scrollable-report surface. */
		select?: (title: string, options: string[]) => Promise<string | undefined>;
	};
};

type UsageCommand = {
	description: string;
	handler: (args: string, ctx: UsageContext) => Promise<void> | void;
};

export interface DeckUsageApi {
	registerCommand(name: string, command: UsageCommand): void;
	on(event: string, handler: (event: unknown, ctx: UsageContext) => Promise<void> | void): void;
}

export interface UsageTimerHandle {
	unref?(): void;
}

export interface DeckUsageRuntime {
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	now(): number;
	readFile(file: string): string;
	setInterval(callback: () => void, ms: number): UsageTimerHandle;
	clearInterval(handle: UsageTimerHandle): void;
	setTimeout(callback: () => void, ms: number): UsageTimerHandle;
	clearTimeout(handle: UsageTimerHandle): void;
}

const PLAIN_THEME: UsageTheme = {
	fg: (_key, value) => value,
	bold: value => value,
};
const BAR_WIDTH = 6;
export const USAGE_CACHE_MS = 30_000;
export const USAGE_REFRESH_INTERVAL_MS = 60_000;
export const USAGE_REQUEST_TIMEOUT_MS = 2_000;
export const NEUTRAL_USAGE_STATUS = "quota —";

const DEFAULT_RUNTIME: DeckUsageRuntime = {
	fetch: (input, init) => globalThis.fetch(input, init),
	now: () => Date.now(),
	readFile: file => fs.readFileSync(file, "utf8"),
	setInterval: (callback, ms) => setInterval(callback, ms) as unknown as UsageTimerHandle,
	clearInterval: handle => clearInterval(handle as never),
	setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as UsageTimerHandle,
	clearTimeout: handle => clearTimeout(handle as never),
};

function parseFastTier(value: unknown): FastTierUsage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<Record<keyof FastTierUsage, unknown>>;
	const finite = (field: keyof FastTierUsage): number | undefined =>
		typeof candidate[field] === "number" && Number.isFinite(candidate[field])
			? candidate[field] as number
			: undefined;
	const windowMs = finite("windowMs");
	const windowStartedAt = finite("windowStartedAt");
	const targetFraction = finite("targetFraction");
	const fastFraction = candidate.fastFraction === null ? null : finite("fastFraction");
	const fastStandardCostUsd = finite("fastStandardCostUsd");
	const totalStandardCostUsd = finite("totalStandardCostUsd");
	const fastRequests = finite("fastRequests");
	const totalRequests = finite("totalRequests");
	if (
		windowMs === undefined
		|| windowStartedAt === undefined
		|| targetFraction === undefined
		|| fastFraction === undefined
		|| fastStandardCostUsd === undefined
		|| totalStandardCostUsd === undefined
		|| fastRequests === undefined
		|| totalRequests === undefined
		|| typeof candidate.exceedsTarget !== "boolean"
		|| !Array.isArray(candidate.multipliers)
		|| !candidate.multipliers.every(multiplier => typeof multiplier === "number" && Number.isFinite(multiplier))
	) return undefined;
	return {
		windowMs,
		windowStartedAt,
		targetFraction,
		fastFraction,
		fastStandardCostUsd,
		totalStandardCostUsd,
		fastRequests,
		totalRequests,
		exceedsTarget: candidate.exceedsTarget,
		multipliers: candidate.multipliers as number[],
	};
}


function parseRoster(value: unknown): UsageRoster | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as { reports?: unknown; generatedAt?: unknown; fastTier?: unknown };
	if (!Array.isArray(candidate.reports)) return null;
	const reports = candidate.reports.filter(
		report => typeof report === "object" && report !== null,
	) as UsageReport[];
	const generatedAt = candidate.generatedAt;
	const fastTier = parseFastTier(candidate.fastTier);
	return {
		reports,
		...(typeof generatedAt === "number" || typeof generatedAt === "string" ? { generatedAt } : {}),
		...(fastTier === undefined ? {} : { fastTier }),
	};
}

function limits(report: UsageReport): UsageLimit[] {
	return Array.isArray(report.limits)
		? report.limits.filter(limit => typeof limit === "object" && limit !== null) as UsageLimit[]
		: [];
}

/** The v2 footer's remaining-quota calculation, with normalized-amount fallbacks. */
export function freeFraction(limit: UsageLimit): number | null {
	const amount = typeof limit.amount === "object" && limit.amount !== null
		? limit.amount as UsageAmount
		: undefined;
	let free = amount?.remainingFraction;
	if (free === undefined && amount?.usedFraction !== undefined) free = 1 - amount.usedFraction;
	if (free === undefined && amount?.remaining !== undefined && amount.limit !== undefined && amount.limit > 0) {
		free = amount.remaining / amount.limit;
	}
	if (free === undefined && amount?.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		free = 1 - amount.used / amount.limit;
	}
	if (free === undefined && amount?.unit === "percent" && amount.remaining !== undefined) free = amount.remaining / 100;
	if (free === undefined && amount?.unit === "percent" && amount.used !== undefined) free = 1 - amount.used / 100;
	return free === undefined || !Number.isFinite(free) ? null : Math.max(0, Math.min(1, free));
}

function severity(free: number): string {
	return free > 0.5 ? "success" : free > 0.2 ? "warning" : "error";
}

/** Exact six-cell bar rendering quarried from the retired v2 orchestrator footer. */
export function renderUsageBar(free: number, theme: UsageTheme = PLAIN_THEME): string {
	const bounded = Math.max(0, Math.min(1, free));
	const full = Math.round(bounded * BAR_WIDTH);
	return `${theme.fg(severity(bounded), "█".repeat(full))}${theme.fg("dim", "░".repeat(BAR_WIDTH - full))}`;
}

function windowTag(limit: UsageLimit): string {
	const window = typeof limit.window === "object" && limit.window !== null ? limit.window : undefined;
	const id = typeof window?.id === "string"
		? window.id
		: typeof limit.label === "string"
			? limit.label
			: "limit";
	const tier = typeof limit.scope === "object" && limit.scope !== null && typeof limit.scope.tier === "string"
		? limit.scope.tier
		: null;
	return tier === null ? id : `${id}·${tier}`;
}

function providerLabel(provider: string): string {
	return provider === "anthropic" ? "claude" : provider === "openai-codex" ? "codex" : provider;
}

function metadataString(report: UsageReport, key: string): string | undefined {
	return typeof report.metadata === "object"
		&& report.metadata !== null
		&& typeof report.metadata[key] === "string"
		? report.metadata[key]
		: undefined;
}

function accountLabel(report: UsageReport, index: number): string {
	return metadataString(report, "email")
		?? metadataString(report, "accountId")
		?? metadataString(report, "account")
		?? metadataString(report, "user")
		?? metadataString(report, "username")
		?? `${providerLabel(report.provider ?? "quota")}#${index + 1}`;
}

function asTheme(source: unknown): UsageTheme {
	if (typeof source !== "object" || source === null) return PLAIN_THEME;
	const candidate = source as { fg?: unknown; bold?: unknown };
	if (typeof candidate.fg !== "function" || typeof candidate.bold !== "function") return PLAIN_THEME;
	const theme = source as UsageTheme;
	return {
		fg(key, value) {
			try {
				const themed = theme.fg(key, value);
				return typeof themed === "string" ? themed : value;
			} catch {
				return value;
			}
		},
		bold(value) {
			try {
				const themed = theme.bold(value);
				return typeof themed === "string" ? themed : value;
			} catch {
				return value;
			}
		},
	};
}

/** One compact account row per report, retaining v2's bars, colors, tags, and free percentage. */
export function renderUsageStatus(roster: UsageRoster | null, theme: UsageTheme = PLAIN_THEME): string {
	if (roster === null || roster.reports.length === 0) return theme.fg("dim", NEUTRAL_USAGE_STATUS);
	return roster.reports.map((report, reportIndex) => {
		const label = accountLabel(report, reportIndex);
		const provider = providerLabel(report.provider ?? "quota");
		const cells = limits(report).map(limit => {
			const free = freeFraction(limit);
			if (free === null) return `${theme.fg("dim", windowTag(limit))} ${theme.fg("dim", "?????? ?")}`;
			return `${theme.fg("dim", windowTag(limit))} ${renderUsageBar(free, theme)} ${theme.fg(severity(free), `${Math.round(free * 100)}%`)}`;
		});
		return `${theme.bold(theme.fg("accent", label))} ${theme.fg("dim", provider)} ${cells.length === 0 ? theme.fg("dim", "quota ?") : cells.join("  ")}`;
	}).join(theme.fg("dim", "  ·  "));
}

function timestamp(value: number | string | undefined): number | null {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string"
			? Date.parse(value)
			: Number.NaN;
	return Number.isFinite(parsed) && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
	if (totalMinutes >= 2 * 24 * 60) return `${Math.floor(totalMinutes / (24 * 60))}d ${Math.floor(totalMinutes % (24 * 60) / 60)}h`;
	if (totalMinutes >= 60) return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
	return `${totalMinutes}m`;
}

function resetText(limit: UsageLimit, now: number): string {
	const window = typeof limit.window === "object" && limit.window !== null ? limit.window : undefined;
	const candidate = typeof window?.resetsAt === "number" ? window.resetsAt : Number.NaN;
	const resetsAt = Number.isFinite(candidate) && Number.isFinite(new Date(candidate).getTime())
		? candidate
		: null;
	if (resetsAt === null) return "reset unknown";
	const verb = typeof window?.resetLabel === "string" ? window.resetLabel : "resets";
	const exact = new Date(resetsAt).toISOString();
	return resetsAt <= now ? `${verb} ${exact} (due)` : `${verb} ${exact} (in ${formatDuration(resetsAt - now)})`;
}

function formatNumber(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return String(Math.round(value * 100) / 100);
}

function amountText(limit: UsageLimit): string {
	const amount = typeof limit.amount === "object" && limit.amount !== null
		? limit.amount as UsageAmount
		: undefined;
	const free = freeFraction(limit);
	const parts = [free === null ? "usage unknown" : `${Math.round(free * 100)}% free`];
	if (
		amount?.unit !== "percent"
		&& typeof amount?.used === "number"
		&& Number.isFinite(amount.used)
		&& typeof amount.limit === "number"
		&& Number.isFinite(amount.limit)
	) {
		parts.push(`${formatNumber(amount.used)}/${formatNumber(amount.limit)} ${amount.unit ?? "units"} used`);
	} else if (
		amount?.unit !== "percent"
		&& typeof amount?.remaining === "number"
		&& Number.isFinite(amount.remaining)
	) {
		parts.push(`${formatNumber(amount.remaining)} ${amount.unit ?? "units"} remaining`);
	}
	return parts.join(" · ");
}

/** Full `/quota` text: every account report, quota window, exact reset, and provider note. */
export function buildUsageText(
	roster: UsageRoster | null,
	theme: UsageTheme = PLAIN_THEME,
	now = Date.now(),
): string {
	if (roster === null) return "deck usage\n\nNo broker roster available.";
	const generatedAt = timestamp(roster.generatedAt);
	const lines = [
		theme.bold(theme.fg("accent", "deck usage")),
		...(generatedAt === null ? [] : [theme.fg("dim", `as of ${new Date(generatedAt).toISOString()} (${formatDuration(now - generatedAt)} ago)`)]),
	];
	if (roster.fastTier !== undefined) {
		const fast = roster.fastTier;
		const target = `${Math.round(fast.targetFraction * 1_000) / 10}%`;
		lines.push("", theme.bold("fast tier · trailing 7d"));
		if (fast.fastFraction === null) {
			lines.push(`  no attributed completed requests · target ≤${target}`);
		} else {
			const share = `${Math.round(fast.fastFraction * 1_000) / 10}%`;
			const multipliers = fast.multipliers.length === 0
				? ""
				: ` · credit rate ${fast.multipliers.map(multiplier => `${formatNumber(multiplier)}×`).join("/")} Standard`;
			lines.push(
				`  ${share} of tracked Standard-rate cost (${fast.fastRequests}/${fast.totalRequests} requests) · target ≤${target}${multipliers}`,
			);
			if (fast.exceedsTarget) lines.push(`  WARNING: trailing fast share exceeds the ${target} target`);
		}
	}
	if (roster.reports.length === 0) lines.push("", "No broker usage reports.");
	for (const [index, report] of roster.reports.entries()) {
		const provider = providerLabel(report.provider ?? "?");
		lines.push("", `${accountLabel(report, index)} · ${provider}`);
		for (const note of Array.isArray(report.notes) ? report.notes : []) lines.push(`  note: ${note}`);
		for (const limit of limits(report)) {
			lines.push(`  ${windowTag(limit)}: ${amountText(limit)} · ${resetText(limit, now)}`);
			for (const note of Array.isArray(limit.notes) ? limit.notes : []) lines.push(`    note: ${note}`);
		}
		const availableResets = typeof report.resetCredits === "object"
			&& report.resetCredits !== null
			&& typeof report.resetCredits.availableCount === "number"
			? report.resetCredits.availableCount
			: undefined;
		if (availableResets !== undefined) lines.push(`  saved resets: ${availableResets}`);
	}
	return lines.join("\n");
}

function gatewayToken(env: Record<string, string | undefined>, runtime: DeckUsageRuntime): string | undefined {
	const configured = env.DECK_GATEWAY_API_KEY?.trim();
	if (configured !== undefined && configured !== "") return configured;
	const home = env.DECK_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".deck");
	try {
		const token = runtime.readFile(path.join(home, "broker", "gateway.token")).trim();
		return token === "" ? undefined : token;
	} catch {
		return undefined;
	}
}

class UsageClient {
	private readonly origin: string;
	private readonly token: string | undefined;
	private cached: { roster: UsageRoster | null; expiresAt: number } | undefined;
	private inflight: Promise<UsageRoster | null> | undefined;

	constructor(
		env: Record<string, string | undefined>,
		private readonly runtime: DeckUsageRuntime,
	) {
		this.origin = (env.DECK_GATEWAY_ORIGIN ?? "http://127.0.0.1:8377").replace(/\/+$/, "");
		this.token = gatewayToken(env, runtime);
	}

	read(): Promise<UsageRoster | null> {
		const now = this.runtime.now();
		if (this.cached !== undefined && now < this.cached.expiresAt) return Promise.resolve(this.cached.roster);
		if (this.inflight !== undefined) return this.inflight;
		this.inflight = this.request()
			.then(roster => {
				// Cache failures too: an offline broker must not turn every settled
				// agent turn into another connection attempt.
				this.cached = { roster, expiresAt: this.runtime.now() + USAGE_CACHE_MS };
				return roster;
			})
			.finally(() => {
				this.inflight = undefined;
			});
		return this.inflight;
	}

	private async request(): Promise<UsageRoster | null> {
		const controller = new AbortController();
		const timeout = this.runtime.setTimeout(() => controller.abort(), USAGE_REQUEST_TIMEOUT_MS);
		try {
			const headers = new Headers({ accept: "application/json" });
			if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
			const response = await this.runtime.fetch(`${this.origin}/v1/usage`, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
			if (!response.ok) return null;
			const roster = parseRoster(await response.json());
			if (roster === null) return null;
			return roster;
		} catch {
			return null;
		} finally {
			this.runtime.clearTimeout(timeout);
		}
	}
}

function setStatus(ctx: UsageContext, value: string): void {
	try {
		ctx.ui?.setStatus?.("deck-usage", value);
	} catch {
		// Status chrome is best-effort and must not disturb the session.
	}
}

/** Register the Prime conversation status chip and `/quota` breakdown. */
export function registerDeckUsage(
	agent: DeckUsageApi,
	env: Record<string, string | undefined> = process.env,
	overrides: Partial<DeckUsageRuntime> = {},
): void {
	const runtime: DeckUsageRuntime = { ...DEFAULT_RUNTIME, ...overrides };
	const client = new UsageClient(env, runtime);
	let latestContext: UsageContext | undefined;
	let statusPoll: UsageTimerHandle | undefined;
	let sessionActive = false;
	let sessionGeneration = 0;

	const refreshStatus = async (ctx: UsageContext, generation: number): Promise<void> => {
		const roster = await client.read();
		if (!sessionActive || generation !== sessionGeneration) return;
		setStatus(ctx, renderUsageStatus(roster, asTheme(ctx.ui?.theme)));
	};
	const startRefresh = (ctx: UsageContext): void => {
		if (!sessionActive) return;
		latestContext = ctx;
		const generation = sessionGeneration;
		void refreshStatus(ctx, generation).catch(() => {
			if (sessionActive && generation === sessionGeneration) setStatus(ctx, NEUTRAL_USAGE_STATUS);
		});
	};

	agent.registerCommand("quota", {
		description: "Show broker quota by account and window",
		async handler(_args, ctx) {
			const roster = await client.read();
			const message = buildUsageText(roster, asTheme(ctx.ui?.theme), runtime.now());
			// Hosts render notify() as a one-line status (observed on prime), so a
			// multi-line report silently loses every line but the last. Prefer the
			// host select dialog as a scrollable read-only viewer; keep notify for
			// hosts without dialogs. No pi-tui components: component identity must
			// stay with the host (version-skewed classes render nothing).
			const select = ctx.ui?.select;
			if (typeof select === "function") {
				try {
					await select.call(ctx.ui, "Broker quota", [...message.split("\n"), "Close"]);
				} catch {
					ctx.ui?.notify?.(message, "info");
				}
			} else {
				try {
					ctx.ui?.notify?.(message, "info");
				} catch {
					// Command presentation is best-effort in non-TUI hosts.
				}
			}
			setStatus(ctx, renderUsageStatus(roster, asTheme(ctx.ui?.theme)));
		},
	});

	agent.on("session_start", (_event, ctx) => {
		sessionActive = true;
		sessionGeneration += 1;
		setStatus(ctx, asTheme(ctx.ui?.theme).fg("dim", NEUTRAL_USAGE_STATUS));
		startRefresh(ctx);
		if (statusPoll !== undefined) return;
		statusPoll = runtime.setInterval(() => {
			if (latestContext !== undefined) startRefresh(latestContext);
		}, USAGE_REFRESH_INTERVAL_MS);
		statusPoll.unref?.();
	});
	agent.on("agent_settled", (_event, ctx) => startRefresh(ctx));
	agent.on("session_shutdown", () => {
		sessionActive = false;
		sessionGeneration += 1;
		if (statusPoll !== undefined) runtime.clearInterval(statusPoll);
		statusPoll = undefined;
		latestContext = undefined;
	});
}

export default function deckUsage(agent: DeckUsageApi): void {
	registerDeckUsage(agent);
}
