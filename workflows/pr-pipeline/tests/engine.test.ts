/**
 * Engine invariant: pi is deck's ONLY Smithers engine.
 *
 * Every agent seat used by any workflow in this workspace must be a PiAgent on
 * the deck provider with an agent-pickable deck model. Direct `codex` /
 * `claude-code` CLI engines are banned (mono-account auth, ambient local CLI
 * config, no broker quota accounting).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { PiAgent } from "smithers-orchestrator";

import { agents, providers } from "../../.smithers/agents.ts";
import { assertDeckModel, DECK_AGENT_CATALOG, DECK_PROVIDER } from "../lib/models.ts";

const workflowsDir = join(import.meta.dir, "..", "..");
const generatedSmithersAgentsDir = join(workflowsDir, ".smithers", "agents");

/** Every .ts/.tsx source in the workspace except generated pack internals. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.name === "node_modules" || entry.name === "executions") continue;
		// smithers init may recreate local per-engine templates here. They are
		// external workspace state, not Deck-authored or shipped workflow source.
		if (full === generatedSmithersAgentsDir) continue;
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

describe("pi is the only engine", () => {
	test("every pack agent seat is a PiAgent on the deck provider", () => {
		const seats = Object.entries(agents);
		expect(seats.length).toBeGreaterThan(0);
		for (const [seat, pool] of seats) {
			expect(pool.length, `seat ${seat} has no agents`).toBeGreaterThan(0);
			for (const agent of pool) {
				// CI installs the pack and the workflow workspace separately, so each
				// can load its own copy of smithers-orchestrator. Check the public
				// PiAgent contract instead of relying on cross-copy constructor identity.
				expect(agent.constructor.name, `seat ${seat}`).toBe("PiAgent");
				expect(agent.cliEngine, `seat ${seat}`).toBe("pi");
				const opts = (agent as PiAgent).opts;
				expect(opts.provider, `seat ${seat}`).toBe(DECK_PROVIDER);
				expect(DECK_AGENT_CATALOG, `seat ${seat}`).toContain(opts.model ?? "<unset>");
				// Never carry a raw key: broker auth only.
				expect(opts.apiKey, `seat ${seat}`).toBeUndefined();
			}
		}
	});

	test("every declared provider is a deck pi agent", () => {
		for (const [name, agent] of Object.entries(providers)) {
			expect(agent.constructor.name, name).toBe("PiAgent");
			assertDeckModel(`${(agent as PiAgent).opts.provider}/${(agent as PiAgent).opts.model}`);
		}
	});

	test("no workflow source constructs a direct codex / claude-code engine agent", () => {
		const banned = /\b(CodexAgent|ClaudeCodeAgent|OpenCodeAgent|AntigravityAgent)\b/;
		const offenders = sourceFiles(workflowsDir)
			.filter((file) => file !== import.meta.path)
			.filter((file) => banned.test(readFileSync(file, "utf8")));
		expect(offenders.map((f) => f.slice(workflowsDir.length + 1))).toEqual([]);
	});

	test("assertDeckModel rejects non-deck providers and off-catalog models", () => {
		expect(() => assertDeckModel("deck/claude-sonnet-5")).not.toThrow();
		expect(() => assertDeckModel("openai/gpt-5.6-sol")).toThrow(/must use the deck provider/);
		expect(() => assertDeckModel("deck/gpt-4o")).toThrow(/agent-pickable deck catalog/);
	});
});
