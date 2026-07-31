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

1. **Tailscale.** Already on the tailnet as `deckbox`. Enable Tailscale SSH
   (and optionally rename):

   ```sh
   sudo tailscale up --ssh --hostname=deckbox
   ```

   Clients then reach it with `ssh deckbox` — no key copying.

2. **Prerequisites.** `git`, [`bun`](https://bun.sh), `gh` (authenticated with
   your **personal** GitHub account).

3. **Clone deck** (code home, separate from the state home):

   ```sh
   git clone https://github.com/twaldin/deck.git ~/dev/deck
   cd ~/dev/deck && git checkout v2
   ```

4. **Install** — either run the script:

   ```sh
   ~/dev/deck/install-personal.sh
   ```

   or do the same by hand:

   ```sh
   bun install --cwd ~/dev/deck/v2
   bun install --cwd ~/dev/deck/broker
   bun install --cwd ~/dev/deck/cli
   bash ~/dev/deck/v2/install.sh        # ~/.deck/.pi extension + deck-v2/deck/smithers shims
   bun ~/dev/deck/v2/bin/deck-v2 bootstrap   # creates ~/.deck (plain dir, never a checkout)
   ```

   Make sure `~/.local/bin` is on `PATH`.

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

## How deck code moves between hosts

| Host | Authors deck? | Gets new deck by |
|---|---|---|
| home laptop (`twaldin-home`) | **yes** — sole deck-dev | pushes PRs to `twaldin/deck` |
| work host (`twaldin-work`) | no | `git -C ~/dev/deck pull` on `v2` + `bash v2/install.sh` |
| deckbox | optional personal features | same: `git pull` on `v2` + `bash v2/install.sh` |

The pull + install pair is the whole sync path. State never travels; only the
repo does.
