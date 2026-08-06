# Deck

Deck is a local, operator-attended software factory used from a pinned
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) conversation.
Durable delivery work runs in Smithers when the conversation calls `ship` or
`adopt`.

**What this is not:** Deck is not a hosted product, an autonomous supervisor,
or an unattended merge service. An operator remains responsible for credentials,
project policy, queued decisions, and any explicit merge authorization.

```text
Prime conversation in ~/.deck
      │  ship · adopt · status
      ▼
Smithers pr-pipeline
      │  implement → adversarial review → PR → reviewers
      └→ watch CI → optional explicit approval → merge → delivery evidence
```

There is no Deck orchestrator extension, fleet overlay, or wake loop. The
factory is a reviewed Prime extension pack plus broker-routed workflow seats.

## Components

| Component | Responsibility |
|---|---|
| **Prime conversation** | Understand the issue, inspect evidence, call factory tools, and surface queued decisions. |
| **`deck-questions`** | Durable questions plus the interactive `/questions` queue. |
| **`deck-ship`** | `ship`, `adopt`, and read-only `status`; dispatches the project PR pipeline rather than implementing delivery in the chat. |
| **`deck-recall`** | Reads per-effort dossiers so a new session can recover the deeper brief and decision history. |
| **Smithers** | Persists and resumes the PR pipeline, including implementation, adversarial review, GitHub review/CI, merge policy, and evidence gates. |
| **Broker** | Required model provider for the conversation and every Smithers Prime seat. It uses accounts configured by this installation's operator. |
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
- `curl`, Node.js, npm, Python 3, and network access for pinned artifact and
  package downloads
- the GitHub CLI (`gh`) authenticated to each repository you want the factory
  to ship

Deck installs the reviewed, patched Prime Agent 0.7.0 artifact under
`~/.deck/.prime/runtime` and links `prime-agent` and `prime-conversation` into
the selected binary directory. It never installs or overwrites an unrelated
agent executable. If `uv` is absent, the installer downloads `uv`/`uvx` 0.11.8,
verifies its SHA-256, and proves an isolated IPython kernel can execute a cell.

## Clean install

```sh
export DECK_REPO_URL="https://github.com/<owner>/deck.git"
git clone --branch main "$DECK_REPO_URL" ~/dev/deck
cd ~/dev/deck
./install.sh

source ~/.deck/enter.sh
prime-conversation
```

The conversation is fail-closed to the local Deck broker. Configure an account
owned by this installation's operator, then keep the broker running:

```sh
# interactive, once per provider account
bun ~/dev/deck/broker/src/cli.ts login anthropic

# keep this process running while conversations or workflow seats execute
bun --cwd ~/dev/deck/broker src/main.ts
```

Do not put API keys in this repository. The Prime profile strips ambient
credentials and loads only Deck's reviewed provider, guard, extension pack, and
conversation-only process package.

## Install, update, and optional services

- `./install.sh` is the clean-clone and convergence entrypoint. It verifies the
  isolated IPython runtime, installs the reviewed Prime artifact and patches,
  the Prime extension pack, pinned process package, command shims, Smithers
  workspace, OptMem, and `~/.deck`.
- `./update.sh` refreshes an existing checkout and invokes that same convergent
  install path. Set `DECK_BRANCH` when updating a branch other than `main`.
- `./v2/install.sh` installs only Deck CLI and Smithers workspace internals.
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
~/.deck/                       private Prime runtime home (not a checkout)
~/.deck/AGENTS.md              public seed converged by install/update
~/.deck/.prime/agent/          credential-stripped Prime conversation profile
~/.deck/.prime/runtime/        pinned patched Prime Agent and process package
~/.deck/.prime/sessions/       Prime conversation sessions
~/.deck/state/smithers/        live Smithers workspace and run state
~/.deck/efforts/               per-effort dossiers
~/.optmem/                     global append-only memory
~/.local/bin/                  prime-agent, prime-conversation, Deck and Smithers shims
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
