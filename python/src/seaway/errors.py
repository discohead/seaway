"""Errors an agent can act on.

Every error carries a stable ``code``, a plain-language ``message``, the
``path`` it concerns when there is one, and a ``suggestion`` that says what to
do next. Validation runs before anything is sent to Archil, and reports every
problem it finds at once so a caller can fix them in a single turn.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    path: Optional[str] = None
    suggestion: Optional[str] = None

    def __str__(self) -> str:
        where = f" [{self.path}]" if self.path else ""
        hint = f" — {self.suggestion}" if self.suggestion else ""
        return f"{self.code}{where}: {self.message}{hint}"


class Error(Exception):
    """Base class. ``str(error)`` is safe to show to a model."""

    code = "error"

    def __init__(
        self,
        message: str,
        *,
        path: Optional[str] = None,
        suggestion: Optional[str] = None,
        code: Optional[str] = None,
    ) -> None:
        self.message = message
        self.path = path
        self.suggestion = suggestion
        if code:
            self.code = code
        super().__init__(str(Issue(self.code, message, path, suggestion)))

    def to_dict(self) -> dict:
        return asdict(Issue(self.code, self.message, self.path, self.suggestion))


class ValidationError(Error):
    """The request is wrong and nothing ran. ``issues`` lists every problem."""

    code = "invalid"

    def __init__(self, issues: Sequence[Issue] | str, **kw) -> None:
        if isinstance(issues, str):
            issues = [Issue(kw.pop("code", self.code), issues, kw.get("path"), kw.get("suggestion"))]
        self.issues = list(issues)
        first = self.issues[0]
        Error.__init__(self, first.message, path=first.path, suggestion=first.suggestion, code=first.code)
        if len(self.issues) > 1:
            self.args = ("\n".join(str(i) for i in self.issues),)

    def to_dict(self) -> dict:
        return {"code": self.code, "issues": [asdict(i) for i in self.issues]}


class BudgetExceeded(Error):
    """The plan costs more than the budget allows. Nothing ran."""

    code = "budget_exceeded"


class Conflict(Error):
    """A transaction could not commit because someone else changed the same paths."""

    code = "conflict"

    def __init__(self, paths: Sequence[str], message: Optional[str] = None) -> None:
        self.paths = list(paths)
        shown = ", ".join(self.paths[:5]) + (" …" if len(self.paths) > 5 else "")
        super().__init__(
            message or f"{len(self.paths)} path(s) changed since this transaction began: {shown}",
            path=self.paths[0] if self.paths else None,
            suggestion="re-run the turn on a fresh transaction; nothing was applied",
        )


class Busy(Error):
    """Another client holds a checkout that covers this path, so it cannot be written right now.

    On Archil a statement that writes an ``owned`` mount holds the mount's checkout while it runs.
    Until it finishes, direct writes to that disk (``write``, ``append``, ``rm``) are refused.
    """

    code = "busy"


class NotSupported(Error):
    """The backend cannot do this (yet). The message says what is missing."""

    code = "not_supported"


class ExecFailed(Error):
    """A command exited non-zero and the caller asked for that to raise."""

    code = "exec_failed"

    def __init__(self, exit_code: int, stderr: str, command: str) -> None:
        self.exit_code = exit_code
        self.stderr = stderr
        tail = stderr.strip().splitlines()[-1] if stderr.strip() else "no stderr"
        super().__init__(f"exit {exit_code}: {tail}", suggestion="read result.stderr for the full output")
        self.command = command
