"""Turns as transactions: all of a turn's changes, or none of them.

The semantics are snapshot isolation over files, with the first committer
winning at path granularity:

1. **Begin.** Checkpoint each disk the turn may write and branch from it. The
   branch is the turn's private workspace; reads inside the turn see a
   consistent snapshot plus the turn's own writes.
2. **Work.** Every verb on the transaction (``sh``, ``sql``, ``write`` …) acts
   on the branch. Nothing the turn does is visible to anyone else.
3. **Commit.** Find what the turn changed (a metadata comparison of the branch
   against its starting point). If none of those paths changed on the main line
   in the meantime (the main line now, against a listing of it taken at the
   start), copy them across in one call. If any did, raise ``Conflict`` naming
   them, and apply nothing.

With ``isolation="serializable"`` the commit also fails if anything under the
declared ``reads`` changed on the main line, which protects decisions that were
based on data the turn did not write.

Archil provides the two expensive parts natively: checkpoints and branches are
copy-on-write and take milliseconds at any size. It does not yet merge a branch
back, so this module does the validation and the copy itself. That is the part
that belongs in the storage layer; see ``docs`` for the two primitives it
reduces to.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Optional

from .backends import MountSpec, Vm
from .context import META
from .errors import Conflict, Error, NotSupported, ValidationError
from .shell import norm, split_mount


@dataclass
class Commit:
    id: str
    applied: list[str] = field(default_factory=list)  # context paths written to the main line
    deleted: list[str] = field(default_factory=list)
    calls: int = 0

    @property
    def empty(self) -> bool:
        return not (self.applied or self.deleted)


class Transaction:
    def __init__(self, ctx, *, writes: Optional[list[str]] = None, reads: Optional[list[str]] = None,
                 isolation: str = "snapshot", name: Optional[str] = None) -> None:
        if isolation not in ("snapshot", "serializable"):
            raise ValidationError(f"unknown isolation '{isolation}'", code="bad_isolation",
                                  suggestion="use 'snapshot' or 'serializable'")
        missing = {"checkpoint", "branch"} - set(ctx.backend.capabilities)
        if missing:
            raise NotSupported(
                f"{ctx.backend.name} cannot run transactions: it lacks {', '.join(sorted(missing))}",
                suggestion="transactions need a disk that can checkpoint and branch (an Archil-managed disk)",
            )
        self.base = ctx
        self.id = name or f"tx-{uuid.uuid4().hex[:10]}"
        self.isolation = isolation
        self.state = "new"
        self.view = None  # the context the turn works in
        self._branches: dict[str, str] = {}
        self._start: dict[str, dict[str, tuple]] = {}  # mount -> {rel: (size, version)} on the branch, at the start
        self._main_start: dict[str, dict[str, tuple]] = {}  # the same listing of the main line, taken first
        self._read_start: dict[str, dict[str, tuple]] = {}
        self._newest = 0.0  # the latest modification time in the listings taken so far

        self.write_roots: dict[str, list[str]] = {}
        if writes:
            for p in writes:
                m, rel = ctx._resolve(p, write=True)
                self.write_roots.setdefault(m.name, []).append(rel)
        else:
            self.write_roots = {m.name: [m.allow] for m in ctx.mounts.values() if m.writable}
        if not self.write_roots:
            raise ValidationError("this context has nothing a transaction could write", code="read_only",
                                  suggestion="mount at least one disk as 'owned' or 'shared'")
        self.read_roots: dict[str, list[str]] = {}
        for p in reads or []:
            m, rel = ctx._resolve(p)
            self.read_roots.setdefault(m.name, []).append(rel)
        if isolation == "serializable" and not self.read_roots:
            raise ValidationError("serializable isolation needs reads=[...]", code="bad_isolation",
                                  suggestion="list the paths this turn's decisions depend on")

    # -- lifecycle -----------------------------------------------------------
    def begin(self) -> "Transaction":
        if self.state != "new":
            raise Error(f"transaction {self.id} is already {self.state}", code="bad_state")
        ctx, backend = self.base, self.base.backend
        mounts = dict(ctx.mounts)
        # List the main line first, then checkpoint. A write that lands in between is in the turn's
        # snapshot but not in this listing, so the commit reports it as a conflict: a needless abort
        # at worst, never a lost update.
        for name, roots in self.write_roots.items():
            self._main_start[name] = self._listing(ctx.mounts[name].handle, ctx.mounts[name], roots)
        for name, roots in self.read_roots.items():
            self._read_start[name] = self._listing(ctx.mounts[name].handle, ctx.mounts[name], roots)
        # Where versions are coarse (Archil: whole seconds), a file written a moment ago could be
        # rewritten again, by anyone, without its version moving, and the commit would not see it.
        # So the snapshot is not taken until the newest file listed is older than that. Usually no wait.
        ctx._settle(self._newest)
        for name in self.write_roots:
            m = ctx.mounts[name]
            checkpoint = ctx._checkpoint(m.handle, f"{self.id}-base")
            branch = backend.branch(m.handle, self.id, checkpoint)
            self._branches[name] = branch
            mounts[name] = replace(m, handle=branch)
            # the whole branch, not only the declared paths: a write the turn did not declare
            # has to be noticed at commit, not dropped
            self._start[name] = self._listing(branch, m, [m.allow])
        ctx._settle(self._newest)  # and the turn's own writes must not share a second with what it started from
        self.view = ctx._derive(mounts, name=f"{ctx.name}#{self.id}")
        self.state = "open"
        return self

    def _listing(self, handle: str, m, roots: list[str]) -> dict[str, tuple]:
        out: dict[str, tuple] = {}
        for root in roots:
            for o in self.base.backend.list(handle, m.key(root), recursive=True):
                rel = m.rel(o.key)
                if rel.startswith(META + "/"):
                    continue
                if not root or rel == root or rel.startswith(root + "/"):
                    out[rel] = (o.size, o.version)
                    self._newest = max(self._newest, o.modified)
        return out

    def changes(self) -> dict[str, tuple[list[str], list[str]]]:
        """What the turn has changed so far: {mount: (written, deleted)}. A metadata comparison."""
        self._require_open()
        out = {}
        for name, branch in self._branches.items():
            m = self.base.mounts[name]
            now = self._listing(branch, m, [m.allow])
            start = self._start[name]
            written = sorted(rel for rel, meta in now.items() if start.get(rel) != meta)
            deleted = sorted(rel for rel in start if rel not in now)
            if written or deleted:
                out[name] = (written, deleted)
        return out

    def commit(self) -> Commit:
        self._require_open()
        ctx, backend = self.base, self.base.backend
        changes = self.changes()
        undeclared = sorted(
            f"{name}/{rel}" for name, (written, deleted) in changes.items() for rel in written + deleted
            if not any(not root or rel == root or rel.startswith(root + "/") for root in self.write_roots[name])
        )
        if undeclared:
            self.state = "aborted"
            raise ValidationError(
                "the turn changed paths it did not declare: " + ", ".join(undeclared[:5]) + (" …" if len(undeclared) > 5 else ""),
                code="undeclared_write",
                suggestion="add them to writes=[...], or leave writes out to cover every writable mount",
            )
        result = Commit(self.id)
        locks = [backend.commit_lock(ctx.mounts[name].handle) for name in sorted(changes)]
        for lock in locks:
            lock.__enter__()
        try:
            # validate every mount before applying to any
            conflicts: list[str] = []
            for name, (written, deleted) in changes.items():
                m = ctx.mounts[name]
                main = self._listing(m.handle, m, self.write_roots[name])
                start = self._main_start[name]
                conflicts += [f"{name}/{rel}" for rel in written + deleted if main.get(rel) != start.get(rel)]
            if self.isolation == "serializable":
                for name, roots in self.read_roots.items():
                    m = ctx.mounts[name]
                    main = self._listing(m.handle, m, roots)
                    start = self._read_start[name]
                    own = set(changes.get(name, ([], []))[0]) | set(changes.get(name, ([], []))[1])
                    conflicts += [f"{name}/{rel}" for rel in sorted(set(main) | set(start))
                                  if main.get(rel) != start.get(rel) and rel not in own]
            if conflicts:
                self.state = "aborted"
                raise Conflict(sorted(set(conflicts)))
            for name, (written, deleted) in changes.items():
                self._apply(name, written, deleted)
                result.applied += [f"{name}/{rel}" for rel in written]
                result.deleted += [f"{name}/{rel}" for rel in deleted]
                result.calls += 1
        finally:
            for lock in reversed(locks):
                lock.__exit__(None, None, None)
        self.state = "committed"
        from .pricing import estimate

        ctx.spend.add(estimate(ctx.prices, calls=result.calls), statement=False)
        ctx._record({"kind": "commit", "tx": self.id, "applied": len(result.applied),
                     "deleted": len(result.deleted), "calls": result.calls})
        return result

    def _apply(self, name: str, written: list[str], deleted: list[str]) -> None:
        """Copy the turn's changes from the branch to the main line, in one call next to the data."""
        ctx, backend = self.base, self.base.backend
        m = ctx.mounts[name]
        manifest = "".join(f"W\t{rel}\n" for rel in written) + "".join(f"D\t{rel}\n" for rel in deleted)
        manifest_rel = f"{META}/tx/{self.id}.changes"
        backend.put(self._branches[name], m.key(manifest_rel), manifest.encode())
        subdirectory = m.source.subdirectory or None
        # An owned mount commits under its checkout, so no other writer can interleave.
        # A shared mount has no checkout to take; its commit is optimistic.
        dst = MountSpec(m.handle, subdirectory, conditional=True) if m.mode == "shared" else \
            MountSpec(m.handle, subdirectory, queue_ms=backend.limits.checkout_queue_ms)
        script = (
            "set -e\n"
            "while IFS=\"$(printf '\\t')\" read -r op rel; do\n"
            '  if [ "$op" = "D" ]; then rm -f "dst/$rel"\n'
            '  else mkdir -p "$(dirname "dst/$rel")"; cp -p "src/$rel" "dst/$rel.px-tmp"; '
            'mv -f "dst/$rel.px-tmp" "dst/$rel"; fi\n'
            f'done < "src/{manifest_rel}"\n'
        )
        out = backend.exec({"src": MountSpec(self._branches[name], subdirectory, read_only=True), "dst": dst},
                           script, Vm())
        if out.exit_code != 0:
            self.state = "failed"
            raise Error(f"commit of {self.id} failed while applying to '{name}': {out.stderr.strip()[-300:]}",
                        code="commit_failed",
                        suggestion="some paths may have been applied; the branch still holds the full turn")

    def rollback(self) -> None:
        """Abandon the turn. Nothing was ever written to the main line, so there is nothing to undo."""
        if self.state == "open":
            self.state = "rolled_back"
            self.base._record({"kind": "rollback", "tx": self.id})

    def _require_open(self) -> None:
        if self.state != "open":
            raise Error(f"transaction {self.id} is {self.state}, not open", code="bad_state",
                        suggestion="call begin(), or use it as a context manager")

    # -- the same verbs as a context, acting on the turn's workspace ---------
    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or name in ("view", "base"):
            raise AttributeError(name)
        view = self.__dict__.get("view")
        if view is None:
            raise Error(f"transaction {self.id} is not open", code="bad_state",
                        suggestion="use `with ctx.transaction() as tx:`")
        return getattr(view, name)

    def __enter__(self) -> "Transaction":
        return self.begin()

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None and self.state == "open":
            self.commit()
        elif self.state == "open":
            self.rollback()
        return False

    def __repr__(self) -> str:
        return f"<Transaction {self.id} {self.state}>"


__all__ = ["Transaction", "Commit", "norm", "split_mount"]
