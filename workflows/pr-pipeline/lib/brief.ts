/**
 * Preflight gate: validate the input brief. Fails closed with the list of
 * open questions (SOP stage 0 - vision questions BEFORE dispatch).
 */

import type { Brief, BriefValidation, DecisionEntry, KillSwitch } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseKillSwitch(value: unknown, questions: string[]): KillSwitch | null {
	if (!isRecord(value)) {
		questions.push(
			'brief.killSwitch is missing: name a kill-switch ({ kind: "named", name: "..." }) or declare its absence explicitly ({ kind: "none" }).',
		);
		return null;
	}
	if (value.kind === "named") {
		if (!nonEmptyString(value.name)) {
			questions.push('brief.killSwitch.kind is "named" but killSwitch.name is empty.');
			return null;
		}
		return { kind: "named", name: value.name.trim() };
	}
	if (value.kind === "none") {
		return { kind: "none" };
	}
	questions.push('brief.killSwitch.kind must be "named" or "none" (explicit declaration required).');
	return null;
}

function parseDecisionLedger(value: unknown, questions: string[]): DecisionEntry[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		questions.push("brief.decisionLedger must be an array of { question, decision, open } entries.");
		return [];
	}
	const entries: DecisionEntry[] = [];
	for (const [i, raw] of value.entries()) {
		if (!isRecord(raw) || !nonEmptyString(raw.question)) {
			questions.push(`brief.decisionLedger[${i}] is malformed (needs a question string).`);
			continue;
		}
		entries.push({
			question: raw.question.trim(),
			decision: nonEmptyString(raw.decision) ? raw.decision.trim() : null,
			open: raw.open === true || !nonEmptyString(raw.decision),
		});
	}
	return entries;
}

/**
 * Validate a raw brief object. Returns the typed Brief, or the full list of
 * open questions that block dispatch. Never throws.
 */
export function validateBrief(raw: unknown): BriefValidation {
	const questions: string[] = [];
	if (!isRecord(raw)) {
		return {
			ok: false,
			openQuestions: [
				"brief is missing entirely: the workflow starts at 'shape is done' and needs { ticket, title, summary, acceptanceCriteria, decisionLedger, killSwitch, breakSignal }.",
			],
		};
	}

	if (!nonEmptyString(raw.ticket)) questions.push("brief.ticket is missing (lindy ticket id).");
	if (!nonEmptyString(raw.title)) questions.push("brief.title is missing.");
	if (!nonEmptyString(raw.summary)) questions.push("brief.summary is missing.");

	const ac = raw.acceptanceCriteria;
	if (!Array.isArray(ac) || ac.length === 0 || !ac.every(nonEmptyString)) {
		questions.push("brief.acceptanceCriteria must be a non-empty array of concrete, checkable criteria.");
	}

	const ledger = parseDecisionLedger(raw.decisionLedger, questions);
	const openEntries = ledger.filter((entry) => entry.open);
	for (const entry of openEntries) {
		questions.push(`open decision: "${entry.question}" has no recorded decision.`);
	}

	const killSwitch = parseKillSwitch(raw.killSwitch, questions);

	if (!nonEmptyString(raw.breakSignal)) {
		questions.push(
			"brief.breakSignal is missing: name the fallout signal to watch (Sentry project / #on-call-issues query / metric). Mandatory even when killSwitch is none.",
		);
	}

	if (questions.length > 0) return { ok: false, openQuestions: questions };

	const brief: Brief = {
		ticket: (raw.ticket as string).trim(),
		title: (raw.title as string).trim(),
		summary: (raw.summary as string).trim(),
		acceptanceCriteria: (ac as string[]).map((s) => s.trim()),
		decisionLedger: ledger,
		killSwitch: killSwitch as KillSwitch,
		breakSignal: (raw.breakSignal as string).trim(),
	};
	if (nonEmptyString(raw.blastRadius)) brief.blastRadius = raw.blastRadius.trim();
	if (Array.isArray(raw.suggestedReviewers) && raw.suggestedReviewers.every(nonEmptyString)) {
		brief.suggestedReviewers = raw.suggestedReviewers.map((s) => s.trim());
	}
	return { ok: true, brief };
}
