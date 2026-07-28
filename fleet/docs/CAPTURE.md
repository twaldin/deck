# Captured frame

`frame.txt` (plain) and `frame.ansi` (colored) are real single-frame captures
of `deck-fleet`, produced on this machine against **live state**:

- `FM_HOME=~/dev/fm2` — the real firstmate fleet home.
- Smithers workspaces: this deck worktree root (which carries a live
  `smithers.db`) and `~/dev/fm2/workflows`.

Reproduce:

```sh
cd <deck-worktree-root>
FM_HOME=~/dev/fm2 bun run fleet/bin/deck-fleet --once --no-color \
  --workspace "$(pwd)" --workspace ~/dev/fm2/workflows > fleet/docs/frame.txt

FM_HOME=~/dev/fm2 bun run fleet/bin/deck-fleet --once --color \
  --workspace "$(pwd)" --workspace ~/dev/fm2/workflows > fleet/docs/frame.ansi
```

What the capture demonstrates end-to-end:

- The live `oneshot` Smithers run is **correlated to its owning task**
  (`fleet-dashboard-tui`) because the run's `rootDir` equals that task's
  `meta.worktree`, and its nodes (`implement` finished, `review` in-progress)
  render as state-colored sub-entries.
- Backlog-only tasks (no live agent) still list, sourced via `tasks-axi`.
- The configured second Smithers workspace path is unavailable, so its failed
  public CLI probe degrades to a `MISSING` diagnostic in the `Sources` footer
  rather than aborting the frame.
- The broker source reports its intentional TODO-seam skip.

`frame.ansi` contains raw ANSI SGR escapes; view it with `cat fleet/docs/frame.ansi`
in a terminal (not a pager that escapes control bytes).
