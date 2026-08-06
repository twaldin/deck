/**
 * Prime's native logins are single-account. If a seat silently falls back from
 * Deck to Prime-native auth, completions still succeed but lose broker rotation,
 * quota windows, and reasoning control. This regression keeps that degradation
 * fail-closed and proves both the root and a real rlm() child use Deck unchanged.
 */
import { createServer, type Server } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";

import { PrimeSeatAgent, PrimeSeatError } from "../lib/engines/prime.ts";

const completionRequestSchema = z.object({
	model: z.string(),
	reasoning_effort: z.string().optional(),
	messages: z.array(z.unknown()),
}).passthrough();
const herdrRequestSchema = z.object({
	id: z.string(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()),
});
const runResultSchema = z.object({
	providerMetadata: z.object({
		prime: z.object({
			rootModel: z.object({ provider: z.string(), model: z.string() }).passthrough(),
			childModels: z.array(z.object({ provider: z.string(), model: z.string(), depth: z.number() }).passthrough()),
		}),
	}),
});

type CompletionRequest = z.infer<typeof completionRequestSchema>;
type CapturedCompletion = {
	headers: Record<string, string>;
	pathname: string;
	body: CompletionRequest;
	childMarker: boolean;
};
type CaptureBroker = {
	origin: string;
	requests: CapturedCompletion[];
	stop: () => Promise<void>;
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testWorkspaceId = "prime-broker-routing-workspace";
const configuredPrimeBinary = process.env.DECK_PRIME_AGENT_BINARY ?? Bun.which("prime-agent");
const runningInCi = !["", "0", "false"].includes((process.env.CI ?? "").toLowerCase());
if (runningInCi && configuredPrimeBinary === null) {
	throw new Error("CI must install prime-agent 0.7.0: the broker-routing regression cannot be skipped");
}
const testWithPrime = configuredPrimeBinary === null ? test.skip : test;
let herdrRoot: string;
let herdrSocket: string;
let herdrServer: Server;
let paneSequence = 0;

function herdrResult(method: string): Record<string, unknown> {
	switch (method) {
		case "workspace.get":
			return { workspace: { workspace_id: testWorkspaceId, label: "prime broker routing test" } };
		case "tab.create": {
			const sequence = ++paneSequence;
			return {
				root_pane: { pane_id: `test-pane-${sequence}` },
				tab: { tab_id: `test-tab-${sequence}` },
			};
		}
		default:
			return { type: "ok" };
	}
}

beforeAll(async () => {
	herdrRoot = await fs.mkdtemp("/tmp/dpr-");
	herdrSocket = path.join(herdrRoot, "herdr.sock");
	herdrServer = createServer((socket) => {
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const request = herdrRequestSchema.parse(JSON.parse(input.slice(0, newline)));
			socket.end(`${JSON.stringify({ id: request.id, result: herdrResult(request.method) })}\n`);
		});
	});
	const listening = Promise.withResolvers<void>();
	herdrServer.once("error", listening.reject);
	herdrServer.listen(herdrSocket, listening.resolve);
	await listening.promise;
});

afterAll(async () => {
	const closed = Promise.withResolvers<void>();
	herdrServer.close((error) => error === undefined ? closed.resolve() : closed.reject(error));
	await closed.promise;
	await fs.rm(herdrRoot, { recursive: true, force: true });
});

