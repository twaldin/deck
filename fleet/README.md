# @deck/fleet — read-only fleet dashboard TUI

A standalone Bun + TypeScript terminal dashboard that shows, live and
**read-only**, every firstmate crewmate (agent) as a tree with its correlated
Smithers workflow runs underneath. Built to be dropped into a
[herdr](#herdr-pane-embedding) pane. It **never** mutates state — no control
actions, no keybindings that change anything, no starting/stopping of any
Gateway or daemon.

```
Fleet · ~/dev/fm2 · 10 tasks (2 active) · 1 runs · 21:28:26
├─ ● fleet-dashboard-tui  working  gpt-5.6-sol/xhigh  ship  pi  43m
│    isolated worktree verified; implementation started
│ └─ ◐ oneshot (oneshot-ms447bsd-90e9781d)  running · @review · 41m ago
│   ├─ ✓ implement — finished
│   └─ ◐ review — in-progress
├─ ○ shadow-old-fm  queued  since 2026-07-27
│    Shadow the live old firstmate before cutover (BLOCKED on captain word)
│    hold: old fm live on day job; shadow starts only on captain word
...
Sources
  MISSING  smithers:…/fm2/workflows — ps failed
  ok  FM_HOME (/Users/twaldin/dev/fm2) — 2 tasks (2 meta, 2 status)
  ok  backlog:tasks-axi — 10 via tasks-axi
  ok  smithers:…/2/deck — 1 run (1 with rootDir)
  skipped  broker — skipped (capability auth not wired — TODO seam)
```

A full captured frame against this machine's real state lives in
[`docs/frame.txt`](docs/frame.txt) (plain) and [`docs/frame.ansi`](docs/frame.ansi)
(colored) — see [docs/CAPTURE.md](docs/CAPTURE.md).

## Invocation

```sh
# From the package dir:
bun run bin/deck-fleet                      # live, auto-refresh
bun run bin/deck-fleet --once --no-color    # single frame (capture/testing)

# Or via the bin name once linked:
deck-fleet --interval 3 --workspace ~/dev/fm2/workflows
```

Quit the live view with `q` or `Ctrl-C` (these are the *only* keys handled).

## Configuration

| Flag | Env / default | Meaning |
| --- | --- | --- |
| `--fm-home <path>` | `$FM_HOME`, else `~/dev/fm2` | Firstmate fleet home. |
| `--workspace <path>` | `cwd` + `<fm-home>/workflows` | Smithers workspace to scan. Repeatable. |
| `--interval <sec>` | `2` | Refresh interval, **clamped to 1–5s**. |
| `--min-width <n>` | `48` | Compact-layout threshold; output never exceeds physical columns. |
| `--once` | off | Render one frame and exit. |
| `--no-color` | auto (off when piped / `NO_COLOR`) | Disable ANSI color. |
| `--color` | — | Force color even when not a TTY. |

## Data sources (all read-only)

1. **Firstmate fleet home** (`FM_HOME`): `state/*.meta` (window, worktree,
   harness, model, effort, kind, backend, …) and the final non-blank event of
   each `state/*.status` tail (using a bounded suffix read). `data/backlog.md` is read **via `tasks-axi list`
   when available**, and safely **falls back to parsing the markdown directly**
   when `tasks-axi` is absent, errors, or emits an unrecognized shape.
2. **Smithers runs**: discovered through the public **read-only CLI only** —
   bounded all-status `smithers ps` queries request one sentinel beyond the
   100-run display ceiling, warn if results are capped, and use
   `smithers inspect <id> --json` for node/progress + the run's durable
   `rootDir`. The dashboard never opens the private sqlite db directly and
   never starts/stops a Gateway or runs any mutating command. The CLI is pinned
   to `smithers-orchestrator@0.30.0` (see the version-skew note in the repo
   `AGENTS.md`).
3. **Broker usage roster** (optional): intentionally a **typed TODO seam**
   (`src/collectors/broker.ts`). No auth scheme is invented; the source reports
   itself as skipped until a capability path is wired.

### Run ↔ task correlation

A run is attached to a task **only** when the run's durable absolute `rootDir`
exactly equals that task's absolute `meta.worktree` (both normalized). This is
the one launch identifier both sides share; fuzzy name matching is deliberately avoided.
Every run that doesn't match — including runs with no `rootDir` — is shown in a
separate **Workflows (uncorrelated)** section rather than guessed onto a task.

### Status staleness

For tasks with a Herdr pane endpoint, each refresh also performs the read-only
`herdr agent get <window>` probe. If the live pane state disagrees with the
latest Firstmate `state/<id>.status` event, the task is annotated with
`status stale (pane: <state>)`; unavailable or unknown pane reads are not
presented as a disagreement.

### Graceful degradation

Every source degrades to a labeled `Sources` diagnostic instead of crashing:
missing `FM_HOME`, no reachable Smithers workspace, absent `tasks-axi`, and the
un-wired broker all render as `MISSING`/`skipped` lines while everything else
still displays.

## Architecture (separable layers)

The renderer is kept **separate from data collection** so a future herdr plugin
could reuse the collectors without the terminal renderer:

```
src/collectors/*   fleet.ts · pane.ts · backlog.ts · smithers.ts · broker.ts  (read-only, injectable runner)
src/correlate.ts   conservative run↔task attribution by rootDir
src/run-state.ts   shared live-vs-terminal Smithers state classification
src/model.ts       buildModel(): fan-out collectors → typed FleetModel
src/render.ts      renderModel(): FleetModel → colored, width-truncated lines
src/diff.ts        FramePainter: differential in-place line updates
src/viewport.ts    fitFrame(): physical terminal row budget
src/tui.ts         refresh loop, resize handling, --once
```

Rendering uses **differential in-place updates**: after the first paint only the
lines whose text changed are rewritten (cursor is moved to the top of the block
and unchanged rows are skipped). Refreshes are single-flight, and quit aborts
in-flight CLI probes. There is **no alternate screen** and no full-screen clear,
so it composes cleanly inside a herdr split. On terminal resize the existing
block is repainted in place. Live frames are fitted to the pane height with an
explicit omitted-line count, and narrow panes switch to compact layout while
remaining capped to their physical column count.

## Herdr pane embedding

Run `deck-fleet` (no `--once`) as the command in a herdr pane. Because it uses
no alternate screen, switches to compact layout below `--min-width`, fits the
pane's row/column bounds, and only rewrites changed lines, it sits quietly in a
split without flicker or resize corruption. Set `--interval` to taste within
the 1–5s band; color is auto-detected from the pane's TTY (force it with
`--color` if herdr pipes the output).

## Development

```sh
bun install
bun test            # fixture-only unit tests, no live dependencies
bunx tsc --noEmit   # typecheck
```

All tests use fixture directories / injected command runners; none touch a live
firstmate home, Smithers db, or the network.
