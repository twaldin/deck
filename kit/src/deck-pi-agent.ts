import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PiAgent } from "smithers-orchestrator";
import { z } from "zod";

const deckPiAgentOptionsSchema = z
	.object({
		model: z.string().min(1).default("claude-haiku-4-5"),
		basePrompt: z.string().min(1),
		rolePrompt: z.string().min(1),
		extraPrompt: z.string().min(1).optional(),
		dispatchSkills: z.array(z.string().min(1)).default([]),
		cwd: z.string().min(1).optional(),
		timeoutMs: z.number().int().positive().optional(),
		noTools: z.boolean().default(false),
		loadSmithersPiPlugin: z.boolean().default(true),
	})
	.strict();

export type DeckPiAgentOptions = z.input<typeof deckPiAgentOptionsSchema>;

const smithersPiExtensionPath = fileURLToPath(
	import.meta.resolve("@smithers-orchestrator/pi-plugin/extension"),
);

function resolveDispatchSkill(skill: string, cwd: string): string {
	const expanded = skill.startsWith("~/") ? path.join(os.homedir(), skill.slice(2)) : skill;
	const candidates = path.isAbsolute(expanded)
		? [expanded]
		: [path.resolve(cwd, expanded), path.join(os.homedir(), ".pi", "agent", "skills", expanded)];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	throw new Error(`DeckPiAgent dispatch skill does not exist: ${skill}`);
}

const deckIntegrationPrompt = `# Deck workflow integration
Use the injected dispatch skills for the assigned workflow step. Emit durable progress through \`deck emit\` when that CLI surface is available; inspect its help before choosing arguments. Never read or request raw model credentials. The Deck broker-backed \`deck\` provider is the only model provider for this agent.`;

export function composeDeckAgentPrompt(options: {
	basePrompt: string;
	rolePrompt: string;
	extraPrompt?: string;
}): string {
	const sections = [options.basePrompt.trim(), options.rolePrompt.trim(), deckIntegrationPrompt];
	if (options.extraPrompt !== undefined) {
		sections.push(options.extraPrompt.trim());
	}
	return sections.join("\n\n");
}

/**
 * Smithers PiAgent pre-wired to Deck's broker-backed provider and first-party
 * Smithers Pi extension. `apiKey` is deliberately absent from the public API.
 */
export class DeckPiAgent extends PiAgent {
	readonly composedSystemPrompt: string;

	constructor(options: DeckPiAgentOptions) {
		const parsed = deckPiAgentOptionsSchema.parse(options);
		const cwd = parsed.cwd ?? process.cwd();
		const dispatchSkills = parsed.dispatchSkills.map((skill) => resolveDispatchSkill(skill, cwd));
		const composedSystemPrompt = composeDeckAgentPrompt(parsed);
		super({
			provider: "deck",
			model: parsed.model,
			systemPrompt: composedSystemPrompt,
			skill: dispatchSkills,
			extension: parsed.loadSmithersPiPlugin ? [smithersPiExtensionPath] : undefined,
			cwd,
			timeoutMs: parsed.timeoutMs,
			noTools: parsed.noTools,
			thinking: "off",
		});
		this.composedSystemPrompt = composedSystemPrompt;
	}
}
