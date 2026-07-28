# @deck/intake — durable PR/review intake poller

Makes "nothing untracked can exist" a checked invariant. Polls GitHub for
(a) open PRs authored by the configured login and (b) open PRs with a review
requested from that login, keeps a durable JSON snapshot, renders a
human-readable markdown list, and prints a machine-parseable diff of what
changed since the previous run. A watcher script wakes a supervisor on any
diff output; `REVIEW-REQUESTED` lines are the high-signal wake condition.

No daemon, no scheduler: the fleet's own watcher owns cadence and invokes
`--once` on its schedule.

## Invocation

```sh
cd intake && bun install   # once

./bin/deck-intake --once \
	--org lindy-ai \
	--include-user-repos \
	--state ~/.deck/intake/intake-prs.json \
	--out /path/to/fleet/data/intake-prs.md \
	--tracked /path/to/fleet/data/tracked-prs.txt
```

| Flag | Meaning | Default |
|---|---|---|
| `--once` | Single poll: fetch, diff, write, print, exit. **Required.** | — |
| `--login <login>` | GitHub login to poll for | `twaldin` |
| `--org <org>` | Search scope org (repeatable) | `lindy-ai` |
| `--include-user-repos` | Also scope to `user:<login>` (the login's own repos) | off |
| `--state <file>` | Durable JSON state file | `~/.deck/intake/intake-prs.json` |
| `--out <file>` | Rendered markdown path | `~/.deck/intake/intake-prs.md` |
| `--tracked <file>` | Known/tracked PR URLs, one per line (`#` comments, trailing annotations after whitespace OK). Anything unlisted is flagged `untracked`. | none (section reports "no file supplied") |
| `--json` | Diff as JSON lines instead of tab-separated | off |
| `--linear` | Linear section — **stub**, fails loudly (no verified Linear auth path yet; see `src/linear.ts`) | off |

Auth: rides the ambient `gh` login (`gh auth status`). Read-only: only
GraphQL search/lookup and the commit-search REST endpoint are used.

Exit codes: `0` ok (empty diff = quiet run), `1` usage error, `2` poll/IO
failure (state file is NOT advanced on failure, so no changes are lost).

## Output contract (stdout)

One line per change. Default form is tab-separated:

```
<kind>\t<url>\t<detail...>
```

| kind | detail | meaning |
|---|---|---|
| `new` | `<buckets>\t<title>` | PR newly in scope |
| `REVIEW-REQUESTED` | (varies) | high-signal: replaces `new`/`reviewers`/`buckets` when the polled login was newly asked for review |
| `removed` | `<resolution>\t<title>` | PR left scope; resolution below |
| `ci` | `<from>-><to>` | CI rollup change (`passing`/`failing`/`pending`/`none`) |
| `review-decision` | `<from>-><to>` | `approved`/`changes-requested`/`review-required`/`none` |
| `reviewers` | `+alice,-bob` | requested-reviewer set changed |
| `buckets` | `my-pr->my-pr,review-owed` | membership changed between sections |
| `untracked` | `<title>` | in scope but absent from the `--tracked` file |

Removal resolutions:

| resolution | meaning |
|---|---|
| `merged` | GitHub reports merged |
| `landed-squash` | **Graphite trap resolved**: state=closed, merged=false, but the squash commit `(#N)` exists on the default branch — the work landed |
| `closed-without-landing` | closed, unmerged, **and** the squash-commit search came back empty — a real alarm |
| `descoped` | still open, just left the search scope (e.g. review request withdrawn) |
| `vanished` | could not resolve the PR at all (deleted repo, lost access) |

`--json` emits the same changes as JSON objects, one per line, validated by
`diffChangeSchema` in `src/schema.ts`.

## The Graphite trap (why `landed-squash` exists)

Graphite squash-lands a stack onto the default branch and closes the PRs
instead of GitHub-merging them. A naive poller reports these as
"closed without merging" — three confirmed repros of that misread. This
poller never reports `closed-without-landing` until a commit-search of the
repo's default branch for a headline ending in `(#N)` comes back empty
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

The diff engine and Graphite resolution are tested against a mocked
`GithubClient`; nothing in the test suite touches the live API.
