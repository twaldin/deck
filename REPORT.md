# Reasoning control report

## Verdict
Reasoning is a named effort selector. Pi passes the selected level through `--thinking`; the Deck gateway validates, clamps to the model capability set, and emits the provider-native field. Anthropic levels become `thinking: {type: "enabled", budget_tokens}`. OpenAI and xAI use `reasoning_effort`.

## Wire and type evidence
- `v2/src/spawn.ts:piArgs` appends `--thinking <level>` and `launchRun` chooses `request.reasoning` before legacy `request.thinking`.
- `broker/src/reasoning.ts:nativeReasoning` maps Anthropic `low/medium/high/xhigh/max` to 4096/8192/16384/32768/65536 token budgets. It maps OpenAI and xAI to `reasoning_effort`.
- `broker/src/validated-gateway.ts` reads `reasoning_effort` or `reasoning.effort`, validates the runtime string, clamps against `supportedReasoning(modelId, provider)`, deletes the generic fields, and writes the native field.
- The gateway classifies Deck Claude models as OpenAI-compatible because Deck registers them with `api: "openai-completions"`; only explicit Anthropic provider routes use Anthropic conversion.
- `broker/pi/deck-provider.ts` maps every advertised Pi level to a supported wire selector. Unsupported model requests are mapped to the nearest supported selector instead of being advertised as `null` and rejected before the gateway.
- Tests prove named Anthropic conversion, xAI per-model clamping, Deck Claude OpenAI routing, invalid effort rejection, Pi argument construction, and profile-to-seat propagation.

## Pi-harness decision
Decision: keep the existing Pi provider metadata path and provide non-null nearest-supported mappings. This is now implemented and tested in `broker/pi/deck-provider.ts`; no Pi harness source change is required. The remaining delivery decision is captain review of the branch/PR. No PR was opened because this worktree instruction forbids push.
