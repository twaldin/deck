/** Compact quota bars for the deck footer. The broker owns the roster. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export type UsageTheme = { fg: (key: string, text: string) => string; bold: (text: string) => string };
export type UsageAccount = { provider?: string; email?: string | null; accountId?: string | null; id?: number; status?: string; blocks?: Array<{ blockedUntilMs?: number }> };
/** An account the broker tore down: its OAuth grant is gone until the captain logs in again. */
export type DeadAccount = { id?: number; provider?: string; email?: string | null; accountId?: string | null; cause?: string; disabledAtMs?: number | null };
export type UsageProvider = { id?: string; needsAuth?: boolean; name?: string };
export type UsageRoster = {
	generatedAt?: string;
	accounts?: UsageAccount[];
	dead?: DeadAccount[];
	reports?: Array<{
		provider?: string;
		metadata?: { email?: string; accountId?: string; account?: string; cooling?: boolean; blocked?: boolean };
		blocks?: Array<{ providerKey?: string; blockScope?: string; blockedUntilMs?: number }>;
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

export async function readLiveControlAccounts(home = homedir()): Promise<UsageAccount[]> {
	try {
		const base = join(home, ".deck");
		const cap = readFileSync(join(base, "broker", "control.token"), "utf8").trim();
		const socket = createConnection(join(base, "run", "broker.sock"));
		return await new Promise<UsageAccount[]>((resolve, reject) => {
			let buffer = "";
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("broker status timeout")); }, 2000);
			socket.on("connect", () => socket.write(`${JSON.stringify({ id: "deck-usage", cap, op: "status" })}\n`));
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const newlineAt = buffer.indexOf("\n");
				if (newlineAt === -1) return; // response is chunked; wait for the full line
				const line = buffer.slice(0, newlineAt);
				if (!line) return;
				clearTimeout(timer); socket.destroy();
				try {
					const response = JSON.parse(line) as { ok?: boolean; data?: { accounts?: UsageAccount[]; providers?: UsageProvider[] } };
					if (!response.ok) reject(new Error("broker status failed")); else resolve([
						...(response.data?.accounts ?? []),
						...(response.data?.providers ?? []).filter(provider => provider.needsAuth).map(provider => ({ provider: provider.id, status: "not logged in" })),
					]);
				} catch (error) {
					reject(error instanceof Error ? error : new Error("broker status parse failed"));
				}
			});
			socket.on("error", error => { clearTimeout(timer); reject(error); });
		});
	} catch { return []; }
}

export function mergeLiveAccounts(roster: UsageRoster, accounts: UsageAccount[]): UsageRoster {
	return { ...roster, accounts };
}

export function readUsageRoster(home = homedir()): UsageRoster | null {
	try {
		const value: unknown = JSON.parse(readFileSync(join(home, ".deck", "broker", "usage.json"), "utf8"));
		return typeof value === "object" && value !== null ? value as UsageRoster : null;
	} catch {
		return null;
	}
}

/** Provider label used on every deck surface: the captain says claude and codex. */
export function providerLabel(provider: string): string {
	return provider === "anthropic" ? "claude" : provider === "openai-codex" ? "codex" : provider;
}

/** Stable identity for one dead account, so a question about it is asked once. */
export function deadAccountKey(dead: DeadAccount): string {
	return `${dead.provider ?? "unknown"}:${dead.email ?? dead.accountId ?? dead.id ?? "unknown"}`;
}

/**
 * Login-needed segment. A dead grant silently removes an account from routing,
 * so it must be visible without opening anything.
 */
export function authDeadStatusLine(roster: UsageRoster | null, theme: UsageTheme = PLAIN): string {
	const dead = roster?.dead ?? [];
	if (dead.length === 0) return "";
	const names = dead.map(entry => entry.email ?? entry.accountId ?? `credential ${entry.id ?? "?"}`);
	return theme.bold(theme.fg("error", `REAUTH NEEDED: ${names.join(", ")}`));
}

export function usageStatusLine(roster: UsageRoster | null, theme: UsageTheme = PLAIN): string {
	if (roster === null) return "";
	const byProvider = new Map<string, string[]>();
	for (const row of aggregate(roster)) {
		const provider = providerLabel(row.provider);
		const cell = `${theme.fg("dim", row.tag)} ${bar(row.free, theme)} ${theme.fg(severity(row.free), `${Math.round(row.free * 100)}%`)}`;
		(byProvider.get(provider) ?? (byProvider.set(provider, []), byProvider.get(provider)!)).push(cell);
	}
	const cells = [...byProvider.entries()].map(([provider, entries]) => `${theme.bold(theme.fg("accent", provider))} ${entries.join("  ")}`);
	const warning = authDeadStatusLine(roster, theme);
	if (warning !== "") cells.unshift(warning);
	return cells.join(theme.fg("dim", "  ·  "));
}
