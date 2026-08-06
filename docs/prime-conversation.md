# Prime conversation seat

The Prime conversation profile is the captain's long-running chat surface on
Prime Agent. It can retrieve Deck context, discuss and shape work, and hand a
frozen packet to the factory through `ship` or `adopt`. It is not a Smithers
worker, workflow engine, supervisor, publisher, or authority store.

The reviewed release is fixed at:

- package version `0.7.0`
- tag `v0.7.0`
- commit `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`


## Install and enter

Prime Agent is installed into Deck's managed `~/.deck/.prime/runtime`; install
and update converge that reviewed artifact without writing global `~/.prime`.
`patches/prime-agent/manifest.json` is the single source for the expected
install state and its full package-tree and CLI fingerprints. The current
policy is the pristine pinned `0.7.0`; the tracked fixes remain unapplied while
their upstream PRs are open. Both install and every profile launch delegate to
`ops/prime-patches.sh verify`; patched, dirty, or unknown builds fail closed.

If Prime is missing, install the manifest's pinned base artifact and verify it:

```sh
cd ~/dev/deck
artifact="$(mktemp -t prime-agent.XXXXXX.tgz)"
url="$(node -p 'require("./patches/prime-agent/manifest.json").base.artifactUrl')"
sha="$(node -p 'require("./patches/prime-agent/manifest.json").base.artifactSha256')"
curl -fsSL "$url" -o "$artifact"
printf '%s  %s\n' "$sha" "$artifact" | shasum -a 256 -c -
npm install -g "$artifact"
rm -f "$artifact"
ops/prime-patches.sh verify
```

The Deck installer is a dry run unless `--apply` is present:

```sh
cd ~/dev/deck
./ops/install-prime-conversation.sh
./ops/install-prime-conversation.sh --apply
```

It is safe to rerun. Apply requires `~/.deck/AGENTS.md` to match the checked-in
v4 seed exactly and refuses to replace an unowned settings, prompt, wrapper,
guard, or extension path. It writes only:

- `deck-questions`, `deck-ship`, `deck-recall`, and `deck-usage` under
  `~/.deck/.prime/agent/extensions/`;
- `broker/prime/deck-provider.ts`, its adjacent `zod` dependency, and a
  profile-local fail-closed provider guard;
- the `v2/src` support tree used by those four extensions;
- the exact package setting `npm:@aliou/pi-processes@0.10.4` and a
  profile-local link to that exact, already-global package (missing or
  mismatched versions fail closed);
- the custody prompt, supplemental harness directory, settings, manifest, and
  entry wrapper.

This mirrors the extension layout made by `v2/install.sh`, but does not invoke
that whole installer. The full installer also adds Deck and Smithers CLI shims
and a Smithers runtime. Those are deliberately outside this conversation
profile's custody.

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
`anthropic-messages`; an additional native stream would require a custom transport.

## Session-scoped process watches

The conversation seat enables the `process` tool for event-driven wake on
process exit, success, failure, or a stdout/stderr match. Use it for interactive
CI and PR watching instead of sleep loops or polling.

Processes are SESSION-SCOPED and do NOT survive a daemon restart. Durable
workflow seats—including PR-pipeline stages, review-gate, and every
Smithers-launched seat—must use Smithers for durable waiting and must not receive
this tool. Prime-selected workflow seats enforce that boundary with
`--no-extensions`, only the adapter-reviewed extensions, and the `ipython`
tool allowlist. Review-gate and every other workflow use the same reviewed
Prime adapter without the conversation-only process package.

A child's watcher wakes that CHILD, not its parent. Put the watcher in the seat
that must react. Deleting or shutting down a child also stops processes managed
by that child.

## Shared Deck daemon and custody

The profile uses these Deck-owned Prime paths:

```text
~/.deck/.prime/agent/       shared Deck config and starved native-auth store
~/.deck/.prime/sessions/    captain conversation session files
~/.deck/.prime/run/conversation.sock
                            shared Deck Prime daemon socket
```

`ops/prime-deck-profile.json` is the single source for the socket's relative
path. The captain conversation, workflow seats, spawn agents, and their RLM
children join this one Deck-scoped daemon so they appear in one Agents View.
It remains distinct from Prime's default per-UID socket, so non-Deck Prime usage
cannot join it. Every shared-daemon seat uses `~/.deck/.prime/agent`, including
its empty native-auth store and Deck-only settings, but resource loading is
per-seat: only the conversation seat admits its configured process package.
The conversation wrapper rejects socket, cwd, system-prompt, provider,
model-scope, extension, external resume, and fork
overrides. The conversation wrapper also refuses `shutdown`: no conversation
client owns the shared factory daemon.

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
- Killing the captain conversation client must not shut down the shared Deck
  daemon, pause, advance, cancel, or orphan a workflow. The factory never
  depends on this seat's heartbeat, goal, transcript, kernel, or A2A delivery.

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
capabilities being adopted. This is an execution surface, not an additional
factory authority.

