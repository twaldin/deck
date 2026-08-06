import { afterEach, describe, expect, test } from "bun:test";
import { buildModelIndex, DEFAULT_ALLOWLIST } from "../src/models";
import { startValidatedGateway } from "../src/validated-gateway";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) await resource.close();
});

function anthropicSuccess(model: string): string {
	return [
		["message_start", { type: "message_start", message: { id: `msg_${model}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("Anthropic vendor egress", () => {
	test("sends adaptive summarized thinking and named effort for real Fable 5 and Opus 5 transports", async () => {
		const captured: unknown[] = [];
		const vendor = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				captured.push(body);
				const model = body !== null && typeof body === "object" && "model" in body && typeof body.model === "string"
					? body.model
					: "unknown";
				return new Response(anthropicSuccess(model), { headers: { "content-type": "text/event-stream" } });
			},
		});
		resources.push({ close: async () => vendor.stop(true) });

		const index = buildModelIndex(DEFAULT_ALLOWLIST);
		const models = ["claude-fable-5", "claude-opus-5"].map(id => {
			const model = index.resolve(`anthropic/${id}`) ?? index.resolve(id);
			if (model === undefined) throw new Error(`missing test model ${id}`);
			return { ...model, baseUrl: `http://127.0.0.1:${vendor.port}` };
		});
		const byId = new Map(models.map(model => [model.id, model]));
		let activeCredentialId: number | undefined;
		const gateway = startValidatedGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			version: "test",
			resolveModel: id => byId.get(id.split("/").at(-1) ?? id),
			listModels: () => models,
			storage: {
				getApiKey: async () => "sk-ant-api03-egress-test",
				getOAuthAccessAt: async () => ({
					ok: true,
					accessToken: "sk-ant-api03-egress-test",
					credentialId: 1,
				}),
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ position: 0, credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
			quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", authProvider: "anthropic", blocked: [] }],
			quotaPreferences: () => [],
		});
		resources.push(gateway);

		for (const model of models) {
			const response = await fetch(`${gateway.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: `anthropic/${model.id}`,
					max_tokens: 128,
					reasoning_effort: "high",
					prompt_cache_key: `egress-${model.id}`,
					messages: [{ role: "user", content: "Reply OK." }],
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "OK" }] });
		}

		expect(captured).toHaveLength(2);
		for (const [position, model] of models.entries()) {
			expect(captured[position]).toMatchObject({
				model: model.id,
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort: "high" },
				stream: true,
			});
			expect(JSON.stringify(captured[position])).not.toContain("budget_tokens");
		}
	}, 30_000);
});
