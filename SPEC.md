# Deck SPEC v0.1 — technical contracts & implementation details

*Companion to PLAN.md (which owns goals/invariants/phases). This document owns schemas, APIs, process models, and acceptance criteria. RFC status: draft for adversarial review.*

## 0. Terminology & layout

| Term | Meaning |
|---|---|
| effort | One unit of open work (ticket, PR stack, investigation). Has exactly one owner agent. |
| owner | The pi session charged with an effort. Dispatches; never implements. |
| dispatch | A child unit of execution: a workflow run or a one-shot subagent. |
| card | A decision request for Tim (schema §4.4). |
| plane | Event classification: `fact` (mechanical), `judgment` (agent), `tim`, `lifecycle`. |

**Code** lives in `~/dev/deck` (git): `extensions/` (pi extensions), `router/`, `broker/`, `cli/` (`deck`, `mcpx`), `workflows/`, `prompts/`, `kit/` (`@deck/smithers-kit`).

**Runtime state** lives in `~/.deck/`:

```
~/.deck/
  efforts/<effort_id>/manifest.json      # current state (atomic, §3)
  efforts/<effort_id>/tail.jsonl         # append-only events (§4)
  efforts/<effort_id>/manifest.lock      # flock for read-modify-write
  intake/cursors.json                    # per-source poll cursors
  intake/seen/<source>.ring              # idempotency key ring buffers
  broker/store.json                      # credentials, 0600 (§6.4)
  broker/usage.json                      # account roster snapshot
  catalog/mcpx.toml                      # mcpx server catalog (§7)
  catalog/browser-domains.json           # per-domain auth-mode matrix (§8)
  catalog/skills.json                    # visibility overlay (§9)
  run/broker.sock · run/router.sock      # unix sockets
```

## 1. Identifiers & addressing

- `effort_id`: `<project>--<slug>`, lowercase kebab, e.g. `lindy--rel-10508-backstop`. Unique across projects; project = repo shortname.
- Event `id`: ULID (sortable, collision-free across writers).
- Session ref: `{machine, session_id}` where `machine` = short hostname; rendered `mbp:0198f3…`. All cross-component references machine-qualified (PLAN I11).
- Dispatch `id`: `<effort_id>/<ulid-prefix8>`.

## 2. Process inventory (steady state)

Exactly **two** resident daemons, both launchd-managed, both crash-restart-safe:

1. **router** — intake polling, event routing, session revival, orphan reaping (§5).
2. **broker** — credentials, token refresh, LLM endpoint, usage accounting (§6).

Everything else is ephemeral: pi sessions (owners, workers), poll subprocesses, Smithers gateway (started on demand by workflows, idles out), browser vault Chromium (on demand).

## 3. Effort manifest — `manifest.json`

```jsonc
{
  "v": 1,
  "effort_id": "lindy--rel-10508-backstop",
  "project": "lindy",
  "title": "REL-10508 leak backstop rework",
  "created": "2026-07-22T18:00:00Z",
  "updated": "2026-07-22T19:42:11Z",
  "stage": "review",              // intake | active | review | landed | watching | done | abandoned
  "overlays": {
    "blocked": null,               // or { "reason": "...", "since": ts, "on": "external|tim|dispatch" }
    "needs_tim": ["01J…"]          // open card ids
  },
  "session": { "machine": "mbp", "session_id": "0198…", "last_heartbeat": ts },
  "watch": { "prs": [{"repo":"lindy-ai/lindy","num":25021}], "tickets": ["REL-10508"], "slack_threads": [] },
  "worktrees": ["wt:lindy:7"],
  "dispatches": [ { "id": "…", "kind": "workflow|subagent", "target": "pr-pipeline@v3", "state": "running|done|failed", "started": ts, "result_ref": "tail:01J…" } ],
  "evidence": [ { "ts": ts, "label": "CI green", "ref": "https://github.com/…/runs/…", "by": "watch|agent" } ],
  "cards": [ { "id": "01J…", "card": {…§4.4}, "status": "open|answered", "answer": "...", "answered_ts": ts } ],
  "digest": "agent-written park summary or null"
}
```

Rules:
- **Stage transitions**: any order allowed except into `done`/`abandoned`, which use terminal CAS — writer must supply expected current stage; mismatch rejects (from `fm-effort.sh`).
- **Overlays never substitute for stage** — an effort is `review` AND `needs_tim`, not "stage: needs_tim".
- **Atomic writes**: serialize under `flock(manifest.lock)` → write `manifest.json.tmp` → `fsync` → `rename`. Readers never lock (rename is atomic).
- **Only the deck extension and router write manifests.** Agents mutate exclusively through lifecycle tools (§4.3). No hand edits by agents, ever.

## 4. Event tail — `tail.jsonl`

