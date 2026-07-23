import {
	DeckError,
	cardSchema,
	openEffort,
	type Card,
	type CardEntry,
} from "@deck/core";
import { z } from "zod";

const deckApprovalInputSchema = z
	.object({
		effortId: z.string().min(1),
		workflowRunId: z.string().min(1).max(200),
		nodeId: z.string().min(1).max(200),
		title: z.string().min(1).max(600),
		summary: z.string().min(1).max(400).optional(),
		recommendation: z.string().min(1).max(400).optional(),
		options: z.array(z.string().min(1).max(120)).min(1).max(5).default(["Approve", "Deny"]),
	})
	.strict();

export type DeckApprovalInput = z.input<typeof deckApprovalInputSchema>;

export interface DeckApprovalMirrorResult {
	cardId: string;
	manifestRevision: number;
	created: boolean;
}

function approvalCardId(runId: string, nodeId: string): string {
	return `smithers:${runId}:${nodeId}`;
}

function sameCard(left: Card, right: Card): boolean {
	return (
		left.kind === right.kind &&
		left.question === right.question &&
		left.recommendation === right.recommendation &&
		left.options.length === right.options.length &&
		left.options.every((option, index) => option === right.options[index])
	);
}

/**
 * Idempotently mirrors a pending Smithers approval into an effort manifest.
 * Resolving the card back into Smithers remains a Gateway integration seam.
 */
export class DeckApproval {
	mirror(input: DeckApprovalInput): DeckApprovalMirrorResult {
		const parsed = deckApprovalInputSchema.parse(input);
		const store = openEffort(parsed.effortId);
		const cardId = approvalCardId(parsed.workflowRunId, parsed.nodeId);
		const card = cardSchema.parse({
			kind: "decision",
			question: parsed.title,
			recommendation:
				parsed.recommendation ?? parsed.summary ?? "Approve this Smithers workflow step if its evidence is sound.",
			options: parsed.options,
		});

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const manifest = store.readManifest();
			const existing = manifest.cards.find((entry) => entry.id === cardId);
			if (existing !== undefined) {
				if (!sameCard(existing.card, card)) {
					throw new DeckError("E_STATE", `approval card id collision: ${cardId}`);
				}
				return { cardId, manifestRevision: manifest.revision, created: false };
			}

			const entry: CardEntry = {
				id: cardId,
				card,
				status: "open",
				answer: null,
				answered_ts: null,
				cancel_in_flight: null,
			};
			try {
				const updated = store.mutate(manifest.revision, null, (current) => ({
					manifest: {
						...current,
						overlays: {
							...current.overlays,
							needs_tim: [...current.overlays.needs_tim, cardId],
						},
						cards: [...current.cards, entry],
					},
					event: {
						plane: "lifecycle",
						type: "lifecycle.workflow_approval_requested",
						actor: `wf:${parsed.workflowRunId}`,
						data: {
							effort_id: parsed.effortId,
							workflow_run_id: parsed.workflowRunId,
							node_id: parsed.nodeId,
							card_id: cardId,
						},
					},
				}));
				return { cardId, manifestRevision: updated.revision, created: true };
			} catch (error) {
				if (!(error instanceof DeckError) || error.code !== "E_CAS") {
					throw error;
				}
			}
		}

		throw new DeckError("E_CAS", `could not mirror approval card after concurrent updates: ${cardId}`);
	}
}
