/**
 * Usage roster (SPEC §6.6): broker/usage.json refreshed on probe; TUI renders.
 * AuthStorage already caches per-credential reports at a 5-min jittered TTL and
 * keeps last-good values through transient failures — this module only projects
 * that into the on-disk roster, stripping provider `raw` payloads. Reports are
 * provider-agnostic: a provider (e.g. xai-oauth) shows up only after a real
 * `cli.ts login` stores its credential — nothing is fabricated for absent ones.
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { isInvalidatedOAuthTokenError } from "@oh-my-pi/pi-ai/error";
import { USAGE_JSON, writeJsonAtomic } from "./paths";
import { getProviderCatalog } from "./models";

export interface UsageRosterEntry {
	provider: string;
	[key: string]: unknown;
}

/**
 * An account pi-ai tore down because its OAuth grant is definitively gone
 * (`invalid_grant`, a non-blip 401/403). Only the captain can fix it, by
 * logging that provider in again, so the roster carries it instead of letting
 * the account silently vanish from every surface.
 */
export interface DeadAccount {
	id: number;
	provider: string;
	email: string | null;
	accountId: string | null;
	cause: string;
	disabledAtMs: number | null;
}

export interface UsageRosterAccount {
	id: number;
	provider: string;
	email: string | null;
	accountId: string | null;
	status: "reported" | "no usage API" | "not logged in";
}

export interface UsageRoster {
	generatedAt: string;
	accounts: UsageRosterAccount[];
	reports: UsageRosterEntry[];
	/** Auth-dead accounts: re-login required. Empty when every grant is live. */
	dead: DeadAccount[];
}

/**
 * A tombstone is auth-dead only when a refresh failed. `remove()` writes
 * "deleted by user", and asking the captain to re-login an account he just
 * logged out is a false alarm.
 */
export function isAuthDeadCause(cause: string): boolean {
	return cause.startsWith("oauth refresh failed:") || isInvalidatedOAuthTokenError(cause);
}

/** Longest cause the roster keeps. The full text is a stack trace; see {@link shortCause}. */
const MAX_CAUSE_CHARS = 200;

/**
 * One readable line for the captain.
 *
 * pi-ai records the verbatim error, which for Anthropic is a nested
 * OAuthError carrying a stack trace and absolute node_modules paths — roughly a
 * kilobyte of noise per account. It reaches a durable question (capped at 8KB
 * per event) and the TUI, so the roster keeps the provider's own error code and
 * drops the trace.
 */
export function shortCause(cause: string): string {
	const code = /"error":\s*"([^"]+)"/.exec(cause)?.[1];
	const description = /"error_description":\s*"([^"]+)"/.exec(cause)?.[1];
	if (code !== undefined) return description === undefined ? code : `${code}: ${description}`;
	const firstLine = cause.split("\n", 1)[0]!.trim();
	return firstLine.length > MAX_CAUSE_CHARS ? `${firstLine.slice(0, MAX_CAUSE_CHARS)}\u2026` : firstLine;
}

async function deadAccounts(storage: AuthStorage): Promise<DeadAccount[]> {
	let tombstones: Awaited<ReturnType<AuthStorage["listDisabledCredentials"]>>;
	try {
		tombstones = await storage.listDisabledCredentials();
	} catch {
		return []; // a store without tombstones must not fail the roster
	}
	return tombstones
		.filter(row => isAuthDeadCause(row.cause))
		.map(row => ({
			id: row.id,
			provider: row.provider,
			email: row.email ?? null,
			accountId: row.accountId ?? null,
			cause: shortCause(row.cause),
			disabledAtMs: row.disabledAtMs ?? null,
		}));
}

/** Fetch all credential reports concurrently. A bounded signal keeps a dead provider from holding the roster request. */
export async function refreshUsageRoster(storage: AuthStorage, signal?: AbortSignal): Promise<UsageRoster> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), 5_000);
	if (signal) signal.addEventListener("abort", () => timeout.abort(), { once: true });
	let reports: Awaited<ReturnType<NonNullable<AuthStorage["fetchUsageReports"]>>> = [];
	try {
		reports = (await storage.fetchUsageReports({ signal: timeout.signal })) ?? [];
	} catch {
		// Keep the roster usable when a provider probe times out.
	} finally {
		clearTimeout(timer);
	}
	const reported = new Set(reports.map(report => {
		const metadata = report.metadata as Record<string, unknown> | undefined;
		return `${report.provider}\0${metadata?.email ?? metadata?.accountId ?? metadata?.account ?? ""}`;
	}));
	const credentials = storage.exportSnapshot().credentials;
	const accounts: UsageRosterAccount[] = credentials.map(entry => {
		const credential = entry.credential;
		const email = credential.type === "oauth" ? (credential.email ?? null) : null;
		const accountId = credential.type === "oauth" ? (credential.accountId ?? null) : null;
		return { id: entry.id, provider: entry.provider, email, accountId,
			status: reported.has(`${entry.provider}\0${email ?? accountId ?? ""}`) ? "reported" : "no usage API" };
	});
	const loggedIn = new Set(credentials.map(entry => entry.provider));
	for (const provider of getProviderCatalog(loggedIn).filter(entry => entry.needsAuth)) {
		accounts.push({ id: -1, provider: provider.id, email: null, accountId: null, status: "not logged in" });
	}
	const roster: UsageRoster = {
		generatedAt: new Date().toISOString(),
		accounts,
		reports: reports.map(report => {
			const { raw: _raw, ...rest } = report as unknown as UsageRosterEntry & { raw?: unknown };
			return rest as UsageRosterEntry;
		}),
		dead: await deadAccounts(storage),
	};
	writeJsonAtomic(USAGE_JSON, roster);
	return roster;
}
