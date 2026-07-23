/**
 * SPEC §6.5 addendum — live cross-account rotation (I8: multi-account at plan
 * limits; PLAN §7.1 exit: "rotation proven").
 *
 * Preconditions are ESTABLISHED, not assumed: a fresh forced usage roster must
 * show at least one anthropic account with an exhausted 7d fable window AND at
 * least one anthropic account without one. Otherwise the test SKIPS (visible
 * as skip, never as a vacuous pass).
 *
 * Hard contract under test: a fable-5 request through the gateway succeeds
 * even though a pool member cannot serve it — an exhausted account never
 * blocks service (I8's pooling outcome).
 *
 * Evidence classification (before/after cooling blocks via control `status`):
 * - block newly recorded (or extended) on an exhausted account this run
 *   ⇒ the 429→markUsageLimitReached→rotate path executed;
 * - block pre-existing ⇒ cooling exclusion honored;
 * - no block ⇒ ranking routed around the hot account (429 path not exercised
 *   this run — still a pass for the pooling contract, logged as such).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { controlRequest, gatewayPost } from "./harness";

const blockShape = z.looseObject({ providerKey: z.string(), blockScope: z.string(), blockedUntilMs: z.number() });
const statusShape = z.looseObject({
	accounts: z.array(
		z.looseObject({
			id: z.number(),
			provider: z.string(),
			email: z.string().nullable(),
			accountId: z.string().nullable(),
			blocks: z.array(blockShape),
		}),
	),
});
const rosterShape = z.looseObject({
	reports: z.array(
		z.looseObject({
			provider: z.string(),
			metadata: z.looseObject({ accountId: z.string().optional(), email: z.string().optional() }).optional(),
			limits: z.array(
				z.looseObject({
					id: z.string(),
					amount: z.looseObject({ used: z.number().optional(), limit: z.number().optional() }),
				}),
			),
		}),
	),
});

type Status = z.infer<typeof statusShape>;

function anthropicAccounts(status: Status) {
	return status.accounts.filter(account => account.provider === "anthropic");
}

// ── Establish preconditions (top-level: drives skipIf) ──────────────────────
const preStatus = statusShape.parse(await controlRequest("status"));
const preRoster = rosterShape.parse(await controlRequest("usage", { force: true }));

/** accountIds whose 7d fable window is exhausted per the FRESH roster. */
const exhaustedAccountIds = new Set<string>();
const anthropicReportAccountIds = new Set<string>();
for (const report of preRoster.reports) {
	if (report.provider !== "anthropic") continue;
	const accountId = report.metadata?.accountId;
	if (!accountId) continue;
	anthropicReportAccountIds.add(accountId);
	const fable = report.limits.find(limit => limit.id.endsWith(":fable"));
	if (fable && fable.amount.used !== undefined && fable.amount.limit !== undefined && fable.amount.used >= fable.amount.limit) {
		exhaustedAccountIds.add(accountId);
	}
}
const pool = anthropicAccounts(preStatus);
const exhausted = pool.filter(account => account.accountId !== null && exhaustedAccountIds.has(account.accountId));
const healthy = pool.filter(
	account => account.accountId !== null && anthropicReportAccountIds.has(account.accountId) && !exhaustedAccountIds.has(account.accountId),
);
const runnable = pool.length >= 2 && exhausted.length >= 1 && healthy.length >= 1;
if (!runnable) {
	console.warn(
		`[rotation] SKIP: pool=${pool.length} exhausted=${exhausted.length} healthy=${healthy.length} — need >=2 anthropic creds with >=1 fable-exhausted and >=1 healthy`,
	);
}

describe("SPEC 6.5 rotation (I8)", () => {
	test.skipIf(!runnable)("fable-5 succeeds while a pool account is fable-exhausted", async () => {
		// Defensive re-assert of the established preconditions.
		expect(exhausted.length).toBeGreaterThanOrEqual(1);
		expect(healthy.length).toBeGreaterThanOrEqual(1);

		const preBlocks = new Map<string, number>();
		for (const account of pool) {
			for (const block of account.blocks) {
				preBlocks.set(`${account.id}|${block.providerKey}|${block.blockScope}`, block.blockedUntilMs);
			}
		}

		const response = await gatewayPost("/v1/messages", {
			model: "claude-fable-5",
			max_tokens: 2048,
			thinking: { type: "enabled", budget_tokens: 1024 },
			messages: [{ role: "user", content: "Is 91 prime? Answer yes or no." }],
		});
		const bodyText = await response.text();
		// The pooling contract: an exhausted member never blocks service.
		expect(response.status).toBe(200);
		const body = z.looseObject({ content: z.array(z.looseObject({ type: z.string() })) }).parse(JSON.parse(bodyText));
		expect(body.content.some(block => block.type === "text")).toBe(true);

		// Evidence classification — only claim 429→rotate on a NEW/extended block.
		const afterStatus = statusShape.parse(await controlRequest("status"));
		const exhaustedIds = new Set(exhausted.map(account => account.id));
		let newBlockEvidence = "";
		let preexistingBlockEvidence = "";
		for (const account of anthropicAccounts(afterStatus)) {
			if (!exhaustedIds.has(account.id)) continue;
			for (const block of account.blocks) {
				const key = `${account.id}|${block.providerKey}|${block.blockScope}`;
				const before = preBlocks.get(key);
				const label = `${account.email}#${account.id}(${block.blockScope || block.providerKey})`;
				if (before === undefined || block.blockedUntilMs > before) newBlockEvidence = label;
				else preexistingBlockEvidence = label;
			}
		}
		if (newBlockEvidence) {
			console.warn(`[rotation] 429→rotate exercised THIS RUN: new/extended cooling block on ${newBlockEvidence}`);
		} else if (preexistingBlockEvidence) {
			console.warn(`[rotation] cooling exclusion honored (pre-existing block on ${preexistingBlockEvidence}); 429 path not re-exercised`);
		} else {
			console.warn("[rotation] ranking routed around the exhausted account; 429 path not exercised this run");
		}
	}, 120_000);
});
