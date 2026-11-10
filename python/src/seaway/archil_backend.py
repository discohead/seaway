"""The backend that talks to Archil, through the official ``archil`` SDK.

Every plan compiles to calls that exist today:

==================  ========================================================
framework           Archil
==================  ========================================================
a task              ``client.exec(disks={path: ExecMountSpec(...)}, command=...)``
grep                ``disk.grep(directory=..., pattern=..., recursive=True)``
read / write        ``disk.get_object`` / ``disk.put_object`` (the S3-compatible API)
append              ``disk.append_object`` (server-side, at most 1 MiB, never retried)
ls / expand         ``disk.list_objects`` (metadata only)
branch              ``disk.create_branch(name, from_checkpoint)``
checkpoint          ``archil checkpoints create`` run inside an exec
==================  ========================================================

Status. This module is written against ``archil`` 0.21.0. It was first run
against a live account on 9 November 2026 (aws-us-west-2, Developer plan), and
what that run found is written into the code below:

* ``archil checkpoints create <mountpoint> <name>`` works from inside a
  serverless exec, on a mount that is not read-only, and a branch can be made
  from the checkpoint straight after.
* A branch's ``filesystem_id`` is an ordinary disk id: it mounts in an exec and
  reads through the object API.
* Archil runs a command with ``/bin/sh``. Statements are bash, as they are on
  the local backend, so the command is handed to bash (see ``wrap``).
* An ETag follows a file's content only when the file was written through the
  object API. A file rewritten in place through a mount keeps its old ETag, so a
  version here is the ETag *and* the modification time (see ``_version``).
* ``checkout_paths`` / ``queue_ms`` do not reach exec from Python: ``archil``
  0.21.0 has neither on its mount spec (the TypeScript client has both). A
  checkout is therefore taken by running ``archil checkout`` at the start of
  the command, retried until ``queue_ms`` has passed. The CLI is only in
  Archil's own exec image, so with ``sized(image=...)`` an ``owned`` mount
  cannot be written from Python.

A plan addresses files relative to the directory its disks are mounted under
(``cat ref/docs/a.md``), so every command starts in ``/mnt/archil``, which is
what the official agent tools do.

A few failures that are not the command's own are reported the way the local
backend reports them, as a result with an exit code, so code written against
one backend reads the same on the other: a mount that cannot be made (exit 1),
a checkout that could not be taken in time (exit 30), and a command that ran
past the time limit (exit 124).
"""

from __future__ import annotations

import dataclasses
import math
import os
from dataclasses import KW_ONLY, dataclass, field
from typing import Any, Optional

from .backends import TRUNCATED_MARK, Backend, ExecOutput, GrepHit, Limits, MountSpec, ObjectInfo, Vm
from .errors import Busy, NotSupported, ValidationError
from .shell import quote

EXEC_ROOT = "/mnt/archil"  # where a multi-disk exec mounts its disks
NO_CHECKOUT = "archil: could not take checkout"  # how a statement that never got its checkout ends


def wrap(command: str, prelude: str = "") -> str:
    """The text sent to Archil for ``command``: start where the disks are mounted, then run it with bash.

    Archil runs a command with ``/bin/sh``, which is dash on its image: no ``[[ ]]``, no
    ``set -o pipefail``, no process substitution. The command travels in a quoted here-document, so
    nothing in it is read by the outer shell and its size does not grow, and is handed to bash
    unchanged. An image without bash runs it with its own ``sh``. ``prelude`` is plain sh run first.
    """
    mark = "PX_EOF"
    lines = set(command.split("\n"))
    while mark in lines:
        mark += "_"
    return (
        f"cd {EXEC_ROOT} || exit 1\n"
        f"{prelude}"
        f"px_script=$(cat <<'{mark}'\n{command}\n{mark}\n)\n"
        'if command -v bash >/dev/null 2>&1; then exec bash -c "$px_script"; else exec sh -c "$px_script"; fi'
    )


