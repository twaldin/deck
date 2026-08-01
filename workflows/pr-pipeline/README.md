# lindy-pr-pipeline — enforced PR pipeline (executable)

The lindy PR SOP (`~/dev/fm2/data/lindy-pipeline.md`) as an **executable smithers
workflow**. Design thesis: step-dropping is THE failure mode of prompt-driven
pipelines (unaddressed GH comments, unrun migrations, skipped fallout watch).
Here every stage is a smithers node whose successors are render-gated on its
**Zod-validated persisted output**, so a stage cannot be skipped: the next
node's input *is* the previous node's validated output row.

Runs on **plain smithers 0.30.0** — no deck router/manifest/TUI dependency.
Model access goes through pi's `deck/` provider (the deck broker on
`127.0.0.1:8377`).

### Reproducible test setup

Run the full suite from this directory. The committed lockfile pins the
workflow dependencies and the frozen install prevents drift:

```sh
cd workflows/pr-pipeline
bun install --frozen-lockfile
bun test tests/
```

The expected result is 187 passing tests and 0 failures.

## This is the DEFAULT ship path

Every profiled project ships through this workflow — the profile
(`config/projects.json`, `v2/src/projects.ts`) only selects the merge posture:

| pipeline | review gate | stamp park | merge |
|---|---|---|---|
| `lindy-full` | adversarial, hard | durable `<Approval>`, captain's word | MQ after stamp |
| `yolo-ship` | adversarial, hard (SAME gate) | skipped by the profile | auto on CI **green** (`will-be-green` is not enough — nobody decided) |

The one-command entry is the deck orchestrator's ship helper, which resolves
the profile, builds the input (brief, yolo/stamp, deploy evidence default) and
starts this workflow detached:

```sh
deck-v2 ship deck-42 --profile deck --worktree ~/.deck/wt/deck-3 --branch deck/my-change \
  --base v2 --title "fix(x): y" --summary "..." --accept "tests green;behavior proven"
```

Enforcement is machine-shaped on both sides: here, `push-pr` renders only after
`local-review` approves (or a human approves `review-escalation`) — no input
can skip it. Local review loops up to eight rounds, fixes only blocking findings,
and exits when only nits remain. Escalation is available only when blockers
remain after the limit. In deck, `deck-v2 spawn --kind ship` REFUSES a profiled repo
without `--no-pipeline` (v2/src/spawn.ts `assertShipGoesThroughPipeline`), so a
bare worker cannot open the PR that skips this graph. Incident: doctrine PR
#26865 shipped with zero adversarial review through exactly that bare path.

## Stage graph → node ids

| SOP stage | Node id(s) | Kind |
|---|---|---|
| 0 preflight gate | `preflight`, `preflight-refusal` | compute; **refuses** with the open-question list |
| 1 implement | `implement` | agent (implementer model) |
| 2 local adversarial review | `local-review-loop` / `local-review` + `local-fix`, `review-escalation` | agent loop, cross-model, fresh context |
| 3 push + PR | `push-pr` | compute; PR registered in the watch-set **as a side effect of this node** |
| 3b request reviewers | `request-reviewers` | compute; CODEOWNERS + recent-author fallback, verified via `requested_reviewers` |
| 4 watch-ci-review | `r{N}-watch-loop` / `r{N}-watch-poll` + `r{N}-watch-fix`, `r{N}-watch-escalation` | persisted compute polls; bounded agent fixes |
| 5 migration gate (conditional) | `migration-check`, `migration-gate` (Approval), `migration-scope`, `migration-{stg,prod}-{run,verify}` | mandatory when diff touches `migrations/` or `packages/database-migrations/` |
| 6 ready-for-stamp | `r{N}-ready-loop` / `r{N}-ready-poll`, `r{N}-ready-exhausted` | human approval + CI green-or-**will-be**-green |
| 7 stamp + merge word | `r{N}-stamp` (Approval), `r{N}-stamp-validity` | durable park; head-change invalidates |
| 8 MQ merge | `r{N}-merge-head-check`, `enqueue-merge` | fresh head re-check at merge time, then compute; GitHub merge queue; receipted; idempotent |
| 8b landing verification | `landing-loop` / `landing-poll`, `landing-exhausted` | squash commit `(#N)` on main — **never** the merged flag |
| 9 fallout watch | `deploy-evidence`, `fallout-window`, `fallout-wait`, `fallout-watch`, `fallout-escalation` | anchored to deploy; NAMED break-signal |
| 10 evidence-gated done | `done` | refuses without landing + deploy evidence + fallout verdict (+ migration evidence when triggered) |

