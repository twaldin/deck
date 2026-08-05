# Standing rules — distilled doctrine (evidence-backed)

## 0. Actor boundary (binding precedence)

- [CHAT SESSION] The plain pi chat session shapes work, invokes the shipment
  interface, queues questions, and reports evidence.
- [WORKFLOW SEAT] Smithers pipeline and orchestrator nodes execute the delivery
  middle after dispatch.
- [CHAT SESSION] **Precedence:** the plain pi chat session discharges build,
  review, and deploy obligations only through `ship`, `adopt`, `status`, and
  queued questions; it never executes the middle.
- [CHAT SESSION] [WORKFLOW SEAT] A rule bearing both labels applies at both
  boundaries. A single label never transfers the obligation to the other actor.

Distilled 2026-07-31 from firstmate corpus + fm2 + deck session evidence.
Each rule carries its source path. This file is TO-KNOW material for briefs and
prompts; the companion SETUP-CHECKLIST.md is TO-BUILD.
- [CHAT SESSION] [WORKFLOW SEAT] Use progressive disclosure: open a cited source
  only when the topic goes deep. No secret values belong here.

- [CHAT SESSION] [WORKFLOW SEAT] Do not duplicate already-loaded deck files:
  merge/Linear traps live in `~/.deck/data/lindy-domain.md`, prod rails in
  `lindy-ops.md`, and pipeline SOP in `lindy-pipeline.md`. This file adds only
  firstmate archive material those deck files do not hold.

## 1. The "make PR" flow (captain's target, binding)

- [CHAT SESSION] When the captain says make PR, grill only if the shape is
  unclear, then invoke `ship` or `adopt` once the shape is done.
- [WORKFLOW SEAT] Execute the delivery middle: implement in a worktree,
  adversarially review, push and open the PR, obtain real review and CI, request
  the captain's stamp and per-PR merge word, land, deploy, watch fallout, and
  gate done on evidence.

- [CHAT SESSION] Keep grill/ideation OUTSIDE the workflow; start the workflow
  only when the shape is done. [~/.deck/data/lindy-pipeline.md §Boundaries]
- [WORKFLOW SEAT] Own the whole middle (build→review→rebase→reviewer chase→easy-fix
  routing→deploy watch). Captain works only the front (what/should-exist) and the
  end (stamp + word). [~/firstmate/data/captain-pr-pipeline-spec.md]
- [WORKFLOW SEAT] Route feedback: easy/correctness-class → fix + push instantly, answer thread,
  re-request, no captain. Product/decision-class → decision card to captain.
  [captain-pr-pipeline-spec.md §5; lindy-pipeline.md stage 4]
- [WORKFLOW SEAT] Never leave a PR unwatched: arm watch-ci-review on every open PR; keep PRs rebased
  on main (stale branches = wasted CI). [captain-pr-pipeline-spec.md §Standing orders]
- [WORKFLOW SEAT] Never gate the stamp request on CI green — ask while CI runs; only real
  decisions block on the captain. [lindy-pipeline.md stage 6, ruling 2026-07-27]
- [WORKFLOW SEAT] Treat validation/CI failure on already-authorized work as FIX-NOW: dispatch
  immediately; only the merge waits for the word. [~/.deck/data/lindy-learnings.md 2026-07-29]
- [CHAT SESSION] Name a kill-switch in every PR brief, or record "none + named
  break-signal." [~/firstmate/data/captain.md §PR pipeline]
- [WORKFLOW SEAT] Make the fallout watch probe that named break-signal.
  [~/firstmate/data/captain.md §PR pipeline]
- [CHAT SESSION] Run the "Should this exist / product fit" check at inception.
- [WORKFLOW SEAT] Run it again before requesting review.
  [captain-pr-pipeline-spec.md]

## 2. Merge authority & autonomy

- [WORKFLOW SEAT] lindy: require the captain's per-PR word, always. No blanket authority; "get it out the
  door" = prepare/chase, not merge. [~/firstmate/data/captain.md; ~/.deck/data/captain.md]
- [WORKFLOW SEAT] deck + machine infra: YOLO on green. Destructive/irreversible/security still
  escalate. kalshi: YOLO + ~$300 loss cap. [~/.deck/data/captain.md §Project autonomy]
- [WORKFLOW SEAT] Merge windows: no merges while captain is AFK overnight — prepare and
  batch-queue for morning. [~/firstmate/data/captain.md §Merge windows]
- [WORKFLOW SEAT] Human stamp: bot/agent/AI-on-behalf reviews never satisfy the gate; never Ali
  as code stamp. Agents may dismiss a stale changes-requested once addressed;
  agents never approve. [captain.md; lindy-domain.md]
