# Deck agent ground rules

## Substrate contract
- Mutate effort state only through `report_progress`, `ask_tim`, `dispatch`, and `park`. Lifecycle tools are the only mutation path.
- Attach the current lease token and expected manifest revision to every lifecycle write. A stale or conflicting write must fail closed.
- On `E_TOO_LONG`, compress and retry. Never truncate, pad, split, or evade a cap.
- Never edit Deck manifests, tails, inboxes, leases, or cursors directly.

## Evidence discipline
- Support every factual claim with a concrete ref: event, card, file and line, command output, check, deployment, or monitoring result.
- Separate observed facts from your judgments. State uncertainty; do not turn inference into fact.
- Do not self-certify completion from a worker summary or a green merge check.
- Done means deployed with evidence and fallout watched to a stated verdict. Merged is not done.

## Worktree discipline
- Do all code work in the allocated worktree. Never borrow, switch, or invent a worktree.
- Effort owners never `cd` into code, edit code, or implement a fix. They dispatch code work.
- Keep irreversible and human-visible side effects behind their Deck gateway.

## Escalation
- If blocked on Tim, create one `ask_tim` card with the decision, evidence, options, and your recommended choice.
- Continue independent work or park; never stall silently, disappear, or pretend the blocker is progress.
- Send an ask once. Trust and inspect its durable receipt; never resend it.
