/**
 * Status grammar. Unchanged from fm2 by decision, with one parser fix.
 *
 * A `.status` line is a wake EVENT, not current-state truth. Current state is
 * reconciled from run liveness and workflow rows.
 *
 * fm2's parser took everything before the first colon as the verb
 * (bin/fm-classify-lib.sh:162-167), so a timestamp-prefixed line
 * `[2026-07-29T01:13 UTC] blocked: main red` parsed its verb as
 * `[2026-07-29T01` and the blocked event was invisible. Six real lines hit this
 * (day1-reflection). Here the verb is anchored: a line whose first token is not
 * a known verb is MALFORMED and reported, never silently reinterpreted.
 */

export const STATUS_VERBS = [
	"working",
	"needs-decision",
	"blocked",
	"paused",
	"resolved",
	"done",
	"failed",
] as const;

export type StatusVerb = (typeof STATUS_VERBS)[number];

/** Terminal verbs end a task's lifecycle. */
export const TERMINAL_VERBS: readonly StatusVerb[] = ["done", "failed"];

/** Verbs that require the captain or orchestrator to act now (report §6.2 T0). */
export const T0_VERBS: readonly StatusVerb[] = ["blocked", "failed", "needs-decision"];

/** Verbs that are actionable but batchable (T1). */
export const T1_VERBS: readonly StatusVerb[] = ["done", "resolved"];

/** Verbs that must never wake anything (T2). 49% of fm2's status volume. */
export const T2_VERBS: readonly StatusVerb[] = ["working", "paused"];

export type StatusEvent = {
	verb: StatusVerb;
	/** Optional decision key: `needs-decision [key=api-shape]: ...`. */
	key: string;
	note: string;
	/** Raw line, for evidence. */
	raw: string;
};

export type MalformedStatusLine = {
	raw: string;
	reason: string;
};

const VERB_SET = new Set<string>(STATUS_VERBS);
const KEY_RE = /^\[key=([a-z0-9][a-z0-9-]{0,63})\]$/;

/**
 * Parse one status line. Returns null for blank lines.
 *
 * Grammar: `<verb>[ [key=<slug>]]: <note>` — the verb is the FIRST token and
 * anchored, which is the fix over fm2.
 */
export function parseStatusLine(line: string): StatusEvent | MalformedStatusLine | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;

	const colon = trimmed.indexOf(":");
	if (colon === -1) {
		return { raw: line, reason: "no colon: a status line is '<verb>: <note>'" };
	}

	const head = trimmed.slice(0, colon).trim();
	const note = trimmed.slice(colon + 1).trim();
	const tokens = head.split(/\s+/).filter((t) => t.length > 0);
	const verb = tokens[0];

	if (verb === undefined || !VERB_SET.has(verb)) {
		return {
			raw: line,
			reason: `line does not start with a status verb (got ${JSON.stringify(
				verb ?? "",
			)}); expected one of ${STATUS_VERBS.join(", ")}. Timestamps belong AFTER the colon.`,
		};
	}

	let key = "default";
	if (tokens.length > 1) {
		const match = tokens[1] === undefined ? null : KEY_RE.exec(tokens[1]);
		if (match === null || match[1] === undefined) {
			return {
				raw: line,
				reason: `unexpected token ${JSON.stringify(tokens[1] ?? "")} between verb and colon; only [key=<slug>] is allowed`,
			};
		}
		key = match[1];
		if (tokens.length > 2) {
			return { raw: line, reason: "more than one token between verb and colon" };
		}
	}

	return { verb: verb as StatusVerb, key, note, raw: line };
}

export function isMalformed(
	parsed: StatusEvent | MalformedStatusLine,
): parsed is MalformedStatusLine {
	return "reason" in parsed;
}

/** Format a status line. The single writer for the grammar. */
export function formatStatusLine(verb: StatusVerb, note: string, key?: string): string {
	const oneLine = note.replace(/\s+/g, " ").trim();
	const keyToken = key !== undefined && key !== "default" ? ` [key=${key}]` : "";
	return `${verb}${keyToken}: ${oneLine}`;
}

export type WakeTier = "T0" | "T1" | "T2";

export function tierFor(verb: StatusVerb): WakeTier {
	if (T0_VERBS.includes(verb)) return "T0";
	if (T1_VERBS.includes(verb)) return "T1";
	return "T2";
}
