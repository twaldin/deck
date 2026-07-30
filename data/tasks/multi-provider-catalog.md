# Task: multi-provider model catalog

Follow-up, filed by the captain's direction. Not tonight's work.

## What this is
Deck's model catalog is Anthropic and OpenAI only. Deck is public now, and a public
setup that hardcodes two vendors is less useful than one that does not. Add xAI
(Grok), OpenRouter, and Kimi.

## Where the seams already are
- `broker/src/models.ts` — `DEFAULT_ALLOWLIST` is the broker's allowlist. The
  broker is LIVE under launchd (ai.deck.broker); treat it as production.
- `workflows/pr-pipeline/lib/models.ts` — `DECK_AGENT_CATALOG` is the
  agent-pickable catalog and MUST stay a subset of the broker allowlist.
  `assertDeckModel` guards it; `workflows/pr-pipeline/tests/engine.test.ts` is the
  red-green enforcement.
- `v2/src/spawn.ts` — worker model defaults; currently the fable class.

## Worth deciding while doing it
OpenRouter is a router, not a vendor: it can expose the same model under a
different id than the direct provider. Decide whether a model reachable two ways is
one catalog entry or two, before adding entries.

Adversarial review pairs reviewer against implementer by OPPOSITE model family.
More families make that better, but the pairing logic needs to know which family a
new id belongs to — check it does not silently treat an unknown vendor as "same
family as everything".

## Acceptance
- The new providers work end to end through the broker, verified with a real call
  per provider, not a unit test alone.
- The catalog stays a subset of the allowlist, with the existing test still
  enforcing it.
- Opposite-family review pairing still picks a genuinely different family.
- The broker stays up.
