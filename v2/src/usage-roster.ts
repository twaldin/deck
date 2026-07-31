/** Compact quota bars for the deck footer. The broker owns the roster. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageTheme = { fg: (key: string, text: string) => string; bold: (text: string) => string };
export type UsageRoster = {
	reports?: Array<{
		provider?: string;
		limits?: Array<{
			label?: string;
			window?: { id?: string };
			amount?: { usedFraction?: number; remainingFraction?: number };
		}>;
	}>;
};

const PLAIN: UsageTheme = { fg: (_key, text) => text, bold: (text) => text };
const BAR_WIDTH = 6;

type UsageLimit = {
	label?: string;
	window?: { id?: string };
	amount?: { usedFraction?: number; remainingFraction?: number };
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
	for (const report of roster.reports ?? []) {
		const provider = report.provider === "anthropic" ? "claude" : report.provider === "openai-codex" ? "codex" : report.provider;
		if (provider === undefined) continue;
		for (const limit of report.limits ?? []) {
			const free = freeFraction(limit);
			if (free === null) continue;
			const tag = limit.window?.id ?? limit.label ?? "limit";
			const cell = `${theme.fg("dim", tag)} ${bar(free, theme)} ${theme.fg(severity(free), `${Math.round(free * 100)}%`)}`;
			(byProvider.get(provider) ?? (byProvider.set(provider, []), byProvider.get(provider)!)).push(cell);
		}
	}
	return [...byProvider.entries()].map(([provider, cells]) => `${theme.bold(theme.fg("accent", provider))} ${cells.join("  ")}`).join(theme.fg("dim", "  ·  "));
}
