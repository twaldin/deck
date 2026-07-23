# Deck SPEC v0.3 — technical contracts & implementation details

*Companion to PLAN.md (goals/invariants/phases). This document owns schemas, APIs, process models, acceptance criteria. RFC draft.*

**v0.3 changelog** — post-mortem-driven (POSTMORTEM.md, 19-day firstmate operating record, deltas D-A…D-H Tim-accepted via Lavish 2026-07-22):
- D-A: §4.5 inbox receipt state Tim-visible in TUI (§14) + Phase-2 exit test: no Tim→owner message silently droppable.
- D-B: `max_active_sessions_global` (§5.5.3) + global swap threshold as spawn-admission input (§5.5.5).
- D-C: whole-system kill -9 + reboot recovery drill added to §5.5.6, promoted to Phase-2 exit gate.
- D-D: `dispatch` succeeds only on verified liveness (session + first heartbeat) (§4.4).
- D-E: merged ≠ done — `done` requires deploy evidence + fallout verdict (§3).
- D-F: Done→backward ticket transitions / PR-link changes on Done tickets detected router-side ⇒ decision card (§5.3); CLI refusal is secondary (external automation bypasses CLIs).
- D-G: §15 Q1 resolved — tight rehydration budget (§4.6).
- D-H: three known doctrine rules (reviewer-deference, drafts-only comms, structural conciseness caps) ship in Phase-2 role blocks (§9).

**v0.2 changelog** — review-driven (codex/gpt-5.6-sol xhigh adversarial pass, 2026-07-22):
- Honest security model: same-UID file perms are NOT a boundary (§14 rewritten); broker proxies LLM calls (no raw model tokens); tool CLIs get scoped short-lived capabilities; agent-authored workflows = trusted code, documented.
- Merge authority mechanized (§10 new): SHA-bound single-use authorization, scoped GH tokens (no merge permission), atomic consume. I7 was prose; now it's a gateway.
- Owner fencing (§4.5 new): per-effort lease + generation token; every mutation and every irreversible side-effect checks it. Fixes the two-owners-after-reboot race.
- Atomicity without a DB (§4.2): ordered writes (tail-before-cursor) + idempotency keys make the crash window benign; SQLite WAL remains a measured-volume trigger, not v1.
- Browser confinement (§8 rewritten): no raw `ws_endpoint` to workers; browser-harness mediates; privileged domains never cloned; serialization contradiction fixed.
- Resource/OOM bounds (§5.5 new): subprocess deadlines+output caps, process-group cancel, global+per-effort admission limits, queue coalescing, memory budgets, OOM acceptance tests.
- Broker conformance (§6.5 expanded) + single-flight refresh rotation (§6.3); TOS/policy risk recorded as a human decision (§6.7 new).
- Effort rehydration (§4.6): immutable charter + decision ledger in manifest; token-budgeted seed preserving root intent/open cards/active dispatches/trigger; full-tail fallback.
- Smithers durability claim corrected (PLAN §5.3 + §11): Deck records independent side-effect receipts for irreversible ops so a crash mid-push/mid-merge is recoverable even if Smithers is gone.
- Migration cutover protocol (§16 new): per-effort exclusive-ownership handoff, drain, verify, rollback.

**Rejected review asks (with reason):** duplicating Smithers's run-state journal inside Deck (redundant — Smithers is the authority for its own runs, accessed via its sanctioned Gateway RPC; Deck only mirrors *side-effect receipts* for irreversible ops, not the whole run graph); full separate-OS-identity sandbox + cryptographically signed workflows as a v1 gate (conflicts with the stated minimalism; same-UID trusted-code model is documented as the v1 boundary with a sandbox as the v2 hardening path).

## 0. Terminology & layout

| Term | Meaning |
|---|---|
| effort | One unit of open work (ticket, PR stack, investigation). Exactly one owner. |
| owner | The pi session charged with an effort. Dispatches; never implements. |
| dispatch | A child unit of execution: workflow run or one-shot subagent. |
| card | A decision request for Tim (§4.4). |
| plane | Event class: `fact` (mechanical), `judgment` (agent), `tim`, `lifecycle`. |

