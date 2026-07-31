# deck

**One pi session runs your software factory.**

You talk to an orchestrator. It starts durable [Smithers](https://github.com/) workflows per effort. Those workflows own the menial loop: implement → adversarial review → PR → reviewers → CI + human + bot comments → stamp or yolo-merge. Models share a broker pool of your subscriptions. Glass in from any laptop over Tailscale.

```
captain  ←→  orch (pi in ~/.deck)
                 │
                 │  ship tool
                 ▼
          smithers pr-pipeline  × N     ← effort owner per PR
                 │
                 seats: implement · adversarial · fix
                 poll:  CI · Claude-bot · humans
                 park:  your stamp (or yolo on green)
```

## What it is

| Piece | Job |
|---|---|
| **Orch** (`cd ~/.deck && pi`) | Captain face. Ideas, stamps, rare judgment. Does not babysit N PRs. |
| **`ship` / `deck-v2 ship`** | Default path for profiled projects. Starts pr-pipeline. |
| **pr-pipeline** | Encoded habits: adversarial loop, reviewers, watch-ci (incl. Claude bot), stamp/yolo. |
| **Broker** | Multi-account OAuth pool (`deck/*` models). Usage via `/usage`. |
| **Profiles** | `lindy-full` (stamp) vs `yolo-ship` (merge on green). Same quality gates. |
| **Fleet** | `/fleet` + statusline — attention only. |

Yolo does **not** skip adversarial review. It skips only the human stamp park.

## Quick start (personal host / deckbox)

```sh
# one-time (or after git pull)
curl -fsSL https://raw.githubusercontent.com/twaldin/deck/v2/install-personal.sh | bash
# or, from a clone:
git clone https://github.com/twaldin/deck.git ~/dev/deck && cd ~/dev/deck && git checkout v2
./install-personal.sh

# keep updated
~/dev/deck/scripts/update-home.sh

# interactive once
bun ~/dev/deck/broker/src/cli.ts login anthropic   # personal accounts only
# optional: openai-codex-device, zai, …

# glass from laptop
herdr --remote tim@100.107.83.38   # or deckbox if hosts file set
source ~/.deck/enter.sh && pi
```

Inside pi: `/fleet` `/usage` `/questions` `/wake` `/calm`, plus `ship` / `spawn` tools.

**Laptop agents** (not the orch): read [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) over SSH — how to drop handoffs the orch will pick up.

## Project profiles

`~/.deck/config/projects.json` — machine form of which repo uses which pipeline:

- **`lindy-full`**: stamp at merge time (after human approve + CI green/rerunning).
- **`yolo-ship`**: auto-merge on green; still adversarial + watch.

Personal hosts never list company repos. Work host never holds personal OAuth that belongs on deckbox.

## Layout

```
~/dev/deck/          code (git)
~/.deck/             orch home (NOT a checkout) — AGENTS.md, state, data, broker store
~/.deck/.pi/         deck-v2 extension (fleet, ship, spawn, …)
~/.pi/agent/         user skills + deck-provider + deck-usage
```

Sync code with git. **Never rsync `~/.deck` between hosts** (credentials + state).

## Docs

| Doc | For |
|---|---|
| [`docs/personal-home.md`](docs/personal-home.md) | Bootstrap deckbox |
| [`docs/LAPTOP-AGENTS.md`](docs/LAPTOP-AGENTS.md) | Home-laptop agents handing work to deckbox |
| [`workflows/pr-pipeline/README.md`](workflows/pr-pipeline/README.md) | Pipeline stages |
| [`v2/seed/orchestrator-contract.md`](v2/seed/orchestrator-contract.md) | Seed for `~/.deck/AGENTS.md` |

## Develop deck itself

Branch from **`v2`**. Ship with profile `deck` (yolo). Promote `v2` → `main` only on captain word.
