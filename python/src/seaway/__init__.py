"""The programmable Archil: define the context an agent needs, then run statements against it.

    import seaway as archil

    ctx = archil.context({
        "logs": archil.disk("app-logs", "append"),
        "obs":  archil.disk("obs-agent", "owned"),
    })

    q = ctx.sql("select level, count(*) as n from {events} group by 1",
                events=ctx.log("logs/api").last("15m"))
    print(q.explain())     # what it mounts, how many calls, what it costs
    rows = q.run().rows    # runs next to the data; only the rows come back

This is a prototype of a proposal, packaged under its own name so it installs
beside the official ``archil`` SDK, which it uses to reach Archil.
"""

from .backends import Backend, ExecOutput, GrepHit, Limits, MountSpec, ObjectInfo, Vm
from .context import MODES, Context, Mount, Source, context, disk
from .errors import (
    BudgetExceeded,
    Busy,
    Conflict,
    Error,
    ExecFailed,
    Issue,
    NotSupported,
    ValidationError,
)
from .local import LocalBackend
from .plan import Plan, Task
from .pricing import Budget, Estimate, Ledger, PriceSheet
from .recipes import Entry, Recipe, Records, Static, duckdb, git, sync
from .shell import FileStat, Glob, Raw, Ref, raw
from .statement import REDUCERS, Meta, Result, Statement
from .structures import Changes, Feed, Log, Selection, View
from .tools import Tool
from .transaction import Commit, Transaction

__version__ = "0.1.0"


def __getattr__(name: str):
    if name == "ArchilBackend":  # imported lazily so the official SDK is only needed when it is used
        from .archil_backend import ArchilBackend

        return ArchilBackend
    raise AttributeError(name)


def from_manifest(manifest, **kw) -> Context:
    """Open a context from a manifest (a dict, a JSON string, or a path to a file)."""
    return Context.from_manifest(manifest, **kw)


__all__ = [
    "context", "disk", "from_manifest", "Context", "Mount", "Source", "MODES",
    "Statement", "Result", "Meta", "Plan", "Task", "REDUCERS",
    "Transaction", "Commit", "Log", "Selection", "View", "Feed", "Changes",
    "Recipe", "Entry", "Static", "Records", "sync", "git", "duckdb",
    "PriceSheet", "Budget", "Estimate", "Ledger",
    "Backend", "LocalBackend", "ArchilBackend", "MountSpec", "Vm", "Limits", "ExecOutput", "ObjectInfo", "GrepHit",
    "Ref", "Glob", "Raw", "raw", "FileStat", "Tool",
    "Error", "ValidationError", "BudgetExceeded", "Busy", "Conflict", "NotSupported", "ExecFailed", "Issue",
]
