// smithers-source: deck-owned (was: generated)
//
// Deck runs Smithers on ONE engine: pi. Every seat below is a `PiAgent` with
// provider "deck", so all model traffic goes through the deck broker (broker
// auth, deck/* model ids, quota-aware routing). The direct `codex` and
// `claude-code` CLI engines are deliberately absent: they authenticate as a
// mono-account and pick up whatever local CLI config happens to exist.
//
// Fallback order inside a seat still crosses model FAMILIES (anthropic <->
// openai), which is what the seats actually wanted; it just no longer crosses
// engines.
import { type AgentLike, PiAgent } from "smithers-orchestrator";
import { assertDeckModel, DECK_PROVIDER } from "../pr-pipeline/lib/models.ts";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** One pi seat on the deck provider. Rejects any non-catalog model at import. */
function deckAgent(model: string, thinking: Thinking): PiAgent {
  assertDeckModel(`${DECK_PROVIDER}/${model}`);
  return new PiAgent({ provider: DECK_PROVIDER, model, thinking, noSession: true });
}

export const providers = {
  claudeOpus: deckAgent("claude-opus-5", "high"),
  claudeSonnet: deckAgent("claude-sonnet-5", "medium"),
  claudeHaiku: deckAgent("claude-haiku-4-5", "off"),
  gptSol: deckAgent("gpt-5.6-sol", "xhigh"),
  gptTerra: deckAgent("gpt-5.6-terra", "medium"),
  gptLuna: deckAgent("gpt-5.6-luna", "medium"),
} as const;

export const agents = {
  // Later entries are runtime fallbacks, invoked only if every earlier attempt fails.
  cheapFast: [providers.gptLuna, providers.claudeHaiku, providers.claudeSonnet],
  research: [providers.gptLuna, providers.claudeSonnet],
  implement: [providers.gptTerra, providers.claudeSonnet],
  midTier: [providers.gptTerra, providers.claudeSonnet],
  smartTool: [providers.gptTerra, providers.claudeSonnet],
  validate: [providers.gptTerra, providers.claudeSonnet],
  smart: [providers.gptSol, providers.claudeOpus],
  review: [providers.gptSol, providers.claudeOpus, providers.claudeSonnet],
  // Anthropic leads the orchestrating/gating seats; gpt is the fallback.
  planning: [providers.claudeOpus, providers.gptSol, providers.claudeSonnet],
  orchestrator: [providers.claudeOpus, providers.gptSol],
} as const satisfies Record<string, AgentLike[]>;
