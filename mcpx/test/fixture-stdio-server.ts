#!/usr/bin/env bun
/** Tiny stdio MCP server fixture: initialize / tools/list / tools/call (echo). */
const decoder = new TextDecoder();
let buffer = "";

function send(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.length === 0) continue;
		const message = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
		if (message.method === "initialize") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "0.0.1" },
				},
			});
		} else if (message.method === "tools/list") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "echo", description: "Echoes its input", inputSchema: { type: "object" } }] },
			});
		} else if (message.method === "tools/call") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }] },
			});
		}
		// notifications (no id) are ignored
	}
}
