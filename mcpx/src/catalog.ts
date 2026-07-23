/**
 * mcpx server catalog: ~/.deck/catalog/mcpx.toml (SPEC §7).
 * Parsed with Bun.TOML, then zod-validated — TOML output is untyped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CATALOG_DIR, DeckError } from "@deck/core";
import { z } from "zod";

export const serverSchema = z
	.object({
		transport: z.enum(["http", "stdio"]),
		url: z.string().url().optional(),
		command: z.string().min(1).optional(),
		args: z.array(z.string()).default([]),
		auth: z.enum(["none", "broker"]).default("none"),
		/** auth=broker seam: command whose stdout (trimmed) is the bearer token. */
		tokenCommand: z.string().min(1).optional(),
	})
	.check(ctx => {
		if (ctx.value.transport === "http" && ctx.value.url === undefined) {
			ctx.issues.push({ code: "custom", message: "http transport requires url", input: ctx.value });
		}
		if (ctx.value.transport === "stdio" && ctx.value.command === undefined) {
			ctx.issues.push({ code: "custom", message: "stdio transport requires command", input: ctx.value });
		}
		if (ctx.value.auth === "broker" && ctx.value.tokenCommand === undefined) {
			ctx.issues.push({ code: "custom", message: "auth=broker requires tokenCommand", input: ctx.value });
		}
	});
export type McpxServer = z.infer<typeof serverSchema>;

const catalogSchema = z.object({ servers: z.record(z.string(), serverSchema) });
export type McpxCatalog = z.infer<typeof catalogSchema>;

export function loadCatalog(file: string = path.join(CATALOG_DIR, "mcpx.toml")): McpxCatalog {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		throw new DeckError("E_STATE", `no mcpx catalog at ${file}; copy mcpx/example.mcpx.toml there`, { file });
	}
	return catalogSchema.parse(Bun.TOML.parse(text));
}

export function resolveServer(catalog: McpxCatalog, name: string): McpxServer {
	const server = catalog.servers[name];
	if (server === undefined) {
		throw new DeckError("E_ARG", `unknown server ${JSON.stringify(name)}; catalog has: ${Object.keys(catalog.servers).join(", ") || "(none)"}`);
	}
	return server;
}