### 4.1 Event envelope
```jsonc
{ "id": "01J…", "ts": "…", "plane": "fact|judgment|tim|lifecycle",
  "type": "fact.pr.ci_state | judgment.assessment | tim.message | tim.decision | lifecycle.dispatch | lifecycle.turn_end | lifecycle.park | …",
  "actor": "router:gh | owner | wf:pr-pipeline/01J… | tim",
  "data": { …type-specific… },
  "idem": { "source": "gh", "external_id": "pr:lindy-ai/lindy:25021:check:…", "version": "updated_at-or-hash" } // facts only
}
```

### 4.2 Idempotency (facts)
- Router keeps per-source cursor (`intake/cursors.json`) and a ring buffer of recent `(source, external_id, version)` keys (`intake/seen/<source>.ring`, capacity 10k, fsynced batchwise). Duplicate key ⇒ drop before append.
- Edits/deletes/status flips are **new versions**, appended as new facts. Consumers fold.
- A judgment references the fact version it assessed (`data.assessed = <event id>`); router marks dependent judgments stale when a newer version of the same `external_id` arrives (staleness = derived, computed at read time by the TUI/owner seed builder — the substrate stores, never thinks).

### 4.3 Lifecycle tools (pi extension `deck-effort`)

Registered only in owner sessions; workers get a reduced set (`report_progress` only, scoped to their dispatch).

| Tool | Params (TypeBox) | Effect |
|---|---|---|
| `report_progress` | `{ status: string, stage?: Stage, evidence?: [{label, ref, note?}] }` | manifest update + `judgment.progress` event |
| `ask_tim` | `{ kind: "scope"\|"merge_word"\|"waiver"\|"priority"\|"cancellation", question, recommendation, options: string[], context? }` | card appended, `needs_tim` overlay set, board notifies |
| `dispatch` | `{ kind: "workflow"\|"subagent", target, brief, skills?: string[], model?, worktree?: bool }` | allocates worktree if asked, spawns (§5.4), records dispatch |
| `park` | `{ digest?: string }` | writes digest, releases session hold; **digest optional by contract** |

Involuntary capture (extension hooks, no agent action): `tim.message` on every user message into an effort session; `lifecycle.turn_end` per turn; `lifecycle.dispatch_result` when a dispatch reports; crash ⇒ nothing needed — tail is already current to the last event (PLAN §5.1 advisory).

### 4.4 Decision card
`{ kind, question, recommendation, options[] }` — all required, options non-empty (validated at tool call; inherited from fm-effort.sh). Tim's answer arrives as `tim.decision {card_id, answer}` + session message.

## 5. Wake router

### 5.1 Loop
Single bun process. Scheduler tick every 30s; each watch target has `{next_poll_at, interval, level}`. Intervals (defaults, config-overridable): PR with failing CI or fresh review activity 60s → green-and-waiting 5m → quiet effort 15m → `watching`-stage fallout monitors 30m. Poll executions are short-lived subprocesses (`gh api graphql`, one query per PR-set per repo, batched — port of `watch-ci-review.ts` internals), max 4 concurrent, jittered. No persistent per-source processes. CPU/RSS budget: idle < 50MB, no browser, no SDK sessions held.

### 5.2 Sources v1
`gh` only. Linear/Slack adapters land with their CLIs (Phase 3); each adapter = `{ pollCmd(cursor) → {facts[], cursor'} }` contract, executed by the router, never self-scheduling. Sentry/prod-signal intake deferred until a workflow consumes it.

### 5.3 Routing & wake policy
Fact → effort via `watch` registration (PR/ticket/thread ⇒ effort_id index, rebuilt from manifests on boot). Each fact type classified `wake` (revive owner: CI red, review comment, merge, deploy event) or `record` (append only: CI still running). Classification is config, not code.

### 5.4 Spawn/revive protocol
1. Session alive? (rpc ping via its socket/pid) → inject message.
2. Else `pi --mode rpc` resume `session_id` → inject.
3. Else fresh `pi --mode rpc` with seed = system prompt (role=owner) + manifest + digest + last K=50 tail events + open cards. Update `session` ref.
Workers/workflow steps spawn the same way with role=worker prompts, or via Smithers `DeckPiAgent`.

### 5.5 Boot & reaping
On start: re-index manifests, re-arm all watches, verify sessions' pids/sockets (dead ⇒ clear `session.last_heartbeat`, board shows stale), scan worktree pool for orphans (flag, never auto-delete with unpushed commits — firstmate 07-20 near-miss rule).

## 6. Credential broker

