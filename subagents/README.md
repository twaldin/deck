# deck-subagents

`deck-subagents` is Deck's single child-agent primitive for interactive pi sessions and Smithers workflow seats. It launches one ephemeral, headless `pi -p` process in the caller's current working directory, validates the requested agent and Deck broker model before spawning, bounds concurrency, kills silent children, and returns one structured result.

## Install

```bash
./subagents/install.sh
```

The installer copies the extension, shared library, and Deck-owned agent registry to `~/.pi/agent/extensions/deck-subagents/`, links `broker/pi/deck-provider.ts` plus its zod dependency into the pi extension tree, and also links the definitions into `~/.pi/agent/agents` for direct pi selection. Spawn validation reads only the namespaced registry, so unrelated or stale ambient agents never become valid tool inputs. The installer removes the retired `extensions/subagent` copy. Rerun it after updating the repository so the installed code advances atomically; the focused installer test checks both extensions, rejects an ambient legacy alias, and loads the copied subagent extension through pi. For an isolated installer check:

```bash
INSTALL_TARGET="$(mktemp -d)/agent" ./subagents/install.sh
```

The pi tool is named `subagent`. It accepts one task per call:

```json
{
  "agent": "worker",
  "task": "Implement the requested change and verify the changed path.",
  "model": "deck/gpt-5.6-luna",
  "thinking": "high",
  "stallTimeoutMs": 300000,
  "maxRuntimeMs": 1800000
}
```

`model`, `thinking`, and both timeouts are optional. The model defaults to the selected agent's frontmatter only after that default passes the same live broker validation.

## Exact registries

Agent names are exact and case-sensitive. The shipped registry is:

| Agent | Role | Default model |
| --- | --- | --- |
| `worker` | Full-capability Claude-family builder | `deck/claude-opus-5` |
| `worker-gpt` | Full-capability GPT-family builder | `deck/gpt-5.6-terra` |
| `reviewer` | Read-oriented GPT-family adversarial reviewer | `deck/gpt-5.6-terra` |
| `reviewer-claude` | Read-oriented Claude-family adversarial reviewer | `deck/claude-opus-5` |
| `scout` | Cheap read-only reconnaissance | `deck/gpt-5.4-mini` |

There are no `claude`, `codex`, or `gpt` aliases and no fuzzy correction. An unknown name returns `invalid-agent` plus the valid list without launching a child.

Model selectors are the intersection of the checked-in `broker/pi/deck-provider.ts` catalog and the live authenticated broker `/v1/models` response. An unknown or unavailable model returns `invalid-model` or `registry-unavailable` before spawn. `:fast` is accepted only for GPT models; it lowers latency at the broker's 2x cost and is not the cheap lane.

Model guidance is embedded in the tool description and exported as `MODEL_PICK_GUIDANCE` from `lib/model-registry.ts`: use `deck/gpt-5.4-mini` or `deck/claude-haiku-4-5` for cheap bounded work, `deck/gpt-5.6-luna` for a fast capable builder, and `deck/gpt-5.6-sol`, `deck/claude-fable-5`, or `deck/claude-opus-5` for deep ambiguous reasoning. Review with the opposite family from the author; `deck/grok-4.5` is a third-family tie-breaker. The authoritative reasoning-level table remains `broker/pi/README.md`.

## Liveness and result contract

Liveness is output activity, not CPU use or filesystem mutation. Every stdout or stderr chunk updates `lastActivityAt`. If no output arrives for five minutes (`DECK_SUBAGENT_STALL_TIMEOUT_MS` or per-call `stallTimeoutMs`), the parent sends `SIGTERM`, sends `SIGKILL` after one second if needed, and returns a result with `exitStatus.status: "stalled"` and `error.kind: "stalled"`. A separate 30-minute wall limit is configurable with `DECK_SUBAGENT_MAX_RUNTIME_MS` or `maxRuntimeMs`.

Concurrency is capped at four children per importing process (`DECK_SUBAGENT_MAX_CONCURRENCY`). The cap is shared by the pi tool and any workflow code importing the same module in that process.

A child must call the private `deck_subagent_yield` tool with `filesTouched` and `summary`. The parent tool result is JSON with this stable shape:

```json
{
  "ok": true,
  "agent": "worker",
  "model": "deck/gpt-5.6-luna",
  "cwd": "/absolute/worktree",
  "filesTouched": ["src/example.ts"],
  "summary": "Implemented and verified the change.",
  "exitStatus": { "status": "succeeded", "code": 0, "signal": null },
  "startedAt": "2026-08-05T00:00:00.000Z",
  "lastActivityAt": "2026-08-05T00:01:00.000Z",
  "durationMs": 60000
}
```

Failures preserve the same fields and add `{ "error": { "kind", "reason", "valid"? } }`. A zero exit without a valid yield is `invalid-yield`, never success.

## Workflow seats

Workflow code imports the same bounded primitive; there is no workflow-specific launcher:

```ts
import { spawnSubagent } from "../../subagents/lib/spawn.ts";

const result = await spawnSubagent({
  agent: "reviewer",
  task: "Review the implementation and return evidence-backed findings.",
  cwd: process.cwd(),
  model: "deck/gpt-5.6-terra",
});
```

The CLI worktree allocator is intentionally not called from this library: it owns global Deck allocation state, effort manifests, branch allocation, dependency warming, and release. Interactive sessions bind the tool to the parent `ctx.cwd`; Smithers seats pass their already-allocated seat/worktree cwd.
