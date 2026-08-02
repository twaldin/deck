/**
 * The gateway must not break streaming. A buffered or drained SSE body would
 * make every agent turn hang, which is worse than the error it replaced.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { startValidatedGateway } from "../src/validated-gateway";

const gateways: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	for (const gateway of gateways.splice(0)) await gateway.close();
});

function sseUpstream(chunks: string[], onRequest?: (body: string) => void) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			onRequest?.(await request.text());
			const stream = new ReadableStream({
				async start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(new TextEncoder().encode(chunk));
						await Bun.sleep(5);
					}
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } }) as any;
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, close: async () => { server.stop(true); } };
}

describe("streaming through the gateway", () => {
	test("SSE chunks arrive incrementally, not buffered into one blob", async () => {
		const chunks = ["data: {\"n\":1}\n\n", "data: {\"n\":2}\n\n", "data: [DONE]\n\n"];
		const upstream = sseUpstream(chunks);
		const gateway = startValidatedGateway({ bind: "127.0.0.1:0" } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
		gateways.push(gateway);

		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", stream: true }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const received: string[] = [];
		const reader = response.body!.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received.push(new TextDecoder().decode(value));
		}
		expect(received.join("")).toBe(chunks.join(""));
		// More than one read means the body was streamed, not collected first.
		expect(received.length).toBeGreaterThan(1);
	}, 20_000);

	test("a streamed non-chat POST body reaches the upstream whole", async () => {
		let seen = "";
		const upstream = sseUpstream(["data: ok\n\n"], body => { seen = body; });
		const gateway = startValidatedGateway({ bind: "127.0.0.1:0" } as Parameters<typeof startValidatedGateway>[0], (() => upstream) as never);
		gateways.push(gateway);
		const payload = "u".repeat(50_000);
		const response = await fetch(`${gateway.url}/v1/files`, { method: "POST", body: payload });
		await response.text();
		expect(seen).toBe(payload);
	}, 20_000);
});
