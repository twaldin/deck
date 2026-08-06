/**
 * Engine invariant: each project profile selects an explicitly reviewed seat
 * engine. Pi and the pinned Prime adapter are allowed; raw vendor CLI agents
 * remain banned because they bypass the Deck broker and seat safety boundary.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { PiAgent } from "smithers-orchestrator";

import { agents, providers } from "../../.smithers/agents.ts";
import { PrimeSeatAgent } from "../lib/engines/prime.ts";
import { assertDeckModel, DECK_AGENT_CATALOG, DECK_PROVIDER } from "../lib/models.ts";
import { SEAT_ENGINES, validateProfiles } from "../lib/profiles.ts";

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

describe("reviewed seat engine allowlist", () => {
	test("pack seats use an allowlisted broker-routed engine", () => {
		const seats = Object.entries(agents);
		expect(seats.length).toBeGreaterThan(0);
		for (const [seat, pool] of seats) {
			expect(pool.length, `seat ${seat} has no agents`).toBeGreaterThan(0);
			for (const agent of pool) {
				expect("cliEngine" in agent, `seat ${seat} does not expose its engine`).toBe(true);
				const cliEngine = "cliEngine" in agent ? String(agent.cliEngine) : "";
				expect(SEAT_ENGINES, `seat ${seat}`).toContain(cliEngine);
				if (cliEngine === "pi") {
					const opts = (agent as PiAgent).opts;
					expect(opts.provider, `seat ${seat}`).toBe(DECK_PROVIDER);
					expect(DECK_AGENT_CATALOG, `seat ${seat}`).toContain(opts.model ?? "<unset>");
					expect(opts.apiKey, `seat ${seat}`).toBeUndefined();
				} else {
					expect(agent.constructor.name, `seat ${seat}`).toBe(PrimeSeatAgent.name);
					const opts = (agent as PrimeSeatAgent).opts;
					assertDeckModel(`${opts.provider}/${opts.model}`);
				}
			}
		}
	});

	test("every declared provider is a deck pi agent", () => {
		for (const [name, agent] of Object.entries(providers)) {
			expect(agent.constructor.name, name).toBe("PiAgent");
			const piAgent = agent as PiAgent;
			assertDeckModel(`${piAgent.opts.provider}/${piAgent.opts.model}`);
		}
	});

	test("profiles default to pi and reject every engine outside pi or prime", () => {
		const base = {
			id: "engine-test",
			repo: "example/engine-test",
			primary: "/tmp/engine-test",
			pipeline: "yolo-ship",
			yolo: true,
			stamp: false,
			knowledge: [],
			depsWarm: true,
		};
		expect(SEAT_ENGINES).toEqual(["pi", "prime"]);
		expect(validateProfiles([base], "test")[0]?.engine).toBe("pi");
		expect(validateProfiles([{ ...base, engine: "prime" }], "test")[0]?.engine).toBe("prime");
		expect(() => validateProfiles([{ ...base, engine: "codex" }], "test")).toThrow(
			/engine must be one of pi \\| prime/,
		);
		expect(() => validateProfiles([{ ...base, engine: "claude-code" }], "test")).toThrow(
			/engine must be one of pi \\| prime/,
		);
	});

	test("no workflow source constructs a direct vendor CLI engine agent", () => {
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