def checkout_prelude(paths: list[str], queue_ms: int) -> str:
    """Take a checkout of each path before the command starts, waiting in line for up to ``queue_ms``.

    This is what the TypeScript client's ``queueMs`` does on the mount itself. From Python it has to
    be done with the CLI, which only Archil's own exec image has.
    """
    wait = max(1, math.ceil(queue_ms / 1000))
    steps = [
        "command -v archil >/dev/null 2>&1 || { "
        f"echo '{NO_CHECKOUT}: this image has no archil CLI, and the Python client cannot ask for a checkout "
        "any other way. Use the default image, or mount the disk as shared.' >&2; exit 30; }",
        f"px_end=$(( $(date +%s) + {wait} ))",
    ]
    for path in paths:
        steps.append(
            f"until px_err=$(archil checkout {quote(path)} 2>&1); do "
            'if [ "$(date +%s)" -ge "$px_end" ]; then '
            f"echo \"{NO_CHECKOUT} of \"{quote(path)}\" within {wait}s: $(printf '%s' \"$px_err\" | head -n 1)\" >&2; "
            "exit 30; fi; sleep 0.2; done"
        )
    return "\n".join(steps) + "\n"


@dataclass
class ArchilBackend(Backend):
    client: Any = None  # the one positional argument: ArchilBackend(client)
    _: KW_ONLY
    api_key: Optional[str] = None
    region: Optional[str] = None
    name: str = "archil"
    limits: Limits = field(default_factory=Limits)
    inside_archil: bool = False  # set True when the caller runs in an Archil sandbox (no egress charge)
    capabilities: frozenset = frozenset({"grep", "share", "checkpoint", "branch"})
    exec_timeout_s: float = 330.0  # the SDK's default request timeout is shorter than the longest exec
    version_granularity_s = 1.0  # a listing reports modification times in whole seconds: see _version

    def __post_init__(self) -> None:
        try:
            import archil  # the official SDK
        except ImportError:  # pragma: no cover
            raise NotSupported("the Archil backend needs the official SDK",
                               suggestion="pip install archil") from None
        self._sdk = archil
        if self.client is None:
            self.client = archil.Archil(api_key=self.api_key, region=self.region, timeout=self.exec_timeout_s)
        self._disks: dict[str, Any] = {}
        self._spec_fields = {f.name for f in dataclasses.fields(archil.ExecMountSpec)}

    # -- disks -----------------------------------------------------------
    def _disk(self, handle: str):
        if handle not in self._disks:
            self._disks[handle] = self.client.disks.get(handle)
        return self._disks[handle]

    def resolve_disk(self, ref: str, *, create: bool = False) -> str:
        if ref.startswith("dsk-"):
            return ref
        found = self.client.disks.list(name=ref)
        if found:
            self._disks[found[0].id] = found[0]
            return found[0].id
        if not create:
            raise ValidationError(f"no disk named '{ref}' in this region", code="unknown_disk",
                                  suggestion="pass create=True to disk(...), or use its dsk- id")
        created = self.client.disks.create(name=ref).disk
        self._disks[created.id] = created
        return created.id

    # -- compute ---------------------------------------------------------
    def _mount(self, spec: MountSpec):
        kw: dict[str, Any] = {"subdirectory": spec.subdirectory, "read_only": spec.read_only,
                              "conditional": spec.conditional}
        native_checkout = "queue_ms" in self._spec_fields
        if native_checkout:
            if spec.queue_ms is not None:
                kw["queue_ms"] = spec.queue_ms
            if spec.checkout_paths:
                kw["checkout_paths"] = list(spec.checkout_paths)
        return self._sdk.ExecMountSpec(spec.disk, **kw), native_checkout

    def exec(self, mounts: dict[str, MountSpec], command: str, vm: Vm) -> ExecOutput:
        disks: dict[str, Any] = {}
        checkouts: list[str] = []
        queue_ms = self.limits.checkout_queue_ms
        for path, spec in mounts.items():
            disks[path], native = self._mount(spec)
            wants_checkout = not spec.read_only and not spec.conditional
            if wants_checkout and not native:
                checkouts += [f"{path}/{p}" for p in spec.checkout_paths] or [path]
                queue_ms = spec.queue_ms if spec.queue_ms is not None else queue_ms
        kw: dict[str, Any] = {}
        if vm.vcpu != 2:
            kw["vcpu_count"] = vm.vcpu
        if vm.mem_mib != 4096:
            kw["mem_size_mib"] = vm.mem_mib
        if vm.image:
            kw["base_image"] = vm.image
        if vm.egress is not None:
            policy = self._sdk.SandboxEgressPolicy(default="deny", allow=list(vm.egress) or None)
            kw["network"] = self._sdk.SandboxNetwork(egress=policy)
        wire = wrap(command, checkout_prelude(checkouts, queue_ms) if checkouts else "")
        if len(wire.encode()) > self.limits.max_command_bytes:
            return ExecOutput(1, "", f"command exceeds {self.limits.max_command_bytes} bytes")
        try:
            res = self.client.exec(disks=disks, command=wire, **kw)
        except self._sdk.ArchilApiError as exc:
            failed = _not_started(exc)
            if failed is None:
                raise
            return failed
        cut = self._cut(res.stdout) or self._cut(res.stderr)
        return ExecOutput(res.exit_code, res.stdout, res.stderr, res.timing.queue_ms,
                          res.timing.execute_ms, res.timing.total_ms, cut)

    def _cut(self, text: str) -> bool:
        """Archil keeps the first bytes of a stream and ends it with a marker when it drops the rest."""
        return text.endswith(TRUNCATED_MARK.strip()) and len(text.encode()) >= self.limits.max_output_bytes - 8

    def grep(self, disk: str, directory: str, pattern: str, **opts) -> tuple[list[GrepHit], str]:
        kw = {k: v for k, v in opts.items() if k in ("recursive", "ignore_case", "globs", "max_results") and v is not None}
        res = self._disk(disk).grep(directory=directory, pattern=pattern, **kw)
        return [GrepHit(m.file, m.line, m.text) for m in res.matches], res.stopped_reason

    # -- objects -----------------------------------------------------------
    def _write(self, key: str, call):
        """Run one write through the object API. A path under someone's checkout is ``Busy``, not a raw 409."""
        try:
            return call()
        except self._sdk.ArchilS3Error as exc:
            if getattr(exc, "status", None) == 409:
                raise Busy(f"another client holds a checkout that covers {key}", path=key,
                           suggestion="retry when the statement writing this disk has finished, "
                                      "or mount the disk as 'shared'") from None
            raise

    def get(self, disk: str, key: str) -> bytes:
        try:
            return self._disk(disk).get_object(key)
        except self._sdk.ArchilS3Error as exc:
            if getattr(exc, "status", None) == 404:
                raise ValidationError(f"no such file: {key}", code="not_found", path=key) from None
            raise

    def put(self, disk: str, key: str, data: bytes, *, if_absent: bool = False) -> None:
        d = self._disk(disk)
        if if_absent and d.object_exists(key):
            # The S3 API supports a create-only put (If-None-Match: *); the SDK does not expose it
            # yet, so this check is not atomic.
            raise ValidationError(f"already exists: {key}", code="exists", path=key)
        self._write(key, lambda: d.put_object(key, data))

    def append(self, disk: str, key: str, data: bytes) -> None:
        if len(data) > self.limits.append_max_bytes:
            raise ValidationError(f"append larger than {self.limits.append_max_bytes} bytes", path=key)
        d = self._disk(disk)
        self._write(key, lambda: d.append_object(key, data))

    def delete(self, disk: str, key: str) -> None:
        d = self._disk(disk)
        key = key.rstrip("/")
        if not key:
            raise ValidationError("refusing to delete everything on a disk", code="bad_path",
                                  suggestion="name a file or a directory below the mount")
        self._write(key, lambda: d.delete_object(key))
        # The key may be a directory, which the object API only removes once it is empty: its files
        # first, then the directories themselves, deepest first.
        below = d.list_objects(key + "/", recursive=True).objects
        if not below:
            return
        files = [o.key for o in below if not o.key.endswith("/")]
        if files:
            failed = self._write(key, lambda: d.delete_objects(files)).errors
            if failed:
                first = failed[0]
                if getattr(first, "code", None) == "OperationAborted":
                    raise Busy(f"another client holds a checkout that covers {first.key}", path=first.key,
                               suggestion="retry when the statement writing this disk has finished")
                raise ValidationError(f"could not delete {first.key}: {first.message}", code="delete_failed",
                                      path=first.key)
        markers = {o.key for o in below if o.key.endswith("/")} | {key + "/"}
        for marker in sorted(markers, key=len, reverse=True):
            self._write(marker, lambda marker=marker: d.delete_object(marker))

    def _info(self, key: str, meta: Any) -> ObjectInfo:
        modified = _epoch(meta.last_modified)
        return ObjectInfo(key, meta.size, modified, _version(meta.etag, modified))

    def list(self, disk: str, prefix: str = "", *, recursive: bool = True) -> list[ObjectInfo]:
        # S3 prefixes match by string, so "logs/api" would also match "logs/api-old". Ask for the
        # directory, and for the file of that exact name.
        d = self._disk(disk)
        out: list[ObjectInfo] = []
        if prefix:
            meta = d.head_object(prefix)
            if meta is not None:
                return [self._info(prefix, meta)]
        res = d.list_objects(prefix.rstrip("/") + "/" if prefix else None, recursive=recursive)
        if not recursive:
            out += [ObjectInfo(p if p.endswith("/") else p + "/", 0) for p in res.common_prefixes
                    if not p.startswith(".archil/")]
        # a listing also carries an entry for each directory, as a key ending in "/"
        out += [self._info(o.key, o) for o in res.objects
                if not o.key.endswith("/") and not o.key.startswith(".archil/")]
        return out

    def head(self, disk: str, key: str) -> Optional[ObjectInfo]:
        meta = self._disk(disk).head_object(key)
        return None if meta is None else self._info(key, meta)

    def share(self, disk: str, key: str, expires_in: int) -> str:
        return self._disk(disk).share(key, expires_in=expires_in).url

    # -- time ----------------------------------------------------------------
    def checkpoint(self, disk: str, name: str) -> str:
        # Not read-only: Archil refuses a checkpoint from a read-only mount. Conditional, so that
        # taking one never waits for, or takes, a checkout.
        out = self.exec({"disk": MountSpec(disk, conditional=True)},
                        f"archil checkpoints create disk {quote(name)}", Vm())
        if out.exit_code != 0:
            said = out.stderr.strip()[-200:]
            if "InvalidArguments" in said:
                raise ValidationError(
                    f"Archil refused the checkpoint name '{name}' on {disk}", code="bad_checkpoint",
                    suggestion="a checkpoint name has to be new on its disk, and made of letters, digits, - and _")
            raise NotSupported(f"could not checkpoint {disk}: {said}",
                               suggestion="checkpoints need an Archil-managed disk in an AWS region")
        return name

    def branch(self, disk: str, name: str, from_checkpoint: str, *, exist_ok: bool = False) -> str:
        d = self._disk(disk)
        try:
            return d.create_branch(name, from_checkpoint).filesystem_id
        except self._sdk.ArchilApiError as exc:
            status = getattr(exc, "status", None)
            if status == 404:
                raise ValidationError(f"no checkpoint '{from_checkpoint}' on {disk}", code="not_found") from None
            if exist_ok and status == 409:
                # 409 is also what a checkpoint that has not finished committing gets; then there is
                # no branch of this name to return, and the first error is the one to report
                try:
                    return d.get_branch(name).filesystem_id
                except self._sdk.ArchilApiError:
                    raise exc from None
            raise


