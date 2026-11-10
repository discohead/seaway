"""Prepared statements for bash.

A command is a template with named parameters. A parameter is either a *value*
(quoted so it can never be interpreted by the shell) or a *path* in the context
(which also tells the planner what the command reads and writes).

Only ``{name}`` tokens whose name was passed as a parameter are substituted, so
ordinary shell braces — ``awk '{print $1}'``, ``${HOME}``, ``{a,b}`` — pass
through untouched.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

from .errors import Issue, ValidationError

_PLACEHOLDER = re.compile(r"(?<![$\\])\{([A-Za-z_][A-Za-z0-9_]*)\}")
_WILDCARD = re.compile(r"[*?\[]")


def norm(path: str) -> str:
    """Normalise a context path: no leading slash, no empty, ``.`` or ``..`` segments."""
    parts = [p for p in str(path).replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValidationError(
            "paths may not contain '..'", path=str(path), code="bad_path",
            suggestion="address files from the top of the context: <mount>/<path>",
        )
    return "/".join(parts)


def split_mount(path: str) -> tuple[str, str]:
    p = norm(path)
    mount, _, rel = p.partition("/")
    return mount, rel


def parent(rel: str) -> str:
    return rel.rpartition("/")[0]


def common_dir(rels: Iterable[str]) -> str:
    """Deepest directory that contains every given relative path."""
    split = [r.split("/") if r else [] for r in rels]
    if not split:
        return ""
    out: list[str] = []
    for column in zip(*split):
        if all(seg == column[0] for seg in column):
            out.append(column[0])
        else:
            break
    return "/".join(out)


@dataclass(frozen=True)
class Ref:
    """A path in the context. ``write=True`` declares that the command changes it."""

    mount: str
    rel: str = ""
    write: bool = False

    @property
    def path(self) -> str:
        return f"{self.mount}/{self.rel}" if self.rel else self.mount

    def __truediv__(self, other: str) -> "Ref":
        return Ref(self.mount, norm(f"{self.rel}/{other}"), self.write)

    def __str__(self) -> str:
        return self.path


@dataclass(frozen=True)
class Glob:
    """Files in the context matching a pattern. ``**`` crosses directories, ``*`` does not."""

    mount: str
    pattern: str

    @property
    def path(self) -> str:
        return f"{self.mount}/{self.pattern}"

    def static_prefix(self) -> str:
        """The directory part before the first wildcard: where listing can start."""
        head: list[str] = []
        for seg in self.pattern.split("/"):
            if _WILDCARD.search(seg):
                break
            head.append(seg)
        else:
            head = head[:-1]  # no wildcard at all: the last segment is a file name
        return "/".join(head)

    def regex(self) -> re.Pattern:
        out, i, p = [], 0, self.pattern
        while i < len(p):
            if p.startswith("**/", i):
                out.append("(?:.*/)?")
                i += 3
            elif p.startswith("**", i):
                out.append(".*")
                i += 2
            elif p[i] == "*":
                out.append("[^/]*")
                i += 1
            elif p[i] == "?":
                out.append("[^/]")
                i += 1
            else:
                out.append(re.escape(p[i]))
                i += 1
        return re.compile("^" + "".join(out) + "$")

    def __str__(self) -> str:
        return self.path


@dataclass(frozen=True)
class Raw:
    """Text inserted into a command exactly as written. Use only for trusted fragments."""

    text: str


def raw(text: str) -> Raw:
    """Text inserted into a command exactly as written. Use only for trusted fragments."""
    return Raw(text)


@dataclass(frozen=True)
class FileStat:
    path: str  # context path: <mount>/<rel>
    size: int
    modified: float = 0.0
    version: str = ""  # changes when the content changes


def quote(value: Any) -> str:
    """One shell word, whatever the value contains. ``None`` is the empty string."""
    if value is None:
        return "''"
    if isinstance(value, bool):
        return "true" if value else "false"
    return shlex.quote(str(value))


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def placeholders(template: str) -> list[str]:
    return [m.group(1) for m in _PLACEHOLDER.finditer(template)]


def check_params(template: str, params: dict[str, Any]) -> None:
    """A parameter that never appears in the template is almost always a typo. Say so before running."""
    used = set(placeholders(template))
    unused = [name for name in params if name not in used]
    if unused:
        raise ValidationError(
            [
                Issue(
                    "unused_parameter",
                    f"parameter '{name}' does not appear in the command as {{{name}}}",
                    suggestion=f"placeholders found: {sorted(used) or 'none'}",
                )
                for name in unused
            ]
        )


def render(template: str, params: dict[str, Any], render_param: Callable[[str, Any], Optional[str]]) -> str:
    """Substitute every ``{name}`` that names a parameter. Everything else is left alone."""

    def sub(match: re.Match) -> str:
        name = match.group(1)
        if name not in params:
            return match.group(0)
        text = render_param(name, params[name])
        return match.group(0) if text is None else text

    return _PLACEHOLDER.sub(sub, template)
