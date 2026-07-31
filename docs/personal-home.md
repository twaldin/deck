# Personal deck-home bootstrap (deckbox)

How to stand up a second, fully separate deck home on the personal host
(`deckbox`, 124 GB / 24c, Tailscale `100.107.83.38`). Context:
work topology and access steps live in the operator's `data/ref/topology.md`
and `data/ref/access-checklist.md`.

## The one rule

**The personal home is outside the company security perimeter.** Each host has
its own `~/.deck`. Nothing inside a `~/.deck` is ever copied between hosts —
not `broker/store.db` (OAuth credentials), not `.env`, not `data/`, not
`state/`, not `questions/`. Deck code syncs through the git remote only.

Forbidden on the personal host, permanently:

- Lindy eng-agent keys, Lindy broker credentials, or any work OAuth account
- prod-readonly credentials of any kind
- `lindy-ai/*` checkouts or any company code

If a step seems to need one of these, the step is wrong. Stop.

## Checklist

Run everything below **on deckbox**, as your own user.

1. **Tailscale.** Already on the tailnet as `deckbox`.

2. **Prerequisites.** `git`, [`bun`](https://bun.sh), `gh` (personal account).

3. **One-shot install** (clones `v2` if needed):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/twaldin/deck/v2/install-personal.sh | bash
   # or from an existing clone:
   ~/dev/deck/install-personal.sh
   ```

   Keep updated later: `~/dev/deck/scripts/update-home.sh`

   Laptop agents: `docs/LAPTOP-AGENTS.md` (inbox + project register).

5. **Broker.** Start the daemon, then log in with **personal accounts only**:

   ```sh
   bun --cwd ~/dev/deck/broker src/main.ts   # foreground; macOS can use ops/install.sh (launchd)
   bun ~/dev/deck/broker/src/cli.ts login anthropic
   bun ~/dev/deck/broker/src/cli.ts login openai-codex-device   # optional; any pi-ai OAuth provider
   bun ~/dev/deck/broker/src/cli.ts status
   ```

   Credentials land in `~/.deck/broker/store.db` (0600) on this host and stay
   here. `ops/install.sh` is macOS/launchd; on Linux run the broker under your
   own process manager (systemd user unit or a shell in tmux — either is fine).

6. **Herdr server.** Install the `herdr` binary on deckbox, then:

   ```sh
   herdr server
   ```

   Glass in from a laptop with `herdr --remote deckbox` (or `ssh deckbox`).

7. **Verify.**

   ```sh
   deck-v2 home     # prints ~/.deck
   deck-v2 fleet    # empty fleet, no errors
   ```

## Shipping a personal project (yolo-ship)

Personal projects on deckbox ship through the same PR pipeline as everything
else; the profile just selects the yolo posture. One-time per project: add a
profile to `~/.deck/config/projects.json` (the deck seed is the template —
`pipeline: "yolo-ship", yolo: true, stamp: false`).

Then one command ships an effort:

```sh
deck-v2 ship myproj-7 --profile myproj \
  --worktree ~/.deck/wt/myproj-1 --branch deck/myproj-7 --base main \
  --title "feat(x): y" --summary "what and why" \
  --accept "tests green;behavior proven"
```

That starts the pr-pipeline workflow detached: adversarial review (opposite
model family) hard-gates the PR open, CI/review watch keeps it mergeable, and
the merge fires automatically on CI green — no stamp park. Watch it with
`smithers ps` / `smithers why <run-id>` from `~/dev/deck/workflows/pr-pipeline`.
A bare `deck-v2 spawn --kind ship` on a profiled repo is refused; that is the
point — the pipeline is the default, `--no-pipeline` is the escape hatch.

## How deck code moves between hosts

| Host | Authors deck? | Gets new deck by |
|---|---|---|
| home laptop (`twaldin-home`) | **yes** — sole deck-dev | pushes PRs to `twaldin/deck` |
| work host (`twaldin-work`) | no | `git -C ~/dev/deck pull` on `v2` + `bash v2/install.sh` |
| deckbox | optional personal features | same: `git pull` on `v2` + `bash v2/install.sh` |

The pull + install pair is the whole sync path. State never travels; only the
repo does.
