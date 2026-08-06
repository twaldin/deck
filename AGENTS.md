# Contributing to deck

This guide is for agents that change the deck repository. The public seed for a
plain pi home is `v2/seed/AGENTS.md`.

## Package map

- `v2/`: deck-v2 library, CLI, home bootstrap, and tests.
- `broker/`: model broker and provider login tools.
- `cli/`: isolated worktree allocation.
- `intake/`: incoming work poller.
- `ops/`: launchd installers and resource monitor.
- `subagents/`: crew agent definitions and installer.
- `extensions/`: pi extensions and installer tests.
- `workflows/`: Smithers workflows and pipeline tests.

## Build and test

Install dependencies in the package you change:

```sh
bun install --cwd v2
bun install --cwd broker
bun install --cwd cli
```

Run affected tests and type checks:

```sh
bun --cwd v2 test
bun --cwd v2 run typecheck
bun --cwd broker test
bun --cwd cli test
bun --cwd intake test
bun --cwd extensions test
```

Use existing package scripts. Do not add a dependency for a small standard
library task.

## Style and safety

- Use TypeScript and the standard-library APIs already used by the package.
- Keep changes small. Test the behavior that changed.
- Do not commit `~/.deck`, `.smithers/`, or `smithers.db*` runtime state.
- Keep the operator home outside a git checkout.
- Do not change unrelated packages or workflows.
- Use plain English for team-facing text.

## Documentation split

Repository contributor guidance lives here. `v2/seed/AGENTS.md` is copied into
the private Deck home. Global memory lives in OptMem; per-effort depth lives in
dossiers. Project-specific doctrine belongs in private project configuration.

## Maintaining this file

Keep this guide useful for agents that improve deck itself. Point to authoritative
files instead of copying details. Remove stale rules when the repository changes.
