# pr-pipeline: locked specification

The captain's stated contract, 2026-08-06. This is the authority. Where code and
this document disagree, the code is wrong.

The pipeline is **enterable at any step**. An effort may start from a brief at
step 1, or adopt an existing PR branch in place and resume from step 3, 4, or 5.
Adoption is not a special mode; it is the same graph entered later.

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
loop until (human approved AND claude approved):
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

## Step 5 — Await the captain's stamp

```
loop until stamped:
    keep rebasing on conflicts
    keep watching CI
    surface state
on stamp: merge
```

Invariants:
- The stamp is the captain's, always. Agents never approve and never merge
  without it.
- **The stamp becomes available after human + Claude approval, and MAY precede
  CI green.** Do not gate the stamp on CI.
- Rebase and CI watch continue while waiting; the PR must not go stale.

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
