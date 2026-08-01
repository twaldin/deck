# @deck/intake — durable PR/review intake poller

Makes "nothing untracked can exist" a checked invariant. Polls GitHub for
(a) open PRs authored by the configured login and (b) open PRs with a review
requested from that login, keeps a durable JSON snapshot, renders a
human-readable markdown list, prints a machine-parseable diff of what
changed since the previous run, and appends every non-`untracked` change to a
durable event log under the deck home that deck-v2's wake reconcile consumes.
`REVIEW-REQUESTED` lines/events are the high-signal wake condition.

Cursors are durable: the JSON state file only advances after outputs are
written, so a restart never re-fires what was already reported, and a crash
never silently consumes a change (worst case: at-least-once event delivery,
which the consumer tolerates).

## Invocation

```sh
cd intake && bun install   # once

# single poll (cron / orchestrator timer owns cadence)
./bin/deck-intake --once \
	--org lindy-ai \
	--include-user-repos \
	--tracked /path/to/fleet/data/tracked-prs.txt

# or long-lived (run it under the process tool / launchd; restart-safe)
./bin/deck-intake --loop 120 --org lindy-ai --include-user-repos

# list intake records with correlated deck task ids
./bin/deck-intake ls
```

| Flag | Meaning | Default |
|---|---|---|
| `--once` | Single poll: fetch, diff, write, print, exit. | — |
| `--loop <seconds>` | Long-lived mode: the same poll on a fixed cadence (>= 10s). Mutually exclusive with `--once`; one of the two is required. | — |
| `--events <file>` | Durable event log (JSONL, append-only) | `$DECK_V2_HOME/intake/events.jsonl` |
| `--login <login>` | GitHub login to poll for | `twaldin` |
| `--org <org>` | Search scope org (repeatable) | `lindy-ai` |
| `--include-user-repos` | Also scope to `user:<login>` (the login's own repos) | off |
| `--state <file>` | Durable JSON state file | `$DECK_V2_HOME/intake/intake-prs.json` |
| `--out <file>` | Rendered markdown path | `$DECK_V2_HOME/intake/intake-prs.md` |
| `--tracked <file>` | Known/tracked PR URLs, one per line (`#` comments, trailing annotations after whitespace OK). Anything unlisted is flagged `untracked`. | none (section reports "no file supplied") |
| `--json` | Diff as JSON lines instead of tab-separated | off |
| `--linear` | Linear section — **stub**, fails loudly (no verified Linear auth path yet; see `src/linear.ts`) | off |

`DECK_V2_HOME` defaults to `~/.deck` — the same home deck-v2 uses.

Auth (live mode): rides the ambient `gh` login — verify with `gh auth status`.
Read-only: only GraphQL search/lookup and the commit-search REST endpoint are
used. Unit tests never touch the live API; a live smoke run is just
`./bin/deck-intake --once --org <org>` with a logged-in `gh`.

## Durable events + waking parked efforts

Every change except `untracked` is appended to the event log as one JSON
object per line (`src/deck.ts`, `IntakeEvent`): `{v, ts, kind, url, taskId,
signal, note}`. `taskId` is the correlated deck task when the PR's URL or head
branch matches a task's `.meta` record under `$DECK_V2_HOME/state/`.
PR-URL match wins; a branch match requires the task's repo (resolved from its
worktree's origin remote) to equal the PR's repo — a task whose repo cannot be
resolved (torn-down worktree) never branch-matches — and an ambiguous branch
match correlates to nothing rather than to the wrong task.
PR titles never enter a note: the note is injected into the orchestrator's
context, and a title is attacker-writable free text. Notes are built only from
enums, logins, `owner/name#N` and API URLs; titles stay on human-facing
surfaces (the markdown report, `deck-intake ls`). Uncorrelated PRs remain intake records, listable with
`deck-intake ls` (tab-separated: `taskId  buckets  ci  review  url  title`).

deck-v2's `reconcile` (v2/src/wake.ts) consumes the log with the same
identity-aware byte cursor it uses for `.status` files, so a wake fires
exactly once per event across restarts:

| event | tier | delivery |
|---|---|---|
| `signal: true` (new review request for the login) | T0 | interrupt now |
| correlated to a task, or `removed` / `review-decision` | T1 | folded batch — wakes the parked effort |
| everything else (uncorrelated CI churn, own new PRs) | T2 | recorded, never delivered |

Idempotence is layered: the diff engine only emits real state changes (same PR
review state never re-emits), the consumer's cursor never re-reads a consumed
line, and a durable url+kind baseline suppresses the crash-window repeat
(events append BEFORE the state file advances, so a crash in between re-emits
the same diff once more — it is recorded, but never wakes twice).

Exit codes: `0` ok (empty diff = quiet run), `1` usage error, `2` poll/IO
failure. The state file is advanced LAST, after the diff has been printed
and the markdown written, and API failures during removal resolution abort
the run — re-detection happens on the next poll. A change is never
silently consumed.

## Output contract (stdout)

One line per change. Default form is tab-separated with fixed leading columns:

```
<kind>\t<signal>\t<url>\t<detail...>
```

`<kind>` is always one of the stable schema kinds below, so a parser can
decide the column shape from column 1 alone. `<signal>` is
`REVIEW-REQUESTED` when the polled login was newly asked for review (the
high-signal wake condition) and `-` otherwise. A watcher wakes a supervisor
on any output; it escalates on `cut -f2 == REVIEW-REQUESTED`.

| kind | detail columns | meaning |
|---|---|---|
| `new` | `<buckets>\t<title>` | PR newly in scope |
| `removed` | `<resolution>\t<title>` | PR left scope; resolution below |
| `ci` | `<from>-><to>` | CI rollup change (`passing`/`failing`/`pending`/`none`) |
| `review-decision` | `<from>-><to>` | `approved`/`changes-requested`/`review-required`/`none` |
| `reviewers` | `+alice,-bob` | requested-reviewer set changed (signal set when we were added) |
| `buckets` | `my-pr->my-pr,review-owed` | membership changed between sections (signal set on entering review-owed) |
| `untracked` | `<title>` | in scope but absent from the `--tracked` file |

Removal resolutions:

| resolution | meaning |
|---|---|
| `merged` | GitHub reports merged |
| `landed-squash` | **Landing check resolved**: the squash commit `(#N)` exists on the default branch — the work landed |
| `closed-without-landing` | closed, unmerged, **and** the squash-commit search came back empty — a real alarm |
| `descoped` | still open, just left the search scope (e.g. review request withdrawn) |
| `vanished` | could not resolve the PR at all (deleted repo, lost access) |

`--json` emits the same changes as JSON objects, one per line, validated by
`diffChangeSchema` in `src/schema.ts`.

## The landing check (why `landed-squash` exists)

A closed or unmerged PR state does not by itself prove that the work did not
land. This poller never reports `closed-without-landing` until a commit-search
of the repo's default branch for a headline ending in `(#N)` comes back empty
(GitHub commit search indexes exactly the default branch). Body-only `#N`
mentions do not count. See `resolveRemoval` in `src/diff.ts` and
`pickSquashCommit` in `src/github.ts`.

## Markdown output

Sections, in order:

1. **My PRs** — open PRs authored by the login.
2. **Reviews I owe** — open PRs with a pending review request for the login;
   requests new this run get a loud `🔔 NEW REVIEW REQUEST` call-out.
3. **Not linked to tracked work** — items whose URL is absent from the
   `--tracked` file (or a note that no file was supplied).
4. **Linear** — disabled stub until an auth path is verified.

## Linear (stub)

Interface only: `src/linear.ts` defines `LinearClient`
(assigned-to-login tickets + active-state tickets) and the pure sectioning
logic (`buildLinearSection`: active tickets with no attached PR in the
tracked set). The `--linear` flag defaults off and fails loudly if passed —
no Linear auth path is verified on this rig and we do not guess at auth.

## Tests

```sh
cd intake && bun test && bunx tsc --noEmit
```

The diff engine and GitHub landing resolution are tested against a mocked
`GithubClient`; nothing in the test suite touches the live API.
