# Deck — dev-workflow revamp plan

*(system name provisional — "deck": the surface you look at; agents crew below it)*
*Status: draft for review · 2026-07-22 · grilled over ~10 decision branches, all resolved below*

## 1. Problems (diagnosed from disk, not vibes)

1. **Transport is the bug.** firstmate drives agents by tmux send-keys + pane-regex. Every incident class in `learnings.md` — Enter-swallowed submits, composer strip, watcher lapses, OOM leaving 13 orphaned shells — is downstream of scraping TUIs instead of speaking a protocol. flt died on the same rock ("liveness/death correctness").
2. **Conversation-as-memory can't hold a queue.** 15–30 ticket/PR pairs + Slack firehose into one chat thread ⇒ the agent follows the last pivot and drops background work. Structural, not fixable by prompting. *(Review nuance, Tim: crewmates did finish their tasks — the bottleneck was single-agent dispatch throughput: one firstmate relaying everything, slow to remember to check finished work. Fix = talk to N owners directly, with a status overview good enough to beat 15 tmux windows.)*
3. **N harnesses × M integrations = config hell.** 3 daily harnesses + 6 dormant; notion reachable 3 ways (2 within codex alone); ≥5 Anthropic + ≥4 OpenAI OAuth grants; 2 local proxies; 3 diverged instruction-file copies at home; 72 lindy skills with zero visibility control.
4. **Five partial meta-layers, no kernel.** firstmate / flt / Superset / no-mistakes / robotim each own a slice of spawn-watch-react. *(Reality check: last ~month only firstmate is actually driven; robotim's env survives solely as the lindy `lsid`-cookie source agents reuse for admin GQL mutations.)*
5. **Voluntary bookkeeping fails.** `fm-effort.sh` ledger autopsy: 137 events, all from one day, all from batch ingest, zero agent emissions, board never rendered.

## 2. Goals / Non-goals

**Goals**
- One surface: TUI listing all open efforts across all projects; drill into any effort's agent session; answer decision cards with a keypress.
- Tim issues intent and stamps merges; agents + workflows do everything else, including orchestration choices.
- Deterministic-*ish* reliability via reusable workflows; flexibility via NL skills; messy-reality interpretation (Graphite MQ weirdness, cancelled CI) stays agent judgment.
- Max tokens, no waiting: multi-account pooling across 3 Claude + 2–3 Codex + z.ai, at **plan limits** (omp-style), with all-accounts usage visible.
- Everything comes back by itself after crash/OOM/reboot.

**Non-goals**
- No captain-of-captains agent. No re-encoding SOPs as rigid state machines. No multi-machine in v1 (seams only). No new memory engine (brain stays). No forking pi core.

## 3. Invariants (hard)

| # | Invariant |
|---|---|
| I1 | Extension-only: pi is never forked or binary-patched. Everything is `~/.pi/agent/extensions/*.ts` + packages + config. |
| I2 | One harness has config (pi). Anything else invoked is stateless, zero config footprint. |
| I3 | The session is not the state. Manifests + event tails on disk are; sessions are ephemeral and revivable. |
| I4 | No voluntary bookkeeping: all record-keeping is a side effect of hooks, watchers, or lifecycle tool calls agents must make anyway. |
| I5 | Semantic judgments (blast radius, "is this actually merged") are agent work via explicit tools; mechanical facts are watcher work; the substrate never *thinks*. |
| I6 | Ingestion is idempotent: `(source, external_id, version)` + per-source cursors; edits/deletes are new facts. |
| I7 | Tim's stamp gates every merge. Slack sends are Tim-only (CLI enforces read+draft). |
| I8 | Multi-account at plan limits is non-negotiable; broker is core infra, not an add-on. |
| I9 | All work in worktrees, PRs against main; effort owners never cd into code. One worktree pool, one allocator. |
| I10 | Shared trees (lindy skills) are read-only truth; Tim's preferences are local overlays. |
| I11 | Every component network-shaped for later multi-machine: `machine:session` addressing, broker on a socket. |

## 4. Architecture

```
Tim ──▶ Deck TUI (pi-tui board)
          │  efforts by project · statuses · decision cards · account usage · drilldown
          ▼
   Effort owners (1 per open effort; parked pi sessions, revived on events)
     charter: negotiate with Tim, dispatch, judge evidence — never implement
          │  dispatch
          ▼
   Workflows + subagents (many per effort)
     pr-pipeline · watch-ci · fallout-watch · ui-review · adversarial-review …
     Smithers (durable/overnight/gated) · pi-dynamic-workflows (intraday fan-out) · NL macro skills
          │
   ───────┴──────────────────────────────────────────────
   Substrate: manifests+event tails · wake router+watchers · credential broker
              tool CLIs (+mcpx) · browser vault · worktree allocator · skills overlay
```

- **Me → N owners → workflows/subagents.** Cross-family adversarial review (claude vs codex) and fresh-eyes UI review are different sessions *by construction*.
- **Drilldown feels persistent, is ephemeral:** resume session if present; else fresh spawn seeded from manifest + event tail (+ last transcript segment after unclean death). Smithers drilldown = `hijack` (pause → hand over → resume).

## 5. Components

### 5.1 Effort manifests + event tails
Extension-owned, atomic, per effort: session ref (`machine:session`), free-form status, evidence links (prose/URLs — agent-interpreted, no rigid SHA schema), pending decision cards, last-activity. Auto-appended tail: Tim's messages/decisions, dispatches + results, turn ends, tool summaries. `park` takes an optional agent digest (optimization, not requirement). Decision-card schema adopted from `fm-effort.sh`: `{kind: scope|merge_word|waiver|priority|cancellation, question, recommendation, options}`. Keep terminal-CAS + reconcile ideas; drop stages-as-positions (blocked/needs-tim are overlays, not stages). **Storage v1: atomic manifest writes (temp+rename) + append-only per-effort JSONL tail + advisory file locking — no database.** SQLite is a migration with an explicit trigger (measured read contention or tail-fold latency on the board), not an undeclared hybrid.

### 5.2 Wake router (the one small always-on piece)
**Resource model (deliberately boring):** two resident daemons total — this router, plus the credential broker (§5.4). Each <60MB RSS idle, both launchd-managed, both crash-restart-safe. The router ticks a schedule and spawn-per-poll's short-lived CLI calls (`gh`, linear/slack CLIs) — no persistent watcher process per source or per effort, no browser, no SDK sessions held open. Scope is bounded by the board: it polls only open efforts' PRs/tickets, staggered intervals with idle backoff (active PR ~60s, quiet effort minutes+). Event sources are added lazily — GH first; Linear/Slack when their CLIs land; sentry/prod-signal intake only if a workflow actually consumes it (no speculative firehoses). Adapted `watch-ci-review.ts` logic runs *inside* the router tick, not as N standalone loops. **Hard OOM bounds** (the motivating failure, finally enforced): poll deadlines + output caps, process-group cancellation, global+per-effort admission limits (max polls/dispatches/worktrees/tabs/workflow-nodes), wake coalescing, per-process RSS budgets, degraded-state alerts — full contract in SPEC §5.5. Routes events to the owning effort: resume or fresh-spawn under a **per-effort lease + epoch** (exactly-one-owner, crash-safe — SPEC §4.5). Re-arms everything on boot; reaps orphans; polling first (webhooks later only if polling measurably hurts).

### 5.3 Workflow library (versioned in git)
`pr-pipeline` (grill → plan-prs/git-graphite → adversarial-review → push → watch-ci → fix red CI + reviewer comments → Tim stamp → merge), `post-deploy-fallout-watch`, `ui-review` (browser-trio loop: drive, screenshot, fresh-eyes inspect), more as they crystallize. **Posture: adopt Smithers** (Tim's call in review; Phase-3 spike still validates: overnight gated pr-pipeline run surviving a reboot). The killer property to build for: **agents author workflows** — an agent writes the JSX file and runs it, consuming a *deck primitive kit* we supply (`DeckPiAgent` pre-wired with broker credentials + skills overlay + worktree allocator + manifest event emission), so authoring a new reusable workflow is itself a dispatchable task. Integration stays **only** via Gateway RPC + `@smithers-orchestrator/pi-plugin` + `PiAgent` (never its SQLite directly). **Honest durability claim (review fix):** Smithers owns its run graph (checkpoints/nodes/approvals) and Deck does NOT duplicate it — so if Smithers disappears, in-flight runs are lost *unless* they performed an irreversible side-effect, which Deck receipts independently (§10) so the owner re-derives next steps. Abandonment cost is real but bounded by side-effect receipts. pi-dynamic-workflows for session-scoped fan-out. Plain NL macro skills remain first-class.

### 5.4 Credential broker (critical path)
One store, namespaced: `llm-accounts/` (3 Claude, 2–3 Codex, z.ai) + `tool-tokens/` (Slack user-scoped, Notion integration, Google refresh — populated later, schema day-one) + `gh/` (split GitHub credentials — see §10). One refresh loop. **Claude module extracts omp's plan-limits mechanism (MIT source) — pi native OAuth and cli-proxy-api both burn extra-usage, so this is item #1.** Exposed to pi via `registerProvider`; rotation on 429/limit; usage events → board roster (per-account spend/limits/status). At cutover: retire VibeProxy + cli-proxy-api + all orphaned grants (pi's stale auth.json, plaintext `gho_` in `~/.claude/config.json`).

### 5.5 Tool layer — everything is a CLI
`gh` model: CLI in PATH, usable by any agent/watcher/cron/machine. Existing: gh, sentry-cli, pup. Build/adopt thin CLIs for slack (read+draft only), linear, notion, gsuite/gmail. **CLI surfaces follow the axi conventions** (kunchenguid's lavish-axi/gh-axi/tasks-axi family): agent-optimized structured output, self-describing help — reuse existing axi tools where they already cover a service (gh-axi) and match the format for new ones. MCP demoted to transport: one `mcpx` bridge CLI (server catalog; hosted MCPs = plain HTTPS calls; stdio MCPs spawned per-invocation). Tokens from broker, not per-CLI sprawl. Each service gets a skill documenting usage.

### 5.6 Browser layer
browser-harness (existing CDP daemon) owns a **dedicated persistent Chromium vault profile** — the auth authority. Google-tier logins happen there once; board flags stale domains → one-click re-auth window. Zen `cookies.sqlite` import = opportunistic bootstrap for proven domains only. **Per-domain auth-mode matrix, smoke-tested, in the TUI:** `clone-ok` / `tabs-in-vault` / `serialized` / `needs-reauth`; ui-review fan-out consults it. Trio composes: browser-use drives, harness owns, trace records. **Migrates the live robotim hack:** the lindy `lsid` admin cookie agents currently pull from robotim's chrome-debug profile becomes a vault-managed domain on day one — that dependency is real and in active use.

### 5.7 Skills + prompts
- Local **visibility manifest** (Claude-Code-style: `auto`/`name-only`/`user-only`/`off` per skill), in Tim's config, never committed to shared trees. Effective set = manifest ∩ scope (owner set / workflow-declared worker set / Tim sees all). New unknown skills default `name-only`. Live-toggle from TUI. **Loader auto-dedups identical skills by content hash** across trees (global vs lindy vs other repos — same skill flows both directions in Tim's usage): byte-identical collapse to one entry automatically; near-dupes flagged in the TUI for a manual visibility call. No tree is ever mutated.
- Per-skill **source policy**: worktree-pinned (code-coupled skills) vs fetched-target-main (SOP/process skills); source commit+age shown in TUI.
- Lindy-tree specifics: personas quarantined `user-only`; the ~⅓ overlapping global skills mostly disappear via content-hash dedup, remainder handled by manifest. Upstream deletion explicitly rejected — Tim uses these skills bidirectionally (gave some to the team, took some global). Background task.
- **Composed system prompts per spawn** (extension): compact base rules (~50 lines) + role block (owner: model-selection + escalation/concision doctrine; worker: conventions+evidence; reviewer: adversarial posture) + task brief. Codebase-description content moves to an on-demand `codebase-map` doc/skill. Home instruction files collapse to one source + links.
- **Doctrine-mining pass** (Tim's review ask): sweep firstmate `learnings.md`/`captain.md`/`AGENTS.md`, brain inbox notes, and past session records for standing rules worth extracting — comms doctrine, merge/migration SOPs, resource discipline, reviewer-deference — into role blocks, workflow steps, or invariants. Dispatchable background task, output reviewed by Tim before adoption.

### 5.8 Worktrees
One `worktree` primitive in the extension; treehouse inspected and reused underneath if harness-agnostic; Smithers `<Worktree>` calls the same allocator (one pool). Teardown on effort close; orphan-reap on boot; never re-dispatch a branch a dead worktree still holds.

### 5.9 Deck TUI
pi-tui app: efforts by project → status, staleness (last heartbeat, loud), pending cards (answer with keypress), account usage roster, per-domain browser auth matrix, skill visibility toggles. Drilldown attaches to the effort session (or revives it). Smithers runs rendered via its Gateway stream as rows under their effort.

## 6. Decommission map

| Thing | Fate |
|---|---|
| firstmate (~102 scripts, tmux fleet) | Retire after migration; salvage: decision-card schema, reconcile idea, doctrine-mining pass over learnings/captain/AGENTS (§5.7) |
| flt / agentelo / harness-ts | Stay dormant; prior art only |
| VibeProxy + cli-proxy-api | Retired at broker cutover |
| Per-harness MCP/oauth/instruction sprawl (codex, claude-code, gemini, cursor, factory, opencode, mastracode, copilot) | Config deleted; CLIs remain installed as stateless break-glass tools (I2) |
| Claude Code / Codex as harnesses | Retired; models reached via pi providers |
| omp | Retired as daily driver; remains the reference spec (subagents, hub, advisor, auth) |
| Superset | Out of scope; hooks become no-ops as harnesses retire — confirm before deleting |
| no-mistakes | Not Tim's pipeline; keep for firstmate-upstream PRs until firstmate retires, then decide |
| tasks-axi | Demoted: board data source at most |
| robotim | Dormant prior art — BUT its chrome-debug profile is the *live* lindy `lsid` admin-cookie source; decommission only after the browser vault takes over that domain (§5.6) |
| ~/.claude plaintext `gho_` token, pi stale auth.json grants, 6 skill backup trees | Deleted at cleanup |

## 7. Build order

Phase ordering honors: broker unblocks everything (Claude plan-limits has *no* interim workaround); board+manifests before mass migration; lindy day-job never stops (firstmate keeps running until Phase 4).

1. **Broker v1** — omp Claude mechanism extracted; Claude+Codex+z.ai modules; `registerProvider` wiring; usage ledger. *Exit: pi session on plan-limits Claude, rotation proven.*
2. **Substrate v1** — manifests+tails, lifecycle tools (`report_progress`/`ask_tim`/`dispatch`/`park`), wake router + watch-ci adapter, worktree primitive (treehouse verdict), minimal Deck TUI (list, cards, drilldown). *Exit: one real lindy PR driven end-to-end through an effort owner.*
3. **Workflow library** — pr-pipeline, watch-ci, fallout-watch as reusable defs; Smithers integration + deck primitive kit (adopt posture, spike validates); ui-review + browser vault + auth matrix (incl. lindy `lsid` takeover from robotim); skills overlay + content-hash dedup + prompt composition; doctrine-mining pass; tool CLIs (slack/linear first, axi conventions).
4. **Migration** — efforts move over one by one via the **per-effort cutover protocol** (SPEC §16: freeze → drain → exclusive-ownership marker → verify no old workers → rollback path); only after the whole fleet is migrated are proxies/grants/config sprawl deleted and instruction files collapsed.
5. **Later** — tailnet nodes (deploy boxes, static-IP laptop), gsuite CLIs, webhook intake if polling ever hurts.

## 8. Risks

| Risk | Mitigation |
|---|---|
| pi 0.x churn (~28 breaking releases) | I1 extension-only; version-pin; bg agent absorbs upgrades |
| Smithers bus-factor ≈1, pre-1.0 | Gateway-seam only; workflows replaceable macros under our contract |
| omp Claude mechanism nontrivial to extract | Phase-1 spike is a **go/no-go gate** (I8): if plan-limits auth can't be reproduced, the plan pauses and the fallback (extra-usage tokens vs staying on omp for Claude traffic vs other) is Tim's explicit call in review — no fallback is pre-accepted |
| Visibility-not-enforcement lets efforts drift | Loud staleness on board (heartbeat age); reconcile job flags dead-session efforts |
| Zen cookie transplant flaky | Vault profile is authority; matrix gates parallelism per domain |
| Attention tax migrates from firstmate to deck | Every component delegable as bg task; substrate deliberately small (router+manifests+broker) |
| Smithers abandonment loses in-flight runs | Bounded by independent side-effect receipts (§10); adopt-posture + Gateway seam keep it replaceable; full Smithers-journal duplication explicitly rejected as over-engineering |
| Merge authority enforced as prompt convention only | Mechanized via **split transports** (SPEC §10, corrected — GitHub has no "merge scope": the merge endpoint is Contents:write, same as push). Workers get `Contents: read` + `Pull requests: write` API token (no merge call) and a repo-scoped **SSH deploy key** for feature-branch pushes (deploy keys can't call the REST API at all); branch protection blocks direct main pushes; the sole `Contents: write` credential lives in the `deck merge` gateway, head-SHA-bound + checks-green + single-use. Agents cannot merge a head Tim never stamped. |
| Same-UID agents can reach the whole credential estate | Honest trusted-code model (SPEC §13): broker proxies LLM calls (no raw tokens to workers); tool CLIs get scoped short-lived capabilities; same-UID file perms are NOT a boundary (v0.1 was wrong). Per-worker sandbox + signed workflows = explicit v2 path, not v1 |
| Provider TOS risk from multi-account pooling | Deliberate human risk acceptance (SPEC §6.7): spoofing the official client to pool subscriptions may violate TOS; Tim signs off knowingly; prefer API-key billing where offered; single-account fallback documented |

## 9. Decisions from review (2026-07-22 Lavish pass)

| # | Decision | Resolution |
|---|---|---|
| D1 | System name | **deck** — confirmed |
| D2 | Treehouse reuse | **Reuse** ("it's basically just a CLI"); wrap behind the `worktree` primitive |
| D3 | Smithers gate | **Adopt posture** (Tim: hard-adopt lean); spike still validates overnight+reboot; requirement added: agent-authorable workflows via deck primitive kit |
| D4 | Superset & no-mistakes | Out of scope; revisit post-migration (unchanged) |
| D5 | Owner model policy | **Best models always** for owners/orchestrators (fable / gpt-5.6). "Cheap model" idea dropped — cheap models only for mechanical chores inside workflows, and only where a workflow author chooses to |
| D6 | Skills dedupe | **Content-hash auto-dedup in the loader** + manifest visibility; no upstream deletion ever (bidirectional sharing) |
| D7 | Phase-1 no-go contingency | Framing accepted: broker is go/no-go; fallback is Tim's call at the time |

Remaining open: none blocking. Phase 1 can start.
