/**
 * Upstream transport failures must never reach a client as a non-JSON 500.
 * A dropped socket makes `fetch` throw; unhandled, Bun answers with an HTML-ish
 * 500 that no OpenAI/Anthropic client can parse.
 */
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { startValidatedGateway } from "../src/validated-gateway";
import type { FastGatewayOptions } from "../src/fast-gateway";

const gateways: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const gateway of gateways.splice(0)) await gateway.close();
});

/**
 * A gateway whose upstream fetch is scripted: each entry is thrown or returned.
 *
 * A plain `Response` entry is cloned so a replay attempt gets a fresh body. Pass
 * a FACTORY for a streamed body: `clone()` tees, and a tee drops queued bytes
 * when one branch errors, which would erase the very prefix a mid-stream test
 * asserts on.
 */
function gatewayWithScriptedUpstream(script: Array<Error | Response | (() => Response)>, options: Partial<FastGatewayOptions> = {}) {
	const attempts: Array<{ url: string; body: string | null }> = [];
	let index = 0;
	const upstreamFetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
		attempts.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
		const step = script[Math.min(index++, script.length - 1)]!;
		if (step instanceof Error) throw step;
		if (typeof step === "function") return step();
		return step.clone() as unknown as Response;
	};
	const upstream = { url: "http://127.0.0.1:1/", close: async () => {} };
	const gateway = startValidatedGateway(
		{ bind: "127.0.0.1:0", ...options } as Parameters<typeof startValidatedGateway>[0],
		(() => upstream) as never,
		upstreamFetch,
	);
	gateways.push(gateway);
	return { gateway, attempts };
}

function econnreset(): Error {
	return Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
}

/**
 * A body that delivers `prefix`, then dies. `pull` (not `start`) sequences it:
 * `controller.error()` discards whatever is still queued, so erroring eagerly
 * would drop the prefix and stop the test proving the mid-stream case.
 */
function bodyThatDiesAfter(prefix: string, error: Error): ReadableStream<Uint8Array> {
	let sent = false;
	return new ReadableStream({
		pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(new TextEncoder().encode(prefix));
				return;
			}
			controller.error(error);
		},
	});
}

async function drain(response: Response): Promise<{ text: string; threw: string | null }> {
	const reader = response.body!.getReader();
	const parts: string[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(new TextDecoder().decode(value));
		}
	} catch (error) {
		return { text: parts.join(""), threw: error instanceof Error ? error.message : String(error) };
	}
	return { text: parts.join(""), threw: null };
}

