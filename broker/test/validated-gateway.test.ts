import { afterEach, describe, expect, test } from "bun:test";
import { startValidatedGateway } from "../src/validated-gateway";

const gateways: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const gateway of gateways.splice(0)) await gateway.close();
});

async function withFakeUpstream() {
	const forwarded: Array<{ path: string; body: Record<string, unknown> }> = [];
	const upstreamServer = Bun.serve({
		 hostname: "127.0.0.1",
		 port: 0,
		 fetch: async request => {
			forwarded.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
			return Response.json({ ok: true });
		},
	});
	const upstream = {
		url: `http://127.0.0.1:${upstreamServer.port}`,
		close: async () => upstreamServer.stop(),
	};
	const gateway = startValidatedGateway({ bind: "127.0.0.1:0" } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
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
		expect(forwarded).toEqual([{ path: "/v1/chat/completions", body: { model: "openai/gpt-5.6-sol", reasoning_effort: "xhigh" } }]);
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

	test("forwards Anthropic thinking payloads", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 32768 } }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "anthropic/claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 32768 } });
	});

	test("returns 400 and does not forward invalid provider payloads", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "xai/grok-4.5", reasoning_effort: "xhigh" }),
		});
		expect(response.status).toBe(400);
		expect(forwarded).toEqual([]);
	});
});
