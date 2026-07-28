# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Smithers workflows live under `workflows/` (workspace anchor: `workflows/.smithers`,
  pinned smithers-orchestrator **0.30.0**). The lindy PR pipeline is
  `workflows/pr-pipeline/` - dispatch/babysit docs in its README.
- **Version-skew trap:** always run the CLI as `bunx smithers-orchestrator@0.30.0 ...`.
  From a directory without a package.json, bun auto-resolves bare specifiers/binaries
  from its global cache and can silently pick a NEWER version than the workspace pin
  (observed: 0.31.0 vs 0.30.0). `workflows/pr-pipeline/` has its own package.json pin
  for the same reason; keep the two pins in lockstep.
- Deck's router/manifest/TUI layer is dormant by decision; new workflows are written
  against plain smithers (kit/ is design reference only).
- Broker model allowlist: `broker/src/models.ts` (`DEFAULT_ALLOWLIST`). The pipeline's
  agent-pickable catalog (`workflows/pr-pipeline/lib/models.ts DECK_AGENT_CATALOG`)
  must stay a subset of it.
- `fleet/` is the standalone read-only fleet dashboard TUI (`@deck/fleet`,
  bin `deck-fleet`). It reads firstmate `state/*.meta`+`.status` tails and Smithers
  runs via the **public read-only CLI only** (`smithers ps|inspect --json`; never the
  private db, never Gateway lifecycle). Collectors are separable from the renderer
  (herdr-plugin reuse); runs correlate only by a unique exact absolute
  `rootDir==worktree`.
  Invocation/config/herdr-embed notes in `fleet/README.md`.

- **pi extension installers ship layout, not just source.** Both shipped
  extensions broke in `~/.pi` while their sources were fine, so verify the
  *installed* shape: `extensions/install.sh` (idle-compaction) and
  `ponytail/install.sh` both honor `INSTALL_TARGET` for safe testing, and
  `extensions/test/installers.test.ts` is the red-green guard. Two traps that
  cost real debugging time: pi discovers `extensions/*.ts` **and**
  `extensions/*/index.ts`, so a multi-file extension must be a directory (a flat
  symlink breaks relative sibling imports, and a flat sibling gets loaded as its
  own extension); and ponytail's CommonJS `hooks/` need
  `ponytail/hooks/package.json` (`type: commonjs`) to survive being copied under
  the vendored `"type": "module"` package. Rationale in each README.
- **Assert extension behavior through `node`, not `bun`.** pi is a
  `#!/usr/bin/env node` CLI and bun's loader is more permissive about CommonJS
  under `"type": "module"`, so bun-only assertions pass while real pi fails.
- Scratch/verification output belongs in `claude-playground/` (gitignored).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
