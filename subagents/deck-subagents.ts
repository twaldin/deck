import { Type, type TSchema } from "typebox";
import {
	CATALOG_MODEL_SELECTORS,
	MODEL_PICK_GUIDANCE,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./lib/model-registry.ts";
import {
	DEFAULT_MAX_RUNTIME_MS,
	DEFAULT_STALL_TIMEOUT_MS,
	spawnSubagent,
	YIELD_MARKER,
} from "./lib/spawn.ts";

interface ToolContext {
	cwd: string;
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

interface ExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: TSchema;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: ToolResult) => void) | undefined,
			context: ToolContext,
		): Promise<ToolResult>;
	}): void;
}

const SubagentParameters = Type.Object({
	agent: Type.String({ description: "Exact registered agent name. Typos and aliases are rejected with the valid list." }),
	task: Type.String({ minLength: 1, description: "Complete, self-contained assignment for the child." }),
	model: Type.Optional(Type.String({ description: `Exact Deck broker model selector. Valid catalog: ${CATALOG_MODEL_SELECTORS.join(", ")}. Omit to use the agent's validated default.` })),
	thinking: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	], { description: "Pi reasoning level; unsupported model/level pairs fail before spawn." })),
	stallTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: `No-output stall timeout in milliseconds. Default: ${DEFAULT_STALL_TIMEOUT_MS}.` })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: `Wall-clock runtime limit in milliseconds. Default: ${DEFAULT_MAX_RUNTIME_MS}.` })),
});

const YieldParameters = Type.Object({
	filesTouched: Type.Array(Type.String(), { description: "Repository-relative files created, edited, moved, or deleted; empty for read-only work." }),
	summary: Type.String({ minLength: 1, description: "Concise completed-work handoff to the parent." }),
});

function asOptionalPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}


export default function deckSubagents(pi: ExtensionApi): void {
	if (process.env.DECK_SUBAGENT_CHILD === "1") {
		pi.registerTool({
			name: "deck_subagent_yield",
			label: "Yield to parent",
			description: "Required terminal handoff for a Deck subagent. Call exactly once after completing the task.",
			parameters: YieldParameters,
			async execute(_toolCallId, params) {
				const filesTouched = Array.isArray(params.filesTouched) ? params.filesTouched.filter((file): file is string => typeof file === "string") : [];
				const summary = typeof params.summary === "string" ? params.summary.trim() : "";
				const payload = { filesTouched: [...new Set(filesTouched)], summary };
				return {
					content: [{ type: "text", text: `${YIELD_MARKER}${JSON.stringify(payload)}` }],
					details: { deckSubagentYield: payload },
					isError: summary.length === 0,
				};
			},
		});
		return;
	}

	pi.registerTool({
		name: "subagent",
		label: "Deck subagent",
		description: [
			"Spawn one headless pi child in the parent session's current working directory. Agent and model names are registry-validated exactly before spawn; invalid input returns the valid list and never launches a child.",
			MODEL_PICK_GUIDANCE,
			"Agent definitions are rediscovered at execution time; an invalid name returns the current valid list.",
			`Liveness is stdout/stderr activity. No output for stallTimeoutMs (default ${DEFAULT_STALL_TIMEOUT_MS}ms) sends SIGTERM, then SIGKILL after a grace period, and returns a structured stalled result. Concurrency is process-capped (default 4).`,
			"Success requires a structured child yield containing filesTouched and summary; every result also includes exitStatus.",
		].join(" "),
		parameters: SubagentParameters,
		async execute(_toolCallId, params, signal, onUpdate, context) {
			const agent = typeof params.agent === "string" ? params.agent : "";
			const task = typeof params.task === "string" ? params.task : "";
			const model = typeof params.model === "string" ? params.model : undefined;
			let lastUpdateAt = 0;
			const result = await spawnSubagent({
				agent,
				task,
				cwd: context.cwd,
				...(model === undefined ? {} : { model }),
				thinking: asThinkingLevel(params.thinking),
				stallTimeoutMs: asOptionalPositiveInteger(params.stallTimeoutMs),
				maxRuntimeMs: asOptionalPositiveInteger(params.maxRuntimeMs),
				signal,
				onActivity(lastActivityAt) {
					const now = Date.now();
					if (onUpdate === undefined || now - lastUpdateAt < 1_000) return;
					lastUpdateAt = now;
					onUpdate({
						content: [{ type: "text", text: JSON.stringify({ status: "running", agent, model: model ?? "agent-default", lastActivityAt }) }],
						details: { status: "running", agent, lastActivityAt },
					});
				},
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result as unknown as Record<string, unknown>,
				isError: !result.ok,
			};
		},
	});
}

export { spawnSubagent } from "./lib/spawn.ts";
export type { SpawnSubagentRequest, SubagentResult } from "./lib/spawn.ts";