### 6.1 Process & surfaces
Bun daemon. Two listeners: unix socket (control: store CRUD, usage snapshot, health) and `127.0.0.1:<port>` HTTP exposing **OpenAI-compatible** `/v1/chat/completions` + `/v1/models` (and an Anthropic-messages endpoint if the Claude module needs native shape). pi wiring: deck extension calls `pi.registerProvider("deck", { baseUrl, models: fetched from broker })`.

### 6.2 Provider module interface
```ts
interface ProviderModule {
  id: "claude" | "codex" | "zai" | …;
  accounts(): Account[];                       // from store
  refresh(a: Account): Promise<Tokens>;        // OAuth refresh
  execute(req, a): Promise<Response>;          // upstream call w/ correct headers/client-id
  classify(resp): "ok" | "rate_limited" | "auth_dead" | "server_err";
  probeUsage(a): Promise<UsageSnapshot>;       // plan window, % used, resets_at
}
```

### 6.3 Selection & rotation
- **Sticky by session**: requests carry `X-Deck-Session`; an account is pinned per session while healthy — **prompt-cache affinity matters more than round-robin fairness**; naive rotation would cold-cache every turn.
- On `rate_limited`: account → `cooling(until)` (from headers or backoff), session re-pins to next healthy account, event `fact.broker.rotated` appended to a global tail; board shows it.
- On `auth_dead`: account flagged, board card raised to Tim.

### 6.4 Store & security
`broker/store.json` mode 0600, owner-only dir. Namespaces `llm/<provider>/<email>` and `tool/<service>/<label>` (schema present in v1; tool tokens populated Phase 3+). Values: refresh token, access token + expiry, client metadata. Broker is the sole reader; CLIs (`mcpx`, slack CLI) obtain short-lived tokens over the unix socket, never read the store. macOS keychain migration is an optional later hardening, not v1.

