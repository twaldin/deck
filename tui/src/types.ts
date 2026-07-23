import type { Charter, DeckEvent, InboxCommand, Manifest } from "@deck/core";
import { z } from "zod";

const usageScopeSchema = z
	.object({
		provider: z.string().optional(),
		accountId: z.string().optional(),
		windowId: z.string().optional(),
		tier: z.string().optional(),
		modelId: z.string().optional(),
		shared: z.boolean().optional(),
	})
	.catchall(z.unknown());

const usageWindowSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		durationMs: z.number().nonnegative().optional(),
		resetsAt: z.number().nullable().optional(),
	})
	.catchall(z.unknown());

const usageAmountSchema = z
	.object({
		used: z.number().optional(),
		limit: z.number().optional(),
		remaining: z.number().optional(),
		usedFraction: z.number().optional(),
		remainingFraction: z.number().optional(),
		unit: z.string(),
	})
	.catchall(z.unknown());

export const usageLimitSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		scope: usageScopeSchema,
		window: usageWindowSchema.optional(),
		amount: usageAmountSchema,
		status: z.string().optional(),
	})
	.catchall(z.unknown());
export type UsageLimit = z.infer<typeof usageLimitSchema>;

const usageMetadataSchema = z
	.object({
		email: z.string().optional(),
		accountId: z.string().optional(),
		orgName: z.string().optional(),
	})
	.catchall(z.unknown());

export const usageReportSchema = z
	.object({
		provider: z.string(),
		fetchedAt: z.number(),
		limits: z.array(usageLimitSchema),
		metadata: usageMetadataSchema.optional(),
	})
	.catchall(z.unknown());
export type UsageReport = z.infer<typeof usageReportSchema>;

export const usageRosterSchema = z.object({
	generatedAt: z.string(),
	reports: z.array(usageReportSchema),
});
export type UsageRoster = z.infer<typeof usageRosterSchema>;

const coolingBlockSchema = z.object({
	providerKey: z.string(),
	blockScope: z.string(),
	blockedUntilMs: z.number(),
});

export const brokerAccountSchema = z.object({
	id: z.number().int(),
	provider: z.string(),
	type: z.string(),
	email: z.string().nullable(),
	accountId: z.string().nullable(),
	orgName: z.string().nullable(),
	expires: z.number().nullable(),
	blocks: z.array(coolingBlockSchema),
});
export type BrokerAccount = z.infer<typeof brokerAccountSchema>;

export const brokerStatusSchema = z.object({
	version: z.string(),
	pid: z.number().int(),
	uptimeMs: z.number().nonnegative(),
	gateway: z.string(),
	accounts: z.array(brokerAccountSchema),
});
export type BrokerStatus = z.infer<typeof brokerStatusSchema>;

export const brokerEnvelopeSchema = z.discriminatedUnion("ok", [
	z.object({ id: z.string(), ok: z.literal(true), data: z.unknown() }),
	z.object({ id: z.string(), ok: z.literal(false), error: z.string() }),
]);

export interface LoadIssue {
	source: string;
	message: string;
}

export interface BoardViewData {
	efforts: Manifest[];
	issues: LoadIssue[];
}

export interface EffortViewData {
	effortId: string;
	manifest: Manifest | null;
	charter: Charter | null;
	events: DeckEvent[];
	inbox: InboxCommand[];
	issues: LoadIssue[];
}

export interface AccountsViewData {
	usage: UsageRoster | null;
	broker: BrokerStatus | null;
	issues: LoadIssue[];
}
