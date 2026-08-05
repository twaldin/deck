# Firstmate post-mortem — evidence base for the deck revamp

*2026-07-22 · Subagent-driven analysis of the full firstmate operating record (2026-07-04 → 2026-07-23)*

## Corpus analyzed

| Source | Volume | Method |
|---|---|---|
| Supervisor transcripts (`~/.omp/agent/sessions/-firstmate/`) | 22 omp sessions, 122 MB | Tim-message extraction (937 user events → 728 real messages, 209 wake injections filtered) + episode mining of the 3 largest sessions |
| Crewmate/secondmate transcripts (`~/.claude/projects/-Users-twaldin--treehouse-*/`) | 463 sessions, 432 MB | Mechanical marker scan (all) + deep sample of 8 (4 largest, 4 pathology-biased) |
| Firstmate's own distillates | `data/learnings.md` (210 lines), `captain.md`, `docs/` (11 defense docs), `bin/` (~140 scripts) | Full read + workaround census with architectural-vs-incidental verdicts |

Six scout agents coded independently; findings below are only those confirmed by ≥2 corpora.

## Verdict

**The revamp is justified, and the rising PR rate does not contradict it.**

- PRs/day is confounded: firstmate's start (Jul 4–6) straddles the biggest pre-existing week (34, wk of Jun 29); the first two clean firstmate weeks (17, 16) were *below* that peak. Only the current week is unambiguously above trend.
- The metric firstmate was supposed to move is **supervision cost per unit of output** — and that cost stayed high and flat for 19 days:
  - **Praise:complaint ratio ≈ 1:10–11 in every window**, including the mature period. No convergence.
  - **~25–28% of everything Tim typed was a resend** of something already said (bootstrap: 35–38 resend clusters; mature window: still 25–30, incl. one 5×-in-2-min burst on Jul 17).
  - **Roughly a third to a half of supervisor session content was fleet plumbing** (re-arming watchers, unwedging lanes, verifying sends, pane hygiene), not decision work — a scout's *qualitative estimate* from keyword-guided episode sampling of the 3 largest sessions, not a measured fleet statistic; direction corroborated by the advisor call-outs and incident density in those transcripts.
  - **82–85% of inbound traffic to multi-day secondmates was self-generated watcher noise**; one logged 125 "background watcher killed" notifications in 5 days.
  - Of **11 friction themes traceable across all three windows, 10 were still occurring at the end; 0 cleanly resolved**; several proven by exact-repeat of the identical bug 2+ weeks apart.
- Tim's own contemporaneous diagnosis matches: *"i feel firstmate has been kinda failing me… work is not parallelizable enough where i am basically just synchronously working with you"* (Jul 13); *"should i just go back to using the harness myself and managing multiple tmux sessions?"* (Jul 16).

## Architectural failure modes (unfixable inside firstmate's design)

Census ground truth: the two largest files in the ~140-script toolbelt (`fm-supervise-daemon.sh` 85K, `backends/herdr.sh` 75K) and the largest doc (`herdr-backend.md` 113K) are **pure defensive machinery**. Five-plus vocabularies (guard/check/lock/drain/hold/checkpoint/continuity/wedge-alarm) re-solve one problem: proving supervision hasn't silently died.

1. **Screen-scraped agent state.** Composer emptiness, busy/idle, ghost-text — 4+ dated incidents chasing rendering ambiguity; the same bare-shell-misread bug found latent in 3 other backends. Worst case: a dead shell misread as an empty composer could have *executed* an injected escalation.
2. **Keystroke injection with no delivery ack.** "Enter swallowed" ×14/19/31 in sampled sessions; 8.5h wedge with 20 undelivered escalations; a 5×-in-40s redelivery loop; a **14.8h** silent escalation buffer; the afk-invx-i5 incident dropped **100%** of escalations.
3. **File-polling + mtime beacons as liveness truth.** Watcher down 23.8h unnoticed; supervision decapitation via harness background-task reaping; grace-window lapses on every long ask-dialog.
4. **Command-string classification as the only enforcement boundary.** A 37K hand-rolled shell tokenizer with a self-declared fragility tripwire is the *only* thing between the model and hiding watcher failure.
5. **Per-harness hook divergence.** Turn-end guard genuinely blocks on 2 of 5 harnesses, fails open on 3; session-start nudge is documented-broken on Grok; dead `pi` panes report as generic `node` — unhealable.
6. **Host SPOF.** Laptop crash, idle-sleep, OOM (swap to 26.6GB, prior 29GB), and wifi drops each killed the whole fleet — ≥6 whole-fleet deaths in 19 days; the macOS reaper SIGTERM'd supervisors' own watchers as collateral. Never mitigated.

