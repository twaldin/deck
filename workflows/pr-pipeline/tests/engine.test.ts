/**
 * Fail-closed engine invariant for every Deck-authored workflow seat and profile.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { agents } from "../../.smithers/agents.ts";
import { PrimeSeatAgent } from "../lib/engines/prime.ts";
import { assertDeckModel, defaultModelPolicy } from "../lib/models.ts";
import { SEAT_ENGINES, validateProfiles } from "../lib/profiles.ts";

const workflowsDir = join(import.meta.dir, "..", "..");
const repoRoot = dirname(workflowsDir);
const generatedSmithersAgentsDir = join(workflowsDir, ".smithers", "agents");
const activeExtensions = /\.(?:[cm]?[jt]sx?|sh|mdx?|json|ya?ml|toml)$/;

function activeFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if ([".git", "archive", "claude-playground", "node_modules", "executions"].includes(entry.name)) continue;
		if (full === generatedSmithersAgentsDir) continue;
		if (entry.isDirectory()) out.push(...activeFiles(full));
		else if (activeExtensions.test(entry.name) && !entry.name.endsWith(".lock")) out.push(full);
	}
	return out;
}

describe("Prime-only seat engine invariant", () => {
	test("every shared Smithers seat is a broker-routed PrimeSeatAgent", () => {
		const seats = Object.entries(agents);
		expect(seats.length).toBeGreaterThan(0);
		for (const [seat, pool] of seats) {
			expect(pool.length, `seat ${seat} has no agents`).toBeGreaterThan(0);
			for (const agent of pool) {
				expect(agent.constructor.name, `seat ${seat}`).toBe(PrimeSeatAgent.name);
				expect(agent.cliEngine, `seat ${seat}`).toBe("prime");
				assertDeckModel(`${agent.opts.provider}/${agent.opts.model}`);
			}
		}
	});

	test("each public role maps to its canonical policy seat", () => {
		// The Prime-only assertion above cannot catch a model-policy inversion:
		// pointing `implement` at the judgment seat is still a PrimeSeatAgent on a
		// deck model. Pin the role -> policy mapping so spending the scarce
		// judgment budget on high-volume work fails loudly instead of silently.
		const policy = defaultModelPolicy();
		const judgment = policy.reviewer ?? policy.oppositionDefaults.openai;
		const expected: Record<string, string | undefined> = {
			implement: policy.implementer,
			cheapFast: policy.mechanical,
			research: policy.mechanical,
			midTier: policy.mechanical,
			smartTool: policy.mechanical,
			validate: judgment,
			smart: judgment,
			review: judgment,
			planning: judgment,
			orchestrator: judgment,
		};
		expect(Object.keys(expected).sort()).toEqual(Object.keys(agents).sort());
		for (const [role, model] of Object.entries(expected)) {
			const pool = agents[role as keyof typeof agents];
			const refs = pool.map((agent) => `${agent.opts.provider}/${agent.opts.model}`);
			expect(refs, `role ${role}`).toEqual([model]);
		}
		expect(policy.implementer, "implementation must not use the judgment seat").not.toBe(judgment);
	});

	test("profiles default to Prime and reject explicit retired or vendor engines", () => {
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
		expect(SEAT_ENGINES).toEqual(["prime"]);
		expect(validateProfiles([base], "test")[0]?.engine).toBe("prime");
		expect(validateProfiles([{ ...base, engine: "prime" }], "test")[0]?.engine).toBe("prime");
		for (const engine of ["pi", "codex", "claude-code"]) {
			expect(() => validateProfiles([{ ...base, engine }], "test"), engine).toThrow();
		}
	});

	test("active repository surfaces cannot reintroduce a retired engine path", () => {
		const banned = /(?:\bPiAgent\b|createHostPiAgent|host-pi|extensions-pi|PI_(?:CODING_AGENT_DIR|CONFIG_DIR|SKIP_VERSION_CHECK|OFFLINE)|\.deck\/\.pi|engine\s*[:=]\s*["']pi["'])/;
		const offenders = activeFiles(repoRoot)
			.filter((file) => file !== import.meta.path)
			.filter((file) => banned.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
	});

	test("no workflow source constructs a direct vendor CLI engine agent", () => {
		const banned = /\b(CodexAgent|ClaudeCodeAgent|OpenCodeAgent|AntigravityAgent)\b/;
		const offenders = activeFiles(workflowsDir)
			.filter((file) => file !== import.meta.path)
			.filter((file) => banned.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => file.slice(workflowsDir.length + 1))).toEqual([]);
	});

	test("assertDeckModel rejects non-deck providers and off-catalog models", () => {
		expect(() => assertDeckModel("deck/claude-sonnet-5")).not.toThrow();
		expect(() => assertDeckModel("openai/gpt-5.6-sol")).toThrow(/must use the deck provider/);
		expect(() => assertDeckModel("deck/gpt-4o")).toThrow(/agent-pickable deck catalog/);
	});
});
