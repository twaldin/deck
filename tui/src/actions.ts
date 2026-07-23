import { DeckError, openEffort, type InboxCommand, type Manifest } from "@deck/core";

export interface CardAnswerResult {
	manifest: Manifest;
	command: InboxCommand;
}

/**
 * Delegates to the store's composite (inbox-first write order, D-A): a crash
 * can leave a deliverable command with the card still open (benign, idempotent
 * re-answer completes it) but can never drop the decision. expectedRevision is
 * kept for UI staleness UX: reject up front if the board rendered stale state.
 */
export function answerCard(effortId: string, cardId: string, answer: string, expectedRevision: number): CardAnswerResult {
	const trimmedAnswer = answer.trim();
	if (trimmedAnswer.length === 0) throw new DeckError("E_ARG", "card answer must be non-empty");
	const store = openEffort(effortId);
	const current = store.readManifest();
	if (current.revision !== expectedRevision) {
		throw new DeckError("E_CAS", "board state is stale; refresh before answering", {
			expected: expectedRevision,
			actual: current.revision,
		});
	}
	const manifest = store.answerCard(cardId, trimmedAnswer);
	const command = store.inboxState().find(entry => entry.cmd_id === `card-answer:${cardId}`);
	if (command === undefined) throw new DeckError("E_IO", "card answer command missing after composite write");
	return { manifest, command };
}

export function sendOwnerMessage(effortId: string, message: string): InboxCommand {
	const trimmedMessage = message.trim();
	if (trimmedMessage.length === 0) throw new DeckError("E_ARG", "owner message must be non-empty");
	return openEffort(effortId).inboxAppend({
		cmd: { type: "tim.message", body: trimmedMessage },
		from: "tim",
	});
}