## Non-architectural but persistent

- **Dropped parallel work / no durable ledger** — "the state is fucked… you have forgotten to do half of the work" (Jul 7) → "why do you keep dropping/forgetting… its just 3" (Jul 18). Same bottleneck, 11 days apart.
- **Prompt-level rules decay.** Verbosity rule written into captain.md Jul 18, violated Jul 21. Amend-don't-stack corrected 3×. Reviewer-deference violated twice in 24h (Jul 21–22). Memory-doc social contracts demonstrably do not hold.
- **Credential/quota fragmentation.** Tim was the ambient credential store: ≥7 manual interventions in week 1 alone; personally burned a Codex rate-limit reset to unblock (Jul 20); proposed the fix himself: "admin page + web ui to mint/view/remove tokens" (Jul 21).
- **Self-certified "done".** Captain was the last line of defense against premature-done across ≥4 unrelated domains ("your done is premature — no review artifacts exist").
- **Lane lifecycle.** Dispatched lanes silently vanished (no meta, no work) twice in one session; tasks jumped worktree slots and branch names across sessions (PR #24930 eventually closed as redundant).

## Strengths — preserve in deck

1. **The hierarchy itself worked.** Multi-day unattended secondmates merged+deployed PRs, shipped a dashboard, proved a $135k/week cost root cause, and correctly overturned Tim's own wrong premise ("your 'gated off' premise was inverted").
2. **Front-loaded, self-contained briefs ≈ zero corrections.** Sampled sessions with 5.6–7K-char briefs needed 0–1 steers vs dozens for iterative tasks. Brief quality, not model capability, was the deciding factor.
3. **Batched decision rounds beat tmux.** 20+ PR/ticket triage via repeated ask-tool rounds was the one interaction mode Tim praised against the "back to tmux" alternative. → validates deck's decision cards as the core interaction primitive.
4. **Fallout-watch caught a real regression** (169-user DeprecatedActionConfiguredError) and post-deploy verification matured into quantified verdicts ("210/day → 0/day").
5. **Captain authority held.** Every merge needed Tim's stamp; the one overnight breach (#25467) is the strongest argument *for* deck's mechanized Keychain gate, not against the model.
6. **Escalation digests improved** (the only mechanism that measurably got better in 19 days) — decision-tagged, low-noise by week 3. Deck should ship this shape on day 1, not evolve it.

## Deck plan coverage check

PLAN.md §1's five diagnosed problems are all confirmed with stronger evidence than the plan cites. Every architectural failure mode above maps to an existing deck commitment: protocol-not-scraping (I1/I3, manifests+tails), out-of-band wake router (§5.2), broker (§5.4/I8), worktree allocator (§5.8/I9), mechanized merge gate (I7), no voluntary bookkeeping (I4), board observability (§5.9). **No finding invalidates any current design decision.**

## Proposed deltas (small; several sharpen existing SPEC sections rather than add mechanisms)

SPEC already covers more of this than the first draft of these deltas credited: §4.5 specifies the durable ack'd command inbox (`{cmd_id, cmd, delivered, acked}`, crash-safe, dedup on redelivery) and §5.5 specifies admission limits, per-process RSS caps with graceful shed, and a swap-pressure acceptance test. D-A/D-B/D-C below are therefore *acceptance/visibility/gap* deltas on those sections, not new controls.

**Status: all 8 accepted by Tim (Lavish review, 2026-07-22) and applied — SPEC bumped to v0.3, PLAN §5.5/§5.7/§7 amended.** Tim's review annotations folded in: D-F's cause set broadened beyond Linear automation (wrong/related-PR auto-linking, teammate agents acting on links); D-E sharpened to *done implies deployed with evidence + fallout monitored* (merged ≠ done).

| # | Delta | Where | Evidence |
|---|---|---|---|
| D-A | **Surface + gate the §4.5 inbox, don't rebuild it.** The mechanism exists (durable, ack'd). Missing: (1) Tim-visible receipt state in the TUI (delivered/acked per message), (2) a Phase-2 exit test asserting no Tim→owner message can be silently dropped end-to-end (TUI → inbox → owner ack → tail). | SPEC §4.5 + §14 TUI; Phase 2 exit | 28% resend volume, unresolved 19 days |
| D-B | **Close the two gaps in §5.5 admission control.** §5.5.3's limits are count-based and per-effort (`max_dispatches_per_effort=8` × N efforts = unbounded sessions). Add: (1) `max_active_sessions_global`, (2) a global memory/swap threshold as an *admission input* (defer new spawns / park under pressure), complementing §5.5.5's per-process RSS shed. | SPEC §5.5.3/§5.5.5 | 26.6GB swap, OS-reaper collateral kills, "over 30 agents nuking my memory" |
| D-C | **Promote §5.5.6(a) to a whole-system Phase-2 exit drill.** The router kill -9 test exists; extend to full-fleet: kill -9 router+broker+owners, then a reboot test — board, manifests, owners recover with zero manual steps. "Comes back by itself" becomes a gate, not a goal. | SPEC §5.5.6 → §7 Phase 2 exit | ≥6 whole-fleet deaths from host events, never mitigated |
| D-D | **`dispatch` returns verified liveness.** The lifecycle tool succeeds only on session-exists + first-heartbeat; reconcile flags handle-without-heartbeat. | SPEC §4.4 lifecycle tools | Lanes silently vanished with no meta, twice in one session |
| D-E | **Done requires evidence.** Manifest transition to done/landed is gated on ≥1 evidence link; reconcile flags evidence-less dones for a decision card. | SPEC §3 manifest schema | Premature-done across ≥4 domains; captain as last defense |
| D-F | **Ticket-state invariants enforced at the router, CLI as secondary guard.** The cited Done→In-Review regression was caused by *Linear's own automation* — a transition that never passes through any deck CLI, so a CLI refusal cannot prevent it. Primary: router fact classification (§5.3) treats Done→backward transitions as a flagged fact ⇒ decision card ("revert or accept?"). Secondary: linear CLI refuses agent-initiated Done→backward writes and PR-attach-to-Done. | SPEC §5.3 routing + PLAN §5.5 | Done↔In-Review ping-pong (forensically traced to Linear automation); rules-decay pattern |
| D-G | **Rehydration budget: resolve SPEC §15 Q1 toward "tight".** Park-digest + bounded tail window; explicitly reject fm-session-start-style full-dump (578-line/143KB, 16s boot digest; whole-session replay observed at session boundaries). | SPEC §15 Q1 → §4.6 | Boot-digest tax + replay tax in supervisor transcripts |
| D-H | **Role-block doctrine ships in Phase 2, not Phase 3.** Reviewer-deference, drafts-only external comms, conciseness contract (hard length cap in the ask/report tool schema — machine-checked, since memory-doc rules demonstrably decay). Doctrine-mining pass stays Phase 3; these three rules are already known. | §5.7 / §7 | 2 authority violations in 24h; verbosity rule broken 3 days after codification |

Explicitly **not** proposed (over-engineering, consistent with standing values): push/webhook ingestion in v1 (anchored-cursor polling fixes the observed missed-window class), any DB, per-worker sandboxes, remote control plane in v1 (D-C's recovery drill is the v1 answer to the host SPOF; multi-machine stays a seam).

## Sources

Scout reports: `agent://TimMsgs1`, `agent://TimMsgs2`, `agent://TimMsgs3`, `agent://WorkaroundCensus`, `agent://SupervisorEpisodes`, `agent://CrewmateSample`. Corpus extract: `local://tim-messages{,-1,-2,-3}.md`.
