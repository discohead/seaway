"""A backend that needs no account: disks are directories, exec is local bash.

It exists so the framework can be tried and tested anywhere, and so an app
written against it can be developed locally and pointed at Archil unchanged.
It follows Archil's shape closely:

* each call gets a fresh working directory with the mounted disks beneath it,
  at the same relative paths a serverless call sees under ``/mnt/archil``;
* nothing but the disks survives a call;
* stdout and stderr are cut after their first bytes and end with a marker when
  they are, and commands time out.

Mounts are realised in one of two ways. Where unprivileged user namespaces are
available (most Linux hosts), each call runs in its own mount namespace with the
disks bind-mounted, so a read-only mount really is read-only and tools such as
``find`` cross mount points exactly as they do on Archil. Elsewhere (macOS) the
mounts are symlinks: writes to a read-only mount are *detected* after the
command, and ``find``/``du`` need ``-L`` or a path inside the mount to cross them.

An egress policy on a call is enforced only in a namespace, and only bluntly: the
call gets no network at all, whether the policy denies everything or names the
hosts it allows. With symlinks the network stays open.

Checkpoints and branches are full copies here. Archil's are copy-on-write and
take milliseconds at any size.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import KW_ONLY, dataclass, field
from pathlib import Path
from typing import Optional

from .backends import TRUNCATED_MARK, Backend, ExecOutput, GrepHit, Limits, MountSpec, ObjectInfo, Vm
from .errors import ValidationError

RESERVED = ".archil"  # Archil keeps an opaque directory of this name on every disk


@dataclass
class LocalBackend(Backend):
    root: Path = Path(".archil-local")  # the one positional argument: LocalBackend("/some/dir")
    _: KW_ONLY
    name: str = "local"
    limits: Limits = field(default_factory=Limits)
    inside_archil: bool = True
    verify_read_only: bool = True
    isolation: str = "auto"  # "namespace" (bind mounts), "symlink", or "auto" to use namespaces when possible
    capabilities: frozenset = frozenset({"checkpoint", "branch", "grep", "share"})

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()
        (self.root / "disks").mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self.isolation = os.environ.get("ARCHIL_LOCAL_ISOLATION", self.isolation)
        if self.isolation == "auto":
            self.isolation = "namespace" if _namespaces_work() else "symlink"
        self.exec_log: list[dict] = []  # every exec this backend ran: handy in tests

    # -- disks -----------------------------------------------------------
    def _dir(self, disk: str) -> Path:
        return self.root / "disks" / disk

    def _file(self, disk: str, key: str) -> Path:
        return self._dir(disk) / key

    def resolve_disk(self, ref: str, *, create: bool = False) -> str:
        path = self._dir(ref)
        if not path.is_dir():
            if not create:
                raise ValidationError(
                    f"no disk named '{ref}'", code="unknown_disk",
                    suggestion="pass create=True to disk(...) to create it on first use",
                )
            path.mkdir(parents=True)
        return ref

    # -- compute ---------------------------------------------------------
    def exec(self, mounts: dict[str, MountSpec], command: str, vm: Vm) -> ExecOutput:
        if len(command.encode()) > self.limits.max_command_bytes:
            return ExecOutput(1, "", f"command exceeds {self.limits.max_command_bytes} bytes")
        call = self.root / "calls" / uuid.uuid4().hex
        mnt = call / "mnt"
        mnt.mkdir(parents=True)
        namespace = self.isolation == "namespace"
        setup: list[str] = []
        watched: list[tuple[str, Path, dict]] = []
        try:
            for key, spec in sorted(mounts.items(), key=lambda kv: len(kv[0])):
                target = self._dir(spec.disk) / (spec.subdirectory or "")
                if not target.is_dir():
                    if spec.read_only:
                        return ExecOutput(1, "", f"mount failed: {key}: no such directory on {spec.disk}")
                    target.mkdir(parents=True)
                point = mnt / key
                if namespace:
                    point.mkdir(parents=True, exist_ok=True)
                    setup.append(f"mount --bind {shlex.quote(str(target))} {shlex.quote(str(point))}")
                    if spec.read_only:
                        setup.append(f"mount -o remount,bind,ro {shlex.quote(str(point))}")
                else:
                    point.parent.mkdir(parents=True, exist_ok=True)
                    os.symlink(target, point)
                    if spec.read_only and self.verify_read_only:
                        watched.append((key, target, _fingerprint(target)))
            env = dict(os.environ, ARCHIL_ROOT=str(mnt))
            if namespace:
                env["ARCHIL_COMMAND"] = command
                script = " && ".join(setup + [f"cd {shlex.quote(str(mnt))}", 'exec bash -c "$ARCHIL_COMMAND"'])
                offline = ["--net"] if vm.egress is not None else []  # an empty network namespace
                argv = ["unshare", "--user", "--map-root-user", "--mount", *offline, "bash", "-c", script]
            else:
                argv = ["bash", "-c", command]
            started = time.perf_counter()
            try:
                # no stdin, as on Archil: a command that reads it sees the end of input at once
                proc = subprocess.run(argv, cwd=mnt, env=env, capture_output=True, stdin=subprocess.DEVNULL,
                                      timeout=self.limits.exec_timeout_s)
                code, out, err = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired as exc:
                code, out, err, notes = 124, exc.stdout or b"", exc.stderr or b"", "\nExec timed out"
            else:
                notes = ""
            elapsed = (time.perf_counter() - started) * 1000
            for key, target, before in watched:
                changed = _changed(before, _fingerprint(target))
                if changed:
                    code = 30  # EROFS
                    notes += (
                        f"\nRead-only file system: {key}/{changed[0]} was modified. "
                        "(Without mount namespaces the local backend detects this after the command; "
                        "Archil refuses the write.)"
                    )
            stdout, cut_out = _head(out, self.limits.max_output_bytes)
            stderr, cut_err = _head(err, self.limits.max_output_bytes)
            stderr += notes  # the backend's own words, not the command's output: never cut
            self.exec_log.append({"mounts": {k: v.to_dict() for k, v in mounts.items()}, "command": command})
            return ExecOutput(code, stdout, stderr, 0.0, elapsed, elapsed, cut_out or cut_err)
        finally:
            shutil.rmtree(call, ignore_errors=True)

    def grep(self, disk: str, directory: str, pattern: str, **opts) -> tuple[list[GrepHit], str]:
        base = self._dir(disk)
        start = base / directory
        if not start.is_dir():  # search takes a directory, as Archil's does: anything else has no files in it
            return [], "completed"
        limit = int(opts.get("max_results") or self.limits.grep_max_results)
        below = (directory.rstrip("/") + "/") if directory else ""
        hits: list[GrepHit] = []
        if shutil.which("rg"):
            # As Archil's search runs it: hidden files are searched and ignore files are not read.
            # It runs in the directory itself, because that is what globs are relative to.
            cmd = ["rg", "--json", "--no-config", "--hidden", "--no-ignore", "-n"]
            if opts.get("ignore_case"):
                cmd.append("-i")
            if not opts.get("recursive", True):
                cmd += ["--max-depth", "1"]
            for g in opts.get("globs") or []:
                cmd += ["-g", g]
            cmd += ["-e", pattern, "."]
            proc = subprocess.run(cmd, cwd=start, capture_output=True, text=True)
            # rg writes one JSON event per line. Split on "\n" alone: a matched line may itself hold
            # U+2028 or U+0085, which JSON leaves as they are and str.splitlines() would break on.
            for line in proc.stdout.split("\n"):
                if not line:
                    continue
                event = json.loads(line)
                if event.get("type") != "match":
                    continue
                data = event["data"]
                file = below + data["path"]["text"].removeprefix("./")
                if RESERVED in file.split("/"):
                    continue
                hits.append(GrepHit(file, data["line_number"], data["lines"].get("text", "").rstrip("\n")))
                if len(hits) >= limit:
                    return hits, "max_results"
            return hits, "completed"
        # No ripgrep here: the same search in Python. Lines end at "\n", as they do for rg, and
        # globs are matched against the path below the directory, as rg's -g does.
        regex = re.compile(pattern, re.I if opts.get("ignore_case") else 0)
        globs = opts.get("globs") or []
        for info in self.list(disk, directory, recursive=opts.get("recursive", True)):
            if info.key.endswith("/") or not glob_keep(info.key[len(below):] if info.key.startswith(below) else info.key, globs):
                continue
            try:
                raw = self._file(disk, info.key).read_bytes()
            except OSError:
                continue
            if b"\0" in raw:  # a binary file is not searched, as with rg
                continue
            text = raw.decode("utf-8", errors="replace")
            lines = text.split("\n")
            if lines and lines[-1] == "":
                lines.pop()
            for number, line in enumerate(lines, 1):
                if regex.search(line):
                    hits.append(GrepHit(info.key, number, line))
                    if len(hits) >= limit:
                        return hits, "max_results"
        return hits, "completed"

    # -- objects -----------------------------------------------------------
    def get(self, disk: str, key: str) -> bytes:
        try:
            return self._file(disk, key).read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            raise ValidationError(f"no such file: {key}", code="not_found", path=key) from None

    def put(self, disk: str, key: str, data: bytes, *, if_absent: bool = False) -> None:
        path = self._file(disk, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        if if_absent:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            except FileExistsError:
                raise ValidationError(f"already exists: {key}", code="exists", path=key) from None
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            return
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def append(self, disk: str, key: str, data: bytes) -> None:
        if len(data) > self.limits.append_max_bytes:
            raise ValidationError(f"append larger than {self.limits.append_max_bytes} bytes", path=key)
        path = self._file(disk, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "ab") as fh:
            fh.write(data)

    def delete(self, disk: str, key: str) -> None:
        path = self._file(disk, key)
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)

    def list(self, disk: str, prefix: str = "", *, recursive: bool = True) -> list[ObjectInfo]:
        base = self._dir(disk)
        start = base / prefix
        out: list[ObjectInfo] = []
        if start.is_file():
            st = start.stat()
            return [ObjectInfo(prefix, st.st_size, st.st_mtime, _version(st))]
        if not start.is_dir():
            return out
        for dirpath, dirnames, filenames in os.walk(start):
            dirnames[:] = sorted(d for d in dirnames if d != RESERVED)
            if not recursive:
                rel = Path(dirpath).relative_to(base).as_posix()
                out += [ObjectInfo(f"{rel}/{d}/" if rel != "." else f"{d}/", 0) for d in dirnames]
            for name in sorted(filenames):
                full = Path(dirpath) / name
                try:
                    st = full.stat()
                except OSError:
                    continue
                out.append(ObjectInfo(full.relative_to(base).as_posix(), st.st_size, st.st_mtime, _version(st)))
            if not recursive:
                break
        return out

    def head(self, disk: str, key: str) -> Optional[ObjectInfo]:
        path = self._file(disk, key)
        if not path.is_file():
            return None
        st = path.stat()
        return ObjectInfo(key, st.st_size, st.st_mtime, _version(st))

    def share(self, disk: str, key: str, expires_in: int) -> str:
        return self._file(disk, key).as_uri()

    # -- time ----------------------------------------------------------------
    def checkpoint(self, disk: str, name: str) -> str:
        dst = self.root / "checkpoints" / disk / name
        if dst.exists():
            raise ValidationError(f"checkpoint '{name}' already exists on {disk}", code="exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(self._dir(disk), dst, symlinks=True)
        return name

    def branch(self, disk: str, name: str, from_checkpoint: str, *, exist_ok: bool = False) -> str:
        src = self.root / "checkpoints" / disk / from_checkpoint
        if not src.is_dir():
            raise ValidationError(f"no checkpoint '{from_checkpoint}' on {disk}", code="not_found")
        handle = f"{disk}@{name}"
        dst = self._dir(handle)
        if dst.exists():
            if exist_ok:
                return handle
            raise ValidationError(f"branch '{name}' already exists on {disk}", code="exists")
        shutil.copytree(src, dst, symlinks=True)
        return handle

    def commit_lock(self, disk: str):
        with self._guard:
            return self._locks.setdefault(disk.split("@")[0], threading.Lock())


def glob_regex(glob: str) -> "re.Pattern[str]":
    """A ripgrep ``-g`` glob as a regular expression over a path relative to the search directory.

    A glob with no ``/`` matches a file name at any depth; one with a ``/`` matches the whole path
    (a leading ``/`` anchors it). ``*`` and ``?`` stay inside one path segment, ``**`` crosses them,
    ``[...]`` is a character class, ``{a,b}`` is alternation and a backslash makes the next character literal.
    """
    anchored = "/" in glob
    glob = glob.lstrip("/")
    out, i, depth = [], 0, 0
    while i < len(glob):
        c = glob[i]
        if c == "\\" and i + 1 < len(glob):
            out.append(re.escape(glob[i + 1])); i += 2
        elif glob.startswith("**/", i):
            out.append("(?:.*/)?"); i += 3
        elif glob.startswith("**", i):
            out.append(".*"); i += 2
        elif c == "*":
            out.append("[^/]*"); i += 1
        elif c == "?":
            out.append("[^/]"); i += 1
        elif c == "[" and "]" in glob[i + 2:]:
            end = glob.index("]", i + 2)
            body = glob[i + 1:end]
            out.append("[" + ("^" + body[1:] if body[:1] in "!^" else body).replace("\\", "\\\\") + "]"); i = end + 1
        elif c == "{":
            out.append("(?:"); depth += 1; i += 1
        elif c == "}" and depth:
            out.append(")"); depth -= 1; i += 1
        elif c == "," and depth:
            out.append("|"); i += 1
        else:
            out.append(re.escape(c)); i += 1
    return re.compile(("^" if anchored else "(?:^|.*/)") + "".join(out) + ")" * depth + "$")


def glob_keep(rel: str, globs: list) -> bool:
    """Would ripgrep search ``rel`` under these ``-g`` globs? The last glob that matches decides; with
    no match, a file is searched unless some glob asks for files by name (one without a leading ``!``)."""
    keep = not any(not g.startswith("!") for g in globs)
    for g in globs:
        negated = g.startswith("!")
        if glob_regex(g[1:] if negated else g).match(rel):
            keep = not negated
    return keep


_NAMESPACES: Optional[bool] = None


def _version(st) -> str:
    """Modification time in nanoseconds and size, in hex. The TypeScript SDK computes the same string."""
    return f"{st.st_mtime_ns:x}-{st.st_size:x}"


def _namespaces_work() -> bool:
    """Can this host give a call its own mount namespace without privileges?"""
    global _NAMESPACES
    if _NAMESPACES is None:
        try:
            probe = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "true"],
                                   capture_output=True, timeout=10)
            _NAMESPACES = probe.returncode == 0
        except (OSError, subprocess.SubprocessError):
            _NAMESPACES = False
    return _NAMESPACES


def _head(data: bytes, limit: int) -> tuple[str, bool]:
    """A stream as Archil returns it: whole if it fits, else its first bytes and a marker, ``limit`` bytes in all."""
    if len(data) <= limit:
        return data.decode("utf-8", errors="replace"), False
    mark = TRUNCATED_MARK.encode()
    return (data[: max(0, limit - len(mark))] + mark).decode("utf-8", errors="replace"), True


def _fingerprint(root: Path, cap: int = 20_000) -> dict:
    seen: dict = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = Path(dirpath) / name
            try:
                st = full.stat()
            except OSError:
                continue
            seen[full.relative_to(root).as_posix()] = (st.st_size, st.st_mtime_ns)
            if len(seen) >= cap:
                return seen
    return seen


def _changed(before: dict, after: dict) -> list[str]:
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