- [WORKFLOW SEAT] Stale-review dismissal: a changes-requested from a reviewer who ignored the
  re-review request can be dismissed without a note when a later real-human
  review of the current head is clean. [~/firstmate/data/captain.md 2026-07-20]
- [WORKFLOW SEAT] Scope-growth badge-riding: after approval, scope growth defaults to fresh
  human re-review — EXCEPT on the captain's explicit per-PR authorization
  (his substitute bar: his own stamp of final diff + AI review layers + physical
  local testing + CI green). Never self-apply. [~/firstmate/data/captain.md 2026-07-24]

## 3. Reviewers

- [WORKFLOW SEAT] Fan-out 3–5 active, code/domain-relevant reviewers, load spread, OOO
  reassigned immediately; suggestion-originators are natural reviewers.
  [~/firstmate/data/captain.md §Reviewer fan-out]
- [WORKFLOW SEAT] Default reviewer selection after adversarial+push: CODEOWNERS +
  review-frequency + gh-reviewer-lookup skill. [~/.deck/data/captain.md §Decisions 2026-07-30]
- [WORKFLOW SEAT] Verify requested_reviewers via API after every request — requests silently
  no-op, plausible-but-wrong logins return ok. [lindy-domain.md trap 3]
- [WORKFLOW SEAT] Reviewer guidance is accept-by-default: implement + short ack, or escalate to
  captain privately. Never argue in-thread. [~/firstmate/data/captain-shared.md]
- [WORKFLOW SEAT] Escalate a stalled review to the CAPTAIN, never to the reviewer.
  [captain-shared.md — zero-tolerance, corrected twice]

## 4. Comms (zero-tolerance set)

- [CHAT SESSION] [WORKFLOW SEAT] Send NO direct Slack messages to humans. "Feel free to ping X" = draft for his
  send. Only carve-out: outage-level severity AND captain clearly AFK, both —
  and even that never authorizes a teammate DM. [~/firstmate/data/captain-shared.md]
- [CHAT SESSION] [WORKFLOW SEAT] Team-facing text: ASD-STE100, plain language, no fleet vocabulary ever.
  Plain-language test: name what breaks, not the mechanism's insider label.
  [~/firstmate/data/captain.md §plain language 2026-07-23]
- [CHAT SESSION] [WORKFLOW SEAT] Put agent attribution at the END; `-- tim's agent` on lindy only, not every repo.
  [~/.deck/data/lindy-learnings.md 2026-07-30 Q4]
- [CHAT SESSION] [WORKFLOW SEAT] Use his Slack voice for drafts: all lowercase, casual shorthand (u, tysm, pls,
  abt), short bursts, sparse emoji (🙏 🫡 😂); disagreement = one message with
  position + link + concrete alternative. He sends. [~/firstmate/data/captain.md §voice]
