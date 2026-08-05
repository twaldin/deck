# deck

**One chat session runs your software factory.**

You talk to an orchestrator. It starts durable [Smithers](https://github.com/smithers-ai/smithers) workflows per effort. Each workflow owns the menial loop end to end:

```
idea → implement → adversarial review → PR → reviewers
     → watch CI + human + bot comments → stamp or auto-merge on green
```

Models share a broker pool of your own subscriptions. Connect from any laptop over your private network (Tailscale or equivalent). The orchestrator stays on a durable host; glass is just a remote shell into that session.

```
you  ←→  orch (pi)
              │
              │  ship
              ▼
       smithers pr-pipeline  × N     ← one run owns each PR
              │
              seats: implement · adversarial · fix
              poll:  CI · review bots · humans
              park:  your merge stamp (or yolo on green)
```

## What it is

| Piece | Job |
|---|---|
| **Orch** | Your face on the factory. Ideas, stamps, rare judgment. Does not babysit N PRs. |
| **`ship`** | Default path for profiled projects. Starts pr-pipeline. |
| **pr-pipeline** | Encoded habits: adversarial loop, reviewers, CI/review watch, stamp or yolo. |
| **Broker** | Multi-account OAuth pool for models. Usage in-session. |
| **Profiles** | Stamp-at-merge vs merge-on-green. **Same quality gates** either way. |
| **Fleet** | Attention board: what is running, waiting, and on what. |

Yolo does **not** skip adversarial review. It skips only the human stamp park at merge time.

## Quick start (personal host)

```sh
# one-time
export DECK_REPO_URL="https://github.com/<owner>/deck.git"
git clone "$DECK_REPO_URL" ~/dev/deck
cd ~/dev/deck && git checkout main
./install.sh

# keep updated
~/dev/deck/update.sh

# interactive once — personal accounts only
bun ~/dev/deck/broker/src/cli.ts login anthropic

# glass from a laptop (SSH to your durable host over your tailnet)
herdr --remote <user>@<host>
source ~/.deck/enter.sh && pi
```

Inside the session: fleet, usage, questions, wake, calm, plus `ship` / `spawn`.

**Laptop agents** (not the orch): see [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) — drop handoffs the orch will pick up.

## Project profiles

`~/.deck/config/projects.json` — which repo uses which pipeline:

- **Stamp profile**: merge waits for your explicit word after human approve + CI green.
- **Yolo profile**: auto-merge on green; still adversarial + watch.

Keep company work and personal OAuth on separate hosts. Never put company secrets on a personal box.

## Layout

```
~/dev/deck/          code (git)
~/.deck/             orch home (NOT a checkout) — contract, state, data, broker store
~/.deck/.pi/         deck extension (fleet, ship, spawn, …)
~/.pi/agent/         user skills + model provider + usage
```

Sync code with git. **Never rsync `~/.deck` between hosts** (credentials + state).

## Docs

| Doc | For |
|---|---|
| [`docs/personal-home.md`](docs/personal-home.md) | Bootstrap a durable personal host |
| [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) | Laptop agents handing work to the orch host |
| [`workflows/pr-pipeline/README.md`](workflows/pr-pipeline/README.md) | Pipeline stages |
| [`v2/seed/orchestrator-contract.md`](v2/seed/orchestrator-contract.md) | Seed for `~/.deck/AGENTS.md` |

## Layout details

- `cli/` allocates isolated deck worktrees and is linked by `v2/install.sh`.
- `intake/` is consumed by the `v2` wake loop.
- `ops/` contains launchd installers and the resource monitor.
- `subagents/` contains crew agent definitions.

The router-era directories were removed. Their design history is in `docs/archive/router-era/`.

## Develop deck itself

Branch from **`main`**. Ship with the deck profile (yolo).