### 6.5 Claude plan-limits module — go/no-go acceptance
Extract from omp source (MIT) the exact client presentation (client id, headers, beta flags, token exchange) that makes subscription OAuth usage bill to **plan limits** rather than extra-usage. Acceptance test: same prompt via (a) omp, (b) broker → both consume plan quota identically (verified against the account usage surface omp's `/usage` reads); a control via pi-native OAuth shows the extra-usage path we're avoiding. Failure after a timeboxed spike (suggest: 3 working days) ⇒ PLAN D7 escalation to Tim. **No fallback is pre-accepted.**

### 6.6 Usage roster
`broker/usage.json` refreshed on probe (per account: plan, window %, resets_at, last_rotated, state). TUI accounts view renders it; deltas appended as events for history.

## 7. `mcpx` — MCP-as-CLI bridge

Catalog `catalog/mcpx.toml`:
```toml
[servers.linear]
kind = "http"                       # hosted MCP endpoint
url  = "https://mcp.linear.app/mcp"
auth = "tool/linear/tim"            # broker ref

[servers.somelocal]
kind = "stdio"
cmd  = ["bunx", "some-mcp-server"]  # spawned per invocation, killed after
```
Invocation: `mcpx <server> list-tools` · `mcpx <server> call <tool> --args '<json>'` → JSON on stdout, nonzero exit on error. No resident processes; hosted = one HTTPS exchange, stdio = spawn/handshake/call/exit. Output follows axi conventions (structured, agent-parseable, self-describing `--help`).

## 8. Browser vault

- browser-harness daemon owns the vault Chromium (dedicated profile dir, launched on demand, idle-shutdown).
- API (unix socket / localhost): `acquire(domains[], purpose) → {mode, ws_endpoint | context_id}` honoring `catalog/browser-domains.json`:
```jsonc
{ "admin.lindy.ai": { "mode": "tabs-in-vault", "last_verified": ts, "source": "vault", "notes": "lsid; replaces robotim chrome-debug profile" },
  "github.com":     { "mode": "clone-ok",      "last_verified": ts, "source": "zen-import" } }
```
- Modes: `clone-ok` (storage-state snapshot → ephemeral context, parallel), `tabs-in-vault` (shared session, bounded tabs), `serialized` (queue), `needs-reauth` (board card).
- Domain classification is empirical: a smoke-test job (`deck browser verify <domain>`) runs the clone+concurrency probe and writes the matrix; nothing is assumed (Zen-import domains especially).
- Zen bootstrap: read-only import from `cookies.sqlite` for allowlisted domains, only into vault; never writes back to Zen.
- **Day-one migration**: lindy `lsid` admin cookie domain onboarded to vault; robotim's chrome-debug profile retired after verification.

## 9. Skills overlay & prompts

### 9.1 Resolution
Loader scan order: global `~/.agent/skills` → worktree repo `.agent/skills` → `~/dev/deck/skills`. For each SKILL.md: `content_hash = sha256(body)`.
- Same hash, multiple roots ⇒ one entry (global root wins for attribution; all paths recorded).
- Same name, different hash ⇒ near-dupe: TUI flags for a manual visibility/source call.
- Effective visibility = `catalog/skills.json` overlay (`auto|name-only|user-only|off`; unknown ⇒ `name-only`) ∩ scope (owner set / dispatch-declared worker set / Tim: all).
- Source policy per skill: `worktree-pinned` (default for code-coupled) or `main-fetched` (SOP skills; router refreshes a cached copy of target-repo main). Source commit + age surfaced in TUI.

### 9.2 Prompt composition (spawn-time)
`prompts/base.md` (≤50 lines: engineering invariants, comms doctrine) + `prompts/roles/{owner,worker,reviewer}.md` (≤40 lines each) + dispatch brief. Owner role block carries model-selection + escalation/concision doctrine (seeded from the doctrine-mining pass over firstmate learnings/captain/AGENTS + brain inbox; mined rules land as PR-reviewed diffs to these files, adopted only with Tim's review).
Owner model: **best available** (fable / gpt-5.6 class) — PLAN D5.

## 10. Worktree primitive

`deck wt acquire --repo ~/work/lindy --branch twaldin/<slug> [--base origin/main]` → `{id, path}`; `deck wt release <id>`; `deck wt audit` (boot). Backend: treehouse adapter if probe passes (CLI present, allocate/release/list semantics confirmed — 20-min inspection is Phase-2 task); else plain `git worktree` under `~/.deck/wt/<repo>/<n>`. Invariants: allocation records owner dispatch; release requires clean-or-pushed (else flags); Smithers `DeckWorktree` calls the same CLI. Base freshness: acquire always fetches base ref first (skill-staleness advisory).

## 11. Deck TUI

pi-tui application (runs inside a pi session or standalone bun TUI — decide in Phase 2 spike; contract below is view-level and holds either way):
- **Board**: efforts grouped by project; columns: stage, overlays (loud), last-heartbeat age (loud when > threshold), open cards count, running dispatches. Sort: needs_tim → stale → active.
- **Effort view**: manifest + folded tail; cards answerable inline (writes `tim.decision`, injects to session); attach ⇒ live session (revive per §5.4); Smithers dispatches show Gateway stream rows; `hijack` for running workflow nodes.
- **Accounts view**: broker roster (§6.6). **Domains view**: browser matrix. **Skills view**: overlay toggles + dupe flags + source age.
- All views are pure renders of files/sockets — TUI holds no state.

## 12. `@deck/smithers-kit`

- `DeckPiAgent extends PiAgent`: injects `--provider deck` (broker), composed prompts (role=worker unless overridden), dispatch-declared skills; emits `lifecycle.*` events by shelling `deck emit` (public CLI, so kit works from any Smithers process).
- `DeckWorktree`: wraps `<Worktree>` over `deck wt` allocator.
- `DeckApproval`: wraps `<Approval>` AND mirrors the request as a deck card, so Tim answers on the deck board, not a second UI; answer forwarded to Gateway.
- Workflows authored by agents must pass `deck wf lint`: uses kit components only (no raw creds/paths), stable task ids, declares consumed skills.

## 13. Multi-machine seams (design-now, build-later)

Machine-qualified ids everywhere (§1); router/broker listen on unix sockets v1, flip to tailnet-bound TCP + token auth later; `~/.deck/efforts` sync strategy (git vs rsync vs single-writer-per-effort pinning) explicitly deferred — v1 asserts single machine, and every effort records its home machine so the later split is additive.

## 14. Security notes

- Broker store 0600; unix sockets 0700 dir; no tokens in env vars of spawned workers (they get broker refs, not values) except where a CLI requires env (then short-lived access tokens only).
- Slack CLI: send subcommand hard-disabled for agent contexts (build-time flag), draft/read only — I7.
- Browser vault cookies never serialized outside `~/.deck`/profile dirs; clone snapshots are tmpfs-backed and per-dispatch.
- Reviewer/adversarial sessions run read-only (existing skill sandbox conventions).

## 15. Open technical questions (for review)

1. Owner seed: is last-K=50 tail events the right rehydration window, or size-budgeted (tokens) instead?
2. Broker HTTP shape: single OpenAI-compat endpoint for all providers vs native Anthropic endpoint alongside (Claude prompt caching + thinking blocks favor native shape)?
3. Router↔extension transport for "inject message into live session": pi RPC stdin is owned by the spawning process — does the router own ALL owner sessions' stdio (sessions as router children), or do we need a per-session socket shim? (Leaning: router owns all owner processes as children; TUI attaches through router.)
4. `watching` stage fallout monitors: per-effort or merged per-deploy? (Leaning: per-deploy workflow that fans results back to touched efforts.)
5. Smithers Gateway lifecycle: one workspace gateway per project repo or one global? (Leaning: per project, started on demand.)
