"""Deck's agent-facing surface, as code.

Prime's contract is that the only tool is code execution. Deck used to register
nine pi-tools (`ship`, `adopt`, `status`, `recall_effort`, `ask_captain`,
`list_questions`, `answer_question`, `process`); every one of them is now a
function here. Nothing in this module reimplements durable semantics - each call
shells out to the `deck-v2` CLI, which is the same code path the interactive
`/questions` command and the pipeline use. One implementation, one source of
truth.

If you are an agent reading this: call `help()` to see the surface.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

__all__ = [
    "DeckError",
    "ask",
    "questions",
    "answer",
    "recall",
    "ship",
    "adopt",
    "runs",
    "why",
    "wake",
    "fleet",
    "procs",
    "effort_status",
    "send",
    "session_id",
    "help",
]

class DeckError(RuntimeError):
    """A deck-v2 invocation failed. Carries the CLI's stderr verbatim."""


def _cli() -> str:
    explicit = os.environ.get("DECK_CLI")
    if explicit:
        return explicit
    found = shutil.which("deck-v2")
    if found is None:
        raise DeckError(
            "deck-v2 is not on PATH; set DECK_CLI to the binary path. "
            "Without it no durable Deck operation can run."
        )
    return found


def _run(args: list[str], *, parse: bool = True) -> Any:
    completed = subprocess.run(
        [_cli(), *args],
        capture_output=True,
        text=True,
        # Tool output is not guaranteed UTF-8. A single smart quote in a build
        # log is byte 0x91 and raises UnicodeDecodeError from inside subprocess,
        # taking down the whole call - observed doing exactly that to four
        # pipeline runs. An encoding accident must never look like a Deck failure.
        errors="replace",
        timeout=120,
    )
    if completed.returncode != 0:
        raise DeckError(
            (completed.stderr or completed.stdout or "").strip()
            or f"deck-v2 {' '.join(args)} exited {completed.returncode}"
        )
    out = completed.stdout.strip()
    if not parse:
        return out
    if out == "":
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # A human-formatted command; hand back the text rather than lying about
        # having structured data.
        return out


def session_id() -> str:
    """This conversation's session id.

    Question ids are scoped to the asking session, and the captain's answer is
    routed back by it. Prime exposes the id to the kernel only as the basename
    of RLM_SESSION_DIR, so this fails loudly rather than guessing: a wrong id
    silently delivers your answer to a different agent.
    """
    artifacts = os.environ.get("RLM_SESSION_DIR")
    if not artifacts:
        raise DeckError(
            "RLM_SESSION_DIR is unset, so the session id is unknown and an "
            "answer could not be routed back to this session."
        )
    return os.path.basename(artifacts.rstrip("/"))


def ask(
    question: str,
    *,
    id: str | None = None,
    context: str | None = None,
    options: list[str] | None = None,
    recommendation: str | None = None,
    urgency: str | None = None,
) -> dict:
    """Queue a decision for the captain. Returns immediately - never block on it.

    Keep working on anything that does not depend on the answer; it is delivered
    back into this session when the captain answers with /questions.
    """
    args = ["questions", "ask", "--question", question, "--session", session_id()]
    if id is not None:
        args += ["--id", id]
    if context is not None:
        args += ["--context", context]
    if options:
        args += ["--option", ";".join(options)]
    if recommendation is not None:
        args += ["--recommendation", recommendation]
    if urgency is not None:
        args += ["--urgency", urgency]
    return _run(args)


def questions() -> list[dict]:
    """Open questions in the durable queue."""
    result = _run(["questions", "list", "--json"])
    return [] if result is None else result.get("questions", [])


def answer(id: str, text: str, *, dismiss: bool = False) -> dict:
    """Answer a plain question.

    Workflow approvals are the captain's alone and are refused here; they are
    resolved through the interactive /questions command.
    """
    args = ["questions", "answer", "--id", id, "--answer", text]
    if dismiss:
        args.append("--dismiss")
    return _run(args)


def recall(reference: str) -> dict:
    """Hydrate an effort from its durable dossier.

    Accepts a task id, `owner/repo#PR`, or a PR URL. Call this before resuming
    an effort instead of reconstructing it from memory.
    """
    return _run(["recall", reference])