describe("upstream resilience", () => {
	test("a POST reset mid-flight is NOT replayed: it may already have been billed", async () => {
		const { gateway, attempts } = gatewayWithScriptedUpstream([econnreset()]);
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai/gpt-5.6-sol" }),
		});
		expect(response.status).toBe(502);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({
			error: { code: "UPSTREAM_UNAVAILABLE", type: "api_error", attempts: 1 },
		});
		// One attempt only. A reset does not prove the provider never generated.
		expect(attempts).toHaveLength(1);
	});

	test("a refused connection IS replayed: nothing was dispatched", async () => {
		const refused = Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
		const { gateway, attempts } = gatewayWithScriptedUpstream([refused, Response.json({ ok: true })]);
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai/gpt-5.6-sol" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(attempts).toHaveLength(2);
		// The retry must carry the SAME body: a Request body is a one-shot stream.
		expect(attempts[1]?.body).toBe(attempts[0]?.body);
		expect(JSON.parse(attempts[1]!.body!)).toMatchObject({ model: "openai/gpt-5.6-sol" });
	});

	test("a GET reset IS replayed: the request is idempotent", async () => {
		const { gateway, attempts } = gatewayWithScriptedUpstream([econnreset(), Response.json({ data: [] })]);
		const response = await fetch(`${gateway.url}/v1/models`);
		expect(response.status).toBe(200);
		expect(attempts).toHaveLength(2);
	});

	test("a persistently refused upstream gives up as structured JSON 502", async () => {
		const refused = Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
		const { gateway, attempts } = gatewayWithScriptedUpstream([refused]);
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "openai/gpt-5.6-sol" }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", attempts: 3 } });
		expect(attempts).toHaveLength(3);
	});

	test("does not replay a POST after an upstream 503; returns structured JSON", async () => {
		const { gateway, attempts } = gatewayWithScriptedUpstream([
			new Response("upstream down", { status: 503 }),
			Response.json({ recovered: true }),
		]);
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", upstream_status: 503, attempts: 1 } });
		expect(attempts).toHaveLength(1);
	});

	test("an exhausted non-JSON 503 ends as structured JSON, not as HTML", async () => {
		const { gateway, attempts } = gatewayWithScriptedUpstream([
			new Response("<html>Service Unavailable</html>", { status: 503, headers: { "content-type": "text/html" } }),
		]);
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
		});
		expect(response.status).toBe(502);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", upstream_status: 503 } });
		expect(attempts).toHaveLength(1);
	});

	test("an exhausted JSON 503 keeps the provider's own error", async () => {
		const { gateway } = gatewayWithScriptedUpstream([
			Response.json({ error: { message: "overloaded", type: "overloaded_error" } }, { status: 503 }),
		]);
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { type: "overloaded_error" } });
	});

	test("does not retry a provider 400 — a client error is the answer", async () => {
		const { gateway, attempts } = gatewayWithScriptedUpstream([
			Response.json({ error: { message: "bad model" } }, { status: 400 }),
		]);
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
		});
		expect(response.status).toBe(400);
		expect(attempts).toHaveLength(1);
	});

	test("an SSE body that dies mid-stream ends as an in-band error frame, not a silent EOF", async () => {
		// The failure mode this guards: headers said 200 and tokens were already
		// delivered, so nothing can be retried and no status code is left to send.
		// Passed through raw, the client reads a CLEAN EOF and treats a truncated
		// answer as a finished one. The error has to travel in-band.
		const { gateway } = gatewayWithScriptedUpstream([
			() => new Response(bodyThatDiesAfter("data: {\"n\":1}\n\n", econnreset()), {
				headers: { "content-type": "text/event-stream" },
			}),
		]);
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", stream: true }),
		});
		expect(response.status).toBe(200);
		const { text, threw } = await drain(response);
		expect(threw).toBeNull();
		// What the upstream did deliver is kept.
		expect(text).toContain("data: {\"n\":1}\n\n");
		// Anthropic clients dispatch on the event name...
		expect(text).toContain("event: error");
		// ...OpenAI clients read the JSON payload. One frame satisfies both.
		const frame = text.slice(text.lastIndexOf("event: error"));
		const payload = JSON.parse(frame.slice(frame.indexOf("data: ") + 6).trim());
		expect(payload).toMatchObject({ type: "error", error: { code: "UPSTREAM_STREAM_FAILED", type: "api_error" } });
		expect(payload.error.message).toContain("ECONNRESET");
		// [DONE] must NOT follow: it is the success sentinel and would re-hide the failure.
		expect(text).not.toContain("[DONE]");
	});

	test("a body torn MID-FRAME never emits the torn frame, and the error frame stays parseable", async () => {
		// The realistic shape of a reset: it lands inside a frame, not on the blank
		// line between two. Appending the error frame onto torn bytes would splice it
		// into the dead frame's `data:` line, and the client would hit a JSON parse
		// failure before it ever reached the broker's explanation.
		const whole = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n';
		// Distinct content, so "the torn frame is absent" cannot be satisfied by the
		// complete frame merely sharing a prefix with it.
		const torn = 'event: content_block_delta\ndata: {"index":7,"delta":{"text":"TRUNCATED_MARK';
		const { gateway } = gatewayWithScriptedUpstream([
			() => new Response(bodyThatDiesAfter(whole + torn, econnreset()), {
				headers: { "content-type": "text/event-stream" },
			}),
		]);
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", stream: true }),
		});
		const { text, threw } = await drain(response);
		expect(threw).toBeNull();
		expect(text).toContain(whole);
		// The torn frame is dropped whole: no client ever sees its truncated JSON.
		expect(text).not.toContain("TRUNCATED_MARK");
		expect(text).not.toContain('"index":7');
		expect(text).not.toContain(torn);
		// Every delivered frame parses \u2014 this is what the splice would have broken.
		const blocks = text.split("\n\n").filter(block => block.trim() !== "");
		for (const block of blocks) {
			const data = block.split("\n").find(line => line.startsWith("data: "));
			expect(data).toBeDefined();
			expect(() => JSON.parse(data!.slice(6))).not.toThrow();
		}
		expect(blocks.at(-1)).toContain("event: error");
		expect(blocks.at(-1)).toContain("UPSTREAM_STREAM_FAILED");
	});

	test("a healthy SSE body passes through unchanged", async () => {
		const { gateway } = gatewayWithScriptedUpstream([
			new Response("data: {\"n\":1}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
		]);
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", stream: true }),
		});
		const { text, threw } = await drain(response);
		expect(threw).toBeNull();
		expect(text).toBe("data: {\"n\":1}\n\ndata: [DONE]\n\n");
		expect(text).not.toContain("event: error");
	});

	test("a REAL socket reset mid-SSE reaches the client as an error frame", async () => {
		// The scripted case proves the guard; this proves the wiring, against an
		// upstream that resets its TCP socket mid-body exactly as a provider does.
		const frame = 'data: {"n":1}\n\n';
		const raw = net.createServer(socket => {
			socket.on("data", () => {
				socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
				socket.write(`${frame.length.toString(16)}\r\n${frame}\r\n`);
				setTimeout(() => socket.resetAndDestroy(), 20);
			});
			socket.on("error", () => {});
		});
		await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", resolve));
		const rawPort = (raw.address() as net.AddressInfo).port;
		const upstream = { url: `http://127.0.0.1:${rawPort}`, close: async () => { raw.close(); } };
		const gateway = startValidatedGateway({ bind: "127.0.0.1:0" } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
		gateways.push(gateway);

		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", stream: true }),
		});
		expect(response.status).toBe(200);
		const { text, threw } = await drain(response);
		expect(threw).toBeNull();
		expect(text).toContain(frame);
		expect(text).toContain("event: error");
		expect(text).toContain("UPSTREAM_STREAM_FAILED");
		expect(text).not.toContain("[DONE]");
	}, 20_000);

	test("a non-chat POST body streams through undecoded and is never replayed", async () => {
		// Binary bytes: buffering these as text would corrupt an upload.
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
		const seen: Array<Uint8Array> = [];
		const upstreamServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				seen.push(new Uint8Array(await request.arrayBuffer()));
				return Response.json({ ok: true }) as any;
			},
		});
		const upstream = { url: `http://127.0.0.1:${upstreamServer.port}`, close: async () => { upstreamServer.stop(); } };
		const gateway = startValidatedGateway({ bind: "127.0.0.1:0" } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
		gateways.push(gateway);

		const response = await fetch(`${gateway.url}/v1/files`, { method: "POST", body: bytes });
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect([...seen[0]!]).toEqual([...bytes]);
	});
});