Enforcement notes (each maps to a cited incident in the SOP):

- **Preflight fails closed**: missing acceptance criteria, open decision-ledger
  entries, or an undeclared kill-switch (named-or-explicit-none + named
  break-signal) throw with the full open-question list. Nothing downstream renders.
- **Reviewers are always requested, post-push** (`request-reviewers`, gates the
  watch loop): CODEOWNERS owners of the touched paths first, then recent commit
  authors on those files ranked by frequency (lindy CODEOWNERS may be thin).
  Explicit entries (`brief.suggestedReviewers` merged with `github.reviewers`)
  may be display names - they resolve to logins via the gh-reviewer-lookup
  pattern (`/users/{login}` first, then commit-author name search); an entry
  that resolves to nothing **escalates instead of being dropped**. Self and
  `github.excludedApprovers` (ali, by default) are never requested. After the
  POST the node re-reads `requested_reviewers` and **escalates on any login GH
  silently dropped** (review requests silently no-op on plausible-but-wrong
  logins). Zero candidates also escalates - the only empty-reviewer path is an
  explicit `github.skipReviewerRequest: true`, recorded as `explicit-skip`.
- **watch-ci exit is machine-checked** (`lib/watch.ts`): zero unresolved review
  threads + all actionable comments answered + reviewers re-requested, verified
  against the `requested_reviewers` API (GH review requests silently no-op) + CI
  green. Pending or absent CI writes a `disposition: "wait"` poll receipt and
  stays in the persisted Smithers loop. It does not start an agent. Hard-red CI
  or review work writes `disposition: "fix"` and starts one bounded fix agent.
  Completed poll iterations survive an owner-process restart and resume from
  Smithers state.
  The agent works in plain commits on the SAME branch — the prompt hard-forbids
  `gh pr create`/child branches (#24026/#24223/#24227 class).
- **Stamp**: `r{N}-stamp` is a real smithers `<Approval>` — the run parks durably
  (a suspended run is a row, not a process) and resumes on `smithers approve`.
  The card is decision-shaped: original issue → fix → danger/blast radius.
  After approval, `r{N}-stamp-validity` re-fetches the head; a moved head
  invalidates the stamp and opens round N+1 back at **watch-ci** (fresh
  `r{N+1}-*` nodes). No silent re-stamp, ever.
- **No agent holds merge authority**: `enqueue-merge` renders only when a round
  has `stamp.approved && validity.valid && merge-head-check.ok`, and it is a
  compute node (submits to the GitHub merge queue, `gh pr merge` is policy-blocked
  repo-side anyway). `r{N}-merge-head-check` re-fetches the PR head immediately
  before enqueue: a head that moved between stamp-validity and merge fails the
  check, ends the round, and re-enters watch-ci (closes the stamp-to-merge
  TOCTOU window).
- **Migration staleness fails closed**: `migration-scope` re-captures the live
  migration file set at gate-approval time (not check time - rework may have
  added files in between); every later ready-poll re-detects the set, and any
  divergence from the approved scope (added, changed, OR removed files) after
  evidence exists makes the `migration-stale` node throw an escalation instead
  of landing stale-evidence migrations.
- **Merge submit re-checks the head one last time** inside `enqueue-merge`,
  immediately before `gh pr merge --auto --squash` - a moved head refuses to submit (nothing was
  enqueued, so the throw is retry-safe).
- **Ready-poll uses FRESH CI**: the ready verdict is computed from check runs
  fetched in the same poll as the approvals, not the earlier watch snapshot.
- **Bot comments count as actionable** in the watch exit (deliberate: the loop
  owns Claude-bot feedback per SOP stage 4; see `lib/watch.ts`).
- **Landing = squash commit `(#N)` on main** (`lib/landing.ts`). The merged
  flag is never consulted (GitHub merge queue closes PRs before landing is confirmed: state=closed, merged=false;
  3 confirmed repros).
- **Done is evidence-gated** (`lib/done.ts`): merged != done.
- **Every loop is bounded** with an escalation path: watch → `r{N}-watch-escalation`
  approval; ready → synthetic regression + fresh round; rounds → hard throw at
  `limits.stampRounds`; landing → hard throw. No infinite loops.

## Model selection (captain addendum)

`lib/models.ts` — agent models are **agent-pickable config from the deck
catalog** (pi harness + `deck/` provider). Pi is the only engine: every agent in
this pipeline is a `PiAgent` on `provider: "deck"`, so auth is broker-held and
quota-aware. See `../README.md` "Engine policy: pi only". Defaults:

| Role | Default |
|---|---|
| implementer | `deck/claude-sonnet-5` |
| reviewer | *derived by family opposition* (→ `deck/gpt-5.6-sol`) |
| watcher | `deck/gpt-5.6-terra` |
| fallout | `deck/claude-opus-5` |

**Family opposition is a first-class knob** (`models.familyOpposition`,
default `true`): adversarial-review/debate nodes pick the OPPOSITE model family
from the producing node via `resolveAdversary()`. Preflight **refuses** a
same-family reviewer unless `familyOpposition: false` is set explicitly.
The catalog (`DECK_AGENT_CATALOG`) mirrors the broker allowlist:
`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-5.6-sol`. Non-catalog or non-`deck/` refs fail preflight
(`assertDeckModel`, also used by the pack seats in `../.smithers/agents.ts`).

## How a crewmate dispatches a run

Prereqs: worktree of the lindy repo with the task branch checked out; deck
broker running (launchd); `bun install` once in this directory.

```sh
cd ~/dev/deck/workflows/pr-pipeline
bun install                      # pins smithers-orchestrator 0.30.0

# 1. Write the input (see examples/dry-run-input.json for the shape).
#    REAL RUN: set "dryRun": false and configure:
#      worktree, branch, repo        — your task worktree
#      commands.deployEvidence       — required (done is evidence-gated)
#      commands.migration*           — required if the diff touches migrations
#      github.selfLogins             — your GH login(s)
cp examples/dry-run-input.json /tmp/lin-123-input.json && $EDITOR /tmp/lin-123-input.json

# 2. Launch. ALWAYS pin the CLI version to match the workflow's pinned dep.
bunx smithers-orchestrator@0.30.0 up pipeline.tsx \
  --input "$(cat /tmp/lin-123-input.json)" \
  --run-id lin-123-pipeline
```

Exit code 3 = parked at an approval, **not** a failure. The run is durable; the
process may die (kill -9 verified) and `--resume true` continues without
re-executing completed nodes.

### Babysitting loop

```sh
bunx smithers-orchestrator@0.30.0 ps                       # run states
bunx smithers-orchestrator@0.30.0 why lin-123-pipeline     # which gate, since when
bunx smithers-orchestrator@0.30.0 inspect lin-123-pipeline # full node state
bunx smithers-orchestrator@0.30.0 logs lin-123-pipeline    # event stream
```

When a gate parks (`migration-gate`, `r{N}-stamp`, escalations): relay the card
to Tim through firstmate (`needs-decision:`), then resolve it yourself:

```sh
bunx smithers-orchestrator@0.30.0 approve lin-123-pipeline --node r0-stamp --by tim
#   or: deny ... --node r0-stamp   (onDeny=fail → the run fails closed)
bunx smithers-orchestrator@0.30.0 up pipeline.tsx --run-id lin-123-pipeline --resume true
```

Long real runs: prefer `up ... --serve --port <p>` to keep the owning process
alive at gates (plain `up` exits at a park; resume works either way).

The stamp card reaches Tim through firstmate; his answer resumes the run. The
crewmate NEVER approves the stamp itself.

### Operational invariants

- Input is immutable after the first frame — fix the brief, start a NEW run.
- The run store lives in the nearest `.smithers/` anchor (`workflows/.smithers`).
  Dispatch from this directory so every pipeline run lands in the same store.
- `push-pr` appends `{ticket, repo, pr, url, registeredAt, runId}` to
  `watchSetPath` (default `~/dev/fm2/data/watch-set.jsonl`) — the intake
  watch-set gets the PR the moment it exists; nothing untracked.
- Rework lands as plain commits on the existing PR branch (agent prompts
  hard-forbid child PRs).
- Workers own code and push only. They exit after each bounded implementation or
  fix. The Deck orchestrator or persisted Smithers nodes own all CI and review
  watches. A worker must never sleep-poll CI.

## Dry-run mode

`"dryRun": true` (the DEFAULT — real GH writes require explicit
`dryRun: false`) stubs every side effect and agent call with scripted fixtures
but keeps the identical stage graph and **real approval parks**:

```sh
bunx smithers-orchestrator@0.30.0 up pipeline.tsx \
  --input "$(cat examples/dry-run-input.json)" --run-id pipeline-dryrun
# → executes preflight→implement→review→push→watch, parks at migration-gate (exit 3)
bunx smithers-orchestrator@0.30.0 approve pipeline-dryrun --node migration-gate --by you
bunx smithers-orchestrator@0.30.0 up pipeline.tsx --run-id pipeline-dryrun --resume true
# → migrations stg→verify→prod→verify, ready-poll, parks at r0-stamp
bunx smithers-orchestrator@0.30.0 approve pipeline-dryrun --node r0-stamp --by you
bunx smithers-orchestrator@0.30.0 up pipeline.tsx --run-id pipeline-dryrun --resume true
# → validity→merge→landing→deploy-evidence→fallout→done. status: finished
```

`fixtures` (dry-run only) steer the script: `changedFiles` (migration path
on/off), `watchPollsToExit`, `watchWaitPolls` (non-actionable CI polls owned by
Smithers), `localReviewRounds`, and `headChangeRounds` (e.g. `[0]` = head moves
after round-0 stamp → watch that the workflow re-enters watch-ci as round 1
instead of re-stamping).

`bypassApprovals: true` (tests only) swaps each `<Approval>` for an
auto-approved compute row under the same node id so `simulate()` can traverse
the full graph. **Preflight refuses it unless `dryRun` is also true** — no real
run can self-approve its gates.

## Tests

```sh
bun install                       # here
bun install --cwd ../.smithers    # engine.test.ts loads the pack's seats
bun test tests/          # 99 tests
bun run typecheck
bun run graph            # render-without-execute sanity check
```

- `tests/reviewers.test.ts` — request-reviewers stage: CODEOWNERS
  parsing/matching (GitHub semantics: `docs/*` owns direct children only,
  `**/` matches zero dirs), frequency fallback, ali/self/bot exclusion, the
  full `executeReviewerRequest` escalation paths against mocked adapters, and
  the gh adapters (request POST + silent-no-op verification) against a mocked
  exec.
- `tests/gates.test.ts` — pure gate logic: brief validation, watch-exit machine
  check, re-request detection, migration detection + evidence, ready-for-stamp
  (bot/excluded/self approvals never count; will-be-green ruling), landing
  `(#N)` matching, evidence-gated done, model catalog + family opposition.
- `tests/engine.test.ts` — the pi-only engine invariant across the whole
  `workflows/` workspace (see `../README.md` "Engine policy: pi only"). It
  imports `../.smithers/agents.ts`, so it needs `.smithers` deps installed.
- `tests/pipeline.test.tsx` — drives the REAL workflow module through
  `smithers-orchestrator/testing` `simulate()`: preflight refusal paths, parks
  at migration-gate/stamp without bypass, full-graph traversal (clean + migration
  + head-change-restamp + watch-loop iteration) with bypass.

## Files

```
pipeline.tsx            the workflow (all stage wiring)
lib/types.ts            pure domain types
lib/brief.ts            preflight validation
lib/models.ts           deck catalog + deck/ provider guard + family opposition
tests/engine.test.ts    pi-only engine invariant (whole workspace)
lib/watch.ts            watch-ci-review machine-checked exit
lib/migrations.ts       migration detection + evidence completeness
lib/ready.ts            ready-for-stamp evaluation
lib/reviewers.ts        CODEOWNERS parsing/matching + reviewer selection
lib/landing.ts          squash-commit (#N) landing check
lib/done.ts             evidence-gated done
lib/gh.ts               gh/git adapters + pure payload parsers
lib/prompts.ts          agent prompt builders
tests/                  unit + workflow-simulation tests
examples/               dry-run input
```

## Known limitations (v1)

- Migration evidence is recorded once per run; if a later rework changes the
  migration files after the gate ran, the ready-poll flags it and regresses the
  round, but re-running migrations needs a human decision (the gate card shows
  the file list at approval time).
- `commands.deployEvidence` is repo-specific and must be configured per run;
  preflight refuses real runs without it.
- Real-mode GH fetchers page at 100 threads/reviews/comments per poll (enough
  for lindy-sized PRs; revisit if a PR outgrows that).
- The pre-merge head re-check narrows the stamp-to-merge race to the seconds
  between check and `gh pr merge --auto --squash` submission; a truly atomic check would need
  server-side support GitHub merge queue does not expose. The landing verification
  still catches any mismatch after the fact (squash `(#N)` search).
