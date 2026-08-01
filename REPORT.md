# Reasoning control report

## Verdict
Pi `--thinking` is a named reasoning-effort selector, not a token cap. Deck's gateway converts the selector to provider-native wire fields. Anthropic uses `thinking.budget_tokens`; OpenAI and xAI use `reasoning_effort`.

## Evidence
- `v2/src/spawn.ts` forwards the selected level as Pi `--thinking`.
- `broker/src/validated-gateway.ts` forwards provider-native fields.
- `broker/src/reasoning.ts` defines the provider wire types and per-model supported levels.
- `broker/pi/deck-provider.ts` advertises model-level supported levels to Pi.

## Pi harness decision
No pi-harness change is required. The existing Pi provider metadata path already supports `thinkingLevelMap`; this change supplies accurate model capabilities and keeps provider-native conversion in the Deck gateway. This decision is parked here for captain review.
