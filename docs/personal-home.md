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

2. **Prerequisites.** `git`, [`bun`](https://bun.sh), `curl`, and Python 3. A standalone chat needs no GitHub CLI; `ship`/`adopt` require `gh` authenticated to the target repository.

3. **One-shot install**:

   ```sh
   export DECK_REPO_URL="https://github.com/<owner>/deck.git"
   git clone --branch main "$DECK_REPO_URL" ~/dev/deck
   cd ~/dev/deck
   ./install.sh
   ```

   Keep updated later (works on an already-installed host): `~/dev/deck/update.sh`.

Create the private home repository once from two reviewed profile directories. The
second directory must be a filtered copy. The script refuses restricted project
material in it and creates both branches. Do not create the personal branch by deleting
files from the full branch after the fact.

```sh
~/dev/deck/scripts/bootstrap-home-repo.sh /path/to/profile-full /path/to/profile-personal
```

The private home repository is synced with plain git:

```sh
deck-v2 home status
deck-v2 home pull
deck-v2 home push
```

Pull is additive. It never deletes local home entries. Review the profile before
pushing it. A trusted host may use `profile/full`; a less-trusted host uses
`profile/personal`. The personal profile is built without restricted project
files or entries. Never copy the full profile to an untrusted host. Runtime
state, Smithers runs, questions, credentials, and `.env` are machine-local.

For a remote operator session, run `~/dev/deck/update.sh`, then
restart the session with `/reload` if the running pi does not reload the
extension automatically. The updater is safe to run repeatedly and is the
primary path for an existing installation. Private repo access requires an
active `gh auth login` before the home repo clone or pull.

   Laptop agents: `docs/LAPTOP-AGENTS.md` (inbox + project register).

4. **Model access.** For a standalone conversation, start Pi and run `/login`
   with your own subscription or API key. The current factory and
   `deck-subagents` seats additionally require a broker configured only with
   accounts belonging on this host:

   ```sh
   bun ~/dev/deck/broker/src/cli.ts login anthropic
   bun --cwd ~/dev/deck/broker src/main.ts
   ```

   Credentials land in `~/.deck/broker/store.db` (0600) on this host and stay
   here. Keep the broker running with your own process manager when the factory
   needs it. It is not started by `install.sh`.

5. **Remote access.** Plain SSH is sufficient:

   ```sh
   ssh -t <user>@<host> 'source ~/.deck/enter.sh && pi'
   ```

6. **Verify.**

   ```sh
   ~/dev/deck/ops/verify-clean-install.sh
   source ~/.deck/enter.sh
   pi
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
the merge fires automatically on CI green — no explicit-approval park. Inspect
it with `smithers ps` / `smithers why <run-id>` from `~/.deck/state/smithers`.
A bare `deck-v2 spawn --kind ship` on a profiled repo is refused; that is the
point — the pipeline is the default, `--no-pipeline` is the escape hatch.

## How deck code moves between hosts

| Host role | Authors deck? | Gets new deck by |
|---|---|---|
| Dev laptop | yes | pushes PRs to the deck remote |
| Work host | no | `~/dev/deck/update.sh` |
| Personal operator host | optional personal features | `~/dev/deck/update.sh` |

`update.sh` is the existing-install path. Runtime state never travels; only the
repository code does.
