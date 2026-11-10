"""A plan is what a statement will do, written down before it does it.

It answers the four questions a harness author settles by hand today:

* **route** – how the work reaches the data (an exec call, parallel grep, …)
* **scope** – which disks the call can see, and whether it can change them
* **split** – how many calls, over which inputs, and how results are combined
* **price** – what it will cost on each meter

A plan is plain data. ``plan.to_dict()`` is the shape a server-side planner
could accept in place of the calls the client makes today.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional

from .backends import MountSpec, Vm
from .pricing import Estimate, fmt_bytes, fmt_usd


def canonical(value) -> str:
    """JSON with sorted keys and no spaces. Both SDKs hash this form, so they agree on a plan's identity."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class Task:
    """One call: a command and the mount map it runs under. The same shape as an exec request."""

    command: str
    mounts: dict[str, MountSpec]
    label: str = ""

    def to_dict(self) -> dict:
        return {"command": self.command, "disks": {k: v.to_dict() for k, v in self.mounts.items()}}


@dataclass
class Plan:
    kind: str
    route: str
    statement: str
    tasks: list[Task]
    vm: Vm = field(default_factory=Vm)
    reads: list[str] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)
    reduce: Optional[str] = None
    estimate: Estimate = field(default_factory=Estimate)
    notes: list[str] = field(default_factory=list)
    files: int = 0
    parallel: int = 1
    unmounted: list[str] = field(default_factory=list)
    read_paths: Optional[list[str]] = None  # reads as paths and globs, when ``reads`` holds display labels

    @property
    def hash(self) -> str:
        body = {
            "kind": self.kind, "statement": self.statement, "vm": self.vm.to_dict(),
            "reduce": self.reduce, "tasks": [t.to_dict() for t in self.tasks],
        }
        return hashlib.sha256(canonical(body).encode()).hexdigest()[:12]

    def to_dict(self) -> dict:
        return {
            "plan": 0,
            "hash": self.hash,
            "kind": self.kind,
            "route": self.route,
            "statement": self.statement,
            "vm": self.vm.to_dict(),
            "parallel": self.parallel,
            "reduce": self.reduce,
            "effects": {"reads": self.reads if self.read_paths is None else self.read_paths, "writes": self.writes},
            "tasks": [t.to_dict() for t in self.tasks],
            "estimate": self.estimate.to_dict(),
            "notes": self.notes,
        }

    def __str__(self) -> str:
        e = self.estimate
        n = len(self.tasks)
        head = f"plan {self.hash}  {self.kind}"
        if self.files:
            head += f" · {self.files} file(s), {fmt_bytes(e.bytes_touched)}"
        head += f" · {n} call{'s' if n != 1 else ''}"
        if self.reduce and n > 1:
            head += f", combined by {self.reduce}"
        lines = [head]

        if self.route == "exec":
            size = f"{self.vm.vcpu} vCPU / {self.vm.mem_mib // 1024} GiB"
            route = f"exec · {size}" + (f" · image {self.vm.image}" if self.vm.image else "")
            if self.vm.egress is not None:
                route += f" · {self.vm.describe_egress()}"
            if n > 1:
                route += f" · up to {min(n, self.parallel)} at once"
        elif self.route == "grep":
            route = "grep · one call per disk, fanned out next to the data"
        else:
            route = self.route
        lines.append(f"  route   {route}")

        mounts: dict[str, MountSpec] = {}
        for task in self.tasks:
            mounts.update(task.mounts)
        scope = [f"{key} → {spec.describe()}" for key, spec in mounts.items()] or ["nothing mounted: nothing to run"]
        if self.unmounted:
            scope.append("not mounted: " + ", ".join(self.unmounted))
        lines.append("  scope   " + scope[0])
        lines += [f"          {s}" for s in scope[1:]]

        nothing = "—" if self.writes or not self.tasks else "— (not declared)"
        lines.append("  reads   " + (", ".join(self.reads) if self.reads else nothing))
        lines.append("  writes  " + (", ".join(self.writes) if self.writes else "—"))

        price = f"{e.call_units} call unit{'s' if e.call_units != 1 else ''} {fmt_usd(e.usd_calls)}"
        if e.bytes_touched:
            price += f" + {fmt_bytes(e.bytes_touched)} active for an hour {fmt_usd(e.usd_active)}"
        if e.egress_bytes:
            price += f" + {fmt_bytes(e.egress_bytes)} egress {fmt_usd(e.usd_egress)}"
        price += f" ≈ {fmt_usd(e.usd)}" + ("" if e.complete else " (input size unknown)")
        lines.append(f"  price   {price}")
        for note in self.notes:
            lines.append(f"  note    {note}")
        return "\n".join(lines)
