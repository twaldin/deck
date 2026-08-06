/**
 * Agent model selection: agent-pickable config from the deck catalog
 * (Prime harness + deck provider), with FAMILY OPPOSITION as a first-class knob.
 *
 * Captain ruling: adversarial-review / debate nodes must pick the OPPOSITE
 * model family from the producing node. That is enforced here (resolution +
 * preflight validation), not left as a comment.
 */

/**
 * The only provider Deck workflow seats may use. Prime + this provider is
 * Deck's single Smithers engine; direct vendor CLIs are banned because they use
 * ambient local authentication outside the broker boundary.
 */
export const DECK_PROVIDER = "deck";

export type ModelFamily = "anthropic" | "openai" | "zai" | "unknown";
export type ModelSeat = string | { model: string; reasoning?: string };
function modelRef(seat: ModelSeat): string { return typeof seat === "string" ? seat : seat.model; }

export interface ModelRef {
	/** Prime provider id, e.g. "deck". */
	provider: string;
	/** model id within the provider, e.g. "claude-opus-5". */
	model: string;
}

/**
 * The captain's canonical model set - the ONLY models any Deck seat may run.
 *
 * Four, deliberately. The broker exposes thousands and the conversation profile
 * used to admit them with a `deck/*` glob, which is how a seat silently ended up
 * orchestrating on claude-sonnet-4-5 at medium. Every seat, workflow node and
 * rlm child resolves to one of these; the orchestrator picks WHICH one per slot,
 * but never outside this list. Extend deliberately, in lockstep with the broker
 * allowlist AND the conversation profile's enabledModels.
 */
export const DECK_AGENT_CATALOG: readonly string[] = [
	// judgment, adversarial review, orchestration
	"claude-fable-5",
	// judgment fallback, worst case only
	"claude-opus-5",
	// implementation
	"gpt-5.6-sol",
	// mechanical and watch work
	"gpt-5.6-luna",
];

/**
 * Canonical Deck model roles. Reasoning lives beside each role in
 * `defaultModelPolicy()`; these refs are kept for callers that only need the
 * broker selector.
 */
export const DEFAULT_MODELS = {
	implementer: "deck/gpt-5.6-sol",
	reviewer: "deck/claude-fable-5",
	judgmentFallback: "deck/claude-opus-5",
	mechanical: "deck/gpt-5.6-luna",
	watcher: "deck/gpt-5.6-luna",
	fallout: "deck/gpt-5.6-sol",
} as const;

export interface ModelPolicy {
	implementer: ModelSeat;
	/** Optional: when omitted and familyOpposition is on, derived from opposition. */
	reviewer?: ModelSeat;
	/** Cheap workhorse for rebases, mechanical fixes, spawn defaults, and RLM children. */
	mechanical: ModelSeat;
	/** Manual-only fallback for judgment seats; no broker signal currently reaches callers. */
	judgmentFallback: ModelSeat;
	watcher: ModelSeat;
	fallout: ModelSeat;
	reasoning: "low" | "medium" | "high" | "xhigh" | "max";
	reasoningImplementer: ModelPolicy["reasoning"];
	reasoningReviewer: ModelPolicy["reasoning"];
	reasoningMechanical: ModelPolicy["reasoning"];
	reasoningWatcher: ModelPolicy["reasoning"];
	reasoningFallout: ModelPolicy["reasoning"];
	/** First-class knob: reviewer/debate nodes must be the opposite family. */
	familyOpposition: boolean;
	/** Family -> counter model id (deck catalog). Overridable per run. */
	oppositionDefaults: Record<string, string>;
}

export const DEFAULT_OPPOSITION: Record<string, string> = {
	// OpenAI implementation is the normal path: reserve fable for the
	// adversarial judgment seat. A rare Anthropic producer is reviewed by sol.
	anthropic: "deck/gpt-5.6-sol",
	openai: DEFAULT_MODELS.reviewer,
};

