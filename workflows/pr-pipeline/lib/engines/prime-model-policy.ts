type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ToolCallEvent = {
	type: "tool_call";
	toolName: string;
	input: Record<string, unknown>;
};

type PrimeExtensionContext = {
	model?: { provider: string; id: string };
	sessionManager: { getHeader(): { rlmDepth?: number } | undefined };
};

export type PrimeExtensionApi = {
	on(event: "tool_call", handler: (event: ToolCallEvent) => void): void;
	on(event: "before_agent_start", handler: (_event: unknown, context: PrimeExtensionContext) => void): void;
	setThinkingLevel(level: ThinkingLevel): void;
};

const REASONING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type PrimeRlmModelPolicy = {
	defaultModel: string;
	reasoningByModel: Record<string, ThinkingLevel>;
};

export function readPrimeRlmModelPolicy(
	env: Record<string, string | undefined> = process.env,
): PrimeRlmModelPolicy {
	const defaultModel = env.DECK_RLM_CHILD_MODEL;
	if (defaultModel === undefined || !/^deck\/[A-Za-z0-9._:-]+$/.test(defaultModel)) {
		throw new Error("DECK_RLM_CHILD_MODEL must be an explicit deck/<model> selector");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(env.DECK_RLM_REASONING_BY_MODEL ?? "");
	} catch (error) {
		throw new Error(`DECK_RLM_REASONING_BY_MODEL must be valid JSON: ${String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("DECK_RLM_REASONING_BY_MODEL must be a model-to-reasoning object");
	}
	const reasoningByModel: Record<string, ThinkingLevel> = {};
	for (const [model, reasoning] of Object.entries(parsed)) {
		if (!/^deck\/[A-Za-z0-9._:-]+$/.test(model) || typeof reasoning !== "string" || !REASONING_LEVELS.includes(reasoning as ThinkingLevel)) {
			throw new Error(`Invalid RLM child policy entry ${JSON.stringify(model)}=${JSON.stringify(reasoning)}`);
		}
		reasoningByModel[model] = reasoning as ThinkingLevel;
	}
	if (reasoningByModel[defaultModel] === undefined) {
		throw new Error(`RLM child default ${defaultModel} has no deliberate reasoning level`);
	}
	return { defaultModel, reasoningByModel };
}

/**
 * Prime 0.7 normally inherits both the root model and root reasoning for a bare
 * `rlm(...)`. Deck changes that before the child can issue a provider request:
 * every IPython cell restores a default-model wrapper around the native RLM
 * function, and every child turn applies the reasoning paired with its actual
 * (defaulted or explicitly pinned) model.
 */
export function registerPrimeRlmModelPolicy(
	pi: PrimeExtensionApi,
	env: Record<string, string | undefined> = process.env,
): void {
	const policy = readPrimeRlmModelPolicy(env);
	const defaultModelLiteral = JSON.stringify(policy.defaultModel);
	const prelude = [
		"import rlm as _deck_rlm_module",
		`if getattr(_deck_rlm_module.run, "__deck_default_model__", None) != ${defaultModelLiteral}:`,
		"    _deck_original_rlm_run = getattr(_deck_rlm_module.run, \"__deck_original_run__\", _deck_rlm_module.run)",
		"    async def _deck_policy_rlm_run(prompt, **kwargs):",
		`        if kwargs.get("model") is None: kwargs["model"] = ${defaultModelLiteral}`,
		"        return await _deck_original_rlm_run(prompt, **kwargs)",
		`    _deck_policy_rlm_run.__deck_default_model__ = ${defaultModelLiteral}`,
		"    _deck_policy_rlm_run.__deck_original_run__ = _deck_original_rlm_run",
		"    _deck_rlm_module.run = _deck_policy_rlm_run",
	].join("\n");

	pi.on("tool_call", (event) => {
		if (event.toolName !== "ipython" || typeof event.input.code !== "string") return;
		const code = event.input.code;
		if (code.trimStart().startsWith("%%")) {
			throw new Error("IPython cell magics are disabled in Prime seats because Deck cannot enforce RLM child policy inside them");
		}
		if (/^\s*from\s+__future__\s+import\b/m.test(code)) {
			const otherExecutableLines = code
				.split("\n")
				.map((line) => line.trim())
				.filter((line) =>
					line !== ""
					&& !line.startsWith("#")
					&& !/^from __future__ import [A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(line)
				);
			if (otherExecutableLines.length > 0) {
				throw new Error("Put future imports in their own IPython cell so Deck can enforce RLM child policy in executable cells");
			}
			return;
		}
		event.input.code = `${prelude}\n${code}`;
	});
	pi.on("before_agent_start", (_event, context) => {
		const depth = context.sessionManager.getHeader()?.rlmDepth ?? 0;
		if (depth <= 0) return;
		const model = context.model;
		if (model === undefined) throw new Error("Prime RLM child has no selected model");
		const modelRef = `${model.provider}/${model.id}`;
		const reasoning = policy.reasoningByModel[modelRef];
		if (reasoning === undefined) {
			throw new Error(`Prime RLM child model ${modelRef} has no deliberate reasoning level in ModelPolicy`);
		}
		pi.setThinkingLevel(reasoning);
	});
}

export default function primeRlmModelPolicy(pi: PrimeExtensionApi): void {
	registerPrimeRlmModelPolicy(pi);
}
