# pr-pipeline: locked specification

The captain's stated contract, 2026-08-06. This is the authority. Where code and
this document disagree, the code is wrong.

The pipeline is **enterable at any step**. An effort may start from a brief at
step 1, or adopt an existing PR branch in place and resume from step 3, 4, or 5.
Adoption is not a special mode; it is the same graph entered later.

---

## Review topology — declared by the profile, never hardcoded

Approval requirements are **per profile**, resolved at runtime from the project
config. No repo name, owner, or host may be special-cased in pipeline code.
Getting this wrong produces an unsatisfiable wait, which is how the first canary
runs hung: they waited for a human approval on repos that have no human
reviewers.

The profile declares the required approver set. The existing fields carry it:

| Profile field | Meaning |
|---|---|
| `yolo: true` | No stamp required. Merge authorization is automatic once the required bot review is resolved, CI is green on the current head, and the PR is mergeable. |
| `stamp: true` | The captain's stamp is required before merge. |
| `reviewers` / CODEOWNERS | Human approvers required for this repo, if any. An empty set means NO human approval is required — never wait for one. |

Current shape, as configuration rather than as rule: repos deckbox already owns
run `yolo` with a bot reviewer and no humans; repos new to deckbox run `stamp`
deliberately, to keep that path exercised; Lindy requires human reviewers plus
Claude-bot plus the stamp.

The captain self-approving his own PR is a real but rare case: support it, never
require it, never block on it.

Step 4's exit condition is therefore "every approver REQUIRED BY THIS PROFILE
has approved" — never a hardcoded "human AND claude".

---

## Step 1 — Produce code

Input: a prompt — brief, spec doc, ticket, or an existing PR branch to adopt.

```
if adopting an existing branch:
    bind to that branch and head; skip to the step the effort is actually at
else:
    seat := implementer            # canonical policy: sol xhigh
    capture BASE = branch + HEAD   # before the seat runs
    seat writes code and commits on the effort branch
```

Invariant: the commit set is derived from `BASE..HEAD`, never self-reported by
the seat.

## Step 2 — Adversarial loop until clean

```
loop:
    review := adversarial seat        # canonical policy: fable-5 high, opposite family
    if review has no blocking findings and local gates pass: break
    fix := implementer seat, given the findings
    fix commits on the same branch
```

Exits only when the adversary raises no blockers and local gates (typecheck,
tests, lint) pass. Agents review and fix; agents never approve.

## Step 3 — Publish

```
rebase onto base            # see rebase invariants
push branch                 # deterministic publisher holds push authority
open PR                     # team-facing body; no internal vocabulary
request relevant reviewers  # per repo config / CODEOWNERS
```

Invariant: the publisher verifies the claimed commit set against real ancestry
before pushing, and refuses on mismatch.

## Step 4 — Watch and resolve, until approved

A single loop. Any of these is a trigger; each **wakes a seat with the effort's
original context plus the trigger payload**:

```
# resolvedReviewPolicy comes from the profile. An EMPTY required set is
# satisfied immediately — it must never mean "wait forever".
reviewsSatisfied := resolvedReviewPolicy.requiredApprovers
                      .every(approver => approver resolved on the CURRENT head)

loop until reviewsSatisfied:
    on merge conflict      -> rebase; on genuine ambiguity wake a seat, never
                              blind-resolve ours/theirs
    on red CI              -> wake seat: diagnose and fix, push
    on new CLAUDE comment  -> classify
    on new HUMAN comment   -> classify

    classify(comment):
        FIX_NOW    -> seat fixes, pushes, replies on the thread
        NOT_VALID  -> reply explaining why, and tell the captain
        DECISION   -> escalate to the captain's queue (product/design call, or
                      "you should argue back on this"); do NOT block other work
```

Invariants:
- Rebase runs throughout, whenever conflicts appear — not only at the start.
- Zero observed checks is never terminal success, and never an infinite wait:
  distinguish "no CI configured" from "CI has not reported yet" and act.
- A bot review never counts as human approval. An agent-assisted review posted
  from a human's account does.

## Step 5 — Reach merge authorization, then merge when actually safe

Authorization and merging are separate. On a `stamp` profile the stamp is
**merge AUTHORIZATION, not a merge trigger** — it may arrive before CI is green.
Merging on the stamp alone would merge red or pending CI.

```
authorized := reviewsSatisfied && (!profile.stamp || validStampForCurrentHead)

loop until authorized:
    keep rebasing on conflicts
    keep watching CI
    surface state

loop until (CI green on the CURRENT head AND mergeable AND no conflicts):
    keep rebasing on conflicts
    keep fixing red CI          # step 4's triggers stay live
    if a rebase moved the head: revalidate approvals and CI against the new head

merge
```

Invariants:
- Agents never approve, never stamp, and never merge outside this gate.
- **On a `stamp` profile the stamp MAY precede CI green.** Do not gate the stamp
  on CI.
- **Never gate the MERGE on authorization alone.** Merge requires authorized AND
  green CI on the current head AND mergeable.
- Any rebase invalidates CI and approval evidence for the old head; revalidate
  both against the new head before merging.
- On a `yolo` profile there is no stamp; authorization is the resolved bot
  review. The merge conditions are otherwise identical.
- Rebase and CI watch continue throughout; the PR must not go stale.

---

## Cross-cutting invariants

1. **Enterable at any step.** Adoption binds an existing PR and resumes.
2. **Derived, never self-reported.** Commit sets come from git, not from a seat's
   claim.
3. **Agents fix; the captain decides.** No agent approves, stamps, or merges.
4. **Rebase is continuous and clean.** No `.orig`/`.rej`, no committed conflict
   markers, no leftover rebase state, no blind side-taking.
5. **No silent waits.** Every loop has a stated terminal condition and an
   escalation path.
6. **Raw `gh`.** No Graphite. `gh-stack`, `gh pr`, `gh merge`.
