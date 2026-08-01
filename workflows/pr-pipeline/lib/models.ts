/**
 * Agent model selection: agent-pickable config from the deck catalog
 * (pi harness + deck provider), with FAMILY OPPOSITION as a first-class knob.
 *
 * Captain ruling: adversarial-review / debate nodes must pick the OPPOSITE
 * model family from the producing node. That is enforced here (resolution +
 * preflight validation), not left as a comment.
 */

/**
 * The only pi provider deck workflows may use. Pi + this provider is deck's
 * single Smithers engine; direct codex / claude-code CLI engines are banned
 * because they use mono-account auth and ambient local CLI config.
 */
export const DECK_PROVIDER = "deck";

export type ModelFamily = "anthropic" | "openai" | "zai" | "unknown";
export type ModelSeat = string | { model: string; reasoning?: string };
function modelRef(seat: ModelSeat): string { return typeof seat === "string" ? seat : seat.model; }

export interface ModelRef {
	/** pi provider id, e.g. "deck". */
	provider: string;
	/** model id within the provider, e.g. "claude-opus-5". */
	model: string;
}

/**
 * Agent-pickable slice of the deck catalog (mirrors broker/src/models.ts
 * DEFAULT_ALLOWLIST). Workflow agents may only be configured with these ids;
 * anything else fails preflight. Extend deliberately, in lockstep with the
 * broker allowlist.
 */
export const DECK_AGENT_CATALOG: readonly string[] = [
	// anthropic
	"claude-fable-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-haiku-4-5",
	// openai (codex family)
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
];

/**
 * Captain policy 2026-07-31: luna implements/watches (high TPS); sol is the
 * only big openai seat; fable reviews/architects/adversaries. No terra in
 * defaults. opus-5/sonnet-5 stay catalog-only last resorts (token-heavy).
 */
export const DEFAULT_MODELS = {
	// Captain 2026-07-31: luna = bread-and-butter high-TPS work; sol = big/smart
	// openai only (no terra); fable = reviewer/architect/adversary. opus/sonnet
	// stay catalog-only last resorts.
	implementer: "deck/gpt-5.6-luna",
	reviewer: "deck/claude-fable-5",
	watcher: "deck/gpt-5.6-luna",
	fallout: "deck/gpt-5.6-sol",
} as const;

export interface ModelPolicy {
	implementer: ModelSeat;
	/** Optional: when omitted and familyOpposition is on, derived from opposition. */
	reviewer?: ModelSeat;
	watcher: ModelSeat;
	fallout: ModelSeat;
	reasoning: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningImplementer: ModelPolicy["reasoning"];
	reasoningReviewer: ModelPolicy["reasoning"];
	reasoningWatcher: ModelPolicy["reasoning"];
	reasoningFallout: ModelPolicy["reasoning"];
	/** First-class knob: reviewer/debate nodes must be the opposite family. */
	familyOpposition: boolean;
	/** Family -> counter model id (deck catalog). Overridable per run. */
	oppositionDefaults: Record<string, string>;
}

export const DEFAULT_OPPOSITION: Record<string, string> = {
	// Opposite-family adversary. OpenAI producer -> fable review; anthropic
	// producer (rare under new defaults) -> sol review.
	anthropic: "deck/gpt-5.6-sol",
	openai: "deck/claude-fable-5",
};

export function defaultModelPolicy(): ModelPolicy {
	return {
		implementer: DEFAULT_MODELS.implementer,
		reviewer: DEFAULT_MODELS.reviewer,
		watcher: DEFAULT_MODELS.watcher,
		fallout: DEFAULT_MODELS.fallout,
		reasoning: "medium",
		reasoningImplementer: "medium",
		reasoningReviewer: "medium",
		reasoningWatcher: "medium",
		reasoningFallout: "medium",
		familyOpposition: true,
		oppositionDefaults: { ...DEFAULT_OPPOSITION },
	};
}

/** "deck/claude-opus-5" -> { provider: "deck", model: "claude-opus-5" }. */
export function parseModelRef(ref: string): ModelRef {
	const idx = ref.indexOf("/");
	if (idx <= 0) return { provider: "deck", model: ref };
	return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

/**
 * Throw unless `ref` is an agent-pickable deck model (`deck/<catalog model>`).
 * Use at agent-construction time so a bad seat fails at import, not mid-run.
 */
export function assertDeckModel(ref: string): void {
	const { provider, model } = parseModelRef(ref);
	if (provider !== DECK_PROVIDER) {
		throw new Error(
			`Model "${ref}" must use the ${DECK_PROVIDER} provider (pi harness + deck broker); got provider "${provider}".`,
		);
	}
	if (!DECK_AGENT_CATALOG.includes(model)) {
		throw new Error(
			`Model "${ref}" is not in the agent-pickable deck catalog: [${DECK_AGENT_CATALOG.join(", ")}].`,
		);
	}
}

export function modelFamily(ref: ModelSeat): ModelFamily {
	const { model } = parseModelRef(modelRef(ref));
	if (model.startsWith("claude-")) return "anthropic";
	if (model.startsWith("gpt-")) return "openai";
	if (model.startsWith("glm-")) return "zai";
	return "unknown";
}

/**
 * Resolve the adversary (reviewer/debate opponent) for a producer model.
 * Explicit reviewer config wins; otherwise the opposition map supplies the
 * opposite-family default. Throws when opposition is on and no opposite-family
 * model can be derived.
 */
export function resolveAdversary(producerRef: ModelSeat, policy: ModelPolicy): string {
	if (policy.reviewer !== undefined && modelRef(policy.reviewer) !== "") return modelRef(policy.reviewer);
	if (!policy.familyOpposition) return DEFAULT_MODELS.reviewer;
	const family = modelFamily(producerRef);
	const counter = policy.oppositionDefaults[family];
	if (counter === undefined) {
		throw new Error(
			`familyOpposition is on but no opposition default exists for family "${family}" (producer ${producerRef}). Add models.oppositionDefaults["${family}"].`,
		);
	}
	return counter;
}

/**
 * Validate a model policy. Returns a list of violations (empty = valid).
 * - every ref must be provider "deck" + a catalog model (agent-pickable);
 * - with familyOpposition on, the resolved reviewer must be a DIFFERENT
 *   family than the implementer (cross-model adversarial review).
 */
export function validateModelPolicy(policy: ModelPolicy): string[] {
	const violations: string[] = [];
	const refs: Array<[string, string]> = [
		["implementer", modelRef(policy.implementer)],
		["watcher", modelRef(policy.watcher)],
		["fallout", modelRef(policy.fallout)],
	];

	let reviewer: string | null = null;
	try {
		reviewer = resolveAdversary(policy.implementer, policy);
		refs.push(["reviewer", reviewer]);
	} catch (err) {
		violations.push(err instanceof Error ? err.message : String(err));
	}

	for (const [role, ref] of refs) {
		try {
			assertDeckModel(ref);
		} catch (err) {
			violations.push(`models.${role}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (reviewer !== null && policy.familyOpposition) {
		const producerFamily = modelFamily(policy.implementer);
		const reviewerFamily = modelFamily(reviewer);
		if (producerFamily === reviewerFamily) {
			violations.push(
				`familyOpposition is on but reviewer "${reviewer}" is the same family (${reviewerFamily}) as implementer "${policy.implementer}". Pick an opposite-family reviewer or set models.familyOpposition=false explicitly.`,
			);
		}
	}

	return violations;
}
