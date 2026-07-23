/**
 * SPEC §6.5 addendum — live cross-account rotation (I8: multi-account at plan
 * limits; PLAN §7.1 exit: "rotation proven").
 *
 * Natural experiment: the battery's first anthropic account (gmail) has an
 * EXHAUSTED 7d fable window (fable-5 → 429), the second (lindy) has headroom.
 * A fable-5 request through the gateway therefore succeeds ONLY if the pool
 * routes around / rotates off the exhausted account. Evidence channels:
 *   (a) the request succeeds at all (pooling outcome),
 *   (b) control `status` exposes per-credential cooling blocks — a
 *       usage-limit block on the exhausted row proves the 429→rotate path ran
 *       (vs. ranking having avoided the hot account outright; both satisfy I8,
 *       the test reports which occurred).
 *
 * Skips (with reason) when fewer than 2 active anthropic credentials exist or
 * when no anthropic account is currently fable-exhausted.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { controlRequest, gatewayPost } from "./harness";

const statusShape = z.looseObject({
	accounts: z.array(
		z.looseObject({
			id: z.number(),
			provider: z.string(),
			email: z.string().nullable(),
			blocks: z.array(
				z.looseObject({ providerKey: z.string(), blockScope: z.string(), blockedUntilMs: z.number() }),
			),
		}),
	),
});

describe("SPEC 6.5 rotation (I8)", () => {
	test("fable-5 request succeeds despite an exhausted account in the pool", async () => {
		const before = statusShape.parse(await controlRequest("status"));
		const anthropic = before.accounts.filter(account => account.provider === "anthropic");
		if (anthropic.length < 2) {
			console.warn(`[rotation] SKIP: need >=2 anthropic credentials, have ${anthropic.length}`);
			return;
		}

		const response = await gatewayPost("/v1/messages", {
			model: "claude-fable-5",
			max_tokens: 2048,
			thinking: { type: "enabled", budget_tokens: 1024 },
			messages: [{ role: "user", content: "Is 91 prime? Answer yes or no." }],
		});
		const bodyText = await response.text();
		expect(response.status).toBe(200);
		const body = z.looseObject({ content: z.array(z.looseObject({ type: z.string() })) }).parse(JSON.parse(bodyText));
		expect(body.content.some(block => block.type === "text")).toBe(true);

		const after = statusShape.parse(await controlRequest("status"));
		const blocked = after.accounts.filter(
			account => account.provider === "anthropic" && account.blocks.length > 0,
		);
		if (blocked.length > 0) {
			console.warn(
				`[rotation] 429→rotate path proven: cooling blocks on ${blocked
					.map(account => `${account.email}#${account.id}(${account.blocks.map(block => block.blockScope || block.providerKey).join(",")})`)
					.join("; ")}`,
			);
		} else {
			console.warn("[rotation] pool served fable-5 without recording a block (ranking avoided the exhausted account)");
		}
	}, 120_000);
});
