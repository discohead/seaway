"""A context as tools for a model.

The set is small on purpose, and uses the names Archil's own agent tools use,
so a model that has seen one has seen the other. Two additions: ``sql`` for
questions that are easier asked as a query, and ``plan``, which prices a
command and shows what it would be allowed to touch without running it.

A tool never raises. It returns the error as text, with the suggestion, so the
model can correct itself on the next step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .errors import Error

MAX_TOOL_OUTPUT = 12_000


def _clip(text: str, limit: int = MAX_TOOL_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… {len(text) - limit} more characters. Narrow the request, or write the output to a file and read part of it."


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[..., str]

    def __call__(self, **args) -> str:
        try:
            return _clip(self.handler(**args))
        except Error as exc:
            return f"error: {exc}"
        except TypeError as exc:
            return f"error: bad arguments for {self.name}: {exc}"
        except Exception as exc:  # the backend's own client: a refused request, a dropped connection
            return f"error: {type(exc).__name__}: {exc}"

    def to_openai(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description,
                                                 "parameters": self.parameters}}

    def to_anthropic(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.parameters}


def _schema(required: list[str], **props: dict) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


_STR = {"type": "string"}
_BOOL = {"type": "boolean"}


def build_tools(ctx, names: Optional[list[str]] = None) -> list[Tool]:
    def read_file(path: str) -> str:
        return ctx.read_text(path)

    def write_file(path: str, content: str) -> str:
        return f"wrote {ctx.write(path, content)} ({len(content.encode())} bytes)"

    def delete_file(path: str) -> str:
        ctx.rm(path)
        return f"deleted {path}"

    def list_files(path: str = "", recursive: bool = False) -> str:
        entries = ctx.ls(path, recursive=recursive)
        return "\n".join(f.path if f.path.endswith("/") else f"{f.path}\t{f.size}" for f in entries) or "(empty)"

    def grep(pattern: str, path: str = "", ignore_case: bool = False) -> str:
        result = ctx.grep(pattern, path or None, ignore_case=ignore_case).run()
        note = "" if result.value["exhaustive"] else f"\n(stopped early: {result.value['stopped_reason']}; results are a sample)"
        return (result.stdout or "(no matches)") + note

    def run_bash(command: str) -> str:
        result = ctx.sh(command).run()
        out = result.stdout + (f"\n[stderr]\n{result.stderr}" if result.stderr.strip() else "")
        return f"exit {result.exit_code}\n{out}" + ("\n(output was cut: only its first bytes are here)" if result.truncated else "")

    def sql(query: str) -> str:
        result = ctx.sql(query).run()
        return result.stdout if result.ok else f"exit {result.exit_code}\n{result.stderr}"

    def plan(command: str) -> str:
        return str(ctx.sh(command).explain())

    paths = "Paths are <mount>/<path>; mounts: " + ", ".join(f"{m.name} ({m.mode})" for m in ctx.mounts.values()) + "."
    tools = [
        Tool("read_file", f"Read a file. {paths}", _schema(["path"], path=_STR), read_file),
        Tool("write_file", "Create or replace a file on a writable mount.",
             _schema(["path", "content"], path=_STR, content=_STR), write_file),
        Tool("delete_file", "Delete a file on a writable mount.", _schema(["path"], path=_STR), delete_file),
        Tool("list_files", "List a directory. Directories end in '/'. Leave path empty to list the mounts.",
             _schema([], path=_STR, recursive=_BOOL), list_files),
        Tool("grep", "Regex search across files, run next to the data. One call however many files.",
             _schema(["pattern"], pattern=_STR, path=_STR, ignore_case=_BOOL), grep),
        Tool("run_bash", "Run a bash command in a fresh VM with the context mounted at the working directory. "
             "Only files on the mounts persist between calls.", _schema(["command"], command=_STR), run_bash),
        Tool("sql", "Run a DuckDB SQL query over files in the context, e.g. "
             "select count(*) from read_json_auto('logs/api/**/*.ndjson').", _schema(["query"], query=_STR), sql),
        Tool("plan", "Show what a bash command would mount and cost, without running it.",
             _schema(["command"], command=_STR), plan),
    ]
    if names is not None:
        return [t for t in tools if t.name in names]
    if not any(m.writable for m in ctx.mounts.values()):
        # a context that can write nothing does not hand a model tools that could only fail
        tools = [t for t in tools if t.name not in ("write_file", "delete_file")]
    return tools


__all__ = ["Tool", "build_tools"]