- [CHAT SESSION] [WORKFLOW SEAT] Slack Connect channels (#team-engineering) reject API posts — plan for a
  human one-click send. One draft per channel limit. [~/firstmate/data/learnings.md]
- [CHAT SESSION] [WORKFLOW SEAT] Never use bare PR/ticket numbers — every mention carries what-it-is context and
  full https:// URLs. [~/firstmate/data/captain.md; ~/.deck/AGENTS.md]

## 5. Decisions

- [CHAT SESSION] [WORKFLOW SEAT] Use the questions queue as THE decision surface; one decision at a time; each card is
  self-contained: original issue → our fix → what this decides/blast radius.
  Chat mention is optional speed-assist, never primary. [lindy-pipeline.md §routing]
- [WORKFLOW SEAT] Report needs-decision through the structured workflow result;
  never ask the captain directly or open a second decision channel.
- [CHAT SESSION] Queue each captain decision once. Two channels race and lose
  decisions. [~/.deck/AGENTS.md §3]
- [WORKFLOW SEAT] Never run OptMem from a worker or subagent. Route decisions
  through the workflow's question result.
- [CHAT SESSION] [WORKFLOW SEAT] Cost is never a hold reason under tens of $k for authorized work; report it
  for correctness only. [~/firstmate/data/captain.md §spend 2026-07-25]
- [WORKFLOW SEAT] In MAX-CRITICAL program mode, route every seat's uncertainty
  through the structured question result.
- [CHAT SESSION] Ask vision-level questions BEFORE dispatch, not after.
  [~/firstmate/data/captain.md 2026-07-25]

## 6. Dispatch & workers

- [WORKFLOW SEAT] One worker, one task; two workers never share a branch. Front-loaded
  self-contained briefs (5.6–7KB briefs needed 0–1 steers vs dozens for
  iterative). Never hand-write a wait-for-another-lane clause (cost 3.5
  lane-days once). [~/.deck/data/learnings.md §Dispatching]
- [WORKFLOW SEAT] Keep long CI/CD polls in the ORCH process (pi-processes) or smithers nodes —
  never in ship-worker sleep loops; workers that poll-and-exit read as dead.
  [~/.deck/data/HANDOFF-2026-07-30.md §3.3]
- [WORKFLOW SEAT] The orchestrator owns decomposition: split N independent streams yourself and
  assign each; a sub-orchestrator runs a FEW workers on one focused domain.
  Prefer new focused seats over loading existing ones. [~/firstmate/data/captain.md 2026-07-27]
- [WORKFLOW SEAT] Give every ship task adversarial review pre-PR by a fresh-context reviewer
  from the opposite model family. Self-report is never the review.
  [~/.deck/AGENTS.md §4; ~/firstmate/data/captain.md]
- [WORKFLOW SEAT] Before hand-solving auth/deploy/CI/prod-debugging, inspect
  the repo's own skills (lindy has 70+ under `.agent/skills/`).
  [~/.deck/data/lindy-learnings.md 2026-07-28]
- [WORKFLOW SEAT] On rate limits, never park — switch harness/account; park only when every lane
  is exhausted. Provider stalls: reprompt up to ~3× before swapping models.
  [~/firstmate/data/captain.md; lindy-learnings.md 2026-07-29]
- [WORKFLOW SEAT] Never discard unlanded work; discarding needs the captain's word
  for that specific task. [~/.deck/AGENTS.md §6]

## 7. Evidence standards

- [WORKFLOW SEAT] Keep completion vocabulary graded and distinct: patch-ready / applied /
  integrated / behavior-validated / merged / deployed; done = acceptance passed
  only. Merged ≠ done; main ≠ prod until CD succeeds (a cancelled e2e CD means
  not deployed). [lindy-learnings.md 2026-07-29 doctrine 8; 2026-07-30 addendum]
- [WORKFLOW SEAT] Landing truth = squash commit `(#N)` on main, never the merged flag
  (lands-and-closes, 3 repros). [lindy-domain.md trap 1]
- [WORKFLOW SEAT] Verify CREATE-type calls by listing before retry; requests silently no-op or
  silently succeed. [~/.deck/data/learnings.md §Verifying]
- [WORKFLOW SEAT] A regression test must go red on the old code — verify by reintroducing the
  bug (3 tests passed against broken code during the v2 build).
  [~/.deck/data/learnings.md §Verifying]
- [WORKFLOW SEAT] Record every remote run start as {env, endpoint, runId, owner,
  startedAt, poller, terminal state} durably BEFORE polling.
  [lindy-learnings.md 2026-07-29 doctrine 6]
- [WORKFLOW SEAT] Status grammar: lines start with the verb; append only actionable /
  authority / terminal events. Statuses are events, not state.
  [lindy-learnings.md doctrine 1–2; ~/.deck/data/learnings.md]
- [CHAT SESSION] [WORKFLOW SEAT] Report outcomes faithfully; name what was NOT done alongside what was.
  [~/firstmate/data/captain-shared.md §Evidence]
- [CHAT SESSION] [WORKFLOW SEAT] Never judge a number without knowing what computed it; pin dated model ids.
  [~/.deck/data/learnings.md]
- [WORKFLOW SEAT] On BLOCKED + 0 fails + 0 pending, check `behind_by` first; update-branch fixes
  the stuck "Expected" required check. [lindy-learnings.md 2026-07-28]

## 8. Prod-scale review gate (standing blind spot)

- [WORKFLOW SEAT] For every new or changed Mongo find/aggregate/write path,
  analyze indexes against multi-million-document assumptions; call out load
  amplifiers such as comparison arms and per-completion writes in PR risk;
  prefer flags for write-heavy instrumentation. "Tests green" is not proof of
  production database safety.
  [~/.deck/data/lindy-learnings.md 2026-07-30 mongo huddle]

## 9. Lindy north star & eval doctrine (short form)

- [CHAT SESSION] [WORKFLOW SEAT] Reliability self-improvement loop is #1; don't fix one-offs the loop should
  fix. Prompt-vs-code razor: `code → unit test` ≡ `prompt → eval`; never freeze
  prose into code to defend it. CoS validator mirrors the CoS main model —
  never pin a default. [~/.deck/data/captain.md §North star]
- [CHAT SESSION] [WORKFLOW SEAT] Eval fidelity: 1:1 with CURRENT prod — frozen task+user-state, prod-current
  sitevars, overrides on top; accurate signal beats pass rates. Scorers judge
  only the named scored execution; cross-case recurrence is prevalence and
  counts. ENG-WEEKS banned as a decision metric. Full doctrine (world-model,
  labeling autonomy, benchmark protocol, privacy):
  [~/firstmate/data/captain.md §Eval doctrine 2026-07-22/23/25 — open when doing eval work]
- [CHAT SESSION] [WORKFLOW SEAT] Slack RTS results are redacted at storage — no eval can verify
  Slack-content behavior. Label provenance: human-seen = pool A/B forever;
  sealed holdout = provenance-disjoint pool C. [lindy-learnings.md]
- [CHAT SESSION] [WORKFLOW SEAT] Scorer fixes are API/config-first (verify mutation path, snapshot, repair in
  DB, canary, measure FPs before rescore); PR only when the data model cannot
  express the fix. [~/firstmate/data/captain.md §Linear & tickets]
- [CHAT SESSION] [WORKFLOW SEAT] e2e exercises the REAL LLM by design; safety = key isolation + per-key
  monitoring, never fake-LLM. e2e-imessage talks to LIVE PROD.
  [~/firstmate/data/captain.md; lindy-domain.md]

## 10. Linear & on-call

- [CHAT SESSION] [WORKFLOW SEAT] Ticket creation contract: assignee=Tim, team AND project (default
  Reliability → "Reliability bugs"), priority+labels per judgment, attribution
  one line at the END. Link PRs immediately; mirror truth; never close
  silently. [~/firstmate/data/captain.md §Linear]
- [CHAT SESSION] [WORKFLOW SEAT] DONE IS TERMINAL (violated 2×, zero-tolerance). Follow-ups = new tickets.
  Never revert his bulk-Done sets. Full trap set: [lindy-domain.md §Linear]
- [CHAT SESSION] [WORKFLOW SEAT] On-call retro is a required field and the Done gate: What happened / How we
  found out / DTD / DTM / What was done / Systemic fixes. Tiering:
  Urgent=Unbreak-Now, High=P0 work-hours, Med-Low=P1/P2. Deploys: API/frontend
  ship immediately, realtime waits off-peak; hourly Slack updates during an
  active outage; each rotation removes noisy alerts. Team runbook:
  https://app.notion.com/p/lindyai/On-Call-da4e3ba0b9ec4d10b4910c7f776817f1
  [~/firstmate/data/oncall-runbook.md]
- [CHAT SESSION] [WORKFLOW SEAT] Never unilaterally cancel a teammate-originated ticket — verify createdBy AND
  attachments first. [~/firstmate/data/captain.md; lindy-domain.md]

## 11. Memory & homes

- [CHAT SESSION] Keep curated current-state files; rewrite and prune, never append forever. A fact
  with no evidence is a guess. [~/.deck/data/learnings.md header; ~/firstmate/data/captain.md]
- [CHAT SESSION] Put project-intrinsic knowledge in that repo's AGENTS.md; fleet strategy
  never in a shared repo. pi discovers AGENTS.md in cwd + ancestors — never
  commit an operator contract under that name. [~/.deck/data/learnings.md]
- [CHAT SESSION] Put durable findings in reports under `data/`; put scratch in a
  `claude-playground/` (dies with the worktree). Never mix.
  [~/firstmate/data/captain.md §Memory]
- [CHAT SESSION] Treat old firstmate home `~/firstmate` as a read-only archive;
  never write it. `~/.deck` must never be a git checkout.
  [lindy-learnings.md; deck-5 AGENTS.md]

## 12. Auth doctrine

- [CHAT SESSION] [WORKFLOW SEAT] Prefer CLIs over MCPs: CLI auth is shared by every agent that shells out; MCP auth
  is per-harness pain. [~/firstmate/data/captain.md §Harnesses; learnings.md 2026-07-08]
- [CHAT SESSION] [WORKFLOW SEAT] OAuth ToS split: bot OAuth accounts sanctioned for OpenAI/codex headless
  only; Anthropic stays API-key, never OAuth for bots. One Anthropic key per
  consumer (keys are uncappable) + spend monitoring + fast rotation; convert
  tokens to dollars before attributing spend. [~/firstmate/data/captain.md; lindy-learnings.md]
- [CHAT SESSION] [WORKFLOW SEAT] sentry + pup CLIs carry WRITE verbs — lanes stay read-only on them without
  explicit word. [~/firstmate/data/learnings.md 2026-07-08]
- [CHAT SESSION] [WORKFLOW SEAT] When a credential seems dead, suspect extraction before the credential
  (quotes survive grep/cut; `source` works). [deck task scaffold; HANDOFF §3.8]
