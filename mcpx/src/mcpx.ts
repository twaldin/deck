#!/usr/bin/env bun
/**
 * mcpx — MCP-as-CLI bridge (SPEC §7, PLAN §5.5).
 *   mcpx <server> list-tools [--json]
 *   mcpx <server> call <tool> [--args '<json>'] [--json]
 * axi-ish output: human text default, --json for machines; DeckError codes on
 * stderr; exit 0 ok / 2 user error / 4 io.
 */
import { DeckError } from "@deck/core";
import { z } from "zod";
import { loadCatalog, resolveServer } from "./catalog";
import { callTool, listTools, type McpTool } from "./client";

function renderTools(tools: McpTool[]): string {
	if (tools.length === 0) return "(no tools)";
	const width = Math.max(...tools.map(tool => tool.name.length));
	return tools.map(tool => `${tool.name.padEnd(width)}  ${tool.description?.split("\n")[0] ?? ""}`).join("\n");
}

async function run(): Promise<number> {
	const argv = process.argv.slice(2);
	const json = argv.includes("--json");
	const positional = argv.filter(argument => !argument.startsWith("--"));
	const argsFlagIndex = argv.indexOf("--args");
	const rawArgs = argsFlagIndex !== -1 ? argv[argsFlagIndex + 1] : undefined;

	const [serverName, op, toolName] = positional;
	if (serverName === undefined || op === undefined || (op !== "list-tools" && op !== "call")) {
		console.error("usage: mcpx <server> list-tools [--json] | mcpx <server> call <tool> [--args '<json>'] [--json]");
		return 2;
	}
	const server = resolveServer(loadCatalog(), serverName);

	if (op === "list-tools") {
		const tools = await listTools(server);
		console.log(json ? JSON.stringify(tools, null, 2) : renderTools(tools));
		return 0;
	}
	if (toolName === undefined) {
		console.error("call requires a tool name");
		return 2;
	}
	const parsedArgs =
		rawArgs === undefined
			? {}
			: z.record(z.string(), z.unknown()).parse(JSON.parse(rawArgs));
	const result = await callTool(server, toolName, parsedArgs);
	if (json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		for (const block of result.content ?? []) {
			if (block.type === "text" && "text" in block && typeof block.text === "string") console.log(block.text);
			else console.log(JSON.stringify(block));
		}
		if (result.structuredContent !== undefined) console.log(JSON.stringify(result.structuredContent, null, 2));
	}
	return result.isError === true ? 4 : 0;
}

run()
	.then(code => process.exit(code))
	.catch(error => {
		if (error instanceof DeckError) {
			console.error(error.message);
			process.exit(error.code === "E_ARG" || error.code === "E_STATE" ? 2 : 4);
		}
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(4);
	});
