import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { serverSchema } from "../src/catalog";
import { callTool, listTools } from "../src/client";

const FIXTURE = path.resolve(import.meta.dir, "fixture-stdio-server.ts");

describe("mcpx stdio transport", () => {
	const server = serverSchema.parse({ transport: "stdio", command: "bun", args: [FIXTURE] });

	test("list-tools round trip", async () => {
		const tools = await listTools(server);
		expect(tools.map(tool => tool.name)).toEqual(["echo"]);
	}, 15_000);

	test("call round trip", async () => {
		const result = await callTool(server, "echo", { hello: "deck" });
		const first = result.content?.[0];
		expect(first !== undefined && "text" in first && typeof first.text === "string" ? JSON.parse(first.text) : null).toEqual({ hello: "deck" });
	}, 15_000);
});

describe("mcpx http transport", () => {
	test("initialize + tools/list against an http fixture, session id honored", async () => {
		const seenSessions: Array<string | null> = [];
		const httpServer = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { id?: number; method?: string };
				seenSessions.push(request.headers.get("mcp-session-id"));
				if (body.method === "initialize") {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
						{ headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } },
					);
				}
				if (body.method === "tools/list") {
					// SSE-shaped response exercises the event-stream parse path.
					const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping" }] } });
					return new Response(`event: message\ndata: ${payload}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response(null, { status: 202 });
			},
		});
		try {
			const server = serverSchema.parse({ transport: "http", url: `http://127.0.0.1:${httpServer.port}/mcp` });
			const tools = await listTools(server);
			expect(tools.map(tool => tool.name)).toEqual(["ping"]);
			// After initialize handed out sess-1, later requests must carry it.
			expect(seenSessions.at(-1)).toBe("sess-1");
		} finally {
			httpServer.stop(true);
		}
	}, 15_000);

	test("unknown server produces a clean E_ARG", () => {
		expect(() => serverSchema.parse({ transport: "http" })).toThrow(/url/);
	});
});
