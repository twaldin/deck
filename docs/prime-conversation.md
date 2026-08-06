# Prime conversation seat

The Prime conversation profile is the captain's long-running chat surface on
Prime Agent. It can retrieve Deck context, discuss and shape work, and hand a
frozen packet to the factory through `ship` or `adopt`. It is not a Smithers
worker, workflow engine, supervisor, publisher, or authority store.

The reviewed release is fixed at:

- package version `0.7.0`
- tag `v0.7.0`
- commit `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`

Base pi remains installed as a cold rollback. There is no automatic Prime-to-pi
fallback and no second live authority path.

## Install and enter

Prime Agent is already installed globally. The profile installer does not
install a second copy and never writes `~/.prime`. It requires version `0.7.0`,
the reviewed CLI and complete release-owned package-tree digests, then wires the
profile around that absolute binary. The reviewed source artifact is
`prime-agent-0.7.0.tgz` at tag `v0.7.0`, SHA-256
`88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b`.
If Prime is missing, install that immutable artifact through npm:

```sh
artifact="$(mktemp -t prime-agent-0.7.0.XXXXXX.tgz)"
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz -o "$artifact"
printf '%s  %s\n' 88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b "$artifact" | shasum -a 256 -c -
npm install -g "$artifact"
rm -f "$artifact"
```

The Deck installer is a dry run unless `--apply` is present:

```sh
cd ~/dev/deck
./ops/install-prime-conversation.sh
./ops/install-prime-conversation.sh --apply
```

It is safe to rerun. Apply requires `~/.deck/AGENTS.md` to match the checked-in
v4 seed exactly and refuses to replace an unowned settings, prompt, wrapper,
guard, or extension path. It installs only:

- `deck-questions`, `deck-ship`, and `deck-recall` under
  `~/.deck/.prime/agent/extensions/`;
- `broker/pi/deck-provider.ts`, its adjacent `zod` dependency, and a
  profile-local fail-closed provider guard;
- the `v2/src` support tree used by those three extensions;
- the custody prompt, supplemental harness directory, settings, manifest, and
  entry wrapper.

This mirrors the extension layout made by `v2/install.sh`, but does not invoke
that whole installer. The full installer also installs `deck-subagents`, Deck
and Smithers CLI shims, and a Smithers runtime. Those are deliberately outside
this conversation profile's custody.

Enter the seat with exactly:

```sh
cd ~/.deck && ./.prime/bin/prime-conversation
```

The wrapper always changes to `~/.deck`, so the closest `AGENTS.md` is the Deck
home seed. The guard captures Prime's actual system prompt and requires the
complete `v2/seed/AGENTS.md` text. The project-scoped settings make `deck` the
default and scope `enabledModels` to `deck/*`. Prime 0.7 has no separate
enabled-providers allowlist, so the profile also supplies a read-only empty
`~/.deck/.prime/agent/auth.json`, points `PRIME_AGENT_CODING_AGENT_DIR` at that
profile, removes direct vendor-key variables, rejects provider/model cycling
overrides, and shuts down if any non-Deck model reaches the runtime guard.
Global `~/.prime/agent/auth.json` OAuth logins are therefore neither copied nor
visible to this seat. A startup catalog probe fails visibly unless Deck has
models and the selected model is Deck; there is no native-provider fallback.
No captain model is hardcoded. A bare Deck model id may be selected for one
session:

```sh
cd ~/.deck && ./.prime/bin/prime-conversation --model gpt-5.6-sol
```

An empirical transparent-proxy probe exercised a real top-level request and a
real `rlm()` child with `--thinking xhigh`. All 14 broker-ingress calls carried
the exact `reasoning_effort: xhigh`; no native thinking payload reached ingress.
The broker validates/clamps that named level and converts it to the native
Anthropic thinking budget after routing. Named thinking levels survive both
paths, but Prime does not expose an explicit numeric budget through `--thinking`.
Prime's `registerProvider` API supports only `openai-completions` and
`anthropic-messages`; `/v1/pi/stream` would require a custom transport.

## Isolation and custody

The profile uses these Prime paths instead of Deck's existing `.pi` paths:

```text
~/.deck/.prime/agent/       project and user config for this profile
~/.deck/.prime/sessions/    conversation session files
~/.deck/.prime/run/conversation.sock
                            profile-only daemon socket
```

Prime's default daemon socket is per UID and outside `HOME`. The wrapper always
passes the profile socket and rejects daemon, cwd, session-directory,
system-prompt, provider, model-scope, extension, external resume, and fork
overrides. This prevents attachment to the default daemon and prevents loading
another profile's session or extension state.

