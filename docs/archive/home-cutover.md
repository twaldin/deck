# Plain-pi home cutover

This checklist is for the reviewed v4 cutover. It does not run during install.
Take the old sessions down first so they cannot recreate retired state while the
home is being cleaned.

## Before moving anything

1. Finish or deliberately park every active delivery run. Preserve any unpushed
   work before treating a worktree as stale.
2. Run the migration in dry-run mode and inspect stdout:

   ```sh
   bun ~/dev/deck/ops/migrate-memory.ts
   ```

3. Create the private review artifact, then review and edit every line. The
   command refuses to replace later review edits unless `--force` is explicit.

   ```sh
   bun ~/dev/deck/ops/migrate-memory.ts --write-review
   ```

4. Install OptMem with `~/dev/deck/ops/install-optmem.sh`. Seed the reviewed
   `~/.deck/data/memory-seed.txt` one line at a time with
   `~/.optmem/memo note`, completing
   any requested compression before the next note. Do not automate past those
   compression prompts.
5. Create `~/.deck/archive/v4-cutover-YYYYMMDD-HHMMSS/` with mode `0700`. All
   items marked **archive** below move into that one timestamped directory.

## Keep in place

| Path | Reason |
| --- | --- |
| `~/.deck/questions/queue.jsonl` | Open decisions survive the cutover. |
| `~/.deck/questions/archive.jsonl` | Decision history remains useful evidence. |
| `~/.deck/broker/` | OAuth stores, control tokens, usage, and broker state are not regenerated. |
| `~/.deck/config/` | Private project, reviewer, routing, and user-specific configuration stays out of the public seed. |
| `~/.deck/.env` and `~/.deck/.deck-profile` | Machine-local environment and profile selection remain private. |
| `~/.deck/workflows` | The canonical Smithers workflow link remains the factory entry. Verify its target before launch. |
| `~/.deck/run/` and `~/.deck/logs/` | Broker and factory sockets/logs remain service-owned. Remove only confirmed stale sockets while their service is stopped. |
| `~/.deck/data/ref/distill/STANDING-RULES.md` | This remains the Lindy seat-injection source; it is not migrated into OptMem. |
| `~/.deck/data/memory-seed.txt` | Keep the captain-reviewed migration artifact until OptMem seeding is verified. |
| Other `~/.deck/data/` evidence and real `~/.deck/efforts/` dossiers | These are durable artifacts, not runtime state. Review individually; do not bulk-delete them. |
| `~/.deck/.pi/models.json`, `auth.json`, and `skills/` | Keep until all factory seats and the global pi home have been verified against their replacements. |
| `~/.deck/intake/`, `catalog/`, and `repos/` | Not part of the retired orchestrator extension. |

## Archive

Move these paths into the timestamped cutover archive; do not delete them:

- the old `~/.deck/AGENTS.md`, then install the reviewed
  `~/dev/deck/v2/seed/AGENTS.md` as the new mode-`0600` home contract;
- `~/.deck/data/captain.md` and `~/.deck/data/learnings.md`, but only after the
  review file is approved and every accepted line is seeded into OptMem;
- `~/.deck/data/projects.md`, after reconciling any still-valid checkout metadata
  into the authoritative `~/.deck/config/projects.json`;
- `~/.deck/state/` in full, including wake cursors, endpoint files, status/meta
  rows, locks, and old Smithers runtime rows; recreate an empty mode-`0700`
  `state/` for the v4 engine;
- stale `~/.deck/wt/`, `~/.deck/worktrees.json`, and
  `~/.deck/worktrees.json.lock`, after confirming no unlanded work remains;
- the sample effort `~/.deck/efforts/smithers-spike/`; keep real effort dossiers;
- legacy conversation/runtime material: `~/.deck/.pi/sessions/`,
  `~/.deck/.pi/agents/`, `~/.deck/shadow/`, `~/.deck/START.md`, and
  `~/.deck/enter.sh`.
- the repo-side workflow-development state: archive
  `~/dev/deck/workflows/.smithers/executions/lindy-adopt-26273-v5/`,
  `~/dev/deck/workflows/.smithers/executions/lindy-adopt-25523-v3/`, every
  `~/dev/deck/workflows/.smithers/executions/post-failure-*/` directory, and
  `~/dev/deck/workflows/smithers.db*` (the database plus WAL/SHM sidecars).
  These are real product-shaped runs in the development workspace; archiving
  them prevents its history from diverging from the canonical
  `~/.deck/state/smithers` workspace and leaves workflow development clean.

Archiving `state/` intentionally removes pre-v4 run continuity. Do it only at the
locked cutover after active work is drained; do not mix old extension rows with
the new engine.

## Delete, then reinstall

Delete only this retired extension entry:

- `~/.deck/.pi/extensions/deck-v2`

On reinstall, Deck also removes the retired copied child-extension layout only
when its complete Deck-owned file fingerprint is present. Unknown or partial
extension directories are left untouched.

The old installer may have left a symlink or a repo-managed copied directory at
this exact path. Verify the link target or installed contents, then remove the
whole named entry. Stop if it contains user-authored files. Do not wildcard
`extensions/`. Re-run the repository installers so the plain-session
`deck-questions`, `deck-ship`, and `deck-recall` extensions are installed at
their documented global pi paths.

## Verify and enter

Verify all of the following before declaring cutover complete:

- `~/.optmem/memo wake` succeeds and returns the reviewed global memory;
- `~/.deck/AGENTS.md` matches the reviewed v4 seed and contains no personal
  reviewer names;
- the `ship`, `adopt`, `status`, questions, and `recall_effort` tools load in a
  fresh session;
- the questions queue and broker store are byte-for-byte the kept originals;
- no retired deck-v2 orchestrator extension resolves from either pi extension
  directory.

The only session entry command is:

```sh
cd ~/.deck && pi
```