export function defaultModelPolicy(): ModelPolicy {
	return {
		implementer: DEFAULT_MODELS.implementer,
		reviewer: DEFAULT_MODELS.reviewer,
		mechanical: DEFAULT_MODELS.mechanical,
		judgmentFallback: DEFAULT_MODELS.judgmentFallback,
		watcher: DEFAULT_MODELS.watcher,
		fallout: DEFAULT_MODELS.fallout,
		reasoning: "xhigh",
		reasoningImplementer: "xhigh",
		reasoningReviewer: "high",
		reasoningMechanical: "xhigh",
		reasoningWatcher: "xhigh",
		reasoningFallout: "xhigh",
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
			`Model "${ref}" must use the ${DECK_PROVIDER} provider (Prime harness + deck broker); got provider "${provider}".`,
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

/** Resolve the provider-qualified selector and effective reasoning as one choice. */
export function resolveSeat(
	ref: ModelSeat,
	fallbackReasoning: ModelPolicy["reasoning"],
): { model: string; reasoning: ModelPolicy["reasoning"] } {
	const selectedReasoning = typeof ref === "string" ? undefined : ref.reasoning;
	if (selectedReasoning !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(selectedReasoning)) {
		throw new Error(`Unsupported model reasoning level "${selectedReasoning}".`);
	}
	return {
		model: modelRef(ref),
		reasoning: (selectedReasoning ?? fallbackReasoning) as ModelPolicy["reasoning"],
	};
}

/**
 * Models a Prime RLM child may deliberately pin, with the reasoning level that
 * belongs to that model in this policy. Later roles win when a profile assigns
 * one model to multiple roles; explicit embedded reasoning wins per role.
 */
export function modelReasoningPolicy(policy: ModelPolicy): Record<string, ModelPolicy["reasoning"]> {
	const reviewer = resolveAdversary(policy.implementer, policy);
	const seats: Array<[ModelSeat, ModelPolicy["reasoning"]]> = [
		[policy.implementer, policy.reasoningImplementer],
		[policy.mechanical, policy.reasoningMechanical],
		[policy.watcher, policy.reasoningWatcher],
		[policy.fallout, policy.reasoningFallout],
		[policy.reviewer ?? reviewer, policy.reasoningReviewer],
		[policy.judgmentFallback, policy.reasoningReviewer],
	];
	return Object.fromEntries(seats.map(([ref, reasoning]) => {
		const resolved = resolveSeat(ref, reasoning);
		const parsed = parseModelRef(resolved.model);
		return [`${parsed.provider}/${parsed.model}`, resolved.reasoning];
	}));
}

/**
 * Validate a model policy. Returns a list of violations (empty = valid).
 * - every ref must be provider "deck" + a catalog model (agent-pickable);
 * - with familyOpposition on, the resolved reviewer must be a DIFFERENT
 *   family than the implementer (cross-model adversarial review).
 */
export function validateModelPolicy(policy: ModelPolicy): string[] {
	const violations: string[] = [];
	const reasoningFields: Array<[string, unknown]> = [
		["reasoning", policy.reasoning],
		["reasoningImplementer", policy.reasoningImplementer],
		["reasoningReviewer", policy.reasoningReviewer],
		["reasoningMechanical", policy.reasoningMechanical],
		["reasoningWatcher", policy.reasoningWatcher],
		["reasoningFallout", policy.reasoningFallout],
	];
	for (const [field, reasoning] of reasoningFields) {
		if (!["low", "medium", "high", "xhigh", "max"].includes(String(reasoning))) {
			violations.push(`models.${field}: unsupported reasoning level ${JSON.stringify(reasoning)}`);
		}
	}
	const refs: Array<[string, string]> = [
		["implementer", modelRef(policy.implementer)],
		["watcher", modelRef(policy.watcher)],
		["fallout", modelRef(policy.fallout)],
		["mechanical", modelRef(policy.mechanical)],
		["judgmentFallback", modelRef(policy.judgmentFallback)],
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
