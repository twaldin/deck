import { createEffort } from "@deck/core";
import { answerCard } from "../../src/actions";

const store = createEffort({
	effort_id: "test--card-answer",
	project: "test",
	title: "Card answer",
	charter: {
		goal: "Deliver a card answer durably.",
		acceptance_criteria: ["Manifest and inbox agree"],
		constraints: [],
	},
});
const withCard = store.mutate(0, null, manifest => {
	manifest.cards.push({
		id: "card-1",
		card: {
			kind: "decision",
			question: "Proceed?",
			recommendation: "Proceed.",
			options: ["yes", "no"],
		},
		status: "open",
		answer: null,
		answered_ts: null,
		cancel_in_flight: null,
	});
	manifest.overlays.needs_tim.push("card-1");
	return {
		manifest,
		event: { plane: "lifecycle", type: "lifecycle.test_card", actor: "test", data: {} },
	};
});
const answer = answerCard(store.effortId, "card-1", "yes", withCard.revision);
const manifest = store.readManifest();
const inbox = store.inboxState();
const tail = store.readTail({ limit: 1 });
process.stdout.write(JSON.stringify({ answer, manifest, inbox, tail }));
