# Deck pi extensions

## Idle compaction

`src/idle-compaction.ts` proactively compacts a parked pi session while its
provider prompt cache should still be warm. It targets long-lived primaries,
secondmates, and crew that repeatedly work and park without exiting.

Pi 0.82's own auto-compaction is intentionally late: it runs when
`contextTokens > contextWindow - reserveTokens`. Idle compaction is a separate,
earlier policy:

```
idle >= cache TTL - safety margin
AND context >= configured percentage of the model window
AND pi is fully idle, has no pending messages, and has no in-flight tools
```

For Anthropic's default 5-minute ephemeral cache and the extension defaults,
that means compacting after 4 minutes idle. The summary request can read the old
prefix through the still-warm cache, then future turns use a smaller context.
This lowers subsequent input cost and latency and keeps long-lived agents out of
the high-context quality-degradation zone.

The extension uses pi's sanctioned `ExtensionContext.compact()` API. It never
injects `/compact` keystrokes and never shells out to another pi process.

### Install

From a deck checkout, run the installer:

```bash
./extensions/install.sh
# safe test target:
INSTALL_TARGET="$(mktemp -d)" ./extensions/install.sh
```

It installs a **directory** extension, symlinking both source files into it:

```
~/.pi/agent/extensions/deck-idle-compaction/
├── index.ts                  -> extensions/src/idle-compaction.ts
└── idle-compaction-policy.ts -> extensions/src/idle-compaction-policy.ts
```

The directory layout is required, not cosmetic. Pi discovers both
`extensions/*.ts` and `extensions/*/index.ts`, so a single flat
`deck-idle-compaction.ts` symlink resolves its relative
`./idle-compaction-policy` import next to the *symlink* rather than next to the
real source, and the import fails. Adding a flat sibling symlink beside it fails
differently: pi discovers that sibling as its own top-level extension and
rejects it with `does not export a valid factory`. Inside one extension
directory only `index.ts` is an entrypoint, so the sibling stays a plain import
target. Reruns of the installer converge.

Then start a new pi process or run `/reload`. This repository does **not**
install the extension automatically. For a one-off trial without installation:

```bash
pi --no-extensions -e ./extensions/src/idle-compaction.ts
```

### Configuration

All timing values are milliseconds. Environment variables apply to the pi
process and are useful for persistent-agent launchers.

| Variable | Default | Meaning |
|---|---:|---|
| `PI_IDLE_COMPACTION` | `true` | Set `0`, `false`, `no`, or `off` to opt this process/session out. |
| `PI_IDLE_COMPACTION_ENGINE` | `client` | `client` uses pi compaction. `native` is a deliberately inert future-engine seam. |
| `PI_IDLE_COMPACTION_TTL_MS` | `300000` | Provider prompt-cache TTL. |
| `PI_IDLE_COMPACTION_MARGIN_MS` | `60000` | Compact this long before TTL expiry; must be less than TTL. |
| `PI_IDLE_COMPACTION_FLOOR_PERCENT` | `30` | Minimum current context as a percentage of the active model's window. |
| `PI_IDLE_COMPACTION_MIN_GROWTH_TOKENS` | `1024` | Absolute minimum growth above the post-compaction estimate before another idle compaction. |
| `PI_IDLE_COMPACTION_MIN_GROWTH_PERCENT` | `5` | Window-relative minimum growth; the effective gate is the larger token/percentage value. |
| `PI_IDLE_COMPACTION_MIN_INTERVAL_MS` | `240000` | Cooldown between compactions, independent of context growth. |
| `PI_IDLE_COMPACTION_RETRY_MS` | `60000` | Initial retry delay when usage is temporarily unknown or compaction fails. Failures back off exponentially. |
| `PI_IDLE_COMPACTION_MAX_RETRIES` | `2` | Maximum retries after the initial failure for one unchanged context marker (0–10). |
| `PI_IDLE_COMPACTION_NOTIFY` | `true` | Show start/completion/failure notifications when UI is available. |

