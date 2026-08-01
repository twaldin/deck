# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Smithers workflows live under `workflows/` (workspace anchor: `workflows/.smithers`,
  pinned smithers-orchestrator **0.30.0**). The PR pipeline is
  `workflows/pr-pipeline/` - dispatch/babysit docs in its README.
  **It is the DEFAULT ship path for every profiled project** (`deck-v2 ship` /
  the orchestrator `ship` tool): the PR open is a pipeline node hard-gated
  behind adversarial review; lindy-full parks for the captain's stamp,
  yolo-ship auto-merges on green. `deck-v2 spawn --kind ship` on a profiled
  repo is refused without `--no-pipeline` (`v2/src/spawn.ts`
  `assertShipGoesThroughPipeline`; entry `v2/src/ship.ts`).
  **Smithers is the standard crew tool for multi-step PR work** (durable state,
  replayable attempts, real approval gates); rationale in `workflows/README.md`.
- **Pi is Deck's ONLY Smithers engine.** Every agent seat is a `PiAgent` on
  `provider: "deck"` (broker auth, `deck/*` models, quota-aware); the direct
  `codex` / `claude-code` CLI engines are deleted, not just unused, because they
  use mono-account auth plus ambient local CLI config. Seats:
  `workflows/.smithers/agents.ts` (deck-owned, no longer generated - if
  `smithers init` recreates `workflows/.smithers/agents/`, delete it again).
  Guard: `assertDeckModel` in `workflows/pr-pipeline/lib/models.ts`; the
  red-green enforcement is `workflows/pr-pipeline/tests/engine.test.ts`.
- **Version-skew trap:** run the CLI through the pinned `smithers` shim that
  `v2/install.sh` writes to `~/.local/bin` (or as `bunx smithers-orchestrator@0.30.0 ...`).
  The one code pin is `v2/src/smithers.ts`; `v2/test/smithers-pin.test.ts` keeps it
  equal to both workspace pins.
  From a directory without a package.json, bun auto-resolves bare specifiers/binaries
  from its global cache and can silently pick a NEWER version than the workspace pin
  (observed: 0.31.0 vs 0.30.0). `workflows/pr-pipeline/` has its own package.json pin
  for the same reason; keep the two pins in lockstep.
- The router-era manifest/TUI stack is deleted. New workflows use plain Smithers and v2.
- Broker model allowlist: `broker/src/models.ts` (`DEFAULT_ALLOWLIST`). The pipeline's
  agent-pickable catalog (`workflows/pr-pipeline/lib/models.ts DECK_AGENT_CATALOG`)
  must stay a subset of it.
- `v2/` is the agent-fleet layer: one library (`v2/src/`) behind two faces — a pi
  extension (`v2/src/extension/`) and a thin CLI (`v2/bin/deck-v2`). Neither wraps
  the other; both import the same modules, so there is no subprocess hop in the
  hot path and no duplicated logic. `v2/README.md` explains the design.
  **Two traps here.** The orchestrator's operating contract is
  `v2/seed/orchestrator-contract.md`, deliberately NOT named `AGENTS.md`: pi
  discovers `AGENTS.md` in the cwd and every ancestor, so committing it under that
  name would make any agent working in this checkout load "you never write code"
  as its own instructions. And the operator home (`~/.deck`) must never be a git
  checkout — `assertHomeIsNotACheckout` enforces it, because a checkout brings its
  own `AGENTS.md` and lets a crew rebase live state out from under the fleet.
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
- **Driving an extension COMMAND over RPC: send, do not `await` the response.**
  pi emits a `prompt` command's response only after the extension command
  handler *returns*, so awaiting it before answering the handler's own
  `extension_ui_request` deadlocks. `extensions/smoke/run-questions-smoke.ts`
  has the working shape (`send()`, await the dialog, then respond).
- **Assert extension behavior through `node`, not `bun`.** pi is a
  `#!/usr/bin/env node` CLI and bun's loader is more permissive about CommonJS
  under `"type": "module"`, so bun-only assertions pass while real pi fails.
- Scratch/verification output belongs in `claude-playground/` (gitignored).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
