# Prime seat adapter

The PR pipeline can select the pinned Prime Agent `0.7.0` adapter per project profile. The profile flag is:

```json
{
  "id": "example",
  "repo": "example/project",
  "pipeline": "yolo-ship",
  "engine": "prime"
}
```

`engine` is a fail-closed `"pi" | "prime"` allowlist. Omitted values default to `pi`. All shipped profiles remain on `pi`; changing a profile is the only activation mechanism. Raw Codex, Claude Code, OpenCode, and other vendor CLI agents remain forbidden.

## Runtime contract

`PrimeSeatAgent` runs Prime in JSON/RPC mode through the Deck broker and verifies the PATH-resolved binary reports exactly `0.7.0`. Every invocation receives a new temporary agent directory, session directory, HOME, and daemon socket. The adapter starts and owns that daemon, applies wall-clock and no-output deadlines, terminates the complete RPC process group with TERM then KILL, shuts the daemon down over its socket, and removes the temporary tree.

The returned Smithers result contains typed output or a typed `PrimeSeatError`, exit code/signal, wall clock, steer count, token usage, and transcript-attested root and RLM-child provider/model provenance. A missing or malformed final yield is an error, never success. An invalid requested model, a broker-substituted root model, or an invalid child model fails closed.

Seat HOME contains only a minimal credential-helper-free `.gitconfig`. It does not contain `~/.deck`, GitHub tokens, an SSH agent socket, publisher/merge/stamp/admin credentials, or raw vendor credentials. The only injected authentication is `DECK_GATEWAY_API_KEY`, used by the reviewed Deck provider exclusively for local model-broker access. Pipeline seats work in an already-created worktree and can commit locally. Any future private-repository fetch credential must be node-scoped and read-only (a read-only deploy key or fine-grained `contents:read` token); never restore the captain's SSH agent or a write-capable GitHub token. The deterministic publisher remains the sole push/merge authority. This split prevents the measured accidental-push class; it is not an OS sandbox.

The canonical `workflow-seat` and `spawn-agent` capability profiles export only Prime's `ipython` tool, load only the reviewed Deck provider extension, set `RLM_DEPTH=0` and `RLM_MAX_DEPTH=1`, and expose no dispatch tool. Extra tools or extensions fail with `PRIME_CAPABILITY_VIOLATION`. These are inexpensive accident-bounding controls, not containment against deliberately hostile same-UID Python. If Deck ever runs unattended against untrusted input, add OS-level seat isolation.

## Herdr auto-attach

Herdr attachment is mandatory. The adapter refuses a Prime launch without an active Herdr socket and parent pane, creates one child pane per seat, forces Prime's built-in reporter environment, and renames the pane using exactly:

```text
{repository}#{ticket number} · {Smithers node id} · {Smithers run id}
```

For example: `lindy#27140 · watch-fix · run-abc`. No workflow-specific Herdr wiring or Deck-side lifecycle projection is used.

Headless RPC verification against an isolated test socket observed `idle -> working -> idle -> pane.release_agent` for normal exit and stall-kill. Two simultaneous real Prime seats produced two distinct pane IDs and independent lifecycle streams. Prime's known limit remains: RLM children share the root seat's Herdr pane. Per-child status and cancellation therefore live in Prime's Agents View / `prime-agent agents`, while Herdr is intentionally per root seat.

Do not point lifecycle tests at the captain's default Herdr socket. Tests create a `deck-test-<pid>` socket, allocate only synthetic `deck-test:*` panes, and tear it down.

## Canary sequence

Prepare four input files that differ only in repository/profile and node scope, then run in this order. Keep a paired `pi` run for every Prime run.

```bash
# 0. Gates before any canary
bun --cwd workflows/pr-pipeline run typecheck
bun --cwd workflows/pr-pipeline test

# 1. Read-only replay in an isolated test profile/worktree
bunx smithers-orchestrator@0.30.0 up workflows/pr-pipeline/pipeline.tsx \
  --input /tmp/prime-read-only.json --run-id prime-read-only

# 2. One write-capable node in a non-Lindy repository
bunx smithers-orchestrator@0.30.0 up workflows/pr-pipeline/pipeline.tsx \
  --input /tmp/prime-non-lindy-node.json --run-id prime-non-lindy-node

# 3. Full non-Lindy pipeline
bunx smithers-orchestrator@0.30.0 up workflows/pr-pipeline/pipeline.tsx \
  --input /tmp/prime-non-lindy-full.json --run-id prime-non-lindy-full

# 4. Only after explicit captain approval: one reversible Lindy profile canary
bunx smithers-orchestrator@0.30.0 up workflows/pr-pipeline/pipeline.tsx \
  --input /tmp/prime-lindy-canary.json --run-id prime-lindy-canary
```

For each paired node/run compare:

- `steers` from `providerMetadata.prime.steers` versus the Pi run;
- node failures, grouped by typed error code;
- `wallClockMs`;
- input, output, and total tokens;
- requested versus transcript-attested root and child models;
- orphan processes and Herdr lifecycle completion.

Stop on any model mismatch, missing provenance, malformed yield, RPC death, stall/orphan, unexpected credential, or Herdr cross-talk.

## Rollback

Change the affected project's `engine` back to `"pi"` (or remove the field), then start a fresh run. Existing runs retain their recorded engine and are not mutated.

Deck-subagents can be deleted only after the read-only replay, write-capable non-Lindy node, full non-Lindy pipeline, and one reversible Lindy canary have all passed with acceptable paired metrics; every spawn/workflow caller has moved to the canonical Prime profiles; private fetch, if required, uses read-only credentials; and the captain explicitly authorizes removal.
