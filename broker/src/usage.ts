/**
 * Usage roster (SPEC §6.6): broker/usage.json refreshed on probe; TUI renders.
 * AuthStorage already caches per-credential reports at a 5-min jittered TTL and
 * keeps last-good values through transient failures — this module only projects
 * that into the on-disk roster, stripping provider `raw` payloads.
 */
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { USAGE_JSON, writeJsonAtomic } from "./paths";

export interface UsageRosterEntry {
	provider: string;
	[key: string]: unknown;
}

export interface UsageRoster {
	generatedAt: string;
	reports: UsageRosterEntry[];
}

/** Fetch (cache-served when warm), strip raw, persist atomically. Returns the roster. */
export async function refreshUsageRoster(storage: AuthStorage, signal?: AbortSignal): Promise<UsageRoster> {
	const reports = (await storage.fetchUsageReports({ signal })) ?? [];
	const roster: UsageRoster = {
		generatedAt: new Date().toISOString(),
		reports: reports.map(report => {
			const { raw: _raw, ...rest } = report as unknown as UsageRosterEntry & { raw?: unknown };
			return rest as UsageRosterEntry;
		}),
	};
	writeJsonAtomic(USAGE_JSON, roster);
	return roster;
}
