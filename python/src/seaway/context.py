"""Context: a value that says what data an agent has, and under what rules.

A context composes several disks into one tree. Each mount names a disk and a
*mode*, which is the mutation strategy for that part of the tree:

========  ====================================================================
mode      meaning, and how it is enforced on Archil
========  ====================================================================
read      Live data, read-only. Mounted ``readOnly``.
frozen    Read-only and pinned to a checkpoint, so every run sees the same bytes.
          Backed by a branch of that checkpoint, mounted ``readOnly``.
owned     This context is the only writer. Calls take a checkout, so writes run
          at local-disk speed and a second writer waits its turn (for a few
          seconds, then it is refused). It is never overwritten.
shared    Many writers. Mounted ``conditional``: no checkout, last write to
          reach the disk wins, so each writer should keep to its own paths.
append    Records are only ever added (logs, journals, histories). Appends go
          through the server-side append; commands see the data read-only.
========  ====================================================================

A context is a plain value: it serialises to a manifest, can be narrowed to a
subset of itself before it is handed to a sub-agent, and can be locked to a set
of checkpoints so a run is reproducible.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable, Optional, Union

from .backends import Backend, MountSpec, Vm, egress_policy
from .errors import Issue, NotSupported, ValidationError
from .pricing import Budget, Estimate, Ledger, PriceSheet, estimate, fmt_bytes
from .shell import FileStat, Glob, Ref, common_dir, norm, split_mount

MODES = ("read", "frozen", "owned", "shared", "append")
META = ".px"  # the framework's own bookkeeping on a disk (Archil reserves ".archil")
PROVISIONAL = "~"  # ends a recorded version that was too new to trust: it never equals a later one
CLOCK_SLACK_S = 0.5  # how far the caller's clock may differ from the backend's and versions still be read safely


@dataclass(frozen=True)
class Source:
    """One disk, as a context wants to see it."""

    disk: str
    mode: str = "read"
    subdirectory: str = ""
    at: Optional[str] = None
    create: bool = False
    description: str = ""

    def to_dict(self) -> dict:
        d: dict = {"disk": self.disk, "mode": self.mode}
        if self.subdirectory:
            d["subdirectory"] = self.subdirectory
        if self.at:
            d["at"] = self.at
        if self.description:
            d["description"] = self.description
        return d


def disk(
    ref: str,
    mode: str = "read",
    *,
    subdirectory: str = "",
    at: Optional[str] = None,
    create: bool = False,
    description: str = "",
) -> Source:
    """Describe a disk to mount: by name or id, with a mode. Nothing is contacted yet."""
    if mode not in MODES:
        raise ValidationError(
            f"unknown mode '{mode}'", code="bad_mode", suggestion=f"use one of: {', '.join(MODES)}"
        )
    if mode == "frozen" and not at:
        raise ValidationError(
            "a frozen mount needs at=<checkpoint>", code="bad_mode",
            suggestion="take one with ctx.lock(name), which returns a manifest with every mount frozen",
        )
    return Source(ref, mode, norm(subdirectory), at, create, description)


@dataclass(frozen=True)
class Mount:
    name: str
    source: Source
    handle: str  # the backend's handle for the disk (a branch handle when frozen or forked)
    allow: str = ""  # narrowed to this sub-tree; "" means the whole mount
    read_only: bool = False  # forced read-only by narrow()

    @property
    def mode(self) -> str:
        return "read" if self.read_only and self.source.mode not in ("read", "frozen") else self.source.mode

    @property
    def writable(self) -> bool:
        return self.mode in ("owned", "shared")

    @property
    def appendable(self) -> bool:
        return self.mode in ("owned", "shared", "append")

    def key(self, rel: str) -> str:
        """Path within the mount -> key on the disk."""
        return "/".join(p for p in (self.source.subdirectory, rel) if p)

    def rel(self, key: str) -> str:
        base = self.source.subdirectory
        return key[len(base) + 1 :] if base and key.startswith(base + "/") else key

    def within(self, rel: str) -> bool:
        return not self.allow or rel == self.allow or rel.startswith(self.allow + "/")

    def spec(self, limits, *, write: bool, sub: str = "") -> tuple[str, MountSpec]:
        """The (in-VM path, mount spec) for a call. ``sub`` narrows a read-only mount further."""
        sub = sub if (sub and self.within(sub)) else self.allow
        vm_key = f"{self.name}/{sub}" if sub else self.name
        subdirectory = self.key(sub) or None
        if not write or not self.writable:
            return vm_key, MountSpec(self.handle, subdirectory, read_only=True)
        if self.mode == "shared":
            return vm_key, MountSpec(self.handle, subdirectory, conditional=True)
        return vm_key, MountSpec(self.handle, subdirectory, queue_ms=limits.checkout_queue_ms)


def default_backend() -> Backend:
    choice = os.environ.get("ARCHIL_BACKEND", "").lower()
    if choice != "local" and os.environ.get("ARCHIL_API_KEY"):
        from .archil_backend import ArchilBackend

        return ArchilBackend()
    from .local import LocalBackend

    return LocalBackend(root=Path(os.environ.get("ARCHIL_LOCAL_ROOT", ".archil-local")))


class Context:
    def __init__(
        self,
        mounts: dict[str, Union[Source, str]],
        *,
        backend: Optional[Backend] = None,
        name: str = "context",
        prices: Optional[PriceSheet] = None,
        budget: Optional[Budget] = None,
        journal: Optional[str] = None,
        tools: Optional[dict[str, str]] = None,
        egress: Any = None,
        _resolved: Optional[dict[str, Mount]] = None,
        _ledger: Optional[Ledger] = None,
        _budget_from: Optional[Estimate] = None,
    ) -> None:
        self.backend = backend or default_backend()
        self.name = name
        self.prices = prices or PriceSheet()
        self.budget = budget
        self.tools_map = dict(tools or {})
        # What a statement's VM may reach on the network: None (open, Archil's default), () for
        # nothing, or the hosts it may reach. A statement can set its own with .egress().
        self.egress = egress if isinstance(egress, tuple) else egress_policy(egress)
        self._journal_backlog: list[dict] = []  # entries the journal could not take yet
        self.spend = _ledger or Ledger(self.prices)
        self._budget_from = _budget_from or Estimate()  # what had been spent when the budget was set
        self.session = uuid.uuid4().hex[:8]
        self.journal = norm(journal) if journal else None
        self._journal_log = None
        if _resolved is not None:
            self.mounts = _resolved
            return
        if not mounts:
            raise ValidationError("a context needs at least one mount", code="empty_context")
        self.mounts: dict[str, Mount] = {}
        for raw_name, source in mounts.items():
            mount_name = norm(raw_name)
            if not mount_name or "/" in mount_name or mount_name == META:
                raise ValidationError(f"bad mount name '{raw_name}'", code="bad_mount",
                                      suggestion="mount names are single path segments, like 'logs'")
            if isinstance(source, str):
                source = disk(source)
            handle = self.backend.resolve_disk(source.disk, create=source.create)
            if source.mode == "frozen":
                handle = self.backend.branch(handle, f"frozen-{source.at}", source.at, exist_ok=True)
            self.mounts[mount_name] = Mount(mount_name, source, handle)

    # -- composition -------------------------------------------------------
    def _derive(self, mounts: dict[str, Mount], **over: Any) -> "Context":
        return Context(
            {}, backend=self.backend, name=over.get("name", self.name), prices=self.prices,
            budget=over.get("budget", self.budget), journal=self.journal, tools=self.tools_map,
            egress=over.get("egress", self.egress),
            _resolved=mounts, _ledger=self.spend, _budget_from=over.get("budget_from", self._budget_from),
        )

    def mount(self, name: str, source: Union[Source, str]) -> "Context":
        """A new context with one more mount (or one replaced)."""
        extra = Context({name: source}, backend=self.backend).mounts
        return self._derive({**self.mounts, **extra})

    def narrow(self, *paths: str, read_only: bool = False) -> "Context":
        """A context that can reach only the given sub-trees, under the same path names.

        Narrowing can only take access away. Use it before handing a context to a
        sub-agent or a tool call that should see less than you do.
        """
        if not paths:
            mounts = {n: replace(m, read_only=m.read_only or read_only) for n, m in self.mounts.items()}
            return self._derive(mounts)
        by_mount: dict[str, list[str]] = {}
        for p in paths:
            m, rel = self._resolve(p)
            by_mount.setdefault(m.name, []).append(rel)
        mounts = {}
        for mount_name, rels in by_mount.items():
            m = self.mounts[mount_name]
            mounts[mount_name] = replace(m, allow=common_dir(rels), read_only=m.read_only or read_only)
        return self._derive(mounts)

    def with_budget(self, budget: Optional[Budget] = None, **limits: Any) -> "Context":
        """The same context under a ceiling: a ``Budget``, or its limits as keywords (``max_usd=0.05``).
        The budget counts what is spent from now on, so a helper handed a budgeted context is not
        charged for what its parent already did. ``with_budget(None)`` removes the ceiling."""
        if budget is None and limits:
            budget = Budget(**limits)
        return self._derive(self.mounts, budget=budget, budget_from=self.spend.snapshot())

    def with_egress(self, egress: Any) -> "Context":
        """The same context with a network policy for everything it runs: ``"deny"`` (nothing
        leaves), a list of hosts (only those), or ``"allow"`` (open, which is Archil's default).

        A mount map limits what a command can read. This limits where what it read can go. Hand a
        model the tools of ``ctx.with_egress("deny")`` unless its commands need the network.
        """
        return self._derive(self.mounts, egress=egress_policy(egress))

    def spent_under_budget(self) -> Estimate:
        return self.spend.snapshot().since(self._budget_from)

    # -- paths -------------------------------------------------------------
    def _resolve(self, path: Union[str, Ref], *, write: bool = False, append: bool = False) -> tuple[Mount, str]:
        if isinstance(path, Ref):
            mount_name, rel = path.mount, path.rel
        else:
            mount_name, rel = split_mount(path)
        m = self.mounts.get(mount_name)
        if m is None:
            raise ValidationError(
                f"no mount named '{mount_name}'", code="unknown_mount", path=str(path),
                suggestion="paths start with a mount name: " + ", ".join(f"{n}/…" for n in self.mounts),
            )
        if not m.within(rel):
            raise ValidationError(
                f"outside this context: it is narrowed to {m.name}/{m.allow}", code="out_of_scope", path=str(path),
                suggestion="ask the owner of the wider context for this path",
            )
        if write and not m.writable:
            hint = "use append() or log() for an append-only mount" if m.mode == "append" else \
                "mount the disk as 'owned' or 'shared' to write to it"
            raise ValidationError(f"'{m.name}' is {m.mode}; it cannot be written", code="read_only",
                                  path=str(path), suggestion=hint)
        if append and not m.appendable:
            raise ValidationError(f"'{m.name}' is {m.mode}; it cannot be appended to", code="read_only",
                                  path=str(path), suggestion="mount the disk as 'append', 'owned' or 'shared'")
        return m, rel

    def path(self, path: str) -> Ref:
        """A path the command reads."""
        m, rel = self._resolve(path)
        return Ref(m.name, rel)

    def out(self, path: str) -> Ref:
        """A path the command writes. Declaring it is what makes the mount writable for that call."""
        m, rel = self._resolve(path, write=True)
        return Ref(m.name, rel, write=True)

    def glob(self, pattern: str) -> Glob:
        """Files matching a pattern. ``**`` crosses directories; ``*`` does not."""
        mount_name, pat = split_mount(pattern)
        g = Glob(mount_name, pat)
        self._resolve(Ref(mount_name, g.static_prefix()))
        return g

    def expand(self, sel: Union[Ref, Glob, str]) -> list[FileStat]:
        """The files a path or glob covers right now, sorted by path. Metadata only: nothing is read."""
        if isinstance(sel, str):
            sel = self.glob(sel) if any(c in sel for c in "*?[") else self.path(sel)
        if hasattr(sel, "resolve"):
            return sel.resolve(self)
        m = self.mounts[sel.mount]
        if isinstance(sel, Glob):
            regex = sel.regex()
            listed = self.backend.list(m.handle, m.key(sel.static_prefix()), recursive=True)
            keep = [(m.rel(o.key), o) for o in listed]
            found = [FileStat(f"{m.name}/{rel}", o.size, o.modified, o.version) for rel, o in keep
                     if regex.match(rel) and not rel.startswith(META + "/") and m.within(rel)]
            return sorted(found, key=lambda f: f.path)
        listed = self.backend.list(m.handle, m.key(sel.rel), recursive=True)
        out = []
        for o in listed:
            rel = m.rel(o.key)
            inside = not sel.rel or rel == sel.rel or rel.startswith(sel.rel + "/")
            if inside and not rel.startswith(META + "/"):
                out.append(FileStat(f"{m.name}/{rel}", o.size, o.modified, o.version))
        return sorted(out, key=lambda f: f.path)  # one order on every backend, so plans are reproducible

    # -- scope: which disks a call sees, and how -----------------------------
    def scope(self, reads: Iterable[tuple[str, str]], writes: Iterable[tuple[str, str]]) -> dict[str, MountSpec]:
        """Compile declared reads and writes into the smallest mount map that satisfies them.

        ``reads`` are (mount, directory) pairs; ``writes`` are (mount, path) pairs.
        With neither, the call sees the whole context, each mount in its own mode.
        """
        reads, writes = list(reads), list(writes)
        limits = self.backend.limits
        if not reads and not writes:
            return dict(m.spec(limits, write=True) for m in self.mounts.values())
        out: dict[str, MountSpec] = {}
        written = {m for m, _ in writes}
        for mount_name in dict.fromkeys([m for m, _ in reads] + [m for m, _ in writes]):
            m = self.mounts[mount_name]
            if mount_name in written:
                vm_key, spec = m.spec(limits, write=True)
            else:
                dirs = [d for mm, d in reads if mm == mount_name]
                vm_key, spec = m.spec(limits, write=False, sub=common_dir(dirs))
            out[vm_key] = spec
        return out

    # -- the data plane: reads and writes that need no compute ---------------
    def read(self, path: str) -> bytes:
        m, rel = self._resolve(path)
        data = self.backend.get(m.handle, m.key(rel))
        if not self.backend.inside_archil:
            self.spend.add(estimate(self.prices, egress_bytes=len(data)), statement=False)
        return data

    def read_text(self, path: str) -> str:
        return self.read(path).decode("utf-8", errors="replace")

    def write(self, path: str, data: Union[bytes, str], *, if_absent: bool = False) -> str:
        m, rel = self._resolve(path, write=True)
        body = data.encode() if isinstance(data, str) else data
        self.backend.put(m.handle, m.key(rel), body, if_absent=if_absent)
        return f"{m.name}/{rel}"

    def append(self, path: str, data: Union[bytes, str]) -> str:
        m, rel = self._resolve(path, append=True)
        body = data.encode() if isinstance(data, str) else data
        self.backend.append(m.handle, m.key(rel), body)
        return f"{m.name}/{rel}"

    def exists(self, path: str) -> bool:
        m, rel = self._resolve(path)
        return self.backend.head(m.handle, m.key(rel)) is not None

    def rm(self, path: str) -> None:
        """Remove a file, or a directory and everything under it."""
        m, rel = self._resolve(path, write=True)
        if not rel:
            raise ValidationError("rm needs a path below the mount", code="bad_path", path=str(path),
                                  suggestion="name a file or a directory; a whole disk is not removed this way")
        self.backend.delete(m.handle, m.key(rel))

    def ls(self, path: str = "", *, recursive: bool = False) -> list[FileStat]:
        """List a directory. Directories end in '/'. Listing never makes data active."""
        if not norm(path):
            return [FileStat(f"{n}/", 0) for n in self.mounts]
        m, rel = self._resolve(path)
        listed = self.backend.list(m.handle, m.key(rel), recursive=recursive)
        out = []
        for o in listed:
            r = m.rel(o.key)
            if r.startswith(META + "/") or r.rstrip("/") == META:
                continue
            out.append(FileStat(f"{m.name}/{r}", o.size, o.modified, "" if o.key.endswith("/") else o.version))
        return out

    def share(self, path: str, *, expires_in: int = 86400) -> str:
        m, rel = self._resolve(path)
        return self.backend.share(m.handle, m.key(rel), expires_in)

    # -- statements: work that runs next to the data ---------------------------
    def sh(self, command: str, **params: Any):
        """A bash command, as a statement. Call ``.explain()`` to see the plan or ``.run()`` to run it."""
        from .statement import Statement

        return Statement(self, "sh", command, tuple(params.items()), vm=Vm(egress=self.egress))

    def grep(self, pattern: str, over: Union[str, Ref, None] = None, **opts: Any):
        """Regex search fanned out next to the data. One call per disk, however many files."""
        from .statement import Statement

        target = over if isinstance(over, Ref) or over is None else self.path(over)
        return Statement(self, "grep", pattern, (("over", target),), opts=tuple(sorted(opts.items())))

    def sql(self, query: str, **params: Any):
        """SQL over files in the context (JSON lines, Parquet, CSV), run by DuckDB next to the data."""
        from .statement import Statement

        return Statement(self, "sql", query, tuple(params.items()), vm=Vm(egress=self.egress))

    def batch(self, statements: list):
        """Run several small statements in one call. Each still gets its own result."""
        from .statement import Statement

        return Statement(self, "batch", "", (), children=tuple(statements), vm=Vm(egress=self.egress))

    # -- versions that are coarser than writes --------------------------------
    def _unsettled(self, modified: float) -> bool:
        """Could a file last modified at ``modified`` still change without its version changing?

        Where a version carries a time in whole seconds (Archil), a file rewritten in place at the
        same size keeps its version until the clock has left the second it was last modified in.
        Until then a recorded version of it proves nothing.
        """
        coarse = getattr(self.backend, "version_granularity_s", 0.0)
        return coarse > 0 and time.time() - modified < coarse + CLOCK_SLACK_S

    def _settle(self, newest: float) -> None:
        """Wait until a file modified at ``newest`` can no longer change behind its version. At most
        a second and a half, and only when something was written that recently."""
        coarse = getattr(self.backend, "version_granularity_s", 0.0)
        if coarse > 0:
            wait = min(newest + coarse + CLOCK_SLACK_S - time.time(), coarse + CLOCK_SLACK_S)
            if wait > 0:
                time.sleep(wait)

    # -- time ----------------------------------------------------------------
    def _checkpoint(self, handle: str, name: str) -> str:
        """Take one checkpoint and count what it cost: on Archil today it is an exec, so it is a call."""
        try:
            return self.backend.checkpoint(handle, name)
        finally:  # a checkpoint that was refused was still a call
            calls = getattr(self.backend, "checkpoint_calls", 0)
            if calls:
                self.spend.add(estimate(self.prices, calls=calls), statement=False)

    def checkpoint(self, name: str) -> dict[str, str]:
        """Checkpoint every writable mount under one name."""
        return {m.name: self._checkpoint(m.handle, name) for m in self.mounts.values() if m.appendable}

    def lock(self, name: str) -> dict:
        """Checkpoint every mount and return a manifest with all of them frozen at that point.

        Opening the returned manifest gives a context that reads the same bytes every
        time, which is what an eval, a replay or a reproducible build needs.
        """
        manifest = self.manifest()
        for m in self.mounts.values():
            if m.source.mode == "frozen":
                continue  # already pinned: a lock keeps the pin a mount has
            self._checkpoint(m.handle, name)
            manifest["mounts"][m.name] = self._mount_manifest(m, replace(m.source, mode="frozen", at=name))
        manifest["locked"] = name
        return manifest

    def fork(self, name: str) -> "Context":
        """A copy of this context whose writable mounts are private branches.

        Use one fork per attempt when several agents try the same task: each sees
        the same starting state and none sees another's writes.
        """
        mounts = dict(self.mounts)
        for m in self.mounts.values():
            if m.writable:
                cp = self._checkpoint(m.handle, f"fork-{name}")
                branch = self.backend.branch(m.handle, name, cp)
                # The fork's source names the branch, so its manifest opens the fork and not the original.
                mounts[m.name] = replace(m, handle=branch, source=replace(m.source, disk=branch, create=False))
        return self._derive(mounts, name=f"{self.name}@{name}")

    def transaction(self, *, writes: Optional[list[str]] = None, reads: Optional[list[str]] = None,
                    isolation: str = "snapshot", name: Optional[str] = None):
        """All of a turn's changes, or none of them. See ``Transaction``."""
        from .transaction import Transaction

        return Transaction(self, writes=writes, reads=reads, isolation=isolation, name=name)

    # -- structures ------------------------------------------------------------
    def log(self, path: str, *, partition: str = "hour", writer: Optional[str] = None):
        from .structures import Log

        return Log(self, path, partition=partition, writer=writer)

    def view(self, path: str, build, *, inputs: Optional[list] = None):
        from .structures import View

        return View(self, path, build, inputs=inputs or [])

    def feed(self, path: str, *, cursor: str):
        """What changed under ``path`` since the reader holding ``cursor`` last looked."""
        from .structures import Feed

        return Feed(self, path, cursor=cursor)

    def sync(self, recipe, into: str) -> dict:
        from .recipes import sync

        return sync(self, recipe, into)

    def tools(self, names: Optional[list[str]] = None) -> list:
        from .tools import build_tools

        return build_tools(self, names)

    # -- manifest ----------------------------------------------------------------
    @staticmethod
    def _mount_manifest(m: Mount, source: Optional[Source] = None) -> dict:
        d = (source or m.source).to_dict()
        if m.allow:
            d["allow"] = m.allow
        if m.read_only:
            d["readOnly"] = True
        return d

    def manifest(self) -> dict:
        mounts = {m.name: self._mount_manifest(m) for m in self.mounts.values()}
        out: dict = {"archilContext": 0, "name": self.name, "mounts": mounts}
        if self.journal:
            out["journal"] = self.journal
        if self.tools_map:
            out["tools"] = self.tools_map
        if self.egress is not None:
            out["egress"] = list(self.egress) or "deny"
        return out

    @classmethod
    def from_manifest(cls, manifest: Union[dict, str, Path], *, backend: Optional[Backend] = None, **kw) -> "Context":
        if isinstance(manifest, Path) or (isinstance(manifest, str) and not manifest.lstrip().startswith("{")):
            manifest = Path(manifest).read_text()
        data = json.loads(manifest) if isinstance(manifest, str) else manifest
        if data.get("archilContext") != 0:
            raise ValidationError("not a context manifest (expected archilContext: 0)", code="bad_manifest")
        sources, narrowed = {}, {}
        for mount_name, d in data["mounts"].items():
            sources[mount_name] = disk(d["disk"], d.get("mode", "read"), subdirectory=d.get("subdirectory", ""),
                                       at=d.get("at"), description=d.get("description", ""))
            if d.get("allow") or d.get("readOnly"):
                narrowed[mount_name] = (d.get("allow", ""), bool(d.get("readOnly")))
        ctx = cls(sources, backend=backend, name=data.get("name", "context"), journal=data.get("journal"),
                  tools=data.get("tools"), egress=data.get("egress"), **kw)
        for mount_name, (allow, ro) in narrowed.items():
            ctx.mounts[mount_name] = replace(ctx.mounts[mount_name], allow=allow, read_only=ro)
        return ctx

    def describe(self) -> str:
        """What a model needs to know about this context, in a few lines."""
        lines = [f'context "{self.name}" on {self.backend.name}']
        where = {m.name: (f"{m.name}/{m.allow}/" if m.allow else f"{m.name}/") for m in self.mounts.values()}
        width = max(len(w) for w in where.values())
        for m in self.mounts.values():
            note = f"  {m.source.description}" if m.source.description else ""
            pin = f" @{m.source.at}" if m.source.at else ""
            lines.append(f"  {where[m.name]:<{width}}  {m.mode:<7} {m.source.disk}{pin}{note}")
        lines.append("Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to "
                     f"the data and bill per call (≈ ${self.prices.call_usd:.5f}). explain() prices a statement first.")
        if self.egress is not None:
            lines.append("Commands run with " + Vm(egress=self.egress).describe_egress() + ".")
        return "\n".join(lines)

    def _record(self, entry: dict) -> None:
        if not self.journal:
            return
        from .structures import _stamp, _utc

        # An entry carries the time it happened, because it may be written later: the journal's disk
        # can be busy (on Archil, while a statement holds its checkout). What cannot be written now
        # is kept, in order, and goes out with the next entry.
        self._journal_backlog.append({"ts": _stamp(_utc(None)), **entry})
        try:
            if self._journal_log is None:
                self._journal_log = self.log(self.journal, partition="day", writer=self.session)
            pending = list(self._journal_backlog)
            self._journal_log.append(pending)
            del self._journal_backlog[: len(pending)]
        except Exception:  # a journal must never break the work it records
            pass

    @property
    def journal_pending(self) -> int:
        """Journal entries not yet on the disk. They are written with the next entry that can be."""
        return len(self._journal_backlog)

    def __repr__(self) -> str:
        return f"<Context {self.name}: " + ", ".join(f"{m.name}({m.mode})" for m in self.mounts.values()) + ">"


def context(mounts: dict[str, Union[Source, str]], **kw: Any) -> Context:
    """Compose disks into a context. See the module docstring for the modes."""
    return Context(mounts, **kw)


def tree_size(ctx: Context, mount: str, rel: str) -> tuple[int, int]:
    """(bytes, files) under a path, from a metadata listing."""
    files = ctx.expand(Ref(mount, rel))
    return sum(f.size for f in files), len(files)


__all__ = ["Context", "Mount", "Source", "context", "disk", "MODES", "META", "tree_size", "fmt_bytes",
           "Issue", "NotSupported"]
