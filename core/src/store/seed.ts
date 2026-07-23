import { z } from "zod";
import { DeckError } from "../errors";
import { eventSchema, type DeckEvent } from "../schemas";
import { openEffort } from "./effort-store";

const seedOptionsSchema = z.object({
	triggeringEvent: eventSchema.optional(),
	tokenBudget: z.number().int().positive(),
});
const dispatchResultDataSchema = z.object({ dispatch_id: z.string() }).loose();
// "Last decisions" is bounded so mandatory ledger context cannot consume an unbounded seed.
const MAX_TIM_DECISIONS = 10;

export interface SeedOptions {
	triggeringEvent?: DeckEvent;
	tokenBudget: number;
}

export interface SeedResult {
	text: string;
	includedEventIds: string[];
	budgetUsed: number;
}

/**
 * SPEC §4.6/D-G seed composition. Token use is conservatively estimated as
 * ceil(UTF-16 characters / 4); this is a budget heuristic, not model tokenization.
 */
export function buildSeed(effortId: string, options: SeedOptions): SeedResult {
	const parsedOptions = seedOptionsSchema.parse(options);
	const store = openEffort(effortId);
	const manifest = store.readManifest();
	const charter = store.readCharter();
	const tailNewest = store.readTail();
	const writer = new SeedWriter(parsedOptions.tokenBudget);

	const charterText = JSON.stringify(charter);
	writer.require("charter", charterText, JSON.stringify({
		truncated: true,
		goal: charter.goal.slice(0, 1_600),
		acceptance_criteria: charter.acceptance_criteria.slice(0, 8).map((criterion) => criterion.slice(0, 300)),
		constraints: charter.constraints.slice(0, 8).map((constraint) => constraint.slice(0, 200)),
	}));
	const openCards = manifest.cards.filter((entry) => entry.status === "open");
	writer.require("open_cards", JSON.stringify(openCards), JSON.stringify({
		truncated: true,
		total: openCards.length,
		cards: openCards.slice(0, 20).map((entry) => ({
			id: entry.id,
			kind: entry.card.kind,
			question: entry.card.question.slice(0, 200),
		})),
	}));

	const activeDispatches = manifest.dispatches.filter((dispatch) =>
		dispatch.state === "pending" || dispatch.state === "running");
	if (activeDispatches.length === 0) {
		writer.require("active_dispatches", "[]");
	} else {
		for (const dispatch of activeDispatches) {
			const serialized = JSON.stringify(dispatch);
			writer.require("active_dispatches", serialized, JSON.stringify({
				id: dispatch.id,
				kind: dispatch.kind,
				target: dispatch.target,
				state: dispatch.state,
				result_ref: dispatch.result_ref,
				truncated: true,
			}));
			const resultEvent = findLatestDispatchResult(dispatch.id, dispatch.result_ref, tailNewest);
			if (dispatch.result_ref !== null && resultEvent === undefined) {
				writer.require("active_dispatches", JSON.stringify({
					dispatch_id: dispatch.id,
					result_ref: dispatch.result_ref,
					missing: true,
				}));
			}
			if (resultEvent !== undefined) {
				writer.requireEvent("active_dispatches", resultEvent);
			}
		}
	}

	if (parsedOptions.triggeringEvent !== undefined) {
		writer.requireEvent("triggering_event", parsedOptions.triggeringEvent);
	}
	if (manifest.digest !== null) {
		writer.require("digest", manifest.digest, JSON.stringify({
			truncated: true,
			head: manifest.digest.slice(0, 400),
		}));
	}

	const decisions = tailNewest
		.filter((event) => event.type === "tim.decision")
		.slice(0, MAX_TIM_DECISIONS);
	if (decisions.length === 0) {
		writer.require("tim_decisions", "[]");
	} else {
		for (const event of decisions) {
			writer.requireEvent("tim_decisions", event);
		}
	}

	for (const event of tailNewest) {
		if (!writer.hasEvent(event)) {
			writer.appendEvent("recent_tail_newest_first", event);
		}
	}
	return writer.result();
}

class SeedWriter {
	private readonly maxChars: number;
	private readonly parts: string[] = [];
	private readonly sections = new Set<string>();
	private readonly eventIds = new Set<string>();
	private readonly idemKeys = new Set<string>();
	private usedChars = 0;

	constructor(tokenBudget: number) {
		this.maxChars = tokenBudget * 4;
	}

	append(section: string, payload: string, fallback?: string): boolean {
		const prefix = this.sections.has(section)
			? "\n"
			: `${this.parts.length === 0 ? "" : "\n\n"}[${section}]\n`;
		let selected = payload;
		if (this.usedChars + prefix.length + selected.length > this.maxChars) {
			if (fallback === undefined || this.usedChars + prefix.length + fallback.length > this.maxChars) {
				return false;
			}
			selected = fallback;
		}
		this.parts.push(`${prefix}${selected}`);
		this.sections.add(section);
		this.usedChars += prefix.length + selected.length;
		return true;
	}

	require(section: string, payload: string, fallback?: string): void {
		if (!this.append(section, payload, fallback)) {
			throw new DeckError("E_ARG", `tokenBudget is too small for mandatory ${section} seed content`, {
				section,
				required_chars: fallback?.length ?? payload.length,
			});
		}
	}

	appendEvent(section: string, event: DeckEvent): boolean {
		if (this.eventIds.has(event.id)) {
			return this.append(section, JSON.stringify({ event_id: event.id, included_above: true }));
		}
		const serialized = JSON.stringify(event);
		const summary = JSON.stringify({
			id: event.id,
			type: event.type,
			ts: event.ts,
			truncated: true,
			head: serialized.slice(0, 400),
		});
		const appended = this.append(section, serialized, summary);
		if (appended) {
			this.eventIds.add(event.id);
			if (event.idem !== undefined) {
				this.idemKeys.add(JSON.stringify([event.idem.source, event.idem.external_id, event.idem.version]));
			}
		}
		return appended;
	}

	requireEvent(section: string, event: DeckEvent): void {
		if (!this.appendEvent(section, event)) {
			throw new DeckError("E_ARG", `tokenBudget is too small for mandatory ${section} event`, {
				section,
				event_id: event.id,
			});
		}
	}

	hasEvent(event: DeckEvent): boolean {
		if (this.eventIds.has(event.id)) {
			return true;
		}
		if (event.idem === undefined) {
			return false;
		}
		return this.idemKeys.has(JSON.stringify([event.idem.source, event.idem.external_id, event.idem.version]));
	}

	result(): SeedResult {
		const text = this.parts.join("");
		return {
			text,
			includedEventIds: [...this.eventIds],
			budgetUsed: Math.ceil(text.length / 4),
		};
	}
}

function findLatestDispatchResult(
	dispatchId: string,
	resultRef: string | null,
	tailNewest: DeckEvent[],
): DeckEvent | undefined {
	if (resultRef !== null) {
		const referencedId = resultRef.startsWith("tail:") ? resultRef.slice("tail:".length) : resultRef;
		return tailNewest.find((event) => event.id === referencedId);
	}
	return tailNewest.find((event) => {
		const data = dispatchResultDataSchema.safeParse(event.data);
		return event.type.includes("result")
			&& data.success
			&& data.data.dispatch_id === dispatchId;
	});
}

