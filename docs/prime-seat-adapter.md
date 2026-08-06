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

`PrimeSeatAgent` runs Prime in JSON/RPC mode through the Deck broker and verifies the PATH-resolved binary reports exactly `0.7.0`. Every seat receives a temporary HOME and session directory, while all Deck Prime surfaces share the pinned profile under `~/.deck/.prime/agent` and the Deck-scoped supervisor socket `~/.deck/.prime/run/conversation.sock`. `DECK_PRIME_DAEMON_SOCKET` can explicitly override the socket. Startup is concurrency-safe: the first seat starts the detached supervisor, later seats join it, and no seat shuts it down. Each seat still owns its RPC process group and session: deadlines terminate only that process group, forced failure requests `prime-agent stop <session>` when the session ID is known, and the per-seat temporary tree is removed. A live Prime worker can recover a failed shared supervisor and rehydrate its session from JSONL and the kernel snapshot, so the single Agents View does not make every active seat dependent on an immortal process.

The returned Smithers result contains typed output or a typed `PrimeSeatError`, exit code/signal, wall clock, steer count, token usage, and transcript-attested root and RLM-child provider/model provenance. A missing or malformed final yield is an error, never success. An invalid requested model, a broker-substituted root model, or an invalid child model fails closed.

Seat HOME contains only a minimal credential-helper-free `.gitconfig`. It does not contain `~/.deck`, GitHub tokens, an SSH agent socket, publisher/merge/stamp/admin credentials, or raw vendor credentials. The only injected authentication is `DECK_GATEWAY_API_KEY`, used by the reviewed Deck provider exclusively for local model-broker access. Pipeline seats work in an already-created worktree and can commit locally. Any future private-repository fetch credential must be node-scoped and read-only (a read-only deploy key or fine-grained `contents:read` token); never restore the captain's SSH agent or a write-capable GitHub token. The deterministic publisher remains the sole push/merge authority. This split prevents the measured accidental-push class; it is not an OS sandbox.

The canonical `workflow-seat` and `spawn-agent` capability profiles export only Prime's `ipython` tool, load only the reviewed Deck provider extension, set `RLM_DEPTH=0` and `RLM_MAX_DEPTH=1`, and expose no dispatch tool. Extra tools or extensions fail with `PRIME_CAPABILITY_VIOLATION`. These are inexpensive accident-bounding controls, not containment against deliberately hostile same-UID Python. If Deck ever runs unattended against untrusted input, add OS-level seat isolation.

## Herdr auto-attach

Prime Agent `0.7.0` includes `HerdrAgentStateExtension`, but source inspection and an isolated headless probe showed that it is a reporter, not a pane allocator: without inherited `HERDR_ENV` and pane identity its factory is a no-op and no pane appears. Deck therefore discovers the configured Herdr socket/workspace and creates a new top-level tab and root pane for every seat. It never calls `pane.split` and never uses an inherited captain pane. Only after allocation does the adapter inject that seat's pane identity so Prime's built-in reporter can publish lifecycle state.

The tab and root pane use exactly:

```text
{effort label} · {Smithers node id} · {Smithers run id}
```

For example: `lindy#27140 · watch-fix · run-abc`. The adapter closes only that pane when the seat exits, including stalled-process termination; concurrent seats retain distinct session and pane identities while sharing the Prime supervisor.

Herdr visibility is fail-soft by default. If Herdr is absent, has no matching workspace, or refuses the socket, the seat runs normally, emits a warning, and receives no ambient `HERDR_*` identity. Set `DECK_HERDR_STRICT=1` (or the explicit adapter option) only when loss of board visibility must fail the seat.

Prime's known limit remains: RLM children share the root seat's Herdr pane. Per-child status and cancellation therefore live in the shared Prime Agents View / `prime-agent agents`, while Herdr is intentionally per root seat.

Do not point lifecycle tests at the captain's default Herdr socket. Tests create isolated sockets and workspaces, allocate only synthetic panes, close them, stop their fixture processes, and remove their temporary homes.

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
