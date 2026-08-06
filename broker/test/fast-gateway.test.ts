import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModelIndex, DEFAULT_ALLOWLIST } from "../src/models";
import { startFastGateway } from "../src/fast-gateway";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) await resource.close();
});

describe("fast gateway proxy", () => {
	test("rewrites :fast requests and forwards the body", async () => {
		let received: Record<string, unknown> | undefined;
		const upstreamServer = Bun.serve({
			port: 0,
			async fetch(request) {
				received = (await request.json()) as Record<string, unknown>;
				return Response.json({ ok: true });
			},
		});
		const upstream = {
			url: `http://${upstreamServer.hostname}:${upstreamServer.port}`,
			async close() {
				upstreamServer.stop(true);
			},
		};
		resources.push(upstream);
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const gateway = startFastGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: index.resolve,
			listModels: () => [],
			storage: {} as AuthStorage,
			upstream,
		});
		resources.push(gateway);

		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai-codex/gpt-5.6-luna:fast", messages: [] }),
		});

		expect(response.status).toBe(200);
		expect(received).toMatchObject({ model: "gpt-5.6-luna", service_tier: "priority" });
	});

	test("forwards bodies for unmatched POST routes", async () => {
		let received = "";
		const upstreamServer = Bun.serve({
			port: 0,
			async fetch(request) {
				received = await request.text();
				return new Response("ok");
			},
		});
		const upstream = {
			url: `http://${upstreamServer.hostname}:${upstreamServer.port}`,
			async close() {
				upstreamServer.stop(true);
			},
		};
		resources.push(upstream);
		const gateway = startFastGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: () => undefined,
			listModels: () => [],
			storage: {} as AuthStorage,
			upstream,
		});
		resources.push(gateway);

		await fetch(`${gateway.url}/v1/pi/stream`, { method: "POST", body: "stream-body" });
		expect(received).toBe("stream-body");
	});
});