function completionStream(
	model: string,
	delta: Record<string, unknown>,
	finishReason: "stop" | "tool_calls",
): Response {
	const id = `chatcmpl-deck-capture-${crypto.randomUUID()}`;
	const envelope = {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1_000),
		model,
	};
	const chunks = [
		{ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] },
		{
			...envelope,
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
	];
	const stream = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function startCaptureBroker(): CaptureBroker {
	const requests: CapturedCompletion[] = [];
	let rootRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = completionRequestSchema.parse(await request.json());
			const childMarker = JSON.stringify(body.messages).includes("[task from parent]");
			requests.push({
				headers: Object.fromEntries(request.headers.entries()),
				pathname: new URL(request.url).pathname,
				body,
				childMarker,
			});
			if (childMarker) {
				return completionStream(body.model, { content: "CHILD_DONE" }, "stop");
			}

			rootRequests += 1;
			if (rootRequests === 1) {
				const code = "child = await rlm('Complete this broker-routing child task.', name='broker-fidelity-child')\nchild";
				return completionStream(body.model, {
					tool_calls: [{
						index: 0,
						id: "call_spawn_broker_fidelity_child",
						type: "function",
						function: { name: "ipython", arguments: JSON.stringify({ code }) },
					}],
				}, "tool_calls");
			}

			if (rootRequests === 2) {
				const code = [
					"import asyncio",
					"for _ in range(100):",
					"    children = await rlm.list_subagents()",
					"    if children and children[0].status != 'running':",
					"        break",
					"    await asyncio.sleep(0.05)",
					"children",
				].join("\n");
				return completionStream(body.model, {
					tool_calls: [{
						index: 0,
						id: "call_wait_for_broker_fidelity_child",
						type: "function",
						function: { name: "ipython", arguments: JSON.stringify({ code }) },
					}],
				}, "tool_calls");
			}
			return completionStream(body.model, { content: '{"ok":true}' }, "stop");
		},
	});
	return {
		origin: `http://${server.hostname}:${server.port}`,
		requests,
		stop: async () => { await server.stop(true); },
	};
}

function primeOptions(thinking: "low" | "xhigh", origin: string) {
	return {
		provider: "deck" as const,
		model: "gpt-5.6-sol",
		cwd: packageRoot,
		brokerApiKey: "capture-server-only-key",
		timeoutMs: 120_000,
		idleTimeoutMs: 90_000,
		terminationGraceMs: 100,
		thinking,
		binary: configuredPrimeBinary ?? undefined,
		herdrSocketPath: herdrSocket,
		herdrWorkspaceId: testWorkspaceId,
		herdrStrict: true,
		env: { DECK_GATEWAY_ORIGIN: origin, HOME: herdrRoot },
	};
}

describe("Prime seat broker-only routing and thinking fidelity", () => {
	testWithPrime("routes root and real rlm child through Deck with exact low and xhigh effort (requires prime-agent 0.7.0)", async () => {
		for (const thinking of ["low", "xhigh"] as const) {
			const broker = startCaptureBroker();
			try {
				const result = runResultSchema.parse(await new PrimeSeatAgent(primeOptions(thinking, broker.origin)).generate({
					prompt: "Spawn the required child, then return the requested JSON result.",
					outputSchema: z.object({ ok: z.literal(true) }),
					taskContext: { runId: `broker-fidelity-${thinking}`, nodeId: "prime-seat", iteration: 0, attempt: 0 },
				}));
				expect(result.providerMetadata.prime.rootModel).toMatchObject({ provider: "deck", model: "gpt-5.6-sol" });
				expect(result.providerMetadata.prime.childModels).toContainEqual(
					expect.objectContaining({ provider: "deck", model: "gpt-5.6-sol", depth: 1 }),
				);

				const rootRequests = broker.requests.filter((request) => !request.childMarker);
				const childRequests = broker.requests.filter((request) => request.childMarker);
				expect(rootRequests.length).toBeGreaterThan(0);
				expect(childRequests.length).toBeGreaterThan(0);
				for (const request of [...rootRequests, ...childRequests]) {
					expect(request.pathname).toBe("/v1/chat/completions");
					expect(request.headers.authorization).toBe("Bearer capture-server-only-key");
					expect(request.body.model).toBe("gpt-5.6-sol");
					expect(request.body.reasoning_effort).toBe(thinking);
					expect(request.body).not.toHaveProperty("reasoning");
					expect(request.body).not.toHaveProperty("thinking");
				}
				expect(childRequests.some((request) => JSON.stringify(request.body.messages).includes("[task from parent]"))).toBe(true);
			} finally {
				await broker.stop();
			}
		}
	}, 360_000);

	test("rejects a non-Deck provider before Prime can use native authentication", () => {
		let failure: unknown;
		try {
			Reflect.construct(PrimeSeatAgent, [{ ...primeOptions("low", "http://127.0.0.1:1"), provider: "openai" }]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PrimeSeatError);
		expect((failure as PrimeSeatError).code).toBe("PRIME_MODEL_MISMATCH");
		expect((failure as Error).message).toContain("must use provider deck");
	});
});