`APPEND_SYSTEM.md` contains the custody contract in Prime's immutable base-prompt
construction. It is read-only and digest-pinned in
`deck-prime-conversation.json`. Prime's `harness/` directory is separate,
writable supplemental state. `autoRefine.enabled` is false: `/refine` remains
available, but a persistent change is deliberate rather than an automatic turn
or compaction action. Prime's own contract is that refinement changes
supplemental harness state, not the base system prompt.

The custody rules are operational boundaries, not a claim that IPython is a
sandbox:

- Prime owns no fleet or workflow state. Smithers, Git/GitHub, dossiers,
  OptMem, and the questions store remain authoritative.
- Prime creates no factory wake, heartbeat, goal, retry, poll, node transition,
  or A2A supervision loop. The one-shot `memo wake` injection at session start
  is retrieval context, not factory liveness.
- Production dispatch goes only through `ship` or `adopt`; `status` is
  read-only. A direct production `smithers-orchestrator` launch from this seat's
  workspace is rejected by `assertProductWorkspace`.
- The wrapper removes Smithers Gateway/token-store, Deck stamp/publisher, admin,
  and direct vendor-provider key variables before Prime starts. The seat receives
  only the separate Deck broker routing token; it holds no Smithers stamp or
  Gateway-admin credential. A workflow stamp or denial is valid only when an
  independently authenticated Gateway accepts it.
- Killing Prime or its isolated daemon must not pause, advance, cancel, or
  orphan a workflow. The factory never depends on this seat's heartbeat, goal,
  transcript, kernel, or A2A delivery.

Prime-local `rlm()` children are allowed for bounded conversational
composition. They are not Smithers workers and inherit the same non-custodial
boundary. The wrapper defaults `RLM_MAX_DEPTH` to `1`: the root may create a
child, and that child cannot create a grandchild. A deliberate session can
change the cap without editing the profile:

```sh
PRIME_CONVERSATION_RLM_MAX_DEPTH=0 \
  ~/.deck/.prime/bin/prime-conversation   # disable children
```

Values above `1` are possible through the same variable, but are not the
reviewed captain default. They should remain explicit experiments: independent
replication found depth two and above less accurate and much slower.

## Why the kernel stays on

The captain's kernel is intentionally enabled. `rlm()` and `/refine` live in the
IPython-backed runtime; disabling the kernel would remove the main Prime
capabilities being adopted. The existing pi chat already has bash and edit, so
arbitrary local execution is not a new authority granted by this cutover.

This does not turn IPython interception into a security boundary. The spike
proved that Python filesystem, subprocess, and network actions happen inside
the kernel without separate outer tool events. Safety therefore comes from zero
factory authority, credential custody in receiving services, server-side packet
validation, and the existing Smithers/review/stamp/MQ gates.

## Herdr behavior

Prime Agent `0.7.0` includes its own Herdr reporter. No
`herdr-agent-state.ts` file is installed in this profile. The focused guard
starts headless RPC sessions against a stub Herdr socket and observes
`pane.report_agent` with source `herdr:pi`, state `idle`, and a matching
`pane.release_agent` on exit. A concurrent two-session drill on the same
isolated Prime daemon verifies that each session keeps its own `HERDR_PANE_ID`.
The built-in lifecycle also reports `working` during an agent turn and `blocked`
for an explicit block or a terminal retry failure.

This does not fight Deck's fleet projection. Prime reports the captain process
with source `herdr:pi` in the Herdr pane that launched it. Deck's best-effort
fleet projection uses source `deck` on Deck-managed effort panes; Smithers and
Deck state remain authoritative. Prime also defers its built-in reporter if a
loaded file-based Herdr integration is present, preventing two `herdr:pi`
reporters from racing.

Known limitation: Prime `rlm()` children share the parent's Herdr pane. Herdr
visibility is therefore per conversation seat, not one pane per RLM child.
Prime's child registry remains the detailed child view.

## Not adopted yet

### Prime Smithers worker seats

Smithers worker seats remain on the current engine until all of these gates pass:

1. A JSON/RPC adapter pins the Prime binary, root provider/model, resources,
   config/session/socket roots, and records binary, prompt, extension, provider,
   profile, and actual model provenance.
2. Engine choice is a reviewed per-profile allowlist, never agent-selected;
   there is no silent Prime-to-pi or broker-to-vendor fallback.
3. The adapter returns only typed result/error receipts and handles malformed
   output, RPC/daemon failure, manual cancel, hard TTL, retry, and deterministic
   root/kernel/daemon/descendant teardown with no orphan.
