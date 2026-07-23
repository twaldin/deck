import { z } from "zod";
import {
	charterSchema,
	eventSchema,
	idemSchema,
	inboxCommandSchema,
	manifestSchema,
	sessionRefSchema,
} from "../schemas";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "id must be a ULID");
const jsonObjectSchema = z.record(z.string(), z.json());

export const eventInputSchema = eventSchema
	.omit({ id: true, ts: true, data: true })
	.extend({
		id: ulidSchema.optional(),
		ts: z.iso.datetime().optional(),
		data: jsonObjectSchema,
	});
export type EventInput = z.infer<typeof eventInputSchema>;

export const charterDraftSchema = charterSchema.omit({ created: true, charter_changes: true });
export type CharterDraft = z.infer<typeof charterDraftSchema>;

export const createEffortInputSchema = z.object({
	effort_id: z.string().min(1),
	project: z.string().min(1),
	title: z.string().min(1),
	charter: charterDraftSchema,
});
export type CreateEffortInput = z.infer<typeof createEffortInputSchema>;

export const mutationResultSchema = z.object({
	manifest: manifestSchema,
	event: eventInputSchema,
});
export type MutationResult = z.infer<typeof mutationResultSchema>;

export const leaseSessionInputSchema = sessionRefSchema.omit({ lease_epoch: true });
export type LeaseSessionInput = z.infer<typeof leaseSessionInputSchema>;

export const inboxCommandInputSchema = inboxCommandSchema
	.omit({ cmd_id: true, ts: true, delivered: true, acked: true, cmd: true })
	.extend({
		cmd_id: z.string().min(1).optional(),
		ts: z.number().optional(),
		cmd: jsonObjectSchema,
	});
export type InboxCommandInput = z.infer<typeof inboxCommandInputSchema>;

export const inboxReceiptSchema = z.object({
	cmd_id: z.string().min(1),
	receipt: z.enum(["delivered", "acked"]),
	ts: z.number(),
});
export type InboxReceipt = z.infer<typeof inboxReceiptSchema>;

export const inboxRecordSchema = z.union([inboxCommandSchema, inboxReceiptSchema]);
export type InboxRecord = z.infer<typeof inboxRecordSchema>;

export const seenRecordSchema = idemSchema.extend({ seen_at: z.number() });
export type SeenRecord = z.infer<typeof seenRecordSchema>;

export const cursorValueSchema = z.json();
export type CursorValue = z.infer<typeof cursorValueSchema>;

export const cursorsSchema = z.record(z.string(), cursorValueSchema);
export type Cursors = z.infer<typeof cursorsSchema>;

export const lockMetadataSchema = z.object({
	pid: z.number().int().positive(),
	acquired: z.number(),
	nonce: z.string().min(1),
});