For a one-session opt-out, use either the environment variable or extension
flag:

```bash
PI_IDLE_COMPACTION=0 pi
pi --no-idle-compaction
```

Provider TTLs differ. Set the TTL to the cache policy of the provider/model path
that pi actually uses; the built-in value encodes the current Anthropic
5-minute default rather than pretending all providers have the same cache.

### Safety and interaction with pi auto-compaction

- The deadline is based on the latest successful provider response, the last
  moment the prompt cache was known to be touched. Startup/resume alone never
  arms a timer: a 2xx `after_provider_response` is provisional until `turn_end`
  confirms a non-error/non-aborted stream, and the timer arms only after
  `agent_settled`. Cache warmth is scoped to that run and exact
  provider/model/base URL; aborted/failed later requests and `model_select`
  invalidate it. The extension will not pay for a known-cold compaction merely
  because an old session was resumed and left untouched.
- `before_agent_start`, `agent_start`, and tool start cancel the timer. The
  callback checks `ctx.isIdle()`, pending messages, and in-flight tools again
  immediately before `ctx.compact()`. This matters because pi 0.82's manual
  compaction path aborts an active turn before summarizing.
- `session_before_compact` marks any compaction in flight, including `/compact`
  and other extensions, so the idle timer cannot race it. Every completion is
  observed through `session_compact`. If pi's threshold or overflow
  auto-compaction runs first, this extension records its context marker and
  stands down instead of compacting the same context again.
- Successful idle compaction persists a branch-local custom state entry with
  the compacted context marker and post-compaction token estimate. An unchanged
  parked session therefore does not compact on every idle interval, including
  after reload/resume. New context must appear and satisfy the cooldown, window-
  relative growth, absolute growth, and floor checks.
- Unknown usage and compaction errors share bounded exponential retries. After
  the configured retry count, the extension stands down until a new context
  marker appears; a parked agent can never spin forever on unavailable usage,
  bad auth, an outage, or an uncompactionable context.
- Pi still owns summary generation, cut-point selection, `keepRecentTokens`,
  overflow recovery, session JSONL writes, and usage accounting. Existing pi
  compaction settings continue to control those mechanics.

### Verification

`test/installers.test.ts` covers the *installed layouts* for both this extension
and `ponytail/` by running the real installers into a temp `INSTALL_TARGET`. It
deliberately probes through **node**, not bun: pi ships as a
`#!/usr/bin/env node` CLI, and bun's loader is forgiving enough about CommonJS
under a `"type": "module"` package that a bun-only assertion passes even with
the packaging bug present. Set `DECK_TEST_NODE` to pin a specific node binary.

Unit tests use an injected fake clock and fake pi lifecycle/context objects; no
LLM is contacted:

```bash
cd extensions
bun install --frozen-lockfile
bun test
bunx tsc -p tsconfig.json --noEmit
```

The opt-in real smoke loads the extension by explicit path (not through
`~/.pi`), builds context through RPC, waits at a shortened warm-cache deadline,
and captures bounded transcript plus session-JSONL evidence:

```bash
cd extensions
bun run smoke/run-idle-compaction-smoke.ts

# or against an INSTALLED layout, which also proves the installed directory's
# relative policy import resolves inside a real pi process:
SMOKE_EXTENSION_PATH=~/.pi/agent/extensions/deck-idle-compaction \
  bun run smoke/run-idle-compaction-smoke.ts
```

The committed smoke evidence in `smoke/evidence/` was produced by pi 0.82 with
`deck/claude-haiku-4-5`. It records the idle notification, `compaction_start`,
`compaction_end`, the before/after estimates, and the actual `compaction` and
`deck.idle-compaction.v1` JSONL entries. The disposable full session file is
excluded.

## Investigation: provider-native compaction engine

Provider-native compaction is promising, but it is not interchangeable with
pi's session compaction and is not reachable through today's `provider=deck`
path. Client-side pi compaction remains the default and only enabled engine.
`PI_IDLE_COMPACTION_ENGINE` is the explicit seam for adding a native engine
later; selecting `native` today emits a warning and does nothing rather than
silently falling back or corrupting a session.