**Code** (`~/dev/deck`, git): `extensions/`, `router/`, `broker/`, `cli/` (`deck`, `mcpx`), `workflows/`, `prompts/`, `kit/` (`@deck/smithers-kit`).

**Runtime state** (`~/.deck/`, all 0600, dir 0700, owner=tim):
```
efforts/<id>/manifest.json     # atomic projection (§3)
efforts/<id>/tail.jsonl        # append-only events (§4)
efforts/<id>/charter.json      # immutable goal + acceptance + constraints (§3.1)
efforts/<id>/manifest.lock     # flock for read-modify-write (single writer)
efforts/<id>/lease             # current owner epoch token (§4.5)
intake/cursors.json            # per-source poll cursors
intake/seen/<source>.ring      # idempotency key ring
broker/store.json              # credentials (§6.4)
broker/usage.json              # account roster snapshot
catalog/mcpx.toml · catalog/browser-domains.json · catalog/skills.json
run/broker.sock · run/router.sock
```

## 1. Identifiers & addressing
- `effort_id`: `<project>--<slug>` (e.g. `lindy--rel-10508-backstop`).
- Event `id`: ULID.
- Session ref: `{machine, session_id}`; rendered `mbp:0198f3…`. All refs machine-qualified (I11).
- Dispatch `id`: `<effort_id>/<ulid8>`.
- Manifest `revision`: monot integer, incremented on every mutation; required as expected-revision by every lifecycle write (CAS on all mutations, not just terminal).

## 2. Process inventory
Two resident launchd-managed daemons (PLAN §5.2 "one daemon" corrected — router + broker; both lightweight, <60MB RSS idle each):
1. **router** — intake polling, event routing, session revival, orphan reaping (§5).
2. **broker** — credentials, token refresh, LLM endpoint proxy, usage accounting (§6).

Ephemeral: pi sessions (owners/workers), poll subprocesses, Smithers gateway (on demand, idles out), browser vault Chromium (on demand).

## 3. Effort manifest — `manifest.json`
```jsonc
{
  "v": 2,
  "effort_id": "lindy--rel-10508-backstop",
  "project": "lindy",
  "title": "REL-10508 leak backstop rework",
  "created": "…", "updated": "…",
  "revision": 47,
  "stage": "review",                       // intake|active|review|landed|watching|done|abandoned
  "overlays": { "blocked": null|"…", "needs_tim": ["01J…"] },
  "session": { "machine":"mbp", "session_id":"0198…", "lease_epoch": 3, "last_heartbeat": ts },
  "watch": { "prs":[…], "tickets":[…], "slack_threads":[] },
  "worktrees": ["wt:lindy:7"],
  "dispatches": [ { "id":"…", "kind":"workflow|subagent", "target":"pr-pipeline@v3", "state":"running|done|failed", "started":ts, "result_ref":"tail:01J…" } ],
  "evidence": [ { "ts":ts, "label":"CI green", "ref":"https://…", "by":"watch|agent" } ],
  "side_effects": [ { "id":"01J…", "kind":"push|merge|deploy|migration", "ref":"sha|run|deploy-id", "status":"attempted|confirmed|rolledback", "ts":ts, "lease_epoch":3 } ],
  "cards": [ { "id":"01J…", "card":{…}, "status":"open|answered", "answer":"…", "answered_ts":ts, "cancel_in_flight": null|"01J…" } ],
  "decisions": [ { "ts":ts, "card_id":"01J…", "answer":"…" } ],
  "digest": "agent park summary or null"
}
```
- **All mutations CAS on `revision`** (expected-revision param); mismatch rejects. Terminal CAS (into done/abandoned) is a specialization.
- **Overlays never substitute for stage.**
- **Atomic write**: under `flock(manifest.lock)` → write `manifest.json.tmp` → fsync → rename. Readers lock-free.
- **Only deck extension + router write.** Agents mutate only via lifecycle tools.
- **Stage semantics — merged ≠ done (post-mortem D-E, Tim-sharpened):** `landed` = merge receipt exists. `done` additionally requires ≥1 deploy-scoped evidence link AND a fallout-watch verdict event in the tail. Terminal CAS into `done` without both is rejected; the reconcile job raises a decision card on any evidence-less done attempt.

