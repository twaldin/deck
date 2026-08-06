import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModelIndex, DEFAULT_ALLOWLIST } from "../src/models";
import { startFastGateway } from "../src/fast-gateway";
import { startValidatedGateway } from "../src/validated-gateway";

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
		expect(received).toMatchObject({ model: "openai-codex/gpt-5.6-luna", service_tier: "priority" });
	});

	test("preserves priority through validated routing and account rotation", async () => {
		const received: Record<string, unknown>[] = [];
		const upstreamServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				received.push(await request.json() as Record<string, unknown>);
				return Response.json({
					id: `rotation-${received.length}`,
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 1 },
				});
			},
		});
		const upstream = {
			url: `http://127.0.0.1:${upstreamServer.port}`,
			async close() {
				upstreamServer.stop(true);
			},
		};
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const pins: number[] = [];
		let rotated = false;
		const gateway = startValidatedGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: index.resolve,
			listModels: index.list,
			quotaAccounts: () => rotated
				? [
					{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 10 },
					{ credentialId: 2, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 0 },
				]
				: [
					{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 0 },
					{ credentialId: 2, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 10 },
				],
			quotaPreferences: () => [],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					pins.push(credentialId);
					return true;
				},
			} as AuthStorage,
			upstream,
		});
		resources.push(gateway);

		for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-sol:fast",
					prompt_cache_key: "fast-rotation-session",
					messages: [{ role: "user", content: `turn ${requestIndex + 1}` }],
				}),
			});
			expect(response.status).toBe(200);
			await response.json();
			rotated = true;
		}

		expect(pins).toEqual([1, 2]);
		expect(received).toHaveLength(2);
		expect(received[0]).toMatchObject({ model: "openai-codex/gpt-5.6-sol", service_tier: "priority" });
		expect(received[1]).toMatchObject({ model: "openai-codex/gpt-5.6-sol", service_tier: "priority" });
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