def ship(
    ticket: str,
    *,
    profile: str,
    worktree: str,
    branch: str,
    title: str,
    summary: str,
    acceptance: list[str],
    base: str | None = None,
    reviewers: list[str] | None = None,
    run_id: str | None = None,
    dry_run: bool = False,
    existing_pr: int | None = None,
    models: dict[str, str] | None = None,
) -> str:
    """Start the detached pr-pipeline for a validated effort brief.

    The pipeline owns review, PR creation, CI, approval and merge. This returns
    as soon as the run is started; it does not wait, and neither should you.

    `models` assigns seats for THIS run - `{"reviewer": "claude-fable-5"}` -
    overriding the profile defaults. Choosing which canonical model runs which
    node is the orchestrator's call; off-catalog ids are rejected at ship time.
    """
    args = [
        "ship",
        ticket,
        "--profile",
        profile,
        "--worktree",
        worktree,
        "--branch",
        branch,
        "--title",
        title,
        "--summary",
        summary,
        "--accept",
        ";".join(acceptance),
    ]
    if base is not None:
        args += ["--base", base]
    if reviewers:
        args += ["--reviewers", ",".join(reviewers)]
    if run_id is not None:
        args += ["--run-id", run_id]
    if dry_run:
        args.append("--dry-run")
    if existing_pr is not None:
        args += ["--existing-pr", str(existing_pr)]
    if models:
        args += ["--models", ",".join(f"{slot}={model}" for slot, model in models.items())]
    return _run(args, parse=False)


def adopt(existing_pr: int, **kwargs: Any) -> str:
    """Adopt an already-open PR into the same pipeline.

    Never opens a second PR, and still runs the review and landing gates.
    """
    return ship(existing_pr=existing_pr, **kwargs)


def _smithers(args: list[str]) -> Any:
    # Deliberately routed through deck-v2, NOT a bare `bunx smithers-orchestrator`.
    # Smithers resolves its run database from the working directory, and the
    # kernel's cwd is wherever the agent happens to be, so a direct call reads
    # the wrong runs or none. The CLI pins the canonical workspace.
    return _run(args)


def runs(run_id: str | None = None) -> Any:
    """Read Smithers' durable run state. Never resumes, retries or approves."""
    return _smithers(["runs"] if run_id is None else ["runs", run_id])


def why(run_id: str) -> Any:
    """Why a run is where it is - the node-level explanation."""
    return _smithers(["why", run_id])


def wake() -> Any:
    """One reconcile pass over the fleet."""
    return _run(["wake", "--json"])


def fleet() -> Any:
    """The current fleet frame: what the factory is actually running."""
    return _run(["fleet", "--json"])


# The retired `process` tool let a seat poll. Seats must not poll: waiting is a
# workflow state, owned by the durable engine that survives a seat's death.
# `procs` is inspection only.
procs = fleet


def effort_status(task_id: str) -> Any:
    """One effort's events and current reconciliation."""
    return _run(["status", task_id, "--json"])


def send(task_id: str, message: str) -> str:
    """Queue a message for that task's next run."""
    return _run(["send", task_id, message], parse=False)


def help() -> str:  # noqa: A001 - deliberately shadows builtins in the agent namespace
    """The capability list. Every former pi-tool is one of these calls."""
    return """deck - the whole agent surface, as code (no pi-tools).

  deck.ask(question, options=[...])   queue a decision for the captain (never blocks)
  deck.questions()                    open questions
  deck.answer(id, text)               answer a plain question (not workflow approvals)
  deck.recall(ref)                    hydrate an effort: task id, owner/repo#PR, or PR URL
  deck.ship(ticket, ..., models={...})  start the pr-pipeline; models= assigns seats
  deck.adopt(existing_pr, ...)        adopt an open PR into the same pipeline
  deck.runs([run_id])                 durable Smithers run state (read-only)
  deck.why(run_id)                    why a run is where it is
  deck.wake()                         one reconcile pass
  deck.fleet() / deck.procs()         what the factory is running now
  deck.effort_status(task_id)         one effort's events
  deck.send(task_id, message)         queue a message for its next run

Retired tools map here: ship->deck.ship, adopt->deck.adopt, status->deck.runs,
recall_effort->deck.recall, ask_captain->deck.ask, list_questions->deck.questions,
answer_question->deck.answer, process->deck.procs, spawn->rlm().

Never poll. If you are waiting on CI, a review, or the captain, end your turn -
the durable workflow wakes you. Bounded fan-out inside one turn is rlm()."""
