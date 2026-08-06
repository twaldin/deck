/**
 * Compatibility helper for the stamp surface.
 *
 * The locked pipeline contract makes the captain's stamp available after the
 * profile-resolved approval loop; CI is surfaced but never gates that stamp.
 * The yolo compatibility profile still has no captain decision and therefore
 * waits for terminal CI before its automatic merge.
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
		reasons.push("CI is hard red; the live step-5 watch must keep fixing it while the captain's stamp remains available.");
	}
	const ready = approver !== null;
	return { ready, approvedBy: approver, ci, reasons };
}
