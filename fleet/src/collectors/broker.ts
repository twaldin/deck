import type { SourceDiagnostic } from "../types";

/**
 * Deck broker usage roster (GET http://127.0.0.1:8377) is capability-authed.
 * The brief explicitly permits skipping it and leaving a TODO seam rather than
 * inventing an auth scheme — so this collector is a typed placeholder.
 *
 * TODO(broker-auth): wire real capability auth here. The broker expects a
 * capability token (see broker/src). When an auth path is verified in this
 * home, implement `fetchBrokerRoster` against `${endpoint}/usage` and surface
 * the roster as an extra tree section. Until then we DO NOT guess a scheme.
 */
export interface BrokerAuth {
	/** Capability token / credential. Intentionally unresolved (TODO seam). */
	readonly capability: string;
}

export interface BrokerRosterEntry {
	account: string;
	model: string;
	usedPct: number;
}

export interface BrokerConfig {
	endpoint: string;
	auth: BrokerAuth | null;
}

export const DEFAULT_BROKER_ENDPOINT = "http://127.0.0.1:8377";

/**
 * Placeholder collector. Never performs an unauthenticated request. Returns a
 * diagnostic explaining the source is intentionally skipped until auth exists.
 */
export async function collectBroker(config: BrokerConfig): Promise<{
	roster: BrokerRosterEntry[];
	diagnostic: SourceDiagnostic;
}> {
	if (config.auth === null) {
		return {
			roster: [],
			diagnostic: {
				source: "broker",
				ok: true,
				level: "skipped",
				detail: "skipped (capability auth not wired — TODO seam)",
			},
		};
	}
	// TODO(broker-auth): implement authed fetch once a capability path is verified.
	return {
		roster: [],
		diagnostic: {
			source: "broker",
			ok: false,
			level: "warning",
			detail: "auth provided but fetch not implemented (TODO)",
		},
	};
}
