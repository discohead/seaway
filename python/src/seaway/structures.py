"""Three structures built from the same verbs: a log, a view and a feed.

A **log** is an append-only stream laid out so that it is cheap to keep and
cheap to ask questions of: one directory per hour, one file per writer. The
partition directory is what lets a question about the last fifteen minutes
touch fifteen minutes of data, and the per-writer file is what lets many
machines append without overwriting one another.

A **view** is a statement with a name. It writes a derived file (a report, an
index, a dashboard) and remembers what it was built from, so refreshing it
when nothing has changed costs nothing, and rebuilding it never needs a model.

A **feed** is a cursor over a listing: what was added, changed or removed under
a path since this reader last looked. It is how work starts from a change in
the data instead of from a clock.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional, Union

from .context import META, PROVISIONAL
from .errors import ValidationError
from .shell import FileStat, Glob, Ref, common_dir, norm, parent
from .plan import canonical
from .statement import Result, Statement, _is_selection, describe_param

_DURATION = re.compile(r"^(\d+)\s*([smhd])$")
_UNITS = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}


def _duration(spec: Union[str, timedelta]) -> timedelta:
    if isinstance(spec, timedelta):
        return spec
    m = _DURATION.match(spec.strip())
    if not m:
        raise ValidationError(f"cannot read '{spec}' as a duration", code="bad_duration",
                              suggestion="use forms like '15m', '2h' or '7d'")
    return timedelta(**{_UNITS[m.group(2)]: int(m.group(1))})


def _utc(dt: Optional[datetime]) -> datetime:
    dt = dt or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Log:
    """Append-only records at ``<path>/<YYYY-MM-DD>/<HH>/<writer>.ndjson``."""

    def __init__(self, ctx, path: str, *, partition: str = "hour", writer: Optional[str] = None) -> None:
        if partition not in ("hour", "day", "none"):
            raise ValidationError(f"unknown partition '{partition}'", code="bad_partition",
                                  suggestion="use 'hour', 'day' or 'none'")
        m, rel = ctx._resolve(path)
        self.ctx = ctx
        self.mount = m.name
        self.rel = rel
        self.partition = partition
        self.writer = re.sub(r"[^A-Za-z0-9_.-]", "-", writer or ctx.session)

    @property
    def path(self) -> str:
        return f"{self.mount}/{self.rel}" if self.rel else self.mount

    def _dir(self, at: datetime) -> str:
        parts = [self.rel]
        if self.partition in ("hour", "day"):
            parts.append(at.strftime("%Y-%m-%d"))
        if self.partition == "hour":
            parts.append(at.strftime("%H"))
        return "/".join(p for p in parts if p)

    def append(self, records: Union[dict, Iterable[dict]], *, at: Optional[datetime] = None) -> list[str]:
        """Add records. Each gets a ``ts`` and an ``id`` unless it already has them.

        The id is what makes a retry safe: an append that is sent twice can be
        recognised and dropped by the reader.
        """
        records = [records] if isinstance(records, dict) else list(records)
        limit = self.ctx.backend.limits.append_max_bytes
        chunks: dict[str, list[bytes]] = {}
        for record in records:
            stamp = _utc(datetime.fromisoformat(record["ts"].replace("Z", "+00:00"))) if "ts" in record else _utc(at)
            line = {"ts": _stamp(stamp), "id": uuid.uuid4().hex[:12], **record}
            data = (json.dumps(line, separators=(",", ":"), default=str) + "\n").encode()
            if len(data) > limit:
                raise ValidationError(f"one record is larger than an append can carry ({limit} bytes)",
                                      code="record_too_large")
            chunks.setdefault(f"{self.mount}/{self._dir(stamp)}/{self.writer}.ndjson", []).append(data)
        written = []
        for path, lines in chunks.items():
            buffer = b""
            for data in lines:
                if buffer and len(buffer) + len(data) > limit:
                    self.ctx.append(path, buffer)
                    buffer = b""
                buffer += data
            if buffer:
                self.ctx.append(path, buffer)
            written.append(path)
        return written

    # -- selections: the part of the log a question needs ---------------------
    def last(self, span: Union[str, timedelta], *, now: Optional[datetime] = None) -> "Selection":
        """Records from the last ``span`` ('15m', '2h', '7d' or a timedelta) up to now."""
        end = _utc(now)
        return Selection(self, end - _duration(span), end, f"last {span}", bounded=False)

    def between(self, start: datetime, end: datetime) -> "Selection":
        """Records with ``start <= ts < end``."""
        return Selection(self, _utc(start), _utc(end), f"{start:%Y-%m-%d %H:%M}..{end:%Y-%m-%d %H:%M}")

    def all(self) -> "Selection":
        return Selection(self, None, None, "all")

    def __repr__(self) -> str:
        return f"<Log {self.path} by {self.partition}>"


def _stamp(at: datetime) -> str:
    """A time as records carry it in ``ts``: UTC, milliseconds, 'Z'. These strings sort in time order."""
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


@dataclass(frozen=True)
class Selection:
    """The records of a log in a time range.

    The range does two jobs. From a listing, which reads nothing, it picks the
    partitions that can hold such records, and those are the only files a
    statement mounts and reads. In SQL it is also a filter on ``ts``, so the
    table is exactly the records in the range. In bash it is the files; a
    partition is an hour or a day, so filter on ``ts`` there if the edges matter.
    """

    log: Log
    start: Optional[datetime]
    end: Optional[datetime]
    label: str
    dir_complete: bool = True  # every file in a selected directory belongs to the selection
    bounded: bool = True  # False for last(): nothing is later than now, so there is no upper bound on ts

    def predicate(self) -> Optional[str]:
        """The SQL condition on ``ts`` that makes the table exactly this range, or None for the whole log."""
        if self.start is None:
            return None
        low = f"ts >= '{_stamp(self.start)}'"
        return f"{low} and ts < '{_stamp(self.end)}'" if self.bounded and self.end is not None else low

    def _covers(self, rel: str) -> bool:
        if self.start is None or self.log.partition == "none":
            return True
        tail = rel[len(self.log.rel) :].strip("/").split("/")
        try:
            if self.log.partition == "hour":
                at = datetime.strptime(f"{tail[0]} {tail[1]}", "%Y-%m-%d %H").replace(tzinfo=timezone.utc)
                width = timedelta(hours=1)
            else:
                at = datetime.strptime(tail[0], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                width = timedelta(days=1)
        except (ValueError, IndexError):
            return False
        return at + width > self.start and at <= self.end

    def resolve(self, ctx) -> list[FileStat]:
        log = self.log
        if self.start is None or log.partition == "none":
            roots = [log.rel]
        else:
            day, last = self.start.date(), self.end.date()
            roots = []
            while day <= last:
                roots.append(f"{log.rel}/{day:%Y-%m-%d}".strip("/"))
                day += timedelta(days=1)
        out: list[FileStat] = []
        for root in roots:
            for f in ctx.expand(Ref(log.mount, root)):
                rel = f.path[len(log.mount) + 1 :]
                if rel.endswith(".ndjson") and self._covers(rel):
                    out.append(f)
        return out

    def roots(self) -> list[tuple[str, str]]:
        files = self.resolve(self.log.ctx)
        if not files:
            return [(self.log.mount, self.log.rel)]
        rels = [parent(f.path[len(self.log.mount) + 1 :]) for f in files]
        return [(self.log.mount, common_dir(rels))]

    def __str__(self) -> str:
        return f"{self.log.path}[{self.label}]"


class View:
    """A derived file that knows how to rebuild itself and whether it needs to."""

    def __init__(self, ctx, path: str, build: Union[Statement, Callable[[], Statement]], *, inputs: list) -> None:
        self.ctx = ctx
        self.ref = ctx.out(path)
        self._build = build
        self.inputs = inputs

    @property
    def path(self) -> str:
        return self.ref.path

    def statement(self) -> Statement:
        stmt = self._build() if callable(self._build) and not isinstance(self._build, Statement) else self._build
        writes = any(isinstance(v, Ref) and v.write for _, v in stmt.params)
        return stmt if stmt.out or writes else stmt.into(self.ref)

    def _state_path(self) -> str:
        return f"{self.ref.mount}/{META}/views/{hashlib.sha1(self.path.encode()).hexdigest()[:16]}.json"

    def _inputs(self, stmt: Statement) -> list:
        if self.inputs:
            return [self.ctx.path(i) if isinstance(i, str) and not any(c in i for c in "*?[") else
                    (self.ctx.glob(i) if isinstance(i, str) else i) for i in self.inputs]
        return [v for _, v in stmt.params if _is_selection(v) or (isinstance(v, Ref) and not v.write)]

    def fingerprint(self) -> str:
        """Changes when the inputs change or the statement changes. Built from a listing: free to compute."""
        return self._fingerprint()[0]

    def _fingerprint(self) -> tuple[str, bool]:
        """The fingerprint, and whether it can be trusted later: not if an input is so new that it
        could still be rewritten without its version changing (see ``Context._unsettled``)."""
        stmt = self.statement()
        head = canonical([stmt.kind, stmt.template.strip(), [[k, describe_param(v)] for k, v in stmt.params]])
        h = hashlib.sha256(head.encode())
        settled = True
        for item in self._inputs(stmt):
            for f in sorted(self.ctx.expand(item), key=lambda f: f.path):
                h.update(f"\n{f.path}\0{f.size}\0{f.version}".encode())
                settled = settled and not self.ctx._unsettled(f.modified)
        return h.hexdigest(), settled

    @property
    def fresh(self) -> bool:
        state = self._state_path()
        if not (self.ctx.exists(state) and self.ctx.exists(self.path)):
            return False
        return json.loads(self.ctx.read_text(state)).get("fingerprint") == self.fingerprint()

    def refresh(self, *, force: bool = False) -> Optional[Result]:
        """Rebuild if the inputs changed. Returns the result of the build, or None if nothing ran."""
        if not force and self.fresh:
            return None
        fingerprint, settled = self._fingerprint()
        if not settled:
            # Built from an input written this very second. Recorded as it is, a rewrite within the
            # same second would leave the view looking fresh. So record it as provisional: the next
            # refresh builds once more, from versions that can be trusted.
            fingerprint += PROVISIONAL
        result = self.statement().run()
        if result.ok:
            self.ctx.write(self._state_path(), json.dumps({
                "path": self.path, "fingerprint": fingerprint, "plan": result.plan.hash,
                "builtAt": datetime.now(timezone.utc).isoformat(), "usd": round(result.meta.usd, 8),
            }))
        return result

    def read(self) -> bytes:
        self.refresh()
        return self.ctx.read(self.path)

    def read_text(self) -> str:
        return self.read().decode("utf-8", errors="replace")

    def share(self, *, expires_in: int = 86400) -> str:
        return self.ctx.share(self.path, expires_in=expires_in)

    def __repr__(self) -> str:
        return f"<View {self.path}>"


@dataclass
class Changes:
    """What a feed found. Truthy when there is something to do. ``ack()`` marks it as handled."""

    feed: "Feed"
    added: list[FileStat]
    modified: list[FileStat]
    removed: list[str]
    previous: dict[str, int]  # size before, for each modified file: an appended-to file grew from here
    _listing: dict[str, list]

    def __bool__(self) -> bool:
        return bool(self.added or self.modified or self.removed)

    @property
    def files(self) -> list[FileStat]:
        return self.added + self.modified

    def refs(self) -> list[Ref]:
        """The added and modified files as statement parameters."""
        return [self.feed.ctx.path(f.path) for f in self.files]

    def ack(self) -> None:
        self.feed._save(self._listing)

    def __repr__(self) -> str:
        return f"<Changes +{len(self.added)} ~{len(self.modified)} -{len(self.removed)} under {self.feed.path}>"


class Feed:
    """What changed under a path since this reader last looked.

    A feed is a cursor over a listing. ``poll()`` lists the path, which reads no
    data, and compares it with what the cursor recorded. ``ack()`` moves the
    cursor. Until then ``poll()`` returns the same changes again, so a reader
    that stops half-way sees them again: delivery is at-least-once.
    """

    def __init__(self, ctx, path: str, *, cursor: str) -> None:
        self.ctx = ctx
        self.ref = ctx.path(path)
        self.cursor = ctx.out(cursor).path

    @property
    def path(self) -> str:
        return self.ref.path

    def _seen(self) -> dict[str, list]:
        if not self.ctx.exists(self.cursor):
            return {}
        return json.loads(self.ctx.read_text(self.cursor)).get("seen", {})

    def _save(self, listing: dict[str, list]) -> None:
        self.ctx.write(self.cursor, canonical({"feed": 0, "path": self.path, "seen": listing}))

    def poll(self) -> Changes:
        seen = self._seen()
        now = {f.path: f for f in self.ctx.expand(self.ref) if f.path != self.cursor}
        added = [f for p, f in now.items() if p not in seen]
        modified = [f for p, f in now.items() if p in seen and seen[p] != [f.size, f.version]]
        removed = sorted(p for p in seen if p not in now)
        # A file written this very second is remembered with a provisional version, so the next poll
        # hands it over again: it could still change without its version changing. At least once.
        listing = {p: [f.size, f.version + (PROVISIONAL if self.ctx._unsettled(f.modified) else "")]
                   for p, f in now.items()}
        return Changes(self, added, modified, removed, {f.path: seen[f.path][0] for f in modified}, listing)

    def __repr__(self) -> str:
        return f"<Feed {self.path} cursor={self.cursor}>"


__all__ = ["Log", "Selection", "View", "Feed", "Changes", "Glob", "norm"]
