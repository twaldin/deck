# Task: native server-side compaction (broker + extension)

AUTHORIZED by the captain (prior-art Q3, answered 2026-07-30).

## What this is
Deck's idle-compaction extension only does CLIENT-side compaction: it calls pi's
compactor, which costs a summarization round-trip per parked agent. Both provider
families now have a server-side path, so the round-trip is avoidable.

Evidence (from data/prior-art-mining/report.md section 5a):
- Anthropic: beta `compact-2026-01-12`, `context_management.edits:
  [{type: "compact_20260112"}]`. Trigger is `input_tokens` (default 150k, min 50k).
  The `instructions` parameter FULLY REPLACES the default prompt, so deck's
  parked-agent instructions survive the move. `pause_after_compaction: true`
  returns stop_reason `compaction`, which is the hook the extension wants to verify
  a summary landed before the session parks. Supported across the whole deck Claude
  catalog (fable-5, opus-5/4.8/4.7/4.6, sonnet-5/4.6, mythos).
- OpenAI: `POST responses/compact`, verified in codex-rs source
  (codex-rs/codex-api/src/endpoint/compact.rs:36). Whether it accepts plain
  API-key traffic versus ChatGPT-backend auth is UNKNOWN and is the one thing that
  needs a probe.

## Scope
1. Broker: forward the Anthropic beta header and the `context_management` block.
   The broker is LIVE under launchd (ai.deck.broker); treat it as production.
2. Probe whether `responses/compact` accepts API-key auth, and report the answer.
   Do not build the OpenAI path on a guess.
3. Extension: the `native` engine seam already exists and is reserved
   (extensions/src/idle-compaction-policy.ts:7, "pi 0.82 can execute only client").
   Route Anthropic-family models to native; keep client-side as the fallback for
   everything else. `cacheProviderForModel` already routes config per family.
4. Also worth measuring, possibly instead of summarization for the idle case:
   Anthropic `clear_tool_uses_20250919`. Old tool results are the bulk of a parked
   agent's context, clearing is less lossy than summarizing, and `clear_at_least`
   manages the cache-invalidation economics the extension's TTL logic already models.

## Already landed (do not redo)
The client-side `customInstructions` upgrade is committed: it now names the
identifiers a cold resume cannot reconstruct (task id, worktree, branch, PR URLs
with CI state, the pending decision and its owner, run receipts). That text is what
should be passed to the native `instructions` parameter.

## Acceptance
- A parked Anthropic-family agent compacts server-side, verified against a real
  session rather than a unit test alone.
- The `responses/compact` auth question is answered with evidence.
- Client-side remains the fallback and still works.
- The broker stays up; no change lands without its tests green.
