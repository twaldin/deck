# Reasoning control report

## Verdict
Named reasoning is validated at the CLI, selected from the explicit request before legacy thinking, passed to Pi with `--thinking`, and converted by the gateway to the provider-native wire field. Anthropic named levels become `thinking: {type: "enabled", budget_tokens}`. OpenAI and xAI use `reasoning_effort`.

## Wire and type evidence
- Pi's installed TypeScript API defines the `ThinkingLevel` vocabulary and `Model.thinkingLevelMap`; the Deck provider registers the same map in `broker/pi/deck-provider.ts`. This is the type and metadata boundary that controls which Pi values can be sent.
- Pi's `clampThinkingLevel` applies `thinkingLevelMap` before the request is built. The OpenAI-completions implementation then writes the mapped value as `reasoning_effort` in the outbound payload. This is why Deck's OpenAI-compatible Claude route stays on `reasoning_effort`.
- `v2/src/cli.ts` parses and validates `--reasoning`; `v2/src/spawn.ts:launchRun` chooses the explicit request before legacy `thinking` and passes the selected value to Pi as `--thinking`.
- `broker/src/validated-gateway.ts` classifies explicit `anthropic/...` model routes as Anthropic, validates and clamps the selector, and emits Anthropic `thinking` budgets. Explicit xAI routes emit xAI `reasoning_effort`; other routes emit OpenAI `reasoning_effort`.
- `broker/pi/deck-provider.ts` maps every advertised Pi level to a supported wire selector. Unsupported model levels map to the nearest supported selector instead of being advertised as null.

## End-to-end evidence
`v2/test/spawn-alloc.test.ts` invokes the CLI validation path, launches a fake Pi executable, captures its actual argv, and verifies explicit reasoning overrides a profile's legacy reasoning value. The gateway tests verify the three provider-native payload shapes and rejection of invalid xAI input. These tests are dependency-gated and must run with the repository dependencies installed.

## Delivery
The implementation is committed on `deck/reasoning-control/V1`. A PR body must include this report's verdict and wire/type evidence. This worktree instruction forbids pushing, so PR creation is an external delivery step and is not claimed here.
