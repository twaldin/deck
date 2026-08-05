# deck v2

This is my pi setup for running a handful of coding agents at once without losing
track of them. It is not a framework and not a product — it is the thing I
actually use, cleaned up enough to read.

## The idea

I had a previous version of this built on tmux. Almost all of its complexity
existed to answer one question: *is that agent still alive, and what is it doing?*
Long-lived agents made that question hard, so there were pollers, watchers,
staleness heuristics, and a supervision daemon — and one of those watchers once
died quietly for most of a day and nobody noticed.

v2 deletes the question instead of answering it better. A worker is a one-shot
run: it starts on an event, does one bounded piece of work, writes a receipt, and
exits. There is nothing to keep alive, so there is nothing to poll.

What is left is small:

- **status files** — append-only, one line per event, `verb: one short line`
- **receipts** — for anything irreversible, written *before* the act
- **Smithers' detached pr-pipeline** — owns delivery progress and liveness
- **three standalone pi extensions** — questions, factory dispatch, and recall

## Library, CLI, and pi tools

The headless implementation lives in `src/`. The CLI (`bin/deck-v2`) calls it
directly, and the standalone entrypoints in `../extensions-pi/` import the same
functions. `ship` and `adopt` therefore dispatch through `src/ship.ts` exactly
as `deck-v2 ship` does; there is no orchestrator extension or duplicate engine.

```
deck-v2 bootstrap          # create ~/.deck
deck-v2 ship <ticket> --profile <id> --worktree <path> --branch <name> ...
                           # DEFAULT ship path: the project's PR pipeline
deck-v2 spawn <id> --task "..." --accept "..." --worktree <path>
deck-v2 status <id>
deck-v2 fleet              # what everything is doing
```

## Shipping goes through the pipeline

`src/ship.ts`: an effort that ends in a PR ships through its project profile's
pipeline (`workflows/pr-pipeline`), where the PR open is a compute node behind
a hard adversarial-review gate; `lindy-full` parks for the captain's stamp,
`yolo-ship` auto-merges on green. `spawn --kind ship` on a profiled repo is
REFUSED without `--no-pipeline` (`assertShipGoesThroughPipeline` in
`src/spawn.ts`) — spawn is for workers inside a pipeline stage and scouts. See
`workflows/pr-pipeline/README.md` "This is the DEFAULT ship path".

## Plain sessions and external memory

Any number of plain pi sessions can start in `~/.deck`. They shape work and use
the factory tools; Smithers owns delivery progress and liveness. Decisions are
queued once instead of being asked through competing channels.

The public home contract is copied from `seed/AGENTS.md`. OptMem holds global
identity, decisions, preferences, and durable lessons. Effort dossiers hold
briefs, rationale, rejected alternatives, and checkpoints. Lindy's
`STANDING-RULES.md` remains a separate seat-injection source.

## The questions queue

`src/questions.ts` + `src/questions-store.ts` provide the durable
captain-facing decision queue. `../extensions-pi/deck-questions.ts` registers
the non-blocking `ask_captain` tool, read-only `list_questions`,
first-answer-wins `answer_question`, and the interactive `/questions` command.
`v2/install.sh` installs that extension into `~/.deck/.pi`, so plain Deck
sessions share one queue while pr-pipeline seats do not load a competing
question surface.

The queue lives at `~/.deck/questions/queue.jsonl` (`DECK_QUESTIONS_FILE`
overrides it for tests). It is one append-only JSONL event log, folded on read;
first answer wins, and delivery sends before it marks. Session start imports
still-open questions from the legacy `~/.pi/agent/questions/` queue once. Live
Deck sessions never rewrite the shared log; archival compaction is exclusive
offline maintenance. The statusline chip is `N?` while questions are open.

The opt-in real smoke spans two pi processes sharing only the queue file:

```bash
cd v2
bun run smoke/run-questions-smoke.ts
```

## The home is not a checkout

`~/.deck` holds `data/` and `state/`. It is deliberately a plain directory, not a
git repo, and the code refuses to run if you point it at one. Two reasons, both
learned the hard way: a checkout brings its own `AGENTS.md`, which the agent then
loads instead of its contract; and live state inside a working tree can get
rebased out from under a running fleet.

## Things worth knowing if you read the code

- `run_epoch` fences local state only. An epoch grants the right to *start*
  something; it cannot un-land a push, so irreversible operations use a claim plus
  a pending receipt instead.
- Do not infer landing from a pull request's closed or unmerged state. Landing
  is confirmed by finding the squash commit on the base branch. Trusting only
  the merged flag can discard work that had actually shipped.
- Statuses are events, not state. `working:` is not progress, silence is not
  failure, and `paused:` means deliberately waiting.
- A live run is judged stuck by SILENCE, not by its budget. The signals are the
  newest write in the task worktree (node_modules/.git excluded) and the session
  transcript's mtime and byte growth. A status line is a report about the work,
  not the work, so its mtime is not activity: a worker looping on a retry can
  keep appending `working:` while writing nothing. A run still writing is
  working, however overdue. `DECK_STALE_SILENCE_MS` moves the 10-minute default;
  the verdict is suppressed with backoff so a standing wedge is not re-reported
  every cycle, and a suppressed task is rescanned at most once per silence window.
  `deck-v2 stale` is read-only in both directions: it neither writes suppression
  nor obeys it, so an inspection always answers with the current verdict. Silence is measured from `run_started`, never from files the
  previous run left behind: a respawn reuses the worktree, so without that anchor
  a replacement run inherits the dead run's mtimes and is called stuck at launch.
- Wake delivery is at-least-once through a durable outbox. Reading the status file
  advances a cursor, so if that read were also the acknowledgement, a failed
  injection would lose the event permanently — and a dropped `blocked:` is the
  worst thing that can happen here.

## Status

The headless libraries back the CLI and standalone extension pack. Plain pi
sessions have no fleet overlay, wake loop, calm mode, or privileged orchestrator
surface; durable shipment progress belongs to Smithers.

`bun test` from this directory. Tests are deliberately not one-per-change: each is
supposed to go red on the behavior it replaced, and several were written by
reintroducing the original bug to prove they do.
