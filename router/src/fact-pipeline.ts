import {
	DeckError,
	SeenRing,
	openEffort,
	readCursors,
	ulid,
	writeCursor,
	type DeckEvent,
	type EffortStore,
	type SeenRingOptions,
} from "@deck/core";
import { z } from "zod";
import {
	adapterFactSchema,
	watchTargetSchema,
	type AdapterPollResult,
	type JsonValue,
	type WatchTarget,
} from "./adapters";
import { classifyFact } from "./classifier";
import type { WakeCoalescer } from "./coalescer";

export interface SeenRingContract {
	has(idem: z.infer<typeof adapterFactSchema>["idem"]): boolean;
	add(idem: z.infer<typeof adapterFactSchema>["idem"]): void;
	flush(): void;
}

export interface FactPipelineOptions {
	coalescer: WakeCoalescer;
	ringFactory?: (source: string, options?: SeenRingOptions) => SeenRingContract;
	cursorWriter?: typeof writeCursor;
	cursorReader?: typeof readCursors;
	effortOpener?: typeof openEffort;
}

interface AppendedFact {
	store: EffortStore;
	event: DeckEvent;
	fact: z.infer<typeof adapterFactSchema>;
}

export interface PipelineResult {
	appended: number;
	duplicates: number;
	wakesQueued: number;
}

export class FactPipeline {
	private readonly coalescer: WakeCoalescer;
	private readonly ringFactory: NonNullable<FactPipelineOptions["ringFactory"]>;
	private readonly cursorWriter: NonNullable<FactPipelineOptions["cursorWriter"]>;
	private readonly cursorReader: NonNullable<FactPipelineOptions["cursorReader"]>;
	private readonly effortOpener: NonNullable<FactPipelineOptions["effortOpener"]>;
	private readonly rings = new Map<string, SeenRingContract>();

	constructor(options: FactPipelineOptions) {
		this.coalescer = options.coalescer;
		this.ringFactory = options.ringFactory ?? ((source, ringOptions) => new SeenRing(source, ringOptions));
		this.cursorWriter = options.cursorWriter ?? writeCursor;
		this.cursorReader = options.cursorReader ?? readCursors;
		this.effortOpener = options.effortOpener ?? openEffort;
	}

	cursorFor(target: WatchTarget): JsonValue | undefined {
		const cursors = this.cursorReader();
		return cursors[cursorKey(watchTargetSchema.parse(target))];
	}

	/** Tail fsync precedes seen-ring/cursor durability; classification happens only after commit (SPEC §4.2). */
	process(targetInput: WatchTarget, pollResult: AdapterPollResult): PipelineResult {
		const target = watchTargetSchema.parse(targetInput);
		const cursor = z.json().parse(pollResult.cursor);
		const facts = z.array(adapterFactSchema).parse(pollResult.facts);
		const ring = this.ringFor(target.source);
		const appended: AppendedFact[] = [];
		let duplicates = 0;
		for (const fact of facts) {
			if (ring.has(fact.idem)) {
				duplicates += 1;
				continue;
			}
			const stores = target.effortIds.map((effortId) => this.effortOpener(effortId));
			for (const store of stores) {
				const event = store.appendEvent(fact);
				appended.push({ store, event, fact });
			}
			// The ring must not suppress a fact until every watched effort tail has committed.
			ring.add(fact.idem);
		}
		this.cursorWriter(cursorKey(target), cursor);

		let wakesQueued = 0;
		for (const item of appended) {
			const manifest = item.store.readManifest();
			const classification = classifyFact(item.fact, {
				waiting: manifest.stage === "review" || manifest.overlays.blocked !== null,
			});
			if (classification.flagged && classification.flagReason !== null) {
				appendFlaggedDecision(item.store, item.event, classification.flagReason);
			}
			if (classification.wake) {
				this.coalescer.enqueue(item.store.effortId, item.event);
				wakesQueued += 1;
			}
		}
		return { appended: appended.length, duplicates, wakesQueued };
	}

	flush(): void {
		for (const ring of this.rings.values()) {
			ring.flush();
		}
	}

	private ringFor(source: string): SeenRingContract {
		const existing = this.rings.get(source);
		if (existing !== undefined) {
			return existing;
		}
		const ring = this.ringFactory(source);
		this.rings.set(source, ring);
		return ring;
	}
}

export function cursorKey(target: WatchTarget): string {
	return `${target.source}:${target.kind}:${target.reference}`;
}

function appendFlaggedDecision(store: EffortStore, subject: DeckEvent, reason: string): void {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const manifest = store.readManifest();
		const cardId = ulid();
		try {
			store.mutate(manifest.revision, null, (current) => ({
				manifest: {
					...current,
					overlays: {
						...current.overlays,
						needs_tim: [...current.overlays.needs_tim, cardId],
					},
					cards: [...current.cards, {
						id: cardId,
						card: {
							kind: "flagged",
							question: `${reason} Revert or accept?`,
							recommendation: "Revert unless the external change is confirmed intentional.",
							options: ["Revert external change", "Accept external change"],
						},
						status: "open",
						answer: null,
						answered_ts: null,
						cancel_in_flight: null,
					}],
				},
				event: {
					plane: "lifecycle",
					type: "lifecycle.external_regression_flagged",
					actor: "router",
					data: { card_id: cardId, subject_event_id: subject.id, reason },
				},
			}));
			return;
		} catch (error) {
			if (!(error instanceof DeckError && error.code === "E_CAS") || attempt === 4) {
				throw error;
			}
		}
	}
}
