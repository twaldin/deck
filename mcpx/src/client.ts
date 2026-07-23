/**
 * Minimal one-shot MCP client (SPEC §7): JSON-RPC 2.0 over streamable HTTP or
 * spawned stdio, no persistent session beyond the invocation. Both transports
 * run initialize → initialized → the requested op, then tear down.
 */
import { DeckError } from "@deck/core";
import { z } from "zod";
import type { McpxServer } from "./catalog";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const STDIO_DEADLINE_MS = 45_000;

const rpcResponseSchema = z.looseObject({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.number(), z.string()]).nullish(),
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
type RpcResponse = z.infer<typeof rpcResponseSchema>;

export const toolSchema = z.looseObject({
	name: z.string(),
	description: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type McpTool = z.infer<typeof toolSchema>;

const toolsListSchema = z.looseObject({ tools: z.array(toolSchema) });
const toolCallResultSchema = z.looseObject({
	content: z.array(z.looseObject({ type: z.string() })).optional(),
	structuredContent: z.record(z.string(), z.unknown()).optional(),
	isError: z.boolean().optional(),
});
export type McpToolCallResult = z.infer<typeof toolCallResultSchema>;

interface Transport {
	request(method: string, params: Record<string, unknown>): Promise<RpcResponse>;
	notify(method: string, params: Record<string, unknown>): Promise<void>;
	close(): void;
}

/** Parse a streamable-HTTP response body: plain JSON or an SSE event stream. */
function parseHttpBody(contentType: string, text: string): RpcResponse {
	if (contentType.includes("text/event-stream")) {
		// Take the LAST data: payload carrying a jsonrpc response (spec allows
		// servers to interleave notifications before the response).
		let last: RpcResponse | undefined;
		for (const block of text.split("\n\n")) {
			for (const line of block.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const parsed = rpcResponseSchema.safeParse(JSON.parse(line.slice(6)));
				if (parsed.success && (parsed.data.result !== undefined || parsed.data.error !== undefined)) {
					last = parsed.data;
				}
			}
		}
		if (last === undefined) throw new DeckError("E_IO", "SSE stream carried no JSON-RPC response");
		return last;
	}
	return rpcResponseSchema.parse(JSON.parse(text));
}

function httpTransport(server: McpxServer, token: string | null): Transport {
	let nextId = 1;
	let sessionId: string | null = null;
	const url = server.url;
	if (url === undefined) throw new DeckError("E_STATE", "http transport requires url");

	async function post(body: Record<string, unknown>, expectResponse: boolean): Promise<RpcResponse | null> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (token !== null) headers.authorization = `Bearer ${token}`;
		if (sessionId !== null) headers["mcp-session-id"] = sessionId;
		const response = await fetch(url as string, { method: "POST", headers, body: JSON.stringify(body) });
		const newSession = response.headers.get("mcp-session-id");
		if (newSession !== null) sessionId = newSession;
		if (response.status === 202) return null;
		if (!response.ok) {
			throw new DeckError("E_IO", `MCP server HTTP ${response.status}`, { body: (await response.text()).slice(0, 400) });
		}
		if (!expectResponse) return null;
		return parseHttpBody(response.headers.get("content-type") ?? "", await response.text());
	}

	return {
		async request(method, params) {
			const response = await post({ jsonrpc: "2.0", id: nextId++, method, params }, true);
			if (response === null) throw new DeckError("E_IO", `no response for ${method}`);
			return response;
		},
		async notify(method, params) {
			await post({ jsonrpc: "2.0", method, params }, false);
		},
		close() {
			// One-shot: nothing persistent to tear down; session id dies with us.
		},
	};
}

function stdioTransport(server: McpxServer): Transport {
	const command = server.command;
	if (command === undefined) throw new DeckError("E_STATE", "stdio transport requires command");
	const proc = Bun.spawn([command, ...server.args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = proc.stdout.getReader();
	let buffer = "";
	const pending = new Map<number, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	let nextId = 1;

	const pump = (async () => {
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.length === 0) continue;
				const parsed = rpcResponseSchema.safeParse(JSON.parse(line));
				if (!parsed.success || parsed.data.id === null || parsed.data.id === undefined) continue;
				const id = typeof parsed.data.id === "string" ? Number.parseInt(parsed.data.id, 10) : parsed.data.id;
				const waiter = pending.get(id);
				if (waiter !== undefined) {
					pending.delete(id);
					waiter.resolve(parsed.data);
				}
			}
		}
		for (const waiter of pending.values()) waiter.reject(new Error("MCP stdio server closed"));
		pending.clear();
	})();
	void pump;

	const deadline = setTimeout(() => {
		proc.kill("SIGKILL");
	}, STDIO_DEADLINE_MS);

	function send(payload: Record<string, unknown>): void {
		proc.stdin.write(`${JSON.stringify(payload)}\n`);
		void proc.stdin.flush();
	}

	return {
		request(method, params) {
			const id = nextId++;
			const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
			pending.set(id, { resolve, reject });
			send({ jsonrpc: "2.0", id, method, params });
			return promise;
		},
		async notify(method, params) {
			send({ jsonrpc: "2.0", method, params });
		},
		close() {
			clearTimeout(deadline);
			try {
				proc.stdin.end();
			} catch {
				// already closed
			}
			proc.kill();
		},
	};
}

async function resolveToken(server: McpxServer): Promise<string | null> {
	if (server.auth !== "broker") return null;
	const tokenCommand = server.tokenCommand;
	if (tokenCommand === undefined) throw new DeckError("E_STATE", "auth=broker requires tokenCommand");
	const proc = Bun.spawn(["sh", "-c", tokenCommand], { stdout: "pipe", stderr: "ignore" });
	const text = (await new Response(proc.stdout).text()).trim();
	if ((await proc.exited) !== 0 || text.length === 0) {
		throw new DeckError("E_CAP", "tokenCommand failed or returned empty token");
	}
	return text;
}

async function openSession(server: McpxServer): Promise<Transport> {
	const token = await resolveToken(server);
	const transport = server.transport === "http" ? httpTransport(server, token) : stdioTransport(server);
	let lastError: unknown;
	for (const version of PROTOCOL_VERSIONS) {
		try {
			const init = await transport.request("initialize", {
				protocolVersion: version,
				capabilities: {},
				clientInfo: { name: "deck-mcpx", version: "0.1.0" },
			});
			if (init.error !== undefined) {
				lastError = new DeckError("E_IO", `initialize rejected: ${init.error.message}`);
				continue;
			}
			await transport.notify("notifications/initialized", {});
			return transport;
		} catch (error) {
			lastError = error;
		}
	}
	transport.close();
	throw lastError instanceof Error ? lastError : new DeckError("E_IO", "MCP initialize failed");
}

export async function listTools(server: McpxServer): Promise<McpTool[]> {
	const transport = await openSession(server);
	try {
		const response = await transport.request("tools/list", {});
		if (response.error !== undefined) throw new DeckError("E_IO", `tools/list: ${response.error.message}`);
		return toolsListSchema.parse(response.result ?? {}).tools;
	} finally {
		transport.close();
	}
}

export async function callTool(server: McpxServer, tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
	const transport = await openSession(server);
	try {
		const response = await transport.request("tools/call", { name: tool, arguments: args });
		if (response.error !== undefined) throw new DeckError("E_IO", `tools/call: ${response.error.message}`);
		return toolCallResultSchema.parse(response.result ?? {});
	} finally {
		transport.close();
	}
}
