#!/usr/bin/env bun
/**
 * Noisy stdio MCP fixture: emits non-JSON debug/stderr-bleed lines interleaved
 * with valid JSON-RPC, to prove the client's pump skips malformed lines instead
 * of hanging or crashing.
 */
const decoder = new TextDecoder();
let buffer = "";

function send(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Debug bleed before anything (a real server logging to stdout by mistake).
process.stdout.write("[debug] server starting up\n");

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.length === 0) continue;
		const message = JSON.parse(line) as { id?: number; method?: string; params?: { protocolVersion?: string } };
		// A garbage line immediately before every real response.
		process.stdout.write("not json at all\n");
		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "noisy", version: "0.0.1" } } });
		} else if (message.method === "tools/list") {
			send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "survivor", description: "returned despite noise" }] } });
		}
	}
}
