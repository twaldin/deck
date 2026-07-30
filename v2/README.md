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
- **an event loop in the orchestrator's own process** — not a daemon, so it cannot
  die silently while everything else keeps running

## Two faces, one library

Everything lives in `src/`. The pi extension (`src/extension/`) imports it
directly, and the CLI (`bin/deck-v2`) is a thin argument parser over the same
functions. Neither is a wrapper around the other: no subprocess hop when the
orchestrator spawns a worker, and no second copy of the logic to keep in sync.

```
deck-v2 bootstrap          # create ~/.deck
deck-v2 spawn <id> --task "..." --accept "..." --worktree <path>
deck-v2 status <id>
deck-v2 fleet              # what everything is doing
```

## Roles

There is one **orchestrator** — the agent I talk to. It dispatches work, judges
what comes back, and is the only thing that asks me questions. **Workers** do the
actual work in isolated worktrees and never talk to me directly; if a worker hits
a decision, it says so in its status file and the orchestrator relays it.

That last rule is not politeness, it is a race fix. When both could ask me
things, I answered one agent's question while the orchestrator independently
authorized another, and the two orders conflicted. Now workers spawn with the
question tool excluded, so the second channel cannot exist.

The orchestrator's operating contract lives in `~/.deck/AGENTS.md`, seeded from
`seed/orchestrator-contract.md`. It is about 1,200 words on purpose: the previous
version was 500 lines, always loaded, and its rules decayed within days — one was
violated three days after being written.

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
- A pull request that landed through a merge queue reads as `closed, not merged`.
  Landing is confirmed by finding the squash commit on the base branch. Trusting
  the merged flag would discard work that had actually shipped.
- Statuses are events, not state. `working:` is not progress, silence is not
  failure, and `paused:` means deliberately waiting.
- Wake delivery is at-least-once through a durable outbox. Reading the status file
  advances a cursor, so if that read were also the acknowledgement, a failed
  injection would lose the event permanently — and a dropped `blocked:` is the
  worst thing that can happen here.

## Status

Works, and I use it. The pieces here cover spawning, status, wakes, the fleet
view, teardown safety, and the backlog. It runs alongside the old system rather
than replacing it outright, with an owner marker deciding which one owns a task.

`bun test` from this directory. Tests are deliberately not one-per-change: each is
supposed to go red on the behavior it replaced, and several were written by
reintroducing the original bug to prove they do.
