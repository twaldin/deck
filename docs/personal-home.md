# Personal deck-home bootstrap

How to stand up a second, fully separate deck home on a durable personal host.
Operator topology and access steps live in that operator's private notes — not
in this public repo.

## The one rule

**The personal home is outside the company security perimeter.** Each host has
its own `~/.deck` and host-local `~/.deck-durable`. Neither tree is copied
between hosts. Deck code syncs through the git remote only. The private home
repository carries reviewed portable profile files only; bootstrap excludes
every durable link and retired profile from it.

Bootstrap uses a sibling root rather than making `~/.deck` a repository or
making the whole home durable. Existing tools keep their `~/.deck/...` paths
through installer-owned symlinks, while a rename or removal of `~/.deck` leaves
the targets in `~/.deck-durable` untouched. A git-backed durable root is
forbidden: it would mix credentials and machine-local workflow authority with
portable profile data. `DECK_DURABLE_HOME` may select another host-local path,
but bootstrap rejects one inside `~/.deck` and records home/host ownership in a
0600 manifest.

| Path under `~/.deck` | Class | Why |
|---|---|---|
| `data/` | DURABLE | Effort dossiers, inbox inputs, and recorded facts are the cold-resume record. |
| `state/` | DURABLE | Effort status/meta/queue/receipts and Smithers databases, executions, approvals, and ship inputs form one integrity unit. Some caches inside are derivable, but selectively wiping the directory can corrupt a live effort. |
| `questions/` | DURABLE | The append-only captain decision queue must retain open and answered decisions. |
| `worktrees.json` | DURABLE | It binds effort, repository, branch, and worktree identities; those relationships cannot be inferred safely. |
| `wt/` | DURABLE | Worktrees may contain uncommitted or unpushed work. The registry and trees survive together. |
| `broker/` | DURABLE | OAuth accounts and local capabilities must remain authenticated on this host. Directories are 0700; every regular file, including `store.db` and tokens, is forced to 0600. |
| `config/`, `config.json` | DURABLE | Project/reviewer policy, admission limits, and host-specific routing are private authority, not installer defaults. |
| `efforts/` | DURABLE | Legacy manifests, charters, inboxes, and tails remain effort evidence until explicitly retired. |
| `archive/`, `backups/`, `repos/` | DURABLE | Recovery copies and potentially local-only checkout work are not assumed reconstructible. |
| `.env`, `.deck-profile` | DURABLE | Host secrets and profile identity are private host configuration. |
| `.pi/` | EPHEMERAL as a live path; ARCHIVE-ONCE | Pi is retired. On first migration bootstrap moves any old profile to `~/.deck-durable/archive/retired-pi-profile` and never recreates a live `.pi`. |
| `.prime/` | EPHEMERAL | The installer owns the runtime, extensions, cache, and profile. Conversation sessions and refinement technique are explicitly non-authoritative. |
| `catalog/` | EPHEMERAL | It is a derived index. |
| `run/` | EPHEMERAL | Sockets, PID files, and process coordination are invalid after a rebuild. |
| `logs/` | EPHEMERAL | Diagnostics do not carry workflow authority. |
| `shadow/` | EPHEMERAL | Session indexes and divergence projections are derived comparison output. |
| `intake/` | DURABLE | The edge-triggered PR snapshot and append-only wake event log cannot be reconstructed after the source cursor advances. |
| `AGENTS.md`, `START.md`, `enter.sh`, `workflows` | EPHEMERAL | These are installer-managed seeds, entrypoints, or links. |
| `worktrees.json.lock` | EPHEMERAL | The kernel lock owner does not survive the process; retaining a stale lock is harmful. |

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

Pull is additive. It never deletes local portable profile entries. Review the
profile before pushing it. A trusted host may use `profile/full`; a less-trusted
host uses `profile/personal`. Project configuration, dossiers, runtime state,
Smithers runs, questions, worktrees, credentials, `.env`, and retired `.pi`
state are host-local durable data and are excluded from both pull and push.

For a remote operator session, run `~/dev/deck/update.sh`, then start a new
`prime-conversation`. The updater is safe to run repeatedly and is the primary
path for an existing installation. Private repo access requires an
active `gh auth login` before the home repo clone or pull.

   Laptop agents: `docs/LAPTOP-AGENTS.md` (inbox + project register).

4. **Model access.** Start the local Deck broker, then use
   `prime-conversation`. Conversation and workflow seats share the broker
   accounts belonging on this host:

   ```sh
   bun ~/dev/deck/broker/src/cli.ts login anthropic
   bun --cwd ~/dev/deck/broker src/main.ts
   ```

Credentials are visible at `~/.deck/broker/store.db` and physically live in
`~/.deck-durable/broker/store.db` (0600) on this host. They stay here. Keep the
broker running with your own process manager when the factory needs it. It is
not started by `install.sh`.

5. **Remote access.** Plain SSH is sufficient:

   ```sh
   ssh -t <user>@<host> 'source ~/.deck/enter.sh && prime-conversation'
   ```

6. **Verify.**

   ```sh
   ~/dev/deck/ops/verify-clean-install.sh
   source ~/.deck/enter.sh
   prime-conversation
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

`update.sh` is the existing-install path. Host-local durable and runtime state
never travels; only repository code and explicitly reviewed portable profile
files do.
