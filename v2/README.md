# Deck runtime

`v2/` is the headless library and CLI behind Deck's current v4 plain-session
shape. The directory name is historical; it does not contain the retired v2
orchestrator extension.

**What this is not:** it is not a hosted product or an autonomous agent
supervisor. It is a local, operator-attended runtime whose durable delivery
work is delegated to explicit Smithers workflows.

## Current shape

Any number of ordinary Pi sessions may start in `~/.deck`. Each session loads
four independent project-local extensions while those components remain in the
tree:

- `deck-questions`
- `deck-ship`
- `deck-recall`
- `deck-subagents` (temporary during the Pi-seat migration)

`deck-ship` exposes the factory as tools. `ship` and `adopt` call the same
headless dispatch code as the CLI; `status` is read-only. There is no
orchestrator extension, fleet overlay, wake loop, or second delivery engine in
the conversation.

```text
plain Pi chat
    │ ship / adopt / status
    ▼
detached Smithers pr-pipeline
    └ implementation, adversarial review, PR/reviewer/CI watch,
      configured merge policy, delivery and fallout evidence
```

The session shapes the issue and handles operator decisions. Smithers persists
pipeline progress and retries. The broker supplies the model seats configured
for the current pipeline. OptMem supplies global cross-session memory; effort
dossiers retain the detailed brief, rationale, alternatives, and checkpoints.

The separate `workflows/review-gate/` poller is an explicitly selected,
company-specific example. Neither `install.sh` nor `update.sh` starts it.

## Install and discovery

Run the repository-root `install.sh` for first-time setup and root `update.sh`
for an existing installation. The internal `v2/install.sh` is called by both;
it is not a competing onboarding command.

The installed layout is:

```text
~/.deck/AGENTS.md
~/.deck/.pi/extensions/deck-questions/index.ts
~/.deck/.pi/extensions/deck-ship/index.ts
~/.deck/.pi/extensions/deck-recall/index.ts
~/.deck/.pi/extensions/deck-subagents/index.ts
~/.deck/.pi/extensions/v2/src/*.ts
~/.deck/state/smithers/
~/.local/bin/{pi,deck,deck-v2,smithers}
```

The extension entrypoints in `../extensions-pi/` import this directory's source.
`v2/install.sh` preserves that relative layout with a marked support tree under
`~/.deck/.pi/extensions/v2/`; support modules are not independently discovered
as extensions.

`~/.deck` is deliberately a plain runtime directory, never a checkout. A
checkout would bring its own repository instructions and would allow rebases or
branch changes to move live state.

## Standalone Pi credentials and broker-backed seats

The root installer pins Pi locally, so no global Pi or Node installation is
needed. A new operator can enter `~/.deck`, start `pi`, use `/login` to store
their own supported subscription or API key in Pi's user configuration, and
choose it with `/model`. This loads the Deck extensions and public seed without
using another person's broker.

The current PR-pipeline and `deck-subagents` model seats use the `deck` provider,
so executing those seats additionally requires this operator's broker process
and broker login. Merely entering a plain session, reading questions, checking
status, or recalling a dossier does not.

## Library, CLI, and tools

The implementation lives in `src/`. `bin/deck-v2` and the standalone extension
entrypoints import the same functions:

```text
deck-v2 bootstrap
deck-v2 ship <ticket> --profile <id> --worktree <path> --branch <name> ...
deck-v2 spawn <id> --task "..." --accept "..." --worktree <path>
deck-v2 status <id>
deck-v2 fleet
```

An effort that ends in a PR goes through the project profile's PR pipeline.
`spawn --kind ship` is refused on a profiled repository unless the caller
explicitly chooses `--no-pipeline`; `spawn` is for bounded seats inside a stage
and for non-shipping research, not a pipeline bypass.

Project profiles are loaded wholesale from
`~/.deck/config/projects.json`. Bootstrap writes an empty list and selects no
personal or company profile. Reviewer exclusions and reviewer routing belong in
`~/.deck/config/reviewers.json`, not in this repository's public seed.

## Questions

`src/questions.ts` and `src/questions-store.ts` implement a durable,
operator-facing queue. The extension supplies question creation, read-only
listing, first-answer-wins answering, and `/questions`.

The queue is `~/.deck/questions/queue.jsonl`
(`DECK_QUESTIONS_FILE` overrides it for tests). It is an append-only JSONL event
log folded on read. Delivery sends before it marks, and a first answer wins.
Session start imports still-open records from the retired global queue once.
Archival compaction is exclusive offline maintenance; live sessions never
rewrite the shared log.

The optional real smoke uses two Pi processes sharing only the queue file:

```sh
cd v2
bun run smoke/run-questions-smoke.ts
```

## State and liveness details

- `run_epoch` fences local state only. Irreversible actions use a claim and a
  pending receipt written before the action.
- Landing is proved by the squash commit on the base branch, not only by a
  closed or merged pull-request flag.
- Status files are event logs. `working:` is not progress and silence alone is
  not failure.
- Staleness is based on worktree and session-transcript activity since the
  current run started. Status-line writes do not count as work.
- Wake delivery is at least once through a durable outbox. A read cannot double
  as acknowledgement because a failed injection would otherwise lose the event.

## Development

From this directory:

```sh
bun test test/
bun run typecheck
```

Tests defend contracts and regressions rather than mirroring each source file.
