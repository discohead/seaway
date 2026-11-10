"""Recipes: how a system of record becomes files.

A recipe is two things. An adapter with the shape of an object store
(``list`` the keys, ``get`` one), and a short description of the layout it
produces, written for whoever reads the files next.

The adapter shape is deliberate. It is the interface Archil has described for
backend extensions: "manifest and synchronize any data into a local file system
with a simple S3 interface adapter". Today ``sync`` runs the adapter and writes
the files into a mount. When extensions ship, the same recipe can be served
lazily by the file system itself, and nothing that reads the files changes.

``sync`` is incremental. Each entry carries a version (an etag, an updated-at
time, a hash); entries whose version has not changed are not fetched again.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Union

from .context import META
from .errors import ValidationError
from .shell import norm


@dataclass(frozen=True)
class Entry:
    key: str  # path of the file this entry becomes, relative to the recipe's directory
    version: str = ""  # anything that changes when the content changes


class Recipe:
    """Subclass and implement ``list`` and ``get``. ``layout`` becomes the directory's README."""

    name = "recipe"
    layout = ""

    def list(self) -> Iterable[Entry]:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError


class Static(Recipe):
    """Fixed files. Useful for skills, prompts and fixtures."""

    def __init__(self, files: dict[str, Union[str, bytes]], *, name: str = "static", layout: str = "") -> None:
        self.files = {norm(k): (v.encode() if isinstance(v, str) else v) for k, v in files.items()}
        self.name, self.layout = name, layout

    def list(self) -> Iterable[Entry]:
        return [Entry(k, hashlib.sha1(v).hexdigest()) for k, v in self.files.items()]

    def get(self, key: str) -> bytes:
        return self.files[key]


def _frontmatter(value: Any) -> str:
    if isinstance(value, (dict, list)) or value is None or isinstance(value, bool):
        return json.dumps(value, default=str)
    text = str(value)
    return json.dumps(text) if (not text or text != text.strip() or any(c in text for c in ":#\n\"'[]{}")) else text


class Records(Recipe):
    """Records from any API, one Markdown file each, with the fields as front matter.

    ``fetch`` returns the records (call the system of record however you like).
    ``key`` names the field that identifies a record; ``version`` the field that
    changes when it does; ``body`` the field that becomes the text of the file.
    """

    def __init__(self, name: str, fetch: Callable[[], Iterable[dict]], *, key: str = "id",
                 version: Optional[str] = None, body: Optional[str] = None, layout: str = "") -> None:
        self.name, self.layout = name, layout
        self._fetch, self._key, self._version, self._body = fetch, key, version, body
        self._cache: Optional[dict[str, dict]] = None

    def _records(self) -> dict[str, dict]:
        if self._cache is None:
            self._cache = {}
            for record in self._fetch():
                slug = "".join(c if c.isalnum() or c in "-_." else "-" for c in str(record[self._key]))
                self._cache[f"{slug}.md"] = record
        return self._cache

    def list(self) -> Iterable[Entry]:
        self._cache = None  # each listing fetches again; the gets that follow it read what it fetched
        out = []
        for key, record in self._records().items():
            version = str(record[self._version]) if self._version else \
                hashlib.sha1(json.dumps(record, sort_keys=True, default=str).encode()).hexdigest()
            out.append(Entry(key, version))
        return out

    def get(self, key: str) -> bytes:
        record = self._records()[key]
        fields = {k: v for k, v in record.items() if k != self._body}
        head = "\n".join(f"{k}: {_frontmatter(v)}" for k, v in fields.items())
        body = str(record.get(self._body, "")) if self._body else ""
        return f"---\n{head}\n---\n{body}\n".encode()


