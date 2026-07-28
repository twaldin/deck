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

- Active tasks have one compact identity row and their full status payload
  wraps to the actual terminal width; it is never ellipsized.
- Queued tasks take one row; completed history is one `✓ N done` summary.
- Source health is one quiet, operator-readable line. Use `--verbose` to show
  the individual collector diagnostics (including failed public CLI probes).
- `frame.txt` and `frame.ansi` are the after captures for the dense layout;
  the prior vertical-tree capture is available from the parent revision.

`frame.ansi` contains raw ANSI SGR escapes; view it with `cat fleet/docs/frame.ansi`
in a terminal (not a pager that escapes control bytes).
