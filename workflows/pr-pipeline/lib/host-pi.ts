import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
/**
 * Resolve the Pi executable when the workflow process starts. Smithers' PiAgent
 * defaults to the `pi` command from its own runtime, which can be a bundled Pi
 * without Deck's provider registration. The gateway/launcher may provide an
 * explicit absolute path; otherwise resolve the host command from PATH now.
 *
 * A workflow test or graph renderer may not have Pi installed at all. In that
 * case retain the normal command name so rendering remains possible; the real
 * gateway resolves and pins an absolute host path before it serves runs.
 */
export function resolveHostPiBinary(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.DECK_PI_BINARY?.trim();
	if (configured) {
		if (!isAbsolute(configured)) throw new Error(`DECK_PI_BINARY must be an absolute path, got ${configured}`);
		return configured;
	}

	try {
		const path = execFileSync("which", ["pi"], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		return path || "pi";
	} catch {
		return "pi";
	}
}

type AgentCommand = { command: string; [key: string]: unknown };

/** Create a PiAgent-compatible agent that launches the host-selected binary. */
export function createHostPiAgent(Agent: any, opts: any, hostBinary = resolveHostPiBinary()): any {
	const agent = new Agent(opts);
	const buildCommand = agent.buildCommand.bind(agent);
	agent.buildCommand = async (params: any): Promise<AgentCommand> => ({
		...(await buildCommand(params)),
		command: hostBinary,
	});
	return agent;
}
