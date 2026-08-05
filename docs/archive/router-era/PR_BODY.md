## Verdict

Named reasoning preserves the requested selector from the profile to every Pi seat and then converts it at the broker wire boundary.

## Evidence

- Pi 0.82.0 supports the full `off|minimal|low|medium|high|xhigh|max` selector. The local Smithers compatibility cast preserves `max` at the PiAgent boundary.
- `v2/src/spawn.ts` gives explicit reasoning precedence over legacy `thinking` and passes it to Pi.
- `v2/test/spawn-alloc.test.ts` proves invalid reasoning is rejected and explicit `high` overrides a profile `low` default.
- `workflows/pr-pipeline/tests/pipeline.test.tsx` proves profile `max` reaches implementer, reviewer, watcher, and fallout PiAgent seats.
- Broker tests prove OpenAI, xAI, and Anthropic provider-native wire shapes, including rejection of invalid xAI input.
- Broker reasoning tests prove downward clamping, including sparse `[low, high]` capabilities.

## Verification

The required reasoning tests pass. This file is the exact body to use when creating the pull request.
