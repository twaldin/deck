# Deck build ledger — overnight run 2026-07-22→23

Status board for the AFK build-out. Canonical docs: PLAN.md, SPEC.md (v0.3.1). Everything below is committed on local main.

## Where things stand

| Phase | State | Evidence |
|---|---|---|
| 1 — Broker | **DONE, gate passed** | §6.5 battery 14 pass/0 fail; live rotation (gmail fable-exhausted → lindy served); pi wired (`--provider deck`) |
| 2 — Substrate | **DONE, both exit gates pass live** | itest/: D-A no-silent-drop incl. router kill -9 crash window; D-C process-level kill-9 (board renders, single owner revives, epoch monotonic). Packages: core (store 15t), router (12t), extensions (14t), cli (10t), tui (8t), prompts (2t) |
| 3 — Tools/workflows | **Mostly done** | mcpx (4t), skills overlay (3t), merge gateway (7t incl. 5 §10 scenarios), Smithers spike PASSED (kill -9 at approval → resume, no re-execution; gateway RPC probed), kit stubs. Deferred: linear/slack CLIs, browser vault integration, full pr-pipeline workflow |
| 4 — Migration | Not started | Inherently per-effort + Tim-gated (firstmate keeps running) |

Total: ~80 unit/integration tests green across 9 packages; every package `tsc --noEmit` clean.

## Blocked on Tim (the morning queue)

1. ~~**Activate broker launchd daemon**~~ **DONE (agent-piloted 2026-07-25).** Broker is now launchd-managed (`ai.deck.broker`, pid survives session end, KeepAlive+RunAtLoad), verified healthy on `127.0.0.1:8377` with all 3 accounts intact; log at `~/.deck/logs/broker.log`. **Router deliberately NOT loaded** — do not `./ops/install.sh` (it bootstraps both; the router would start spawning real owners before the first-effort validation). Router activation waits until after the first supervised live effort.
2. **GitHub credentials — personal only, NO App (PLAN I12, SPEC §10):**
   - **Agent API:** a personal fine-grained PAT (`Contents:read`, `PullRequests:write`, `Metadata:read`) scoped to the repos you work on → store it in the broker utility tier (`gh/utility/`). Read-only-for-writes: it 403s on merge by design. User-scoped, invisible to lindy.
   - **Push:** your existing personal SSH key — nothing to set up.
   - **Merge authority:** your personal `Contents:write` credential (your `gh auth token` OAuth token or a dedicated write-PAT) into the **Keychain, never disk**:
     `security add-generic-password -s deck-merge -a github -w "$(gh auth token)" -T ""`
     then in Keychain Access set the item's ACL to require confirmation (biometric). Gateway releases it per-merge via `deck-merge run --keychain deck-merge:github`.
   - **No GitHub App, no deploy keys, no org/repo settings changes** — Deck stays invisible to lindy (I12). Rely on the team's existing branch protection.
3. **Machine-reboot drill** (D-C full scope): after launchd activation, reboot; then verify board renders + owners revive on wake. Process-level kill -9 is already gated green; reboot is the remaining leg.
4. **Remaining broker logins**: Claude waldin.net; Codex waldin.net + lindy (`cd ~/dev/deck/broker && bun src/cli.ts login anthropic|openai-codex-device`); z.ai key via `bun src/cli.ts login zai` **in your own terminal** (never through an agent transcript).
5. **Codex subagent caps**: gmail Codex hit its usage limit (resets Jul 28; codex CLI same). This killed 7 of 12 overnight subagent lanes mid-flight (work recovered inline) and blocked cross-harness adversarial review — substrate review ran on claude-opus instead (same-family caveat). Decide: buy credits, add another Codex account, or accept claude-only review until the 28th.
6. **First real lindy PR through an effort owner** — the remaining Phase-2 exit criterion; needs a real ticket during your workday.
7. **`deck emit` CLI** doesn't exist yet — Smithers kit's DeckPiAgent composes the instruction but event emission is blocked on it (small Phase-3 item, noted from the spike).


## Shadow (agent-piloted while you were AFK, 2026-07-25)

- **Continuous shadow watcher is RUNNING** (`deck-shadow-watch` hub process, 10-min ticks, persists across omp exits — not launchd; restart with `cd ~/dev/deck/shadow && bun src/shadow.ts --watch 600 --fm-home ~/firstmate` if the broker host reboots). Artifacts: `~/.deck/shadow/latest.txt|json` (current picture), `divergences.jsonl` (append-only tick trail), `session-index.json` (cursor+token store).
- **Evidence base now includes all mate session logs** (your directive): Claude projects, Codex rollouts, omp agent sessions — 8,991 files backfilled streaming, then cursor-incremental (~2s/tick). Provenance rules: work-records only (assistant turns/tool results), per-record timestamps, actor partition (firstmate's own transcripts = awareness only, never "worker activity"), fm-session-start/inventory-digest guards, deck's own sessions excluded, PR↔Linear co-occurrence linkage, untracked candidates resolved against GitHub (only OPEN PRs report; terminal cached). Per-file cwd is sniffed from session meta and is authoritative over path slugs (Codex paths are date-only); store rebuilt post-fix, findings unchanged.
- **Graphite correction (retracted claim):** my earlier "#25426 divergence" was FALSE — it was a Graphite lands-and-closes (squash on main), firstmate was right. Classifier now resolves CLOSED PRs against main before judging; regression test added. Lesson logged: deck must absorb firstmate's learnings.md domain knowledge or it will manufacture false "firstmate is broken" signals.
- **Current standing findings** (see latest.txt): 2 known-yet-untracked OPEN PRs (#26153, #25523 — worked by mates + mentioned in firstmate's own transcripts, absent from backlog In-flight); 5 join-limited fm_behind observations (status keyed by window, not slug); watcher-stall corroborations while you're AFK (expected idle, recorded honestly).

## Deferred by design (not blocked, just next)

- linear/slack CLI adapters + their broker tool-token namespaces (router adapter seam is ready).
- Browser vault integration (SPEC §8) — browser-harness exists, mediation API not started.
- pr-pipeline workflow implementation (structure sketched in workflows/pr-pipeline/).
- TUI merge action with Keychain-signed authorizations (deck-merge mint is CLI-local v1).
- Park-inject on swap pressure (router defers spawns + degrades today; park-inject noted in supervisor).
- Broker paths.ts consolidation into @deck/core layout.

## Judgment calls made overnight (flag if you disagree)

- SPEC §15 Q2 resolved: both gateway endpoints; clients use OpenAI-compat ingress (pi's client-composed native-Anthropic gets rejected by third-party-app policy).
- SPEC §15 Q3 resolved: router-owns owner processes — forced by pi 0.73.0 (no external attach; RPC is parent-stdin-only).
- Park semantics: park tool = digest + tail event + pi `terminate:true`; router observes agent_end + park event, gracefully terminates, marks parked.
- Card answers: inbox-first write order (deliverable command before manifest flip) — crash leaves a benign re-answerable state, never a dropped decision.
- D-D liveness probe: pi session-file materialization (= first assistant message) — undocumented pi behavior, pinned by the live gate test; version-fragile, noted.
