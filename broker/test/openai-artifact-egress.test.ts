import { afterEach, describe, expect, test } from "bun:test";
import { buildModelIndex, DEFAULT_ALLOWLIST } from "../src/models";
import { startValidatedGateway } from "../src/validated-gateway";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) await resource.close();
});

function openAIReasoningSuccess(): string {
	const item = {
		type: "reasoning",
		id: "rs_stable_wire",
		status: "completed",
		encrypted_content: "wire-ciphertext",
		summary: [{ type: "summary_text", text: "wire visible summary" }],
	};
	const response = {
		id: "resp_stable_wire",
		object: "response",
		status: "completed",
		output: [item],
		usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 1 } },
	};
	const events = [
		{ type: "response.created", response },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("OpenAI artifact vendor egress", () => {
	test("demotes encrypted reasoning to visible assistant text before the real Responses transport", async () => {
		const captured: Array<{ path: string; body: unknown }> = [];
		const vendor = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				captured.push({ path: new URL(request.url).pathname, body: await request.json() });
				return Response.json({ error: { type: "invalid_request_error", message: "request captured" } }, { status: 400 });
			},
		});
		resources.push({ close: async () => vendor.stop(true) });

		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const bundled = index.resolve("openai/gpt-5.4");
		if (bundled === undefined) throw new Error("missing OpenAI Responses transport test model");
		const model = { ...bundled, baseUrl: `http://127.0.0.1:${vendor.port}/v1` };
		const gateway = startValidatedGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: id => id.split("/").at(-1) === model.id ? model : undefined,
			listModels: () => [model],
			storage: { getApiKey: async () => "sk-openai-egress-test" } as never,
			quotaAccounts: () => [{ credentialId: 1, provider: "openai", authProvider: "openai", blocked: [] }],
			quotaPreferences: () => [],
		});
		resources.push(gateway);

		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-5.4",
				prompt_cache_key: "account-rotation",
				input: [
					{
						type: "reasoning",
						id: "rs_wrong_account",
						encrypted_content: "opaque-wrong-account",
						summary: [{ type: "summary_text", text: "visible summary" }],
					},
					{ role: "user", content: "continue" },
				],
			}),
		});
		// The fake vendor rejects after capture; the assertion is the actual body
		// produced by pi-ai's OpenAI Responses transport, not the outer rewrite.
		expect(response.status).toBe(502);
		await response.text();
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			path: "/v1/responses",
			body: {
				model: "gpt-5.4",
				input: [
					{ type: "message", role: "assistant" },
					{ role: "user", content: "continue" },
				],
				store: false,
			},
		});
		const vendorBody = JSON.stringify(captured[0]?.body);
		expect(vendorBody).toContain("visible summary");
		expect(vendorBody).not.toContain('\"encrypted_content\":');
		expect(vendorBody).not.toContain("opaque-wrong-account");
		expect(vendorBody).not.toContain("rs_wrong_account");
		expect(vendorBody).not.toContain('"type":"reasoning"');
	}, 30_000);

	test("uses the quota-selected account for the real Responses transport", async () => {
		const authorizations: string[] = [];
		const vendor = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization") ?? "");
				if (request.headers.get("authorization") === "Bearer token-b") {
					return Response.json({ id: "unexpected-account-switch", output: [] });
				}
				return Response.json({
					error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided" },
				}, { status: 401 });
			},
		});
		resources.push({ close: async () => vendor.stop(true) });

		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const bundled = index.resolve("openai/gpt-5.4");
		if (bundled === undefined) throw new Error("missing OpenAI Responses transport test model");
		const model = { ...bundled, baseUrl: `http://127.0.0.1:${vendor.port}/v1` };
		let activeCredentialId: number | undefined;
		let unpinnedGetApiKeyCalls = 0;
		const targetedPositions: number[] = [];
		const gateway = startValidatedGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: id => id.split("/").at(-1) === model.id ? model : undefined,
			listModels: () => [model],
			storage: {
				getApiKey: async () => {
					unpinnedGetApiKeyCalls += 1;
					return "token-b";
				},
				getOAuthAccessAt: async (_provider: string, position: number) => {
					targetedPositions.push(position);
					return {
						ok: true,
						accessToken: position === 0 ? "token-a" : "token-b",
						credentialId: position + 1,
					};
				},
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [
					{ position: 0, credentialId: 1, active: activeCredentialId === 1 },
					{ position: 1, credentialId: 2, active: activeCredentialId === 2 },
				],
				invalidateCredentialMatching: async () => true,
			} as never,
			quotaAccounts: () => [
				{ credentialId: 1, provider: "openai", authProvider: "openai", blocked: [], lastUsedAt: 0 },
				{ credentialId: 2, provider: "openai", authProvider: "openai", blocked: [], lastUsedAt: 100 },
			],
			quotaPreferences: () => [],
		});
		resources.push(gateway);

		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-5.4",
				prompt_cache_key: "pinned-auth-retry",
				input: "probe",
			}),
		});
		expect(response.status).not.toBe(200);
		await response.text();
		expect(authorizations.length).toBeGreaterThan(0);
		expect(new Set(authorizations)).toEqual(new Set(["Bearer token-a"]));
		expect(targetedPositions.length).toBeGreaterThan(0);
		expect(new Set(targetedPositions)).toEqual(new Set([0]));
		expect(unpinnedGetApiKeyCalls).toBe(0);
	}, 30_000);

	test("preserves encrypted reasoning end to end for a stable model and credential", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const vendor = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				captured.push(await request.json() as Record<string, unknown>);
				return new Response(openAIReasoningSuccess(), { headers: { "content-type": "text/event-stream" } });
			},
		});
		resources.push({ close: async () => vendor.stop(true) });
		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const bundled = index.resolve("openai/gpt-5.4");
		if (bundled === undefined) throw new Error("missing OpenAI Responses transport test model");
		const model = { ...bundled, baseUrl: `http://127.0.0.1:${vendor.port}/v1` };
		let activeCredentialId: number | undefined;
		const gateway = startValidatedGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: id => id.split("/").at(-1) === model.id ? model : undefined,
			listModels: () => [model],
			storage: {
				getApiKey: async () => "stable-token",
				getOAuthAccessAt: async () => ({ ok: true, accessToken: "stable-token", credentialId: 1 }),
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ position: 0, credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
			quotaAccounts: () => [{ credentialId: 1, provider: "openai", authProvider: "openai", blocked: [] }],
			quotaPreferences: () => [],
		});
		resources.push(gateway);
		const first = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-5.4",
				prompt_cache_key: "stable-wire-session",
				input: "first",
			}),
		});
		expect(first.status).toBe(200);
		const firstBody = await first.json() as { output?: unknown[] };
		const reasoning = firstBody.output?.find(item =>
			item !== null && typeof item === "object" && "type" in item && item.type === "reasoning"
		);
		expect(JSON.stringify(reasoning)).toContain("wire-ciphertext");
		expect(reasoning).toBeDefined();
		const second = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-5.4",
				prompt_cache_key: "stable-wire-session",
				input: [reasoning, { role: "user", content: "second" }],
			}),
		});
		expect(second.status).toBe(200);
		await second.json();
		expect(captured).toHaveLength(2);
		const secondVendorBody = JSON.stringify(captured[1]);
		expect(secondVendorBody).toContain("wire-ciphertext");
		expect(secondVendorBody).toContain("rs_stable_wire");
		expect(secondVendorBody).toContain('"type":"reasoning"');
	}, 30_000);
});