### OpenAI Responses

OpenAI exposes two related Responses mechanisms:

1. Add `context_management: [{ type: "compaction", compact_threshold: ... }]`
   to `POST /v1/responses`; when the rendered context crosses the threshold, the
   response stream emits an encrypted compaction item.
2. Call the stateless `POST /v1/responses/compact` endpoint with the full input
   window and pass its returned canonical output window as-is into later
   Responses calls.

The compaction item is opaque `encrypted_content`, not a human-readable summary.
That can preserve provider reasoning state, but it cannot directly become pi's
transparent `CompactionEntry.summary`, and pi must retain the provider's full
canonical output shape rather than pruning it as if it were an ordinary message.
See [OpenAI's compaction guide](https://developers.openai.com/api/docs/guides/compaction)
and [compact endpoint reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/compact/).

### Anthropic Messages beta

Anthropic's server-side compaction beta uses the `compact-2026-01-12` beta
header and a `context_management.edits` strategy of type
`compact_20260112`. It triggers at an input-token threshold (minimum 50k), may
pause after compaction, reports per-iteration usage, and emits a transparent
`compaction` content block whose summary is sent back on later requests. This is
closer to pi's visible summary model, but it is still a provider wire-format
block with streaming, stop-reason, caching, and usage semantics that pi 0.82
does not model. See [Anthropic's compaction documentation](https://platform.claude.com/docs/en/build-with-claude/compaction)
(and the equivalent [Bedrock integration reference](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html)).

### What deck broker support would require

Deck's broker currently delegates a generic OpenAI-compatible
`/v1/chat/completions` ingress and a native `/v1/messages` ingress to pi-ai's
auth gateway (`broker/src/main.ts`). Pi sees the deck catalog as generic
OpenAI-compatible models. Merely forwarding an unknown field is insufficient.
A production native engine would need an explicit capability contract and
end-to-end state model:

- advertise native-compaction capability per resolved upstream provider/model,
  never from the public `provider=deck` label alone;
- route OpenAI models through Responses (including `/responses/compact`) rather
  than chat completions, preserve encrypted items byte-for-byte, and return
  compaction usage;
- pass Anthropic's beta header and `context_management` request shape through
  the native Messages route, then preserve compaction blocks, compaction stop
  reasons, stream events, and `usage.iterations`;
- expose a broker API that lets pi request **compact now at idle**, rather than
  only provider threshold compaction during the next user turn;
- teach pi's provider adapter and session manager how to persist/rebuild each
  native artifact and how to emit a normal `session_compact` lifecycle event;
- capability-negotiate and fail closed so resumed sessions never send an
  OpenAI encrypted artifact to Anthropic, or vice versa.

### Opaque artifact versus transparent session

| Choice | Advantages | Costs / risks |
|---|---|---|
| Provider-native opaque artifact (OpenAI) | Can preserve hidden reasoning/provider state; canonical provider implementation; potentially better semantic continuity. | Provider-locked and not inspectable/editable; complicates export, branching, model switching, replay, redaction, and durable debugging; broker and pi must preserve exact wire items. |
| Provider-native transparent summary (Anthropic) | Human-auditable summary and closer to pi's current session model; server coordinates compaction with inference. | Still provider-specific; beta/version coupling; special stream/stop/usage/cache semantics; summary portability is not guaranteed. |
| Pi client-side summary (default) | Transparent JSONL, branchable, exportable, model/provider portable, already integrated with pi lifecycle and cut points. | Loses hidden provider reasoning state and requires a separate summarization request; quality depends on pi's summary prompt/model. |

The native path should therefore be an explicit engine, not an automatic
optimization hidden in the broker. Persist engine/provider/version metadata on
every native compaction, retain a transparent fallback summary when feasible,
and prohibit provider/model switching across opaque artifacts unless a tested
conversion path exists.
