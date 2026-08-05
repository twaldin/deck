# deck-subagents research verdict

## Sources inspected

**Pi upstream.** The current `earendil-works/pi` example at `packages/coding-agent/examples/extensions/subagent/{index.ts,agents.ts,README.md}` is a useful UI example, not a production supervisor. It discovers user/project markdown agents, launches `pi -p --mode json --no-session`, supports single/parallel/chain calls, streams JSON events, and renders usage. Agent lookup is exact, but there is no broker-model validation, output-stall deadline, required terminal protocol, durable result schema, or reusable workflow API. A child that exits zero with no assistant text is reported as successful `(no output)`. Parallel/chain orchestration is more surface than v4 needs.

**Deck's installed fork (retired by this change).** `subagents/extension/index.ts` had grown to 1,095 lines plus four helpers. Its attempted fixes explain the reported failures:

- `extension/subagents.ts` hard-coded `claude → reviewer-claude` and `gpt|codex → worker-gpt`, conflating a model-family hint with an agent role. Worse, edit-distance “suggestions” returned a resolved name, so a typo within distance two silently ran the suggested agent instead of failing. The tool schema exposed no per-call `model`, even though agent descriptions promised an override. This is the alias/selection failure class.
- `extension/watchdog.ts` sampled worktree mtimes, transcript files, and process CPU every five seconds with a 25-second default. CPU can advance while no useful output reaches the parent; recursive worktree sampling is expensive and unrelated to child responsiveness. On failure it stopped and deleted the transcript directory while child stdout could still append to it. This was not a reliable heartbeat.
- Success was the last assistant text part, not a yield. `filesTouched` did not exist, exit state lived only in extension details, and a zero exit with no output remained success. The private `runSingleAgent` could not be imported by Smithers, guaranteeing a second workflow implementation.

**Firstmate (`~/firstmate`).** `bin/fm-spawn.sh` supplies the strongest operational invariants: adapter names are selected from explicit launch templates and unknown names stop; a project worker must resolve to a real worktree root distinct from the primary checkout; metadata/status and turn-end signals are separated; monitoring reconciles process liveness rather than trusting a pane. Its tmux/backend fleet, durable watcher, steering, recovery, and teardown machinery are intentionally out of scope. The reusable lessons are exact registries, one launch path, caller-owned worktree allocation, explicit completion, and a bounded failure path.

**OMP task tool (`omp://tools/task.md`).** OMP is a pattern quarry only. The relevant patterns are execution-time agent rediscovery, exact unknown-agent rejection, a semaphore shared across calls, cwd/isolation passed as an explicit contract, mandatory structured `yield`, explicit status in every result, cancellation propagation, and artifact/output caps. Its async job manager, lifecycle registry, revival, IRC, recursive agents, isolation PAL, and fleet semantics do not belong in this pi-native primitive.

## Verdict

**Port the small upstream execution idea, not either extension wholesale.** Keep one pi-facing tool and Deck's markdown agent registry, but replace the Deck fork with a thin `deck-subagents.ts` adapter over an exported `lib/spawn.ts`. The library is the product: pi sessions and Smithers seats call the same `spawnSubagent` function.

The hardened boundary is deliberately narrow:

1. Agent names are exact registry entries. No aliases, case folding, fuzzy execution, or silent fallback. Unknown input returns the valid list before process creation.
2. Model selectors must be in both the checked-in `broker/pi/deck-provider.ts` catalog and the authenticated broker `/v1/models` pool. Tool text gives cheap/fast, deep-reasoning, and opposite-family-review lanes from `broker/pi/README.md`.
3. The child runs `pi -p` in the trusted caller cwd. The CLI allocator is not trivially importable: it owns global allocation state, effort manifests, branches, dependency warming, and release. Pi binds cwd to `ctx.cwd`; workflow seats pass their already-allocated cwd.
4. Stdout/stderr bytes are the heartbeat. Five minutes without output sends `SIGTERM`, then `SIGKILL`, and returns `stalled`; continuous output is separately bounded by a wall-clock limit.
5. The child must call a private yield tool. The parent always receives `filesTouched`, `summary`, and `exitStatus`; missing yield is failure. A process-scoped semaphore caps concurrency at four.

This kills the three observed classes without introducing fleet management: typos cannot spawn, a silent child cannot hang forever, and successful completion cannot disappear into unstructured final text.
