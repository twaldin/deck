/**
 * Turn broker auth-dead accounts into durable captain questions.
 *
 * A dead OAuth grant is exactly the class the questions queue exists for: only
 * the captain can fix it (he has to log in), it must survive a session restart,
 * and it must be asked once rather than every reconcile cycle. The id is global
 * and derived from the account identity, so any orchestrator session folds onto
 * the same question instead of opening a second one.
 *
 * The reverse edge matters just as much: once the account is live again the
 * question is stale, and a stale login question is exactly the noise the queue
 * is supposed to remove. Sync resolves it automatically.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { answer, askIfAbsent, openQuestions, readQuestions } from "./questions-store";
import { deadAccountKey, providerLabel, type UsageRoster } from "./usage-roster";

const ID_PREFIX = "broker-auth-dead:";

function archivedQuestionIds(file: string): Set<string> {
	const ids = new Set<string>();
	let raw: string;
	try {
		raw = readFileSync(path.join(path.dirname(file), "archive.jsonl"), "utf8");
	} catch {
		return ids;
	}
	for (const line of raw.split("\n")) {
		try {
			const entry = JSON.parse(line) as { id?: unknown };
			if (typeof entry.id === "string") ids.add(entry.id);
		} catch {
			// Ignore a torn archive tail. It can only repeat one question.
		}
	}
	return ids;
}

/**
 * One id per INCIDENT, not per account.
 *
 * The queue fold makes resolution terminal and carries it across a re-ask, so a
 * reused id is single-use: once dismissed, that exact id can never be shown
 * again. An account that dies, is logged back in, then dies again is a second
 * incident and must ask a second time, so the disable timestamp is part of the key.
 */
export function authDeadQuestionId(dead: Parameters<typeof deadAccountKey>[0]): string {
	const incident = dead.disabledAtMs ?? 0;
	return `${ID_PREFIX}${deadAccountKey(dead)}:${incident}`;
}

/**
 * Ask about every dead account, and resolve questions whose account recovered.
 * Returns the ids touched so a caller can report or test what changed.
 */
export function syncAuthDeadQuestions(
	file: string,
	roster: UsageRoster | null,
	session: { sessionId: string; cwd: string },
	now = Date.now(),
): { asked: string[]; cleared: string[] } {
	// Only an AUTHORITATIVE roster may resolve a question. `readUsageRoster`
	// returns null on a read or parse failure, and a broker older than the dead
	// field writes no `dead` key at all — treating either as "nothing is dead"
	// would dismiss a live login question, and the fold makes that permanent.
	if (roster === null || roster === undefined || !Array.isArray(roster.dead)) return { asked: [], cleared: [] };
	const dead = roster.dead;
	const already = archivedQuestionIds(file);
	for (const question of readQuestions(file)) already.add(question.id);
	const asked: string[] = [];
	for (const account of dead) {
		const id = authDeadQuestionId(account);
		if (already.has(id)) continue;
		const label = account.email ?? account.accountId ?? `credential ${account.id ?? "?"}`;
		const provider = providerLabel(account.provider ?? "?");
		const event = askIfAbsent(file, {
			id,
			idScope: "global",
			questionKind: "agent",
			question: `REAUTH NEEDED: ${label} (${provider}). Run: bun ~/dev/deck/broker/src/cli.ts login ${account.provider ?? "<provider>"}. Continue?`,
			context: `The broker removed this account: its OAuth grant no longer refreshes (${account.cause ?? "oauth refresh failed"}). It carries no quota until you log in again. Every other account keeps working.`,
			options: ["log in now", "leave it out"],
			recommendation: "log in now",
			urgency: "high",
			sessionId: session.sessionId,
			cwd: session.cwd,
			now,
		});
		asked.push(event.id);
	}

	const live = new Set(dead.map(account => authDeadQuestionId(account)));
	const cleared: string[] = [];
	for (const question of openQuestions(file)) {
		if (!question.id.startsWith(ID_PREFIX) || live.has(question.id)) continue;
		answer(file, question.id, "the account authenticates again; no login needed", "dismissed", now);
		cleared.push(question.id);
	}
	return { asked, cleared };
}
