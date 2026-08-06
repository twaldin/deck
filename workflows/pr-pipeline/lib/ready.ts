/**
 * Ready-for-stamp (SOP stage 6): real human approval + CI
 * green-or-WILL-BE-green.
 *
 * The explicit approval gate does not wait on CI green. Flake reruns and
 * trivial CI fixes are agent work inside the watch loop; only real decisions
 * block on the operator. Hard red still blocks (it is watch-loop work).
 */

import type { CiState, ReadyVerdict, ReviewApproval } from "./types.ts";

export interface ReadyOptions {
	/** The PR author (self approvals never count). */
	author: string;
	/** Logins whose approvals do not count (for example the operator or bots). */
	excludedApprovers: string[];
	/**
	 * yolo profile (e.g. deck): ready needs CI actually green (or no checks),
	 * and needs NO human approval. "will-be-green" is NOT ready: yolo merge
	 * fires on green, so the poll loop waits for checks to finish.
	 */
	yolo?: boolean;
}

/**
 * A real human approval: latest review state per non-bot, non-author,
 * non-excluded login is APPROVED.
 */
export function findHumanApproval(approvals: ReviewApproval[], options: ReadyOptions): string | null {
	const excluded = new Set(options.excludedApprovers.map((login) => login.toLowerCase()));
	excluded.add(options.author.toLowerCase());

	const latestByLogin = new Map<string, ReviewApproval>();
	for (const review of approvals) {
		const login = review.login.toLowerCase();
		const prior = latestByLogin.get(login);
		if (prior === undefined || review.submittedAt > prior.submittedAt) {
			latestByLogin.set(login, review);
		}
	}
	for (const review of latestByLogin.values()) {
		if (review.isBot) continue;
		if (excluded.has(review.login.toLowerCase())) continue;
		if (review.state === "APPROVED") return review.login;
	}
	return null;
}

export function evaluateReadyForStamp(
	approvals: ReviewApproval[],
	ci: CiState,
	options: ReadyOptions,
): ReadyVerdict {
	const reasons: string[] = [];
	const approver = findHumanApproval(approvals, options);
	if (options.yolo === true) {
		const ciOk = ci === "green" || ci === "none";
		if (!ciOk) reasons.push(`yolo merge fires on green; CI is ${ci}.`);
		return { ready: ciOk, approvedBy: approver, ci, reasons };
	}
	if (approver === null) {
		reasons.push("no real human approval yet (bot/agent reviews and excluded logins never count).");
	}
	if (ci === "red") {
		reasons.push("CI is hard red - that is watch-loop work, not stamp-ready.");
	}
	// "none" (no checks configured) and "will-be-green" both pass per ruling.
	const ready = approver !== null && ci !== "red";
	return { ready, approvedBy: approver, ci, reasons };
}
