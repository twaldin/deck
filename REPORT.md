# Reasoning control report

## Verdict
Named reasoning is validated at the CLI, selected from the explicit request before legacy thinking, passed to Pi as `--thinking`, and converted by the broker gateway to the provider-native wire field. Pi's thinking level is a **named reasoning/effort selector**, not a token cap and not itself a native `reasoning_effort` field. The gateway performs the provider conversion: Anthropic uses `thinking.type="enabled"` with `budget_tokens`; OpenAI-compatible and xAI routes use `reasoning_effort`.

## Wire and type evidence
- Installed Pi source: `/Users/twaldin/.bun/install/cache/@oh-my-pi/pi-agent-core@17.0.1@@@1/src/thinking.ts:8-20` defines the `ThinkingLevel` vocabulary. Installed Pi model-resolution source: `/Users/twaldin/.bun/install/cache/@oh-my-pi/pi-catalog@17.2.2@@@1/src/model-thinking.ts:715-730` clamps requested effort to model capabilities. These are the Pi type and model-capability boundaries.
- The pinned Smithers type is auditable in `workflows/pr-pipeline/node_modules/smithers-orchestrator/docs/llms-full.txt:8516`: `PiAgent.thinking` accepts `off|minimal|low|medium|high|xhigh`. Therefore pipeline profile `max` is deliberately translated to Pi `xhigh` in `workflows/pr-pipeline/pipeline.tsx:417-429`; the broker remains the final wire boundary.
- `broker/pi/deck-provider.ts:7,52-101` registers `thinkingLevelMap`, including the per-model mapping for `max`; `broker/src/validated-gateway.ts:30-50` selects provider routing, clamps supported levels, and builds the outbound payload; `broker/src/reasoning.ts:44-62` converts selectors to native fields and rejects unsupported xAI values.
- `v2/src/cli.ts:33-36,229` validates `--reasoning`; `v2/src/spawn.ts:373-374` gives explicit reasoning precedence over legacy `thinking` and passes it to Pi.

## End-to-end evidence
`v2/test/spawn-alloc.test.ts:89-106` supplies required `--accept`, proves invalid reasoning reaches the reasoning validator, then launches a fake Pi and captures the explicit `high` argv over a profile `low` default. `workflows/pr-pipeline/tests/pipeline.test.tsx` renders the real pipeline and inspects the constructed implementer PiAgent options; it proves profile `max` reaches that seat as Pi-compatible `xhigh`. `broker/test/validated-gateway.test.ts` proves OpenAI, xAI, and Anthropic wire shapes and rejects invalid xAI input.

## Delivery
This report is the evidence text for the PR body. The current worktree instruction forbids pushing, so no PR is created from this worktree.