def _epoch(value: Any) -> float:
    return value.timestamp() if value is not None and hasattr(value, "timestamp") else 0.0


def _version(etag: Optional[str], modified: float) -> str:
    """A string that changes whenever the file's content can have changed.

    On Archil an ETag is the hash of the content only for a file written through the object API. A
    file written through a mount gets an ETag when it is created and keeps it while it is rewritten
    in place; only its modification time moves, and a listing reports that in whole seconds. So the
    version is both. Two rewrites of the same size inside one second still look alike.
    """
    return f"{etag}@{int(modified)}" if etag else ""


def _not_started(exc: Exception) -> Optional[ExecOutput]:
    """A call Archil answered with an error instead of a result, as the result the local backend gives."""
    status, said = getattr(exc, "status", None), str(exc)
    if status == 504:
        return ExecOutput(124, "", "Exec timed out")
    if status == 400 and "subdirectory does not exist" in said:
        return ExecOutput(1, "", f"mount failed: {said}")
    if status == 400 and "delegation" in said and ("queued" in said or "timed out" in said):
        return ExecOutput(30, "", f"{NO_CHECKOUT}: {said}")
    return None


def from_env() -> ArchilBackend:
    return ArchilBackend(api_key=os.environ.get("ARCHIL_API_KEY"), region=os.environ.get("ARCHIL_REGION"))


__all__ = ["ArchilBackend", "from_env", "wrap", "checkout_prelude"]