### 3.1 Charter — `charter.json` (immutable-ish)
Set at effort creation; mutated only by explicit Tim-approved charter-change events (appended, never overwritten): `{ goal, acceptance_criteria[], constraints[], created, charter_changes:[…] }`. The seed builder (§4.6) always includes it — root intent survives any crash.

## 4. Event tail — `tail.jsonl`
### 4.1 Envelope
```jsonc
{ "id":"01J…", "ts":"…", "plane":"fact|judgment|tim|lifecycle",
  "type":"fact.pr.ci_state | judgment.assessment | tim.message | tim.decision | lifecycle.dispatch | lifecycle.turn_end | lifecycle.park | lifecycle.side_effect | …",
  "actor":"router:gh | owner | wf:pr-pipeline/01J… | tim",
  "data":{…},
  "idem":{ "source":"gh", "external_id":"pr:lindy-ai/lindy:25021:check:…", "version":"updated_at-or-hash" } }
```
### 4.2 Atomicity without a DB (the crash window is benign by construction)
- **Write order invariant**: append to `tail.jsonl` (O_APPEND, line fsynced) BEFORE advancing `intake/cursors.json` and BEFORE appending to `seen/<source>.ring`. Worst case on crash between steps: an event is duplicated on next poll. Duplicates are dropped by `idem` key (§4.3). An event is never *lost* because the cursor only advances after the tail commit.
- Multi-field manifest mutations go through the single flock'd writer path (§3) — manifest + its own tail event are written under one lock hold; the tail event is the last line written before lock release.
- Residual risk: a partial JSONL line (crash mid-`write`). Mitigation: O_APPEND writes are whole-line on POSIX for writes ≤ `PIPE_BUF` (4KB); longer payloads are written via a single `write()` of a pre-serialized buffer (no streaming split). Recovery: a malformed trailing line on boot is quarantined to `tail.bad` and the prior good line is the head.
- SQLite WAL remains a **measured-volume trigger** (sustained tail-fold latency on the board, or >N writers contending), not v1.

### 4.3 Idempotency (facts)
Router keeps per-source cursor + ring buffer of recent `(source, external_id, version)` (10k cap, fsynced batchwise, ring eviction by age). Duplicate key ⇒ drop before append. Edits/deletes/status flips = new versions appended as new facts. Judgments reference assessed fact-event; staleness computed at read time (substrate stores, never thinks).

