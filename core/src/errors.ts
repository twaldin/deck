/**
 * Deck error codes. Every rejection an agent or tool can see carries one of
 * these stable codes plus a human message naming the violated constraint.
 */
export type DeckErrorCode =
	| "E_TOO_LONG" // conciseness cap exceeded (SPEC §4.4, D-H) — field + limit named
	| "E_CAS" // revision mismatch on manifest mutation (SPEC §3)
	| "E_LEASE" // stale lease_epoch / lease token (SPEC §4.5)
	| "E_EVIDENCE" // terminal CAS into done without deploy evidence + fallout verdict (D-E)
	| "E_ADMISSION" // admission limit reached (SPEC §5.5.3)
	| "E_CAP" // missing/invalid capability on a control surface
	| "E_ARG" // malformed argument
	| "E_STATE" // operation invalid for current stage/state
	| "E_LIVENESS" // dispatch failed session-exists + first-heartbeat verification (D-D)
	| "E_IO"; // storage failure (corrupt manifest, lock timeout, …)

export class DeckError extends Error {
	readonly code: DeckErrorCode;
	readonly detail: Record<string, unknown>;

	constructor(code: DeckErrorCode, message: string, detail: Record<string, unknown> = {}) {
		super(`${code}: ${message}`);
		this.code = code;
		this.detail = detail;
	}
}

/** Enforce a D-H conciseness cap: reject, never truncate (SPEC §4.4). */
export function assertCap(field: string, value: string, limit: number): void {
	if (value.length > limit) {
		throw new DeckError("E_TOO_LONG", `${field} is ${value.length} chars; limit ${limit}. Compress and retry.`, {
			field,
			limit,
			length: value.length,
		});
	}
}