4. Every node starts with fresh disposable config, sessions, and harness state.
   Publisher, push, stamp, merge/MQ, and Gateway-admin credentials stay outside.
5. The adapter suite, paired read-only replay, write-capable non-Lindy node,
   complete non-Lindy pipeline, and one reversible Lindy profile canary pass
   with zero hard custody/provenance/liveness violations. Quality must be at
   least pi, intervention no worse, and one predeclared cost, duration, steer,
   or failure metric must improve without regression elsewhere.

The captain conversation profile is the only profile permitted to dispatch a
one-off top-level Prime `spawn-agent` for longer work. The single no-dispatch
capability definition lives in `workflows/pr-pipeline/lib/engines/prime.ts` as
`PRIME_SEAT_CAPABILITY_PROFILES["spawn-agent"]`: `RLM_MAX_DEPTH=1`, only
`ipython`, and `dispatch:false`. The identical `workflow-seat` profile is also
no-dispatch, so spawn-to-spawn nesting is impossible. This installer does not
install a spawn launcher: spawning remains unavailable here until a reviewed
launcher invokes that adapter-owned profile; it must never be emulated with a
subprocess or another extension.

### Factory spawn cutover

The existing `deck-subagents` factory primitive is not installed here and is
not replaced yet. Factory spawn flips to Prime-native RLM only after promoted
Prime worker seats pass, then the child-specific gates also pass:

- exact allowlisted child provider/model is attested and unavailable models
  fail closed;
- depth, concurrency, and budget are bounded;
- every child returns a schema-valid receipt;
- malformed and deliberately hung children, manual cancellation, root TTL, RPC
  loss, and parent teardown leave no descendant and cannot advance a node;
- the separate Smithers cross-family review stays independently pinned;
- every spawn caller migrates in one cutover and `deck-subagents` is deleted,
  not retained as a warm alternate.

The captain's depth-one conversation children do not flip either factory gate:
they are local decomposition with no workflow custody.

## Guard and manual upgrade

Run the focused guard against its automatically-created sandbox home:

```sh
cd ~/dev/deck
bun test ops/prime-conversation.test.ts
```

The default suite runs the installer twice, loads the real global Prime binary
through the sandbox wrapper, inspects the tools, Deck model catalog, selected
provider, and `deck/*` scope, fires OptMem, captures the base prompt and Deck
seed, exercises production-workspace refusal, verifies stamp credentials are
absent, checks Herdr against isolated test sockets, and trips on version or
package-integrity drift. It neither reads nor writes the live `~/.deck`; the
sandbox provider token is a dummy and no paid model call occurs.

A real broker completion is an explicit operator check, not part of the default
suite. It requires an operator-supplied token and may update the live broker's
quota/session-stickiness state:

```sh
read -r -s DECK_LIVE_BROKER_TOKEN
export DECK_LIVE_BROKER_TOKEN
DECK_LIVE_BROKER_CHECK=1 bun test ops/prime-conversation.test.ts
unset DECK_LIVE_BROKER_TOKEN
```

Do not run `prime-agent update`; the profile wrapper rejects it. Prime's `update`
command follows a moving release and has no version selector. Startup checks are
neutralized with `PI_SKIP_VERSION_CHECK=1`, `PI_OFFLINE=1`, and `--offline`.

A manual upgrade is a reviewed pin change:

1. Enter cold pi and stop Prime's isolated daemon before changing the global
   binary:

   ```sh
   cd ~/.deck && ./.prime/bin/prime-conversation shutdown
   cd ~/.deck && pi
   ```

2. Review the upstream release, bind its version/tag to an exact commit, record
   the official artifact SHA-256, and derive the reviewed CLI and release-owned
   package-tree digests. Update every pin in the installer, guard, and this
   document.
3. Download the exact reviewed tarball, verify its SHA-256, then install that
   local artifact with `npm install -g <verified-artifact>`. The public
   `prime-agent@<version>` npm selector is not the release channel; never use the
   moving `prime-agent update` command.

4. Rewire the profile and rerun the upgrade tripwire in a sandbox:

   ```sh
   cd ~/dev/deck
   ./ops/install-prime-conversation.sh
   ./ops/install-prime-conversation.sh --apply
   bun test ops/prime-conversation.test.ts
   ```

Do not re-enter Prime if the tripwire, extension/provider load, custody prompt,
OptMem, workspace refusal, socket, or Herdr guard fails.

## Cold rollback

The rollback command is:

```sh
cd ~/.deck && pi
```

Prime is not automatically selected again. Diagnose and pin a reviewed fix,
then rerun the failed guard and its dependent gates before re-entry.
