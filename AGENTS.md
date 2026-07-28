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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
