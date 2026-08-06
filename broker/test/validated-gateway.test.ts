import { afterEach, describe, expect, test } from "bun:test";
import { startValidatedGateway } from "../src/validated-gateway";
import type { FastGatewayOptions } from "../src/fast-gateway";

const gateways: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const gateway of gateways.splice(0)) await gateway.close();
});
type FakeUpstreamResponse =
	| Response
	| ((path: string, body: Record<string, unknown>) => Response | Promise<Response>);


async function withFakeUpstream(options: Partial<FastGatewayOptions> = {}, upstreamResponse: FakeUpstreamResponse = Response.json({ ok: true })) {
	const forwarded: Array<{ path: string; body: Record<string, unknown> }> = [];
	const upstreamServer = Bun.serve({
		 hostname: "127.0.0.1",
		 port: 0,
		 fetch: async request => {
			const path = new URL(request.url).pathname;
			const body = await request.json() as Record<string, unknown>;
			forwarded.push({ path, body });
			const response = typeof upstreamResponse === "function"
				? await upstreamResponse(path, body)
				: upstreamResponse.clone();
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
		},
	});
	const upstream = {
		url: `http://127.0.0.1:${upstreamServer.port}`,
		pinRequestCredential: () => {},
		close: async () => upstreamServer.stop(),
	};
	const gateway = startValidatedGateway({ bind: "127.0.0.1:0", ...options } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
	gateways.push(gateway);
	return { gateway, forwarded };
}

describe("validated gateway outbound requests", () => {
	test("forwards codex max without rewriting it to high", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-sol", reasoning_effort: "max" }),
		});
		expect(response.status).toBe(200);
		expect(forwarded[0]?.body).toEqual({ model: "gpt-5.6-sol", reasoning_effort: "max", reasoning: { effort: "max" } });
	});

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

	test("warns once per session when a requested level is clamped", async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
		try {
			const { gateway } = await withFakeUpstream();
			for (let i = 0; i < 2; i++) {
				await fetch(`${gateway.url}/v1/chat/completions`, {
					method: "POST",
					body: JSON.stringify({ model: "xai/grok-4.5", reasoning_effort: "xhigh", prompt_cache_key: "session-warning" }),
				});
			}
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("requested=xhigh effective=high");
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

	test("strips encrypted OpenAI reasoning before a same-session account rotation", async () => {
		let rotated = false;
		let activeCredentialId: number | undefined;
		const pins: number[] = [];
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
		try {
			const { gateway, forwarded } = await withFakeUpstream({
				quotaAccounts: () => rotated
					? [
						{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 10 },
						{ credentialId: 2, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 0 },
					]
					: [
						{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 0 },
						{ credentialId: 2, provider: "openai-codex", authProvider: "openai-codex", blocked: [], lastUsedAt: 10 },
					],
				storage: {
					pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
						activeCredentialId = credentialId;
						pins.push(credentialId);
						return true;
					},
					listOAuthAccounts: () => [1, 2].map(credentialId => ({ credentialId, active: credentialId === activeCredentialId })),
				} as never,
			}, () => Response.json({
				id: "resp_rotation",
				object: "response",
				output: [{
					type: "reasoning",
					id: "rs_rotation",
					encrypted_content: "encrypted-account-1",
					summary: [{ type: "summary_text", text: "visible summary" }],
				}],
			}));

			const first = await fetch(`${gateway.url}/v1/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "openai-codex/gpt-5.6-sol",
					prompt_cache_key: "rotation-session",
					input: [{ role: "user", content: "first turn" }],
				}),
			});
			expect(first.status).toBe(200);
			await first.json();

			rotated = true;
			const second = await fetch(`${gateway.url}/v1/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "openai-codex/gpt-5.6-sol",
					prompt_cache_key: "rotation-session",
					input: [
						{
							type: "reasoning",
							id: "rs_rotation",
							encrypted_content: "encrypted-account-1",
							summary: [{ type: "summary_text", text: "visible summary" }],
						},
						{ type: "compaction", id: "cmp_rotation", encrypted_content: "encrypted-compaction" },
						{ role: "user", content: "second turn" },
					],
				}),
			});
			expect(second.status).toBe(200);
			await second.json();
			expect(pins).toEqual([1, 2]);
			expect(forwarded[1]?.body.input).toEqual([
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "visible summary" }],
				},
				{ role: "user", content: "second turn" },
			]);
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings.some(line => line.includes('\"family\":\"openai\"') && line.includes('\"disposition\":\"summary-preserved\"'))).toBe(true);
		expect(warnings.some(line => line.includes('\"kind\":\"openai-compaction\"') && line.includes('\"disposition\":\"dropped\"'))).toBe(true);
		expect(warnings.filter(line => line.includes('\"action\":\"pin\"')).some(line => line.includes('\"credentialId\":1'))).toBe(true);
		expect(warnings.filter(line => line.includes('\"action\":\"pin\"')).some(line => line.includes('\"credentialId\":2'))).toBe(true);
	});

	test("preserves encrypted OpenAI reasoning for a proven same-model same-account continuation", async () => {
		let activeCredentialId: number | undefined;
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [] }],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
		}, () => Response.json({
			id: "resp_stable",
			object: "response",
			output: [{
				type: "reasoning",
				id: "rs_stable",
				encrypted_content: "encrypted-stable",
				summary: [{ type: "summary_text", text: "stable summary" }],
			}],
		}));
		const artifact = {
			type: "reasoning",
			id: "rs_stable",
			encrypted_content: "encrypted-stable",
			summary: [{ type: "summary_text", text: "stable summary" }],
		};
		const first = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai-codex/gpt-5.6-sol",
				prompt_cache_key: "stable-session",
				input: [{ role: "user", content: "first" }],
			}),
		});
		expect(first.status).toBe(200);
		await first.json();
		const second = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai-codex/gpt-5.6-sol",
				prompt_cache_key: "stable-session",
				input: [artifact, { role: "user", content: "second" }],
			}),
		});
		expect(second.status).toBe(200);
		await second.json();
		expect(forwarded[1]?.body.input).toEqual([artifact, { role: "user", content: "second" }]);
	});

	test("demotes only foreign prior Anthropic thinking after a quota model fallback", async () => {
		let fallback = false;
		let activeCredentialId: number | undefined;
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{
				credentialId: 1,
				provider: "anthropic",
				authProvider: "anthropic",
				blocked: fallback ? ["fable-7d"] : [],
			}],
			quotaPreferences: () => [{ id: "claude-opus-5", provider: "anthropic" }],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
		}, (_path, body) => {
			const isFable = body.model === "anthropic/claude-fable-5";
			return Response.json({
				type: "message",
				content: [
					{ type: "thinking", thinking: isFable ? "fable visible summary" : "opus visible summary", signature: isFable ? "sig-fable" : "sig-opus" },
					{ type: "redacted_thinking", data: isFable ? "redacted-fable" : "redacted-opus" },
					{ type: "text", text: "answer" },
				],
			});
		});

		const fable = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-fable-5",
				prompt_cache_key: "model-swap-session",
				messages: [{ role: "user", content: "fable turn" }],
			}),
		});
		expect(fable.status).toBe(200);
		await fable.json();

		fallback = true;
		const opus = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-opus-5",
				prompt_cache_key: "model-swap-session",
				messages: [{ role: "user", content: "opus turn" }],
			}),
		});
		expect(opus.status).toBe(200);
		await opus.json();

		const continued = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-fable-5",
				prompt_cache_key: "model-swap-session",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "fable visible summary", signature: "sig-fable" },
							{ type: "redacted_thinking", data: "redacted-fable" },
						],
					},
					{ role: "user", content: "middle" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "opus visible summary", signature: "sig-opus" },
							{ type: "redacted_thinking", data: "redacted-opus" },
							{ type: "text", text: "latest answer" },
						],
					},
					{ role: "user", content: "continue" },
				],
			}),
		});
		expect(continued.status).toBe(200);
		await continued.json();
		expect(forwarded[2]?.body).toMatchObject({
			model: "anthropic/claude-opus-5",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "fable visible summary" }],
				},
				{ role: "user", content: "middle" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "opus visible summary", signature: "sig-opus" },
						{ type: "redacted_thinking", data: "redacted-opus" },
						{ type: "text", text: "latest answer" },
					],
				},
				{ role: "user", content: "continue" },
			],
		});
	});

	test("does not let nested tool JSON poison thinking provenance and treats a later assistant string as latest", async () => {
		let call = 0;
		let activeCredentialId: number | undefined;
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", authProvider: "anthropic", blocked: [] }],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
		}, () => {
			call += 1;
			if (call === 1) {
				return Response.json({
					type: "message",
					content: [{ type: "thinking", thinking: "fable summary", signature: "shared-signature" }],
				});
			}
			if (call === 2) {
				return Response.json({
					type: "message",
					content: [{
						type: "tool_use",
						id: "tool_1",
						name: "echo",
						input: { type: "thinking", signature: "shared-signature" },
					}],
				});
			}
			return Response.json({ type: "message", content: [{ type: "text", text: "continued" }] });
		});

		for (const model of ["claude-fable-5", "claude-opus-5"]) {
			const response = await fetch(`${gateway.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: `anthropic/${model}`,
					prompt_cache_key: "poison-proof",
					messages: [{ role: "user", content: model }],
				}),
			});
			expect(response.status).toBe(200);
			await response.json();
		}

		const continued = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-opus-5",
				prompt_cache_key: "poison-proof",
				messages: [
					{
						role: "assistant",
						content: [{ type: "thinking", thinking: "fable summary", signature: "shared-signature" }],
					},
					{ role: "user", content: "middle" },
					{ role: "assistant", content: "plain latest answer" },
					{ role: "user", content: "continue" },
				],
			}),
		});
		expect(continued.status).toBe(200);
		await continued.json();
		expect(forwarded[2]?.body.messages).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "fable summary" }] },
			{ role: "user", content: "middle" },
			{ role: "assistant", content: "plain latest answer" },
			{ role: "user", content: "continue" },
		]);
	});

	test("records streamed Anthropic signature provenance before the next turn", async () => {
		let call = 0;
		let activeCredentialId: number | undefined;
		const frames = [
			`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "stream-" } })}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } })}\n\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		];
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", authProvider: "anthropic", blocked: [] }],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
		}, () => {
			call += 1;
			if (call > 1) return Response.json({ type: "message", content: [{ type: "text", text: "continued" }] });
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					for (const frame of frames) controller.enqueue(encoder.encode(frame));
					controller.close();
				},
			}), { headers: { "content-type": "text/event-stream" } });
		});

		const streamed = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				prompt_cache_key: "streamed-provenance",
				stream: true,
				messages: [{ role: "user", content: "start" }],
			}),
		});
		expect(streamed.status).toBe(200);
		await streamed.text();

		const continued = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				prompt_cache_key: "streamed-provenance",
				messages: [{
					role: "assistant",
					content: [{ type: "thinking", thinking: "summary", signature: "stream-signature" }],
				}],
			}),
		});
		expect(continued.status).toBe(200);
		await continued.json();
		expect(forwarded[1]?.body.messages).toEqual([{
			role: "assistant",
			content: [{ type: "thinking", thinking: "summary", signature: "stream-signature" }],
		}]);
	});

	test("rejects latest Anthropic thinking when the producing credential could not be pinned", async () => {
		let call = 0;
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 9, provider: "anthropic", authProvider: "anthropic", blocked: [] }],
			storage: {} as never,
		}, () => {
			call += 1;
			return call === 1
				? Response.json({
					type: "message",
					content: [{ type: "thinking", thinking: "api-key summary", signature: "api-key-signature" }],
				})
				: Response.json({ type: "message", content: [{ type: "text", text: "continued" }] });
		});
		const first = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				prompt_cache_key: "api-key-provenance",
				messages: [{ role: "user", content: "start" }],
			}),
		});
		expect(first.status).toBe(200);
		await first.json();

		const second = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				prompt_cache_key: "api-key-provenance",
				messages: [{
					role: "assistant",
					content: [{ type: "thinking", thinking: "api-key summary", signature: "api-key-signature" }],
				}],
			}),
		});
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ error: { code: "ARTIFACT_PROVENANCE_MISMATCH" } });
		expect(forwarded).toHaveLength(1);
	});

	test("rejects an unproven latest Anthropic thinking block without rewriting or forwarding it", async () => {
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "anthropic", authProvider: "anthropic", blocked: [] }],
			storage: { pinSessionOAuthAccount: () => true } as never,
		});
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "anthropic/claude-sonnet-5",
				prompt_cache_key: "imported-session",
				messages: [{
					role: "assistant",
					content: [{ type: "thinking", thinking: "do not rewrite", signature: "foreign-signature" }],
				}],
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "ARTIFACT_PROVENANCE_MISMATCH" } });
		expect(forwarded).toEqual([]);
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

	test("rewrites an OpenAI alias to the credential provider without a model fallback", async () => {
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 7, provider: "openai-codex", authProvider: "openai-codex", blocked: [] }],
			storage: { pinSessionOAuthAccount: () => true } as never,
		});
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "openai/gpt-5.5", prompt_cache_key: "alias-no-fallback" }),
		});
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

	test("strips unknown pi-native provider artifacts and forwards the canonical request", async () => {
		const { gateway, forwarded } = await withFakeUpstream();
		const response = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "openai/gpt-5.4",
				context: {
					messages: [{
						role: "assistant",
						providerPayload: {
							type: "openaiResponsesHistory",
							items: [{ type: "reasoning", encrypted_content: "opaque" }],
						},
					}],
				},
			}),
		});
		expect(response.status).toBe(200);
		await response.json();
		expect(forwarded[0]?.body).toMatchObject({
			context: { messages: [{ providerPayload: { type: "openaiResponsesHistory", items: [] } }] },
		});
	});

	test("preserves proven pi-native reasoning on a stable model and credential", async () => {
		let activeCredentialId: number | undefined;
		const signature = JSON.stringify({ type: "reasoning", encrypted_content: "pi-stable" });
		const message = {
			role: "assistant",
			model: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
			content: [{ type: "thinking", thinking: "visible pi summary", thinkingSignature: signature }],
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [{ type: "reasoning", id: "rs_pi", encrypted_content: "pi-stable", summary: [{ type: "summary_text", text: "visible pi summary" }] }],
			},
		};
		let call = 0;
		const { gateway, forwarded } = await withFakeUpstream({
			quotaAccounts: () => [{ credentialId: 1, provider: "openai-codex", authProvider: "openai-codex", blocked: [] }],
			storage: {
				pinSessionOAuthAccount: (_provider: string, _sessionId: string, credentialId: number) => {
					activeCredentialId = credentialId;
					return true;
				},
				listOAuthAccounts: () => [{ credentialId: 1, active: activeCredentialId === 1 }],
			} as never,
		}, () => {
			call += 1;
			return Response.json({ message: call === 1 ? message : { ...message, content: [{ type: "text", text: "continued" }] } });
		});
		const first = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				modelId: "openai-codex/gpt-5.6-sol",
				context: { messages: [{ role: "user", content: "first", timestamp: 1 }] },
				options: { sessionId: "pi-stable-session" },
				stream: false,
			}),
		});
		expect(first.status).toBe(200);
		await first.json();
		const second = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				modelId: "openai-codex/gpt-5.6-sol",
				context: { messages: [message, { role: "user", content: "second", timestamp: 2 }] },
				options: { sessionId: "pi-stable-session" },
				stream: false,
			}),
		});
		expect(second.status).toBe(200);
		await second.json();
		expect(forwarded[1]?.body.context).toMatchObject({ messages: [message, { role: "user", content: "second" }] });
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
