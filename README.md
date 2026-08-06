# Deck

Deck is a local, operator-attended software factory used from ordinary
[Pi](https://github.com/earendil-works/pi) sessions. The conversation stays a
plain Pi chat; durable delivery work runs in Smithers when the chat calls
`ship` or `adopt`.

**What this is not:** Deck is not a hosted product, an autonomous supervisor,
or an unattended merge service. An operator remains responsible for credentials,
project policy, queued decisions, and any explicit merge authorization.

```text
plain Pi session in ~/.deck
      │  ship · adopt · status
      ▼
Smithers pr-pipeline
      │  implement → adversarial review → PR → reviewers
      └→ watch CI → optional explicit approval → merge → delivery evidence
```

There is no Deck orchestrator extension, fleet overlay, or wake loop. The
factory is a set of tools loaded into a plain session.

## Components

| Component | Responsibility |
|---|---|
| **Plain Pi session** | Understand the issue, inspect evidence, call factory tools, and surface queued decisions. |
| **`deck-questions`** | Durable questions plus the interactive `/questions` queue. |
| **`deck-ship`** | `ship`, `adopt`, and read-only `status`; dispatches the project PR pipeline rather than implementing delivery in the chat. |
| **`deck-recall`** | Reads per-effort dossiers so a new session can recover the deeper brief and decision history. |
| **Smithers** | Persists and resumes the PR pipeline, including implementation, adversarial review, GitHub review/CI, merge policy, and evidence gates. |
| **Broker** | Optional multi-account model provider for the conversation; required by the current Smithers model seats. It uses accounts configured by this installation's operator. |
| **OptMem** | Global append-only identity, decisions, preferences, and lessons. Effort-specific detail stays in dossiers. |

Project and reviewer policy is private machine configuration:

- `~/.deck/config/projects.json`
- `~/.deck/config/reviewers.json`

The repository ships no personal project profile, reviewer handle, or default
merge authority. Company-specific profiles may be kept as explicitly selected
examples; they are never selected by bootstrap.

## Prerequisites

- Git
- [Bun](https://bun.sh/)
- `curl`, Python 3, and network access for the pinned OptMem installer and
  package downloads
- a Pi-supported model account or API key
- the GitHub CLI (`gh`) authenticated to each repository you want the factory
  to ship; it is not needed for a standalone conversation

Deck installs its pinned Pi CLI under `~/.local/bin/pi`; a global Pi or Node
installation is not required. If `uv` is absent, the installer downloads
`uv`/`uvx` 0.11.8 for the host platform, verifies the release's published
SHA-256, installs both beside the Deck shims, and proves an isolated IPython
kernel can execute a cell. A kernel bootstrap failure aborts the install.

An existing non-Deck `pi` command is never overwritten. The installer stops
before downloads or home changes and prints an exact `BIN_TARGET` command for
installing Deck's shims in a separate directory.

## Clean install

```sh
export DECK_REPO_URL="https://github.com/<owner>/deck.git"
git clone --branch main "$DECK_REPO_URL" ~/dev/deck
cd ~/dev/deck
./install.sh

source ~/.deck/enter.sh
pi
```

Review and accept Pi's project-local trust prompt for `~/.deck/.pi`. In Pi, run
`/login`, choose your own provider subscription or API-key provider, then use
`/model`. Pi stores that credential in its own user configuration under
`~/.pi/agent/`; no broker account belonging to another operator is needed for a
standalone conversation.

An environment variable such as `ANTHROPIC_API_KEY` is also supported, but do
not put API keys in this repository.

The standalone path loads questions, shipping/status, recall, and the seed
`~/.deck/AGENTS.md`. Calls that start the current PR-pipeline model seats
additionally need the Deck broker:

```sh
# interactive, once per provider account
bun ~/dev/deck/broker/src/cli.ts login anthropic

# keep this process running while broker-backed seats execute
bun --cwd ~/dev/deck/broker src/main.ts
```

The broker is not started by `install.sh`, and it is not required merely to
enter and use a plain session with your own Pi credential.

## Install, update, and optional services

- `./install.sh` is the first-time, clean-clone bootstrap. It installs or
  verifies `uv`, proves the isolated IPython tool runtime, installs package
  dependencies, the Deck-scoped Pi extension pack, command shims, the isolated
  Smithers workspace, OptMem, and the plain `~/.deck` home.
- `./update.sh` refreshes an existing checkout and converges the same installed
  files. Set `DECK_BRANCH` when updating a branch other than `main`.
- `./v2/install.sh` is the internal component installer used by both paths; it
  is not a second onboarding entrypoint.
- `./ops/install.sh` previews optional resident launchd services; apply with
  `./ops/install.sh --yes` only after reviewing the plan.

Neither install nor update starts the separate review-gate poller. The
`workflows/review-gate/` workflow is a company-specific example and must be
started deliberately, after its project configuration and authenticated
Smithers Gateway are ready:

```sh
cd ~/dev/deck
bun workflows/review-gate/launch.ts
```

## Installed layout

```text
~/dev/deck/                    code and factory definitions (git checkout)
~/.deck/                       private plain-Pi runtime home (not a checkout)
~/.deck/AGENTS.md              public seed copied on first bootstrap
~/.deck/.pi/extensions/        deck-questions, deck-ship, and deck-recall
~/.deck/state/smithers/        live Smithers workspace and run state
~/.deck/efforts/               per-effort dossiers
~/.optmem/                     global append-only memory
~/.local/bin/                  pinned pi, deck, deck-v2, and smithers shims
~/.pi/agent/                   the operator's Pi credentials and global config
```

Sync code with Git. Never rsync `~/.deck` between hosts: it contains private
configuration and runtime state.

## Project profiles

Each entry in `~/.deck/config/projects.json` chooses a pipeline and its merge
posture:

- an explicit-approval profile waits for the configured operator decision after
  repository review and CI requirements pass;
- an auto-merge profile merges on green but keeps implementation,
  adversarial-review, CI, and evidence gates.

Bootstrap creates an empty profile list. Copy and review an example or write a
profile for your own repository before using `ship`.

Reviewer identity and routing are private machine configuration in
`~/.deck/config/reviewers.json`. Before shipping, set `selfLogins` to every
GitHub login whose approval must not count as independent, plus any
`excludedApprovers`, `reviewerDenylist`, and default `reviewers`. Bootstrap
creates all four arrays empty; no operator identity ships in the repository.

## More detail

| Document | Subject |
|---|---|
| [`v2/README.md`](v2/README.md) | Plain-session and library architecture |
| [`workflows/pr-pipeline/README.md`](workflows/pr-pipeline/README.md) | Pipeline stages and gates |
| [`v2/seed/AGENTS.md`](v2/seed/AGENTS.md) | Public plain-session contract copied into `~/.deck` |
| [`ops/README.md`](ops/README.md) | Optional resident services |
| [`docs/prime-conversation.md`](docs/prime-conversation.md) | Optional Prime conversation profile |

## Develop Deck

Read [`AGENTS.md`](AGENTS.md), branch from `main`, and run only the tests for
the package you change.
