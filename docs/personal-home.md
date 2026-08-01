# Personal deck-home bootstrap

How to stand up a second, fully separate deck home on a durable personal host.
Operator topology and access steps live in that operator's private notes — not
in this public repo.

## The one rule

**The personal home is outside the company security perimeter.** Each host has
its own `~/.deck`. Nothing inside a `~/.deck` is ever copied between hosts —
not `broker/store.db` (OAuth credentials), not `.env`, not `data/`, not
`state/`, not `questions/`. Deck code syncs through the git remote only.

Forbidden on the personal host, permanently:

- Company eng-agent keys, company broker credentials, or any work OAuth account
- prod-readonly credentials of any kind
- Company product checkouts

If a step seems to need one of these, the step is wrong. Stop.

## Checklist

Run everything below **on the personal host**, as your own user.

1. **Private network.** Host reachable from your laptop (Tailscale or equivalent).

2. **Prerequisites.** `git`, [`bun`](https://bun.sh), `gh` (personal account).

3. **One-shot install**:

   ```sh
   git clone https://github.com/twaldin/deck.git ~/dev/deck
   cd ~/dev/deck && git checkout main
   ./install-personal.sh
   ```

   Keep updated later (works on an already-installed host): `~/dev/deck/scripts/update-home.sh`.

The private home repository is synced with plain git:

```sh
deck-v2 home status
deck-v2 home pull
deck-v2 home push
```

The laptop uses the `profile/full` tree. Deckbox uses `profile/personal`. The
personal profile is built without Lindy files or the Lindy project entry. Never
copy the full profile to deckbox. Runtime state, Smithers runs, questions,
credentials, and `.env` are machine-local and are never synced.

For a remote deckbox session, run `~/dev/deck/scripts/update-home.sh`, then
restart the session with `/reload` if the running pi does not reload the
extension automatically. The updater is safe to run repeatedly and is the
primary path for an existing installation. Private repo access requires an
active `gh auth login` before the home repo clone or pull.

   Laptop agents: `docs/LAPTOP-AGENTS.md` (inbox + project register).

4. **Broker.** Start the daemon, then log in with **personal accounts only**:

   ```sh
   bun --cwd ~/dev/deck/broker src/main.ts   # foreground; or your process manager
   bun ~/dev/deck/broker/src/cli.ts login anthropic
   bun ~/dev/deck/broker/src/cli.ts login openai-codex-device   # optional
   bun ~/dev/deck/broker/src/cli.ts status
   ```

   Credentials land in `~/.deck/broker/store.db` (0600) on this host and stay
   here. On Linux run the broker under your own process manager (systemd user
   unit or a shell in tmux).

5. **Herdr server.** Install the `herdr` binary on the host, then:

   ```sh
   herdr server
   ```

   Glass in from a laptop with `herdr --remote <user>@<host>`.

6. **Verify.**

   ```sh
   deck-v2 home     # prints ~/.deck
   deck-v2 fleet    # empty fleet, no errors
   ```

## Shipping a personal project (yolo-ship)

Personal projects ship through the same PR pipeline as everything else; the
profile just selects the yolo posture. One-time per project: add a profile to
`~/.deck/config/projects.json` (`pipeline: "yolo-ship", yolo: true, stamp: false`).

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

| Host role | Authors deck? | Gets new deck by |
|---|---|---|
| Dev laptop | yes | pushes PRs to the deck remote |
| Work host | no | `git pull` on `main` + `bash v2/install.sh` |
| Personal orch host | optional personal features | same: `git pull` on `main` + install |

The pull + install pair is the whole sync path. State never travels; only the
repo does.
