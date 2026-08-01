/** Compact quota bars for the deck footer. The broker owns the roster. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageTheme = { fg: (key: string, text: string) => string; bold: (text: string) => string };
export type UsageRoster = {
	generatedAt?: string;
	reports?: Array<{
		provider?: string;
		metadata?: { email?: string };
		limits?: Array<{
			id?: string;
			label?: string;
			window?: { id?: string };
			scope?: Record<string, unknown>;
			amount?: { usedFraction?: number; remainingFraction?: number };
			status?: "ok" | "warning" | "exhausted" | "unknown";
		}>;
	}>;
};

const PLAIN: UsageTheme = { fg: (_key, text) => text, bold: (text) => text };
const BAR_WIDTH = 6;

type UsageLimit = {
	id?: string;
	label?: string;
	window?: { id?: string };
	scope?: Record<string, unknown>;
	amount?: { usedFraction?: number; remainingFraction?: number };
	status?: "ok" | "warning" | "exhausted" | "unknown";
};

function freeFraction(limit: UsageLimit): number | null {
	const amount = limit.amount;
	const free = amount?.remainingFraction ?? (amount?.usedFraction === undefined ? null : 1 - amount.usedFraction);
	return free === null || !Number.isFinite(free) ? null : Math.max(0, Math.min(1, free));
}

function severity(free: number): string {
	return free > 0.5 ? "success" : free > 0.2 ? "warning" : "error";
}

function bar(free: number, theme: UsageTheme): string {
	const full = Math.round(free * BAR_WIDTH);
	return `${theme.fg(severity(free), "█".repeat(full))}${theme.fg("dim", "░".repeat(BAR_WIDTH - full))}`;
}

function windowTag(limit: UsageLimit): string {
	const id = limit.window?.id ?? limit.label ?? "limit";
	const tier = typeof limit.scope?.tier === "string" ? limit.scope.tier : null;
	return tier === null ? id : `${id}·${tier}`;
}

export function aggregate(roster: UsageRoster): { provider: string; tag: string; free: number; count: number }[] {
	const buckets = new Map<string, { provider: string; tag: string; sum: number; count: number }>();
	for (const report of roster.reports ?? []) {
		const provider = report.provider;
		if (provider === undefined) continue;
		for (const limit of report.limits ?? []) {
			const free = freeFraction(limit);
			if (free === null) continue;
			const tag = windowTag(limit);
			const key = `${provider}\u0000${limit.id ?? tag}`;
			const bucket = buckets.get(key) ?? { provider, tag, sum: 0, count: 0 };
			bucket.sum += free;
			bucket.count += 1;
			buckets.set(key, bucket);
		}
	}
	return [...buckets.values()]
		.map(bucket => ({ provider: bucket.provider, tag: bucket.tag, free: bucket.sum / bucket.count, count: bucket.count }))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.tag.localeCompare(b.tag));
}

export function readUsageRoster(home = homedir()): UsageRoster | null {
	try {
		const value: unknown = JSON.parse(readFileSync(join(home, ".deck", "broker", "usage.json"), "utf8"));
		return typeof value === "object" && value !== null ? value as UsageRoster : null;
	} catch {
		return null;
	}
}

export function usageStatusLine(roster: UsageRoster | null, theme: UsageTheme = PLAIN): string {
	if (roster === null) return "";
	const byProvider = new Map<string, string[]>();
	for (const row of aggregate(roster)) {
		const provider = row.provider === "anthropic" ? "claude" : row.provider === "openai-codex" ? "codex" : row.provider;
		const cell = `${theme.fg("dim", row.tag)} ${bar(row.free, theme)} ${theme.fg(severity(row.free), `${Math.round(row.free * 100)}%`)}`;
		(byProvider.get(provider) ?? (byProvider.set(provider, []), byProvider.get(provider)!)).push(cell);
	}
	return [...byProvider.entries()].map(([provider, cells]) => `${theme.bold(theme.fg("accent", provider))} ${cells.join("  ")}`).join(theme.fg("dim", "  ·  "));
}
