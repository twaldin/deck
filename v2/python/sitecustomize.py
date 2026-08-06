"""Make the kernel's subprocess text mode survive real-world tool output.

Python decodes `subprocess.run(..., text=True)` output as strict UTF-8. Any byte
that is not valid UTF-8 - a Windows-1252 smart quote (0x91) in a vendored file,
a latin-1 name in a build log, a binary blob caught by a repo-wide grep - raises
UnicodeDecodeError from deep inside `subprocess`, killing the call.

That is not hypothetical: four pipeline runs died this way in one batch, all on a
seat's own `subprocess.run(["rg", ...])` over a repo containing one such byte.
The seat wrote correct-looking code; the default is the trap.

Fixing this in a prompt would mean asking every seat to remember `errors=` on
every call forever. The kernel is the right place: when a caller asks for text
and expresses no opinion about decode errors, replace them instead of raising.
An explicit `errors=` always wins, and byte mode is untouched.

This file is imported automatically by `site` because the profile puts its
directory on PYTHONPATH.
"""

from __future__ import annotations

import subprocess

_original_init = subprocess.Popen.__init__


def _tolerant_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
    wants_text = kwargs.get("text") or kwargs.get("universal_newlines") or kwargs.get("encoding")
    if wants_text and kwargs.get("errors") is None:
        kwargs["errors"] = "replace"
    return _original_init(self, *args, **kwargs)


# Idempotent: re-importing must not stack wrappers.
if getattr(subprocess.Popen.__init__, "__deck_tolerant__", False) is not True:
    _tolerant_init.__deck_tolerant__ = True  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = _tolerant_init  # type: ignore[method-assign]
