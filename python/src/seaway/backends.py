"""The small set of operations a backend must provide.

Everything the framework does compiles down to these calls. They mirror what
Archil exposes today: object reads and writes through the S3-compatible API,
``exec`` with a mount map, parallel ``grep``, checkpoints and branches.

Two backends ship with the prototype:

* ``LocalBackend`` runs the same plans on plain directories and local bash, so
  the API can be tried, tested and developed against without an account.
* ``ArchilBackend`` sends them to Archil through the official ``archil`` SDK.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .errors import NotSupported, ValidationError

# How a stream that was cut ends. Archil keeps the first bytes of stdout and of stderr and writes this
# after them; the local backend does the same, so a reducer or a reader sees one behaviour.
TRUNCATED_MARK = "\n[output truncated]"


@dataclass(frozen=True)
class MountSpec:
    """One disk as a single call sees it. Field for field, Archil's exec mount spec."""

    disk: str
    subdirectory: Optional[str] = None
    read_only: bool = False
    conditional: bool = False
    checkout_paths: tuple[str, ...] = ()
    queue_ms: Optional[int] = None

    def to_dict(self) -> dict:
        d: dict = {"disk": self.disk, "readOnly": self.read_only, "conditional": self.conditional}
        if self.subdirectory:
            d["subdirectory"] = self.subdirectory
        if self.checkout_paths:
            d["checkoutPaths"] = list(self.checkout_paths)
        if self.queue_ms is not None:
            d["queueMs"] = self.queue_ms
        return d

    def describe(self) -> str:
        where = f"{self.disk}:/{self.subdirectory}" if self.subdirectory else self.disk
        if self.read_only:
            how = "read-only"
        elif self.conditional:
            how = "read-write, conditional"
        elif self.checkout_paths:
            how = "read-write, checkout " + ", ".join("/" + p for p in self.checkout_paths)
        else:
            how = "read-write, checkout /"
        return f"{where} ({how})"


def egress_policy(value) -> Optional[tuple[str, ...]]:
    """Normalise an egress setting: ``None`` or ``"allow"`` (the network is open, Archil's default),
    ``"deny"`` (nothing leaves), or a list of hosts (only those are reachable).

    The result is ``None`` for open, ``()`` for deny, or the allowed hosts.
    """
    if value is None or value == "allow":
        return None
    if value == "deny":
        return ()
    if isinstance(value, str) or not all(isinstance(h, str) and h for h in value):
        raise ValidationError(f"cannot read {value!r} as an egress policy", code="bad_egress",
                              suggestion="use 'deny', 'allow', or a list of hosts such as ['pypi.org']")
    return tuple(value)


@dataclass(frozen=True)
class Vm:
    vcpu: int = 2
    mem_mib: int = 4096
    image: Optional[str] = None
    egress: Optional[tuple[str, ...]] = None  # None: open. (): nothing leaves. hosts: only these.

    def to_dict(self) -> dict:
        d: dict = {"vcpuCount": self.vcpu, "memSizeMib": self.mem_mib}
        if self.image:
            d["baseImage"] = self.image
        if self.egress is not None:  # the shape Archil's exec takes as `network`
            policy: dict = {"default": "deny"}
            if self.egress:
                policy["allow"] = list(self.egress)
            d["network"] = {"egress": policy}
        return d

    def describe_egress(self) -> str:
        if self.egress is None:
            return ""
        return "egress only to " + ", ".join(self.egress) if self.egress else "egress denied"


@dataclass
class ExecOutput:
    exit_code: int
    stdout: str
    stderr: str
    queue_ms: float = 0.0
    execute_ms: float = 0.0
    total_ms: float = 0.0
    truncated: bool = False


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    size: int
    modified: float = 0.0  # seconds since the epoch
    etag: str = ""  # a version identifier, when the backend has one

    @property
    def version(self) -> str:
        """A string that changes when the content changes: the etag, or failing that the modification time."""
        return self.etag or repr(self.modified)


@dataclass(frozen=True)
class GrepHit:
    file: str
    line: int
    text: str


@dataclass(frozen=True)
class Limits:
    """Platform limits the planner designs around. Defaults follow Archil's documentation."""

    max_command_bytes: int = 100 * 1024
    max_output_bytes: int = 4 * 1024 * 1024  # per stream; the first bytes are kept, then TRUNCATED_MARK
    exec_timeout_s: float = 300.0
    max_parallel: int = 64  # "hundreds" by default on Archil; kept modest here
    append_max_bytes: int = 1024 * 1024
    grep_max_results: int = 1000
    checkout_queue_ms: int = 5000


@dataclass(kw_only=True)
class Backend:
    """Base class. Optional features raise ``NotSupported`` with a reason.

    These fields are passed by keyword only. A dataclass puts its base class's fields first, so
    were they positional, ``LocalBackend("/some/dir")`` would set ``name`` and leave the root where
    it was. A backend that declares one of them again has to keep it keyword-only (``KW_ONLY``).
    """

    name: str = "backend"
    limits: Limits = field(default_factory=Limits)
    inside_archil: bool = True  # False when the caller is outside Archil and reads pay egress
    capabilities: frozenset = frozenset()
    # What one checkpoint bills as. Archil has no REST call for a checkpoint yet, so it is taken by
    # an exec, which is one call. The local backend prices it the same way.
    checkpoint_calls = 1
    # How coarse a file's version is, in seconds. 0 means every write changes it. Archil's is 1: a
    # file rewritten in place, at the same size, twice within one second keeps the same version.
    version_granularity_s = 0.0

    # -- disks -----------------------------------------------------------
    def resolve_disk(self, ref: str, *, create: bool = False) -> str:
        raise NotImplementedError

    # -- compute next to the data -----------------------------------------
    def exec(self, mounts: dict[str, MountSpec], command: str, vm: Vm) -> ExecOutput:
        raise NotImplementedError

    def grep(self, disk: str, directory: str, pattern: str, **opts) -> tuple[list[GrepHit], str]:
        raise NotImplementedError

    # -- objects (the data plane) ----------------------------------------
    def get(self, disk: str, key: str) -> bytes:
        raise NotImplementedError

    def put(self, disk: str, key: str, data: bytes, *, if_absent: bool = False) -> None:
        raise NotImplementedError

    def append(self, disk: str, key: str, data: bytes) -> None:
        raise NotImplementedError

    def delete(self, disk: str, key: str) -> None:
        """Remove a file, or a directory and everything under it. A key that is not there is not an error."""
        raise NotImplementedError

    def list(self, disk: str, prefix: str = "", *, recursive: bool = True) -> list[ObjectInfo]:
        """Files under ``prefix``. When not recursive, sub-directories are returned too, as keys ending in ``/``."""
        raise NotImplementedError

    def head(self, disk: str, key: str) -> Optional[ObjectInfo]:
        raise NotImplementedError

    def share(self, disk: str, key: str, expires_in: int) -> str:
        raise NotSupported(f"{self.name} cannot create share links")

    # -- time ----------------------------------------------------------------
    def checkpoint(self, disk: str, name: str) -> str:
        raise NotSupported(f"{self.name} cannot create checkpoints")

    def branch(self, disk: str, name: str, from_checkpoint: str, *, exist_ok: bool = False) -> str:
        """Create a writable copy-on-write fork and return a disk handle for it."""
        raise NotSupported(f"{self.name} cannot create branches")

    def commit_lock(self, disk: str):
        """A context manager held while a transaction validates and applies.

        On Archil the storage layer provides this: the commit runs under a
        checkout of the paths it writes. Backends without that need their own lock.
        """
        import contextlib

        return contextlib.nullcontext()