def sync(ctx, recipe: Recipe, into: str) -> dict:
    """Materialise a recipe under ``into``. Returns what changed."""
    m, rel = ctx._resolve(into, write=True)
    root = f"{m.name}/{rel}" if rel else m.name
    state_path = f"{m.name}/{META}/recipes/{hashlib.sha1(root.encode()).hexdigest()[:16]}.json"
    previous: dict[str, str] = json.loads(ctx.read_text(state_path)) if ctx.exists(state_path) else {}
    entries = list(recipe.list())
    seen: dict[str, str] = {}
    stats = {"written": 0, "unchanged": 0, "deleted": 0, "into": root}
    for entry in entries:
        key = norm(entry.key)
        if not key or key.startswith(META):
            raise ValidationError(f"recipe '{recipe.name}' produced a bad key: {entry.key!r}", code="bad_key")
        seen[key] = entry.version
        if entry.version and previous.get(key) == entry.version:
            stats["unchanged"] += 1
            continue
        ctx.write(f"{root}/{key}", recipe.get(entry.key))
        stats["written"] += 1
    for key in previous:
        if key not in seen:
            ctx.rm(f"{root}/{key}")
            stats["deleted"] += 1
    readme = recipe.layout.rstrip() + "\n"
    if recipe.layout and not (ctx.exists(f"{root}/README.md") and ctx.read_text(f"{root}/README.md") == readme):
        ctx.write(f"{root}/README.md", readme)
    ctx.write(state_path, json.dumps(seen, sort_keys=True))
    ctx._record({"kind": "sync", "recipe": recipe.name, **stats})
    return stats


def git(ctx, url: str, into: str, *, depth: int = 1):
    """A repository as a directory. Returns a statement, so it can be explained before it runs.

    This recipe runs next to the data: the clone happens in a call with the
    target disk mounted, and nothing passes through the caller.
    """
    return ctx.sh("rm -rf {dest} && git clone --quiet --depth {depth} {url} {dest}",
                  url=url, depth=depth, dest=ctx.out(into))


DUCKDB_VERSION = "2.0.0"
DUCKDB_URL = "https://github.com/duckdb/duckdb/releases/download/v{version}/duckdb-cli-linux-amd64.tar.gz"
# The SHA-256 of that archive, for each version this SDK has been run with. It is what GitHub
# publishes for the release asset, and what the file hashed to when it was downloaded.
DUCKDB_SHA256 = {"2.0.0": "c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc"}

_DUCKDB_INSTALL = (
    'set -euo pipefail; t=$(mktemp -d); f="$t/duckdb.tar.gz"; want={sum}; curl -fsSL -o "$f" {url}; '
    'got=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1); '
    'if [ "$got" != "$want" ]; then echo "duckdb: the download has SHA-256 $got, not the pinned $want" >&2; exit 1; fi; '
    'tar -xzf "$f" -C "$t"; install -m 0755 "$t/duckdb" {dest}'
)


def duckdb(ctx, into: str, *, version: str = DUCKDB_VERSION, url: Optional[str] = None, sha256: Optional[str] = None):
    """The DuckDB command line on a disk, so that ``ctx.sql`` has an engine on Archil.

    Archil's exec image does not carry DuckDB. This puts the binary at ``<into>/duckdb``; a context
    opened with ``tools={"duckdb": "<into>/duckdb"}`` then runs its SQL with it. Run it once per
    disk: the file stays. Returns a statement, so it can be explained before it runs. The download
    happens in the call, next to the disk, so the call needs the network (GitHub, by default).

    The archive is checked against a SHA-256 before it is unpacked, and one that does not match
    installs nothing. The hash of the default version is pinned in ``DUCKDB_SHA256``. Another
    ``version``, or an archive at a ``url`` of your own, has to come with its ``sha256``.

    It is the Linux x86-64 build, which is what Archil's exec VMs are. On the local backend SQL uses
    the ``duckdb`` on your PATH and none of this is needed.
    """
    source = url or DUCKDB_URL.format(version=version)
    want = (sha256 or ("" if url else DUCKDB_SHA256.get(version, ""))).lower()
    if not want:
        raise ValidationError(f"no SHA-256 is pinned for {source}: pass sha256 with the archive's hash",
                              code="unpinned_download")
    if not re.fullmatch(r"[0-9a-f]{64}", want):
        raise ValidationError("sha256 has to be the archive's SHA-256, as 64 hex characters", code="bad_sha256")
    return ctx.sh(_DUCKDB_INSTALL, url=source, sum=want, dest=ctx.out(f"{norm(into)}/duckdb"))


__all__ = ["Recipe", "Entry", "Static", "Records", "sync", "git", "duckdb", "DUCKDB_VERSION", "DUCKDB_SHA256"]
