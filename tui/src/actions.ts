import { DeckError, openEffort, type InboxCommand, type Manifest } from "@deck/core";

export interface CardAnswerResult {
	manifest: Manifest;
	command: InboxCommand;
}

export function answerCard(effortId: string, cardId: string, answer: string, expectedRevision: number): CardAnswerResult {
	const trimmedAnswer = answer.trim();
	if (trimmedAnswer.length === 0) throw new DeckError("E_ARG", "card answer must be non-empty");
	const store = openEffort(effortId);
	const manifest = store.mutate(expectedRevision, null, draft => {
		const entry = draft.cards.find(candidate => candidate.id === cardId);
		if (entry === undefined) throw new DeckError("E_STATE", "card no longer exists", { card_id: cardId });
		if (entry.status !== "open") throw new DeckError("E_STATE", "card is already answered", { card_id: cardId });
		const answeredAt = Date.now();
		entry.status = "answered";
		entry.answer = trimmedAnswer;
		entry.answered_ts = answeredAt;
		draft.decisions.push({ ts: answeredAt, card_id: cardId, answer: trimmedAnswer });
		draft.overlays.needs_tim = draft.overlays.needs_tim.filter(candidate => candidate !== cardId);
		return {
			manifest: draft,
			event: {
				plane: "tim",
				type: "tim.decision",
				actor: "tim",
				data: { card_id: cardId, answer: trimmedAnswer },
			},
		};
	});
	const command = store.inboxAppend({
		cmd: { kind: "card_answer", card_id: cardId, answer: trimmedAnswer },
		from: "tim",
	});
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
