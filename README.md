# deck

**Plain pi sessions use a durable software factory.**

Start any number of pi sessions in `~/.deck`. OptMem carries global identity,
decisions, preferences, and lessons across sessions. Effort dossiers carry the
deeper brief and decision history. Shipping work goes through durable
[Smithers](https://github.com/smithers-ai/smithers) workflows:

```
plain pi session
      │  ship · adopt · status
      ▼
smithers pr-pipeline
      │  implement → adversarial review → PR → reviewers
      └→ watch CI → explicit stamp when required → merge → deploy/fallout proof
```

The conversation session shapes work and surfaces queued decisions. The engine
owns progress, retries, CI/review watch, merge mechanics, and liveness.

## What it is

| Piece | Job |
|---|---|
| **Plain pi session** | Understand the issue, inspect evidence, and call factory tools. |
| **`ship` / `adopt` / `status`** | The only shipment interface: start, take over, or inspect durable work. |
| **pr-pipeline** | Encoded implementation, adversarial review, reviewers, CI, merge, and fallout gates. |
| **Questions** | Durable, decision-shaped asks that do not block unrelated work. |
| **OptMem + dossiers** | Global continuity plus per-effort depth. |
| **Broker** | Multi-account model access using the operator's own subscriptions. |

Profiles choose the merge posture. Every profile keeps the same implementation,
adversarial-review, CI, review, and evidence gates.

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

# enter a plain session
cd ~/.deck && pi
```

Inside the session use `ship`, `adopt`, `status`, questions, `recall_effort`, and
`subagent`. There is no fleet-supervision or wake-loop command surface.

**Laptop agents:** see [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) for
handoffs that a deck session can route into the factory.

## Project profiles

`~/.deck/config/projects.json` — which repo uses which pipeline:

- **Stamp profile**: merge waits for your explicit word after human approve + CI green.
- **Yolo profile**: auto-merge on green; still adversarial + watch.

Keep company work and personal OAuth on separate hosts. Never put company secrets on a personal box.

## Layout

```
~/dev/deck/          code and factory definitions (git)
~/.deck/             private plain-pi home (NOT a checkout)
~/.optmem/           global append-only memory and summary tree
~/.deck/efforts/     per-effort dossiers
~/.deck/.pi/         Deck-scoped extensions, skills, and model configuration
~/.pi/agent/         Global deck-subagents extension and shared pi skills
```

Sync code with git. **Never rsync `~/.deck` between hosts** (credentials + state).

## Docs

| Doc | For |
|---|---|
| [`docs/personal-home.md`](docs/personal-home.md) | Bootstrap a durable personal host |
| [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) | Laptop agents handing work to a deck home |
| [`workflows/pr-pipeline/README.md`](workflows/pr-pipeline/README.md) | Pipeline stages |
| [`v2/seed/AGENTS.md`](v2/seed/AGENTS.md) | Public seed for plain sessions in `~/.deck` |
| [`docs/home-cutover.md`](docs/home-cutover.md) | Locked v4 home cutover checklist |

## Layout details

- `cli/` allocates isolated deck worktrees and is linked by `v2/install.sh`.
- `ops/` contains launchd installers and the resource monitor.
- `subagents/` contains crew agent definitions.

The router-era directories were removed. Their design history is in `docs/archive/router-era/`.

## Develop deck itself

Branch from **`main`**. Ship with the deck profile (yolo).
