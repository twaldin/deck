# Deck workflows

This directory is a Smithers 0.30.0 workflow workspace. The generated pack lives in `.smithers/`; Deck-authored workflows live beside it so they remain small and reviewable.

## Smithers is the standard crew tool for multi-step PR work

Any crew task that is more than one edit-and-check — implement + review + CI
watch + stamp + land, or anything with approvals, retries, or an overnight tail
— runs as a Smithers workflow, not as an ad-hoc agent loop. Smithers gives the
fleet the things ad-hoc loops do not have: durable state that survives SIGKILL
and reboot (see the drill below), replayable per-node attempts, real approval
gates, and one read-only surface (`smithers ps|inspect --json`) that the fleet
dashboard already reads. Start from `pr-pipeline/` — it is the enforced lindy
SOP — and reach for a new workflow only when the shape genuinely differs.

## Engine policy: pi only

**Pi is the only Smithers engine Deck uses.** Every agent seat in this
workspace is a `PiAgent` with `provider: "deck"`, so all model traffic goes
through the Deck broker: broker-held credentials, `deck/*` model ids from the
broker allowlist, and quota-aware routing. The direct `codex` and
`claude-code` CLI engines are removed, not merely unused — they authenticate as
a single mono-account and inherit whatever ambient local CLI config happens to
exist on the host, which is neither attributable nor quota-aware.

- Pack seats: `.smithers/agents.ts` (`providers` + `agents`). Deck-owned, no
  longer regenerated content; `.smithers/agents/` (the per-engine
  `codex.ts` / `claude-code.ts` config wrappers) is deliberately deleted. If
  `smithers init` recreates that directory, delete it again rather than wiring
  it up.
- Model catalog and the `deck/` provider guard: `pr-pipeline/lib/models.ts`
  (`DECK_PROVIDER`, `DECK_AGENT_CATALOG`, `assertDeckModel`). Seats validate at
  import time, so an off-catalog or non-`deck/` model fails before a run starts.
- Enforcement: `pr-pipeline/tests/engine.test.ts` asserts every seat is a
  `PiAgent` on `deck/`, carries no raw `apiKey`, and that no workflow source in
  this workspace constructs `CodexAgent` / `ClaudeCodeAgent` / `OpenCodeAgent` /
  `AntigravityAgent`. Run it with `cd pr-pipeline && bun test`.

Family diversity is preserved *within* pi: a seat's fallback list crosses model
families (anthropic <-> openai) rather than crossing engines, which is what
adversarial review actually needs.

- `spike/hello-deck.tsx` — the durability spike (kill -9 drill accepted; see below).
- `pr-pipeline/` — the executable lindy PR pipeline (enforced SOP workflow on plain
  smithers; own `package.json` pinning smithers-orchestrator 0.30.0). See
  `pr-pipeline/README.md` for dispatch/babysit instructions. Version note: run it
  with `bunx smithers-orchestrator@0.30.0 ...` — an unpinned `bunx` from a directory
  without a package.json can auto-resolve a NEWER cached CLI and skew against the
  workspace's pinned runtime.

## Setup and health check

Smithers is project-scoped. Do not install it globally with npm, and do not use
the unrelated `smithers` npm package. The `smithers` on PATH is the pinned shim
that `v2/install.sh` writes to `~/.local/bin/smithers` — it delegates to
`bunx smithers-orchestrator@<pin>` with the pin read from `v2/src/smithers.ts`,
so the shim, the fleet code, and this workspace cannot skew
(`v2/test/smithers-pin.test.ts` asserts all pins are equal). `v2/install.sh`
also links `~/.deck/workflows` to this directory so the fleet board reads runs
from the home.

```sh
cd ~/dev/deck/workflows
bun install --cwd .smithers
bunx smithers-orchestrator workflow doctor
```