### 4.4 Lifecycle tools + card schema
`report_progress`, `ask_tim`, `dispatch`, `park` (table in v0.1 unchanged). Card = `{ kind, question, recommendation, options[] }` (all required, options non-empty). **New:** `ask_tim` with `kind: cancellation` carries `cancel_in_flight: <dispatch_id>`; answering it triggers the fencing cancel (§4.5.3).
**`dispatch` returns verified liveness (D-D):** the call succeeds only after session-exists + first heartbeat; a handle with no heartbeat within the spawn deadline fails the dispatch, and reconcile flags any recorded dispatch whose session never heartbeat — a "running" status line is never proof a lane exists (firstmate lost lanes silently, twice in one session).
**Conciseness caps (D-H — the enforcement §9 references):** schema-level max lengths, validated by the extension before any write: `ask_tim.question ≤ 600` chars, `recommendation ≤ 400`, each option label ≤ 120, `options[] ≤ 5`; `report_progress.status ≤ 500` chars; `park.digest ≤ 2000` (all config, chosen at roughly Tim's "one paragraph or bullets" bar). **Rejection, not truncation:** an over-limit call fails with `E_TOO_LONG` naming the field and limit — the agent must compress and retry (truncation would silently hide information; rejection forces the summary Tim actually asked for). Long-form material (reports, evidence, diffs) goes into files/evidence links, never into card or status text.

### 4.5 Owner fencing (one owner, ever)
- **Lease**: `session.lease_epoch` (monot int) + a random lease token in `lease`. Spawn/revive writes the new epoch and token; router kills or fences any process whose token is stale.
- **Mutation fence**: every lifecycle tool call carries the owner's lease token; CAS check = `revision` AND `lease_epoch`. A stale owner's write is rejected (it must re-spawn).
- **Side-effect fence** (§10): every irreversible op (push/merge/deploy/migration) checks `lease_epoch` immediately before executing AND records a `lifecycle.side_effect` receipt after.
- **4.5.3 Cancellation**: a `cancellation` card answered, or router detecting a dead lease, issues a cancel to the dispatch's process group (§5.5.2); the dispatch id is marked `cancelled`; in-flight side-effects are fenced by epoch.
- **Command inbox** (durable, ack'd): router→owner and Tim→owner commands go through `efforts/<id>/inbox.jsonl` with `{cmd_id, cmd, delivered, acked}`; owner acks on apply. Survives owner crash and dedupes redelivery. **Receipt state is Tim-visible (D-A):** the TUI renders `delivered`/`acked` per message (§14). **Phase-2 exit test:** end-to-end assertion that no Tim→owner message can be silently dropped (TUI send → inbox append → owner ack → tail event), including across owner crash/revive — the firstmate resend pattern (~28% of captain messages) must be structurally impossible.

### 4.6 Rehydration seed builder
Token-budgeted (not event-counted). Always included first, in order: charter (§3.1), open cards, active dispatches + their latest result, the triggering event, digest (if present), last `tim.decision`s. Remaining budget fills with recent tail (newest backward). Full-tail fallback if budget allows. Oversized single events are summarized (not dumped) — one event can't overflow the window. **Budget posture (resolves §15 Q1 — D-G): tight.** Park-digest + bounded tail window are the norm; exact K per owner model tuned in Phase 2. Anti-patterns explicitly rejected: firstmate-style full boot dumps (its 578-line/143KB session-start digest, 16s wall) and transcript replay at session boundaries.

## 5. Wake router
### 5.1 Loop
Single bun process; 30s scheduler tick; per-target `{next_poll_at, interval, level}`. Defaults: failing-CI / fresh-review PR 60s → green-waiting 5m → quiet 15m → `watching` fallout 30m. Max 4 concurrent polls, jittered. CPU/RSS idle <50MB; no browser, no held sessions.
### 5.2 Sources
`gh` v1; linear/slack adapters land with their CLIs (Phase 3). Adapter contract `{ pollCmd(cursor) → {facts[], cursor'} }`, executed by router, never self-scheduling.
### 5.3 Routing & wake
Fact → effort via watch index (rebuilt from manifests on boot). Each fact type classified `wake`/`record` (config, not code). **External ticket-state regressions (D-F, Tim-sharpened):** facts showing a Done→backward ticket transition or a PR-link change on a Done ticket are classified `wake` + flagged ⇒ decision card ("revert or accept?"). Observed causes — Linear's own PR-mirroring automation, wrong/related-PR auto-linking (a link appearing in the ticket is enough), teammate agents acting on links in comments/descriptions — NONE pass through deck CLIs, so detection must be router-side; the linear CLI's refusal of agent-initiated Done→backward writes and PR-attach-to-Done (PLAN §5.5) is only the secondary guard.
### 5.4 Spawn/revive protocol (lease-aware)
alive (rpc ping with lease token) → inject via inbox. Else resume `session_id` → new epoch → inject. Else fresh rpc with seed (§4.6) → new epoch. **Concurrent wake race**: the CAS on `lease_epoch` means only the first writer wins a spawn; a second router tick/TUI attach sees the bumped epoch and routes to the live session instead of spawning again.
### 5.5 Resource & OOM bounds (the motivating failure, finally bounded)
- **5.5.1 Subprocess discipline**: every poll has a deadline (default 45s) and an output cap (default 512KB); exceeding either cancels the process group (§5.5.2) and emits a degraded-intake event. No poll can hang the router.
- **5.5.2 Process-group cancellation**: router spawns polls/owners/workflows in their own process group; cancel = `kill(-pgid, SIGTERM)` then SIGKILL after grace; reaps children so none orphan (the firstmate reaper lesson).
- **5.5.3 Admission limits (global + per-effort)**: `max_concurrent_polls=4`, `max_dispatches_per_effort=8`, **`max_active_sessions_global=12` (D-B — per-effort caps alone leave total sessions unbounded: the "over 30 agents nuking my memory" scenario)**, `max_worktrees_global=24`, `max_browser_tabs_global=16`, `max_workflow_nodes_per_run=200` (config). Over-limit ⇒ queue with backpressure + coalescing.
- **5.5.4 Queue coalescing**: multiple facts for one effort within a 5s window coalesce into one wake with a folded summary (no 10× wake for 10 CI events).
- **5.5.5 Memory budgets + degraded alerts**: per-process RSS cap with graceful shed; broker/router report degraded state into a system effort visible on the board. **Global memory admission (D-B):** machine swap usage is an admission *input*, not just a shed trigger — above a configured swap threshold (default 18GB; firstmate's observed OOM band was 26–29GB with alarms at ~22GB) new spawns are deferred and idle owners parked first.
- **5.5.6 Acceptance tests**: (a) kill -9 the router mid-poll ⇒ on restart, no orphan polls, no lost facts (idempotency), no duplicate owners (lease CAS); (b) simulate swap pressure ⇒ graceful shed, not OOM; (c) 4 deliberately-hung CLIs ⇒ router stays responsive, degraded-intake card raised; **(d) whole-system drill (D-C — Phase-2 exit gate): kill -9 router + broker + every live owner, then a full machine reboot ⇒ board renders, manifests/tails intact, owners revive on next wake or drilldown, zero manual steps.** "Everything comes back by itself" is a tested gate, not a goal (firstmate suffered ≥6 whole-fleet deaths from host events, never mitigated).

## 6. Credential broker
### 6.1 Process & surfaces
Bun daemon: unix socket (control, capability-auth'd) + `127.0.0.1:<port>` HTTP exposing OpenAI-compat `/v1/*` and (recommended, see §15 Q2) a native Anthropic-messages endpoint. pi wiring: `pi.registerProvider("deck", { baseUrl, models })`. **Broker proxies LLM calls — it never returns raw provider tokens to any worker.** Workers point at the broker; the broker holds upstream creds.
### 6.2 Provider module interface
`{ id, accounts(), refresh(a), execute(req,a), classify(resp), probeUsage(a) }` (unchanged from v0.1).
### 6.3 Selection, rotation, single-flight refresh
- Sticky by session (prompt-cache affinity > fairness).
- `rate_limited` → account cooling, session re-pins, `fact.broker.rotated` event.
- **Single-flight refresh**: two concurrent requests needing the same expiring refresh token share ONE in-flight refresh (dedup on `(account_id)`); losers await the winner's result. Prevents the refresh-token-rotation race that invalidates tokens.
### 6.4 Store & security
`broker/store.json` 0600. **The broker is the sole reader of the store.** CLIs/tools obtain scoped short-lived access tokens over the capability-auth'd unix socket (§14). macOS keychain = optional v2 hardening.
### 6.5 Claude plan-limits module — acceptance (expanded)
Extract omp's client presentation (client id, headers, beta flags, token exchange). **Conformance battery** (not just one prompt): (1) quota attribution matches omp on the account usage surface (the original test); (2) streaming; (3) tool-calls; (4) thinking blocks; (5) prompt caching headers honored; (6) mid-stream cancellation; (7) model-eligibility (only plan-covered models routed); (8) token revocation handling; (9) atomic refresh rotation under concurrency. Failure after timeboxed spike (3 working days) ⇒ D7 escalation.
### 6.6 Usage roster
`broker/usage.json` refreshed on probe; TUI renders; deltas as events.
### 6.7 Provider-policy / TOS risk — explicit human decision (new)
Spoofing the official client presentation to pool multiple Claude/Codex subscription accounts may violate provider TOS even when quota attribution succeeds; MIT-licensed omp source is not authorization to impersonate. I8 marks multi-account pooling non-negotiable, but Tim signs off **knowing** the TOS/termination risk. Mitigations: prefer official API-key billing where a plan offers it; never expose this surface outside Tim's machines; keep a single-account fallback path documented. This is a deliberate risk acceptance, recorded.

## 7. `mcpx` — MCP-as-CLI bridge (unchanged from v0.1)
Catalog `catalog/mcpx.toml`; `mcpx <server> list-tools` / `call <tool> --args`; hosted = HTTPS, stdio = spawn-per-invocation; tokens via broker capability; axi-convention output.

## 8. Browser vault (rewritten for confinement)
- browser-harness daemon owns vault Chromium (dedicated profile, on-demand, idle-shutdown). **API is mediated, not passthrough:** workers call `deck browser act --domains <d> --purpose <p> --actions <a>` describing intent; the harness drives and returns screenshots/DOM/results. **Workers never receive a raw CDP `ws_endpoint` or shared context handle.**
- `catalog/browser-domains.json` per-domain: `{ mode, last_verified, source, trust }`.
- Modes: `clone-ok` (in-memory storage-state snapshot, ephemeral context, per-dispatch, destroyed after, never persisted to disk — fixes the v0.1 contradiction), `tabs-in-vault` (shared session, bounded), `serialized` (queue), `needs-reauth` (card).
- **Privileged/trust=high domains (e.g. lindy admin, anything with `lsid`) NEVER cloned** — vault-tabs-only, mediated actions, Tim-approval for mutations.
- Smoke test (`deck browser verify <domain>`) probes clone+concurrency and writes the matrix; also tests redirect scope, cookie scope, cross-tab isolation, revocation, crash cleanup. Nothing assumed.
- Zen bootstrap: read-only import from `cookies.sqlite` for allowlisted domains into vault only.
- **Day-one**: lindy `lsid` onboarded to vault (trust=high, mediated-only); robotim chrome-debug retired after verify.

## 9. Skills overlay & prompts (unchanged structure)
Local visibility manifest (`auto`/`name-only`/`user-only`/`off`; unknown⇒`name-only`) ∩ scope; content-hash auto-dedup; per-skill source policy (worktree-pinned vs main-fetched); composed prompts (base ≤50 lines + role block ≤40 + brief); owner model = best available (PLAN D5); doctrine-mining pass seeds role blocks. **Role-block doctrine ships Phase 2 (D-H):** three rules are already known and don't wait for the mining pass — reviewer-deference (implement-or-escalate, never argue in-thread), drafts-only external comms, and the conciseness contract enforced structurally via the §4.4 schema caps (`E_TOO_LONG` rejection — memory-doc rules demonstrably decayed in firstmate within days). Initial owner/worker role blocks + prompt composition are Phase-2 substrate (PLAN §7.2); the mining pass and reviewer role block stay Phase 3.

## 10. Merge & side-effect gateway (new)
I7 mechanized — the merge stamp is no longer prose.
- **Split credentials (correct model — there is no "merge scope" to withhold).** GitHub gates `PUT /repos/{o}/{r}/pulls/{n}/merge` under **Contents: write**, identical to the authority an authenticated push needs, so a single token that can push can also merge. Enforcement therefore separates *transport*, not *scope*:
  - **Agent API credential = GitHub App installation token, not a fine-grained PAT** (correction: PATs are manually-generated user creds with no minting API — the broker cannot issue them per-dispatch). Tim creates two GitHub Apps; the broker mints short-lived **installation access tokens** (1h TTL, via JWT signed by the App private key + the installation-access endpoint) on demand:
    - **`deck-agent` app** (installed on the repos Deck touches; permissions: `Contents: read`, `Pull requests: write`, `Metadata: read`, + `Workflows: write` only if the app is granted it). Its private key lives in the broker utility tier (`gh/utility/deck-agent.pem`). Per-dispatch, the broker mints a 1h token; no `Contents: write` ⇒ the merge REST endpoint 403s. `gh`/`gt` for agents are pointed at this token; `gt merge` fails for agents by design.
    - **`deck-merge` app** (permissions: `Contents: write` only; installed on the same repos). Its private key is **authority-tier** — Keychain-held, biometric-release per merge (below). Kept separate from `deck-agent` so the agent path can never elevate to write.
    - **Fallback if an org disallows App installation** (e.g. lindy-ai requires team approval): a single static fine-grained PAT with the minimal scopes, held in the broker utility tier, used for agent API calls. Weaker (not short-lived, manual rotation, broader blast radius) — documented as fallback, not default. Merge authority still Keychain-gated regardless. **Confirm the lindy org App-installation policy at Phase 2** (a setup task Tim does manually; not code).
  - **Git push transport** = a repo-scoped **SSH deploy key** (write) injected into the worker's `ssh-agent` for the dispatch lifetime only. Deploy keys authenticate `git@github.com` SSH operations, not `api.github.com` — a worker with only a deploy key can `git push` but cannot call *any* REST endpoint, merge included. (App installation tokens *can* push over HTTPS, but we deliberately keep push on the deploy-key transport so the worker's API credential — the deck-agent token — provably lacks write.)
  - **Branch protection / rulesets** on every protected base (`main`, release branches): require PR + green checks, block direct pushes and force-push. Even if a deploy key leaks, it can't land on `main` without the gate. Configured per repo; treated as a Deck prerequisite, not optional.
  - **Merge gateway** = sole minter of `deck-merge` installation tokens. The `deck-merge` App private key lives in **macOS Keychain under an ACL that requires Tim's biometric/password to release, per merge** — NOT in `broker/store.json`. The gateway releases the key, mints a 1h `Contents: write` token, does the merge, lets it expire — only after (a) a valid Tim-minted single-use authorization (below) AND (b) the Keychain prompt fires. This is a **real authority boundary**: a prompt-injected worker running as `tim` can *trigger* a prompt (spam is visible/noisy) but cannot silently obtain the key or merge without Tim's physical approval. This is what makes I7 genuinely mechanized, not an accidental-merge guardrail.
  - **Graphite merge-queue caveat**: `gt` merge-queue submissions call the merge API with whatever token `gt` holds — so `gt merge`/merge-queue for agents must route through the gateway (gateway holds the queue credential behind the same Keychain release) or be policy-disabled in the agent's `gt` config. Verified during Phase-3 onboarding per repo.
- **Single-use merge authorization**: `deck merge --pr <n>` (no `--auth` arg — Tim does not paste tokens; the auth is minted by the TUI merge action signed by a Keychain-held key). Bound to `{repo, pr, head_sha, base, required_checks[], workflow_run_id?}`. Head change (new push) invalidates it. Checks must be green. Consumed atomically at merge (revision CAS + lease fence + Keychain release). A head SHA Tim never approved at the prompt cannot be merged.
- **Side-effect receipts** (push/merge/deploy/migration): recorded in `manifest.side_effects` AND as `lifecycle.side_effect` tail events, independent of Smithers — so a crash mid-side-effect is recoverable from Deck state alone (the Smithers-durability gap, closed). The push receipt also captures the deployed commit SHA, which the merge gateway binds against.

## 11. `@deck/smithers-kit` (corrected durability claim)
`DeckPiAgent` (provider=deck, composed prompts, dispatch skills, emits via `deck emit`), `DeckWorktree` (over `deck wt`), `DeckApproval` (mirrors to a deck card; Tim answers on the board). **Honesty on durability**: Smithers is the authority for its own run state (checkpoints, nodes, approvals) via its Gateway; Deck does NOT duplicate that graph. If Smithers disappears, in-flight runs are lost UNLESS the run performed an irreversible side-effect — those are independently receipted in Deck (§10) and the owner re-derives next steps from receipts + charter. This is the real cost of Smithers abandonment: not transparent, bounded by side-effect receipts.

## 12. Multi-machine seams (design-now)
Machine-qualified ids; sockets v1 → tailnet TCP + token auth later; effort sync deferred (v1 single machine; every effort records home machine).

## 13. Security model (rewritten — honest)
- **Two-tier trust model (honest).** Same-UID is NOT a security boundary — v0.1's "0600/0700 stops workers" and v0.2's "agents physically cannot merge" were both wrong. Credentials split into two tiers by the authority they carry:
  - **Authority tier** — credentials whose misuse is catastrophic or irreversible (merge PAT; later: anything that sends to humans, spends money, or touches prod). These are **NOT** trusted to the same-UID process. They live in **macOS Keychain with a Tim-biometric ACL and are released per use** (§10). This is a real OS boundary — the worker can request but cannot silently extract. Merge authority is the v1 member of this tier (required by I7).
  - **Utility tier** — model accounts and read-scoped tool tokens. Broker-held, broker-proxies (LLM calls) or issues scoped short-lived capabilities; under the v1 **trusted-code model** (workflows Tim authors/approves run as tim; ad-hoc agent-authored workflows trusted by default, like firstmate). Same-UID limitation is documented, not hidden.
- **Broker proxies LLM calls** — workers never see provider tokens (utility tier).
- **Tool CLIs** obtain scoped, short-lived (≤15m), action-bounded capabilities from the broker socket over an authenticated (capability-token) channel; raw refresh tokens never leave the broker (utility tier).
- **Broker control socket** requires a capability token; same-UID alone doesn't grant (reduces accidental reach, not a hostile-actor boundary — that's what the authority tier is for).
- **v2 hardening path** (not v1): per-worker sandbox (`sandbox-exec`/container) promotes utility-tier credentials behind a real boundary too; separate browser trust levels enforced by OS; signed/reviewed workflows; restricted execution format. Called out so the gap is explicit, not hidden.
- **Note on unattended merges**: Keychain-release-per-merge means overnight unattended merges are impossible by construction. This is *consistent* with I7 (Tim gates merges); if an overnight "land while Tim sleeps" path is ever wanted, it requires an explicit Tim-pre-authorized, head-SHA-bound, time-boxed capability — a separate, deliberately-scoped feature, not the default.

## 14. Deck TUI (view-level; unchanged)
Board / effort / accounts / domains / skills views — pure renders of files+sockets. Drilldown attaches via router (which owns owner process groups, §15 Q3). Effort view renders per-message inbox receipt state (`delivered`/`acked`, §4.5 — D-A).

## 15. Open technical questions
1. ~~Rehydration: token-budget vs count~~ **RESOLVED (D-G)**: token-budget, tight posture (§4.6); exact K per owner model tuned in Phase 2.
2. Broker HTTP: single OpenAI-compat vs + native Anthropic endpoint (caching/thinking favor native) — leaning both.
3. Router owns all owner processes as children (so it can inject via stdin + fence via pgid) vs per-session socket shim — leaning router-owns.
4. `watching` fallout monitors: per-effort vs per-deploy (leaning per-deploy, fans back to touched efforts).
5. Smithers Gateway: per-project-on-demand vs global (leaning per-project).

## 16. Migration cutover protocol (new — closes Finding 2)
Per-effort, not big-bang. For each effort moving firstmate→deck:
1. **Freeze**: mark effort `migrating` in both systems; firstmate stops accepting new dispatches for it.
2. **Drain**: let in-flight firstmate work finish or transfer; capture current state (PRs, approvals, watches, cursors) into the deck manifest + charter.
3. **Exclusive ownership marker**: `efforts/<id>/owner_system = deck`; firstmate watcher checks this and skips; deck router arms watches from the imported cursor.
4. **Verify no old workers**: confirm no firstmate-spawned pane/process holds the effort's worktree/branch (the 07-20 near-miss check).
5. **Rollback path**: marker flipped back to `firstmate` re-enables the old watcher; deck pauses. Tested before any grant revocation.
6. Only after the whole fleet is migrated: revoke old grants, delete config sprawl (PLAN Phase 4).
