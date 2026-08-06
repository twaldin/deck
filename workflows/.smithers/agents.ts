// smithers-source: deck-owned (was: generated)
//
// Shared Smithers seats derive exclusively from Deck's canonical model policy.
// Direct vendor CLIs and standing judgment fallbacks are intentionally absent.
import type { AgentLike } from "smithers-orchestrator";
import { PrimeSeatAgent } from "../pr-pipeline/lib/engines/prime.ts";
import {
  assertDeckModel,
  defaultModelPolicy,
  parseModelRef,
  type ModelSeat,
} from "../pr-pipeline/lib/models.ts";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const cwd = process.env.DECK_SMITHERS_SEAT_CWD ?? process.cwd();
const modelPolicy = defaultModelPolicy();

function deckAgent(seat: ModelSeat, thinking: Thinking): PrimeSeatAgent {
  const ref = typeof seat === "string" ? seat : seat.model;
  assertDeckModel(ref);
  const { provider, model } = parseModelRef(ref);
  return new PrimeSeatAgent({
    provider,
    model,
    thinking,
    cwd,
    effortLabel: "smithers-pack",
    timeoutMs: 45 * 60_000,
    modelPolicy,
  });
}

export const providers = {
  implementer: deckAgent(modelPolicy.implementer, modelPolicy.reasoningImplementer),
  reviewer: deckAgent(modelPolicy.reviewer ?? modelPolicy.oppositionDefaults.openai!, modelPolicy.reasoningReviewer),
  mechanical: deckAgent(modelPolicy.mechanical, modelPolicy.reasoningMechanical),
  watcher: deckAgent(modelPolicy.watcher, modelPolicy.reasoningWatcher),
  fallout: deckAgent(modelPolicy.fallout, modelPolicy.reasoningFallout),
} as const;

export const agents = {
  cheapFast: [providers.mechanical],
  research: [providers.mechanical],
  implement: [providers.implementer],
  midTier: [providers.mechanical],
  smartTool: [providers.mechanical],
  validate: [providers.reviewer],
  smart: [providers.reviewer],
  review: [providers.reviewer],
  planning: [providers.reviewer],
  orchestrator: [providers.reviewer],
} as const satisfies Record<string, AgentLike[]>;