This does not turn IPython interception into a security boundary. The spike
proved that Python filesystem, subprocess, and network actions happen inside
the kernel without separate outer tool events. Safety therefore comes from zero
factory authority, credential custody in receiving services, server-side packet
validation, and the existing Smithers/review/stamp/MQ gates.

## Herdr behavior

Prime Agent `0.7.0` includes its own Herdr reporter. No
`herdr-agent-state.ts` file is installed in this profile. The focused guard
starts headless RPC sessions against a stub Herdr socket and observes
`pane.report_agent` in state `idle`, and a matching
`pane.release_agent` on exit. The built-in lifecycle also reports `working`
during an agent turn and `blocked` for an explicit block or terminal retry
failure.

The wrapper now supplies the pane that reporter needs. When the conversation is
already running in a validated Herdr pane/socket tuple, it keeps that ambient
pane. Partial or stale ambient identity is cleared. When the captain starts
`prime-conversation` from a plain terminal, the wrapper validates `herdr status
server --json`, reuses or creates the `deck-fleet` workspace, creates a labelled
root tab, and uses an argv-safe Bash bootstrap to run the same wrapper command
in its root pane. It then focuses that tab and attaches the terminal to Herdr.
The new pane receives Herdr's injected socket, workspace, tab, and pane identity;
a recursion guard prevents another allocation. Every CLI call is bounded; if
the CLI or server is unavailable or wedged, the wrapper continues locally
instead of blocking the conversation.

This does not fight Deck's fleet projection. Prime reports the captain process;
Deck's best-effort fleet projection uses source `deck` on Deck-managed effort
panes. Smithers and Deck state remain authoritative.
Prime also defers its built-in reporter if a file-based Herdr integration is
present, but Deck does not install one.

Known limitation: Prime `rlm()` children share the parent's Herdr pane. Herdr
visibility is therefore per conversation seat, not one pane per RLM child.
Prime's child registry remains the detailed child view.

## Workflow seats

Every Smithers agent task, including PR-pipeline and review-gate, constructs the
reviewed `PrimeSeatAgent`. Project profiles cannot select another engine.
Workflow seats load only `ipython`; they do not receive the conversation-only
process package. Native RLM children are bounded by the adapter's capability
profile and inherit the canonical mechanical model policy.

The adapter pins binary, provider, model, resource roots, credentials, and
provenance; validates typed results; and owns timeout, cancellation, teardown,
and Herdr lifecycle behavior.

## Guard and manual upgrade

Run the focused guard against its automatically-created sandbox home:

```sh
cd ~/dev/deck
bun test ops/prime-conversation.test.ts
```

The default suite runs the installer twice, starts real Prime `0.7.0` with the
workflow resource filters, and observes only `ipython`. It then joins the same
daemon through the conversation wrapper and observes `process` loading without
a command collision alongside the Deck tools. The suite also checks the Deck
model catalog, selected provider and `deck/*` scope, OptMem, base prompt and
Deck seed, production-workspace refusal, credential starvation, Herdr, and
version/package-integrity tripwires. It never reads or writes live `~/.deck`;
the sandbox provider token is a dummy and no paid model call occurs.

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

1. Drain every Deck Prime seat and stop the shared daemon explicitly before
   changing the managed runtime:

   ```sh
   prime-agent shutdown --force
   ```

2. Review the upstream release and every tracked patch. Update
   `patches/prime-agent/manifest.json` with the exact base, patch, artifact,
   full-tree, and CLI fingerprints and set its reviewed `expectedInstallState`.
   Do not copy those fingerprints into this installer or document.
3. Install only the manifest-selected artifact, then run
   `ops/prime-patches.sh verify`. The public `prime-agent@<version>` npm selector
   is not the release channel; never use the moving `prime-agent update`
   command.

4. Rewire the profile and rerun the upgrade tripwire in a sandbox:

   ```sh
   cd ~/dev/deck
   ./ops/install-prime-conversation.sh
   ./ops/install-prime-conversation.sh --apply
   bun test ops/prime-conversation.test.ts
   ```

Do not re-enter Prime if the tripwire, extension/provider load, custody prompt,
OptMem, workspace refusal, socket, or Herdr guard fails.

