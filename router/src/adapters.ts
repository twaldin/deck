import { eventSchema, type DeckEvent } from "@deck/core";
import { z } from "zod";
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const watchTargetSchema = z.object({
	source: z.string().min(1),
	kind: z.string().min(1),
	reference: z.string().min(1),
	effortIds: z.array(z.string().min(1)).min(1),
});
export type WatchTarget = z.infer<typeof watchTargetSchema>;

export const adapterFactSchema = eventSchema
	.omit({ id: true, ts: true })
	.extend({
		plane: z.literal("fact"),
		data: z.record(z.string(), z.json()),
		idem: eventSchema.shape.idem.unwrap(),
	});
export type AdapterFact = z.infer<typeof adapterFactSchema>;

export interface AdapterPollResult {
	facts: AdapterFact[];
	cursor: JsonValue;
}

/** A target-bound adapter never self-schedules; the router owns every invocation (SPEC §5.2). */
export interface TargetPollAdapter {
	readonly source: string;
	readonly target: WatchTarget;
	pollCmd(cursor: JsonValue | undefined, signal?: AbortSignal): Promise<AdapterPollResult>;
}

export interface SourceAdapter {
	readonly source: string;
	supports(target: WatchTarget): boolean;
	bind(target: WatchTarget): TargetPollAdapter;
}