Both `smithers-orchestrator` and `@smithers-orchestrator/cli` are pinned to `0.30.0` in `.smithers/package.json`. Doctor passed on 2026-07-22 with bundled `jj` and `git` on `PATH`. The actual spike run reported `vcsType: git` and the Deck repository revision, so this workspace used Smithers' git fallback rather than creating a jj repository.

## Run the hello-deck spike

`spike/hello-deck.tsx` has two agent tasks and one durable approval node:

1. `draft-greeting` returns a Zod-validated `{ subject, greeting }` object.
2. `approve-summary` pauses before downstream work.
3. `summarize-greeting` reads the persisted draft and returns a Zod-validated `{ summary }` object.

Both agent tasks use Smithers' `PiAgent` with `provider: "deck"`, `model: "claude-haiku-4-5"`, thinking off, and no tools, skills, or session. Pi obtains the provider through Deck's globally registered broker extension; the workflow receives no provider key.

A normal run is:

```sh
bunx smithers-orchestrator up spike/hello-deck.tsx \
  --input '{"name":"Deck"}' \
  --run-id hello-deck-local

bunx smithers-orchestrator approve hello-deck-local \
  --node approve-summary \
  --by deck-operator

bunx smithers-orchestrator up spike/hello-deck.tsx \
  --run-id hello-deck-local \
  --resume true
```

The first command exits with code 3 at the approval gate. That is a paused run, not a failure.

## Durability drill

The accepted drill run is `deck-spike-kill9-v2`. Smithers' `--serve` mode was required because 0.30.0's plain `up` exits as soon as the run waits for approval; serve mode keeps the owning orchestrator process alive at that gate.

Command transcript, with the shell's PID substituted for `$PID`:

```text
$ bunx smithers-orchestrator up spike/hello-deck.tsx \
    --input '{"name":"Deck"}' \
    --run-id deck-spike-kill9-v2 \
    --serve --port 7347
[00:00:00] → draft-greeting (attempt 1, iteration 0)
[00:00:02] ✓ draft-greeting (attempt 1)
[smithers] Workflow waiting-approval. Server still running — press Ctrl+C to stop.

$ kill -9 $PID
# process-tree exit status: 137

$ bunx smithers-orchestrator up spike/hello-deck.tsx \
    --run-id deck-spike-kill9-v2 \
    --resume true
runId: deck-spike-kill9-v2
status: waiting-approval
# No draft-greeting execution appeared.

$ bunx smithers-orchestrator approve deck-spike-kill9-v2 \
    --node approve-summary \
    --by deck-spike
status: approved

$ bunx smithers-orchestrator up spike/hello-deck.tsx \
    --run-id deck-spike-kill9-v2 \
    --resume true
[00:00:00] ✓ approve-summary (attempt 1)
[00:00:00] → summarize-greeting (attempt 1, iteration 0)
[00:00:06] ✓ summarize-greeting (attempt 1)
[00:00:06] ✓ Run finished
status: finished
```

SQLite was queried read-only for this one-off durability proof. Deck runtime code must continue to use Gateway RPC and must not integrate against these private tables.

Immediately after SIGKILL, before resume:

```sql
SELECT node_id, state, last_attempt, output_table
FROM _smithers_nodes
WHERE run_id = 'deck-spike-kill9-v2'
ORDER BY node_id;
```

```text
approve-summary  | waiting-approval | NULL | approval
draft-greeting   | finished         | 1    | draft
```

The `draft` table already contained one row for `(deck-spike-kill9-v2, draft-greeting, 0)`, with subject `Welcome to Deck`. After the first resume, the attempt ledger still contained exactly one Task A attempt:

```sql
SELECT node_id, COUNT(*) AS attempt_rows,
       MIN(attempt) AS first_attempt, MAX(attempt) AS last_attempt
FROM _smithers_attempts
WHERE run_id = 'deck-spike-kill9-v2'
GROUP BY node_id;
```

```text
draft-greeting | 1 | 1 | 1
```

After approval and completion:

```text
approve-summary    | attempt 1 | finished
draft-greeting     | attempt 1 | finished
summarize-greeting | attempt 1 | finished
run status         | finished
```

Task A therefore survived a hard owner-process death and did not re-execute. This proves Smithers' completed-node checkpoint and approval state survive SIGKILL. It does not yet prove the PLAN §5.3 overnight/reboot condition; that longer operational drill remains separate.

The accepted run used 1,608 model tokens: Task A 784 input + 30 output, Task B 769 input + 25 output. Recorded cost was about $0.001828. One pre-drill calibration of Task A used another 814 tokens, for 2,422 tokens total during the spike.

## Gateway probe

The 0.30.0 Gateway was started on loopback with a freshly minted bearer token. The token remained in Smithers' runtime state and is intentionally not recorded here.

```text
$ bunx smithers-orchestrator gateway \
    --host 127.0.0.1 --port 7351 --mint-token --idle-timeout 0

$ bunx smithers-orchestrator gateway status
running: true
url: http://127.0.0.1:7351
backend: sqlite
version: 0.30.0
auth: token

$ gatewayClient.getRun({ runId: "deck-spike-kill9-v2" })
status: finished
runState.state: succeeded
vcsType: git
summary.finished: 3

$ gatewayClient.listRuns({})
deck-spike-kill9-v2: finished

$ bunx smithers-orchestrator gateway stop
stopped: true

$ bunx smithers-orchestrator gateway status
running: false
```

An unauthenticated `getRun` received HTTP 401 `A bearer token is required`. Authenticated `getRun`, `listRuns`, `listApprovals`, `getSchemaSignature`, and `listRunTokenUsage` calls succeeded. The published v1 RPC catalog also exposes run control (`launchRun`, `resumeRun`, `pauseRun`, `cancelRun`, `hijackRun`, `rewindRun`), approvals/signals, run and node inspection/diffs, run/devtools streams, cron, accounts/usage, memory/prompts/scores, tickets, and browser sessions.

### 0.30.0 integration findings

- `getRun` provides the status and `runState` that Deck's board needs. Its gateway-client response type is currently only `Record<string, unknown>`, so Deck must validate the response at its boundary rather than treating it as a strongly typed domain object.
- `@smithers-orchestrator/pi-plugin` is a Pi extension for Smithers inspection, commands, and Gateway APIs; it is not an agent class. `DeckPiAgent` therefore extends Smithers' `PiAgent` and loads the first-party plugin as an extension.
- Gateway has no Deck-specific worktree, event, or card methods. `DeckWorktree` remains a `deck wt` CLI adapter. `DeckApproval` writes the Deck card locally; a future board answer bridge must call Gateway `submitApproval` to resolve the Smithers node.
- The current `deck` CLI has `deck wt` but no `deck emit`. `DeckPiAgent` composes the required event-emission instruction, but actual emission is blocked until that CLI command exists.
- `listRunTokenUsage` returned an empty event list for these Pi-backed tasks even though the durable execution log contains exact usage. Deck should not depend on that RPC for Pi cost accounting without an upstream fix or adapter.
- Plain `up` exits at a pending approval in 0.30.0. A live-process kill drill must use `up --serve`; ordinary resume does not need serve mode.

## Deck primitive kit

`../kit` is package `@deck/smithers-kit` v0.0.0:

- `DeckPiAgent`: broker-only `provider=deck`, composed base/role/integration prompt, dispatch skills, and the Smithers Pi plugin.
- `DeckWorktree`: shell-free, Zod-validated delegation to `deck wt alloc|release|ls|reap`.
- `DeckApproval`: idempotent, CAS-safe mutation of an existing effort manifest and paired lifecycle event.

Run its checks with:

```sh
cd ~/dev/deck/kit
bun test
bun run typecheck
```

The reverse Deck-card-to-Smithers-decision bridge is intentionally not faked; it is the remaining Gateway integration point described above.
