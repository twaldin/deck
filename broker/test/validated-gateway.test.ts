import { afterEach, describe, expect, test } from "bun:test";
import { startValidatedGateway } from "../src/validated-gateway";
import type { FastGatewayOptions } from "../src/fast-gateway";

const gateways: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const gateway of gateways.splice(0)) await gateway.close();
});

async function withFakeUpstream(options: Partial<FastGatewayOptions> = {}, upstreamResponse: Response = Response.json({ ok: true })) {
	const forwarded: Array<{ path: string; body: Record<string, unknown> }> = [];
	const upstreamServer = Bun.serve({
		 hostname: "127.0.0.1",
		 port: 0,
		 fetch: async request => {
			forwarded.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
			return upstreamResponse.clone() as any;
		},
	});
	const upstream = {
		url: `http://127.0.0.1:${upstreamServer.port}`,
		close: async () => upstreamServer.stop(),
	};
	const gateway = startValidatedGateway({ bind: "127.0.0.1:0", ...options } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
	gateways.push(gateway);
	return { gateway, forwarded };
}

describe("validated gateway outbound requests", () => {
	test("forwards OpenAI effort payloads", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai/gpt-5.6-sol", reasoning_effort: "xhigh" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded).toEqual([{ path: "/v1/chat/completions", body: { model: "openai/gpt-5.6-sol", reasoning_effort: "xhigh", reasoning: { effort: "xhigh" } } }]);
	});

	test("forwards xAI effort payloads", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "xai/grok-4.5", reasoning_effort: "high" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "xai/grok-4.5", reasoning_effort: "high" });
	});

	test("converts Anthropic named levels to native token budgets", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", reasoning_effort: "high" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "anthropic/claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 16384 } });
	});

	test("clamps named levels per model before forwarding", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "xai/grok-4.5", reasoning_effort: "medium" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "xai/grok-4.5", reasoning_effort: "medium" });
	});

	test("keeps Deck Claude models on OpenAI-compatible routing", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "deck/claude-sonnet-4-5", reasoning_effort: "high" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "deck/claude-sonnet-4-5", reasoning_effort: "high" });
	});

	test("skips cooling accounts, pins the selected credential, and forwards fallback model", async () => {
		const events: unknown[] = [];
		const pins: unknown[] = [];
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [
				{ credentialId: 1, provider: "anthropic", authProvider: "anthropic", blocked: ["all-model-5h", "all-model-7d"] },
				{ credentialId: 2, provider: "anthropic", authProvider: "anthropic", blocked: ["fable-7d"] },
				{ credentialId: 3, provider: "anthropic", authProvider: "anthropic", blocked: ["fable-7d"] },
			],
			quotaPreferences: () => [{ id: "claude-sonnet-5", provider: "anthropic" }],
			onQuotaEvent: event => events.push(event),
			storage: { pinSessionOAuthAccount: (...args: unknown[]) => { pins.push(args); return true; } } as never,
		});
		const response = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-fable-5", prompt_cache_key: "session-1" }) });
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body.model).toBe("anthropic/claude-sonnet-5");
		expect(pins).toEqual([["anthropic", "session-1", 2]]);
		expect(events).toHaveLength(1);
	});

	test("rewrites the full provider-qualified model on an OpenAI alias fallback", async () => {
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 7, provider: "openai-codex", authProvider: "openai-codex", blocked: ["codex-spark"] }],
			quotaPreferences: () => [{ id: "gpt-5.5", provider: "openai-codex" }],
			storage: { pinSessionOAuthAccount: () => true } as never,
		});
		const response = await fetch(`${gateway.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "openai/gpt-5.6-spark" }) });
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body.model).toBe("openai-codex/gpt-5.5");
	});

	test("converts an upstream 429 to structured 503 with retry conversion", async () => {
		const { gateway, forwarded } = await withFakeUpstream({ quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", blocked: [] }], storage: {} as never }, new Response("upstream limited", { status: 429, headers: { "retry-after": "7" } }));
		const response = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }) });
		const body = await response.json();
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(body).toMatchObject({ error: { code: "NO_QUOTA", type: "quota_exhausted", retry_after_ms: 7000 } });
		expect(forwarded).toHaveLength(1);
	});

	test("returns structured 503 and does not forward when all accounts cool", async () => {
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", blocked: ["all-model-5h", "all-model-7d"] }],
		});
		const response = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }) });
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "NO_QUOTA", type: "quota_exhausted", provider: "anthropic" } });
		expect(forwarded).toEqual([]);
	});

	test("returns 400 and does not forward invalid provider payloads", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "xai/grok-4.5", reasoning_effort: "turbo" }),
		});
		expect(response.status).toBe(400);
		expect(forwarded).toEqual([]);
	});
});
