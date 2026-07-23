# pr-pipeline structure

This is the Phase-3 structure from PLAN §5.3, not an executable workflow yet.

```text
input: effort id + repository + requested change
  |
  v
1. grill
  - clarify behavior, constraints, and acceptance evidence
  - output: agreed implementation brief
  |
  v
2. plan-prs / git-graphite
  - split the brief into a reviewable Graphite stack
  - output: ordered PR plan and branch/worktree assignments
  |
  v
3. adversarial-review
  - independent cross-model review of the plan and implementation
  - output: resolved findings and review evidence
  |
  v
4. push
  - push the reviewed branches
  - output: independently receipted push SHA(s)
  |
  v
5. watch-ci
  - wait for checks and reviewer activity
  - output: current CI and review state
  |
  v
6. fix red CI + reviewer comments
  - apply fixes, re-review, push, and return to watch-ci
  - loop until checks are green and actionable comments are resolved
  |
  v
7. Tim stamp
  - durable DeckApproval mirrored to the effort card
  - output: approval bound to the current head SHA and required checks
  |
  v
8. merge
  - invoke the separately authorized merge gateway
  - output: independently receipted merge SHA
```

## Durable boundaries

- Every stage has a stable node id and a Zod-validated output.
- Smithers owns run, node, retry, and approval state. Deck reads it through Gateway RPC rather than copying the graph.
- Push and merge are irreversible side effects. Their receipts live in the Deck manifest and event tail independently of Smithers.
- `DeckWorktree` delegates all allocation and release to `deck wt`; workflows do not create a second worktree pool.
- The Tim stamp is resolved from the Deck board back through Gateway `submitApproval`. No workflow agent receives merge authority.
- The CI-fix loop is bounded and escalates through a Deck card instead of retrying indefinitely.
