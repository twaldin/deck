import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentRole = "implementer" | "reviewer" | "mechanical";
export type AgentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDefinition {
	name: string;
	description: string;
	role?: AgentRole;
	model?: string;
	thinking?: AgentThinking;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
}

export class AgentRegistryError extends Error {
	constructor(message: string, readonly validAgents: readonly string[] = []) {
		super(message);
		this.name = "AgentRegistryError";
	}
}

export function defaultAgentDirectory(): string {
	return fileURLToPath(new URL("../agents", import.meta.url));
}

function frontmatterValue(lines: readonly string[], key: string): string | undefined {
	const prefix = `${key}:`;
	const line = lines.find((candidate) => candidate.startsWith(prefix));
	if (line === undefined) return undefined;
	const value = line.slice(prefix.length).trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

export function parseAgentDefinition(filePath: string, source: string): AgentDefinition {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") throw new AgentRegistryError(`Agent definition ${filePath} has no frontmatter`);
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new AgentRegistryError(`Agent definition ${filePath} has unterminated frontmatter`);
	const frontmatter = lines.slice(1, end);
	const name = frontmatterValue(frontmatter, "name");
	const description = frontmatterValue(frontmatter, "description");
	const roleValue = frontmatterValue(frontmatter, "role");
	if (roleValue !== undefined && !["implementer", "reviewer", "mechanical"].includes(roleValue)) {
		throw new AgentRegistryError(`Agent definition ${filePath} has invalid role ${JSON.stringify(roleValue)}`);
	}
	if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		throw new AgentRegistryError(`Agent definition ${filePath} has an invalid name`);
	}
	if (!description) throw new AgentRegistryError(`Agent definition ${filePath} has no description`);
	const toolsValue = frontmatterValue(frontmatter, "tools");
	const tools = toolsValue?.split(",").map((tool) => tool.trim()).filter(Boolean);
	const model = frontmatterValue(frontmatter, "model");
	const thinkingValue = frontmatterValue(frontmatter, "thinking");
	if (thinkingValue !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingValue)) {
		throw new AgentRegistryError(`Agent definition ${filePath} has invalid thinking ${JSON.stringify(thinkingValue)}`);
	}
	return {
		name,
		description,
		...(roleValue === undefined ? {} : { role: roleValue as AgentRole }),
		...(model === undefined ? {} : { model }),
		...(thinkingValue === undefined ? {} : { thinking: thinkingValue as AgentThinking }),
		...(tools === undefined ? {} : { tools }),
		systemPrompt: lines.slice(end + 1).join("\n").trim(),
		filePath,
	};
}

export async function discoverAgents(agentDirectory = defaultAgentDirectory()): Promise<AgentDefinition[]> {
	let entries;
	try {
		entries = await readdir(agentDirectory, { withFileTypes: true });
	} catch (error) {
		throw new AgentRegistryError(`Cannot read agent registry ${agentDirectory}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const agents: AgentDefinition[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(agentDirectory, entry.name);
		agents.push(parseAgentDefinition(filePath, await readFile(filePath, "utf8")));
	}
	const duplicates = agents.map((agent) => agent.name).filter((name, index, names) => names.indexOf(name) !== index);
	if (duplicates.length > 0) throw new AgentRegistryError(`Duplicate agent names in ${agentDirectory}: ${[...new Set(duplicates)].join(", ")}`);
	return agents;
}

export function resolveAgent(agents: readonly AgentDefinition[], requested: string): AgentDefinition {
	const validAgents = agents.map((agent) => agent.name);
	const agent = agents.find((candidate) => candidate.name === requested);
	if (agent !== undefined) return agent;
	throw new AgentRegistryError(
		`Unknown agent ${JSON.stringify(requested)}. Valid agents: ${validAgents.join(", ") || "none"}. Agent names are exact; aliases and typo correction are disabled.`,
		validAgents,
	);
}
