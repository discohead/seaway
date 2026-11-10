"""What a statement costs, worked out before it runs.

The numbers come from Archil's public price sheet as read in November 2026.
They are estimates: the invoice is the authority. Every figure can be
overridden by passing your own ``PriceSheet`` to ``context(...)``.

The model has three meters, because those are the three a statement can move:

* **calls** – each exec, grep or SQLite query is one serverless tool call.
  A call on a VM larger than the default bills as a multiple of one call.
* **active data** – bytes a statement reads or writes stay on the SSD tier for
  about an hour and are billed at the active rate for that hour.
* **egress** – bytes that leave Archil. Free when the caller runs inside Archil.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Callable, Optional

from .errors import BudgetExceeded

GIB = 1024**3
GB = 1000**3


@dataclass(frozen=True)
class PriceSheet:
    as_of: str = "2026-11"
    source: str = "https://archil.com/pricing"
    call_usd: float = 0.05 / 1000  # per default-size serverless tool call
    call_vcpu: int = 2
    call_mem_mib: int = 4096
    active_gib_month_usd: float = 0.20
    archive_gb_month_usd: float = 0.025
    sandbox_vcpu_hour_usd: float = 0.055
    sandbox_gib_hour_usd: float = 0.020
    egress_gb_usd: float = 0.07
    active_window_hours: float = 1.0  # data stays "active" about an hour after a touch
    hours_per_month: float = 730.0

    def call_units(self, vcpu: int = 2, mem_mib: int = 4096) -> int:
        """A larger VM bills as the larger of its vCPU or memory multiple, rounded up."""
        return max(1, math.ceil(max(vcpu / self.call_vcpu, mem_mib / self.call_mem_mib)))

    def active_usd(self, nbytes: int) -> float:
        """Cost of keeping ``nbytes`` active for one active window."""
        return (nbytes / GIB) * self.active_gib_month_usd * self.active_window_hours / self.hours_per_month

    def egress_usd(self, nbytes: int) -> float:
        return (nbytes / GB) * self.egress_gb_usd

    def sandbox_hour_usd(self, vcpu: int, mem_mib: int) -> float:
        return vcpu * self.sandbox_vcpu_hour_usd + (mem_mib / 1024) * self.sandbox_gib_hour_usd

    def breakeven_calls_per_hour(self, vcpu: int = 2, mem_mib: int = 4096) -> int:
        """Calls per hour above which a warm sandbox of this size is cheaper than per-call execution."""
        return int(self.sandbox_hour_usd(vcpu, mem_mib) / self.call_usd)


@dataclass(frozen=True)
class Estimate:
    """The predicted cost of a plan. ``complete`` is False when sizes were unknown."""

    calls: int = 0
    call_units: int = 0
    bytes_touched: int = 0
    egress_bytes: int = 0
    usd_calls: float = 0.0
    usd_active: float = 0.0
    usd_egress: float = 0.0
    complete: bool = True

    @property
    def usd(self) -> float:
        return self.usd_calls + self.usd_active + self.usd_egress

    def __add__(self, other: "Estimate") -> "Estimate":
        return Estimate(
            self.calls + other.calls,
            self.call_units + other.call_units,
            self.bytes_touched + other.bytes_touched,
            self.egress_bytes + other.egress_bytes,
            self.usd_calls + other.usd_calls,
            self.usd_active + other.usd_active,
            self.usd_egress + other.usd_egress,
            self.complete and other.complete,
        )

    def since(self, earlier: "Estimate") -> "Estimate":
        """What was added after ``earlier``, for a budget that starts counting part-way through a session."""
        return Estimate(
            self.calls - earlier.calls,
            self.call_units - earlier.call_units,
            self.bytes_touched - earlier.bytes_touched,
            self.egress_bytes - earlier.egress_bytes,
            self.usd_calls - earlier.usd_calls,
            self.usd_active - earlier.usd_active,
            self.usd_egress - earlier.usd_egress,
            self.complete,
        )

    def to_dict(self) -> dict:
        return {
            "calls": self.calls,
            "callUnits": self.call_units,
            "bytesTouched": self.bytes_touched,
            "egressBytes": self.egress_bytes,
            "usd": round(self.usd, 8),
            "usdCalls": round(self.usd_calls, 8),
            "usdActive": round(self.usd_active, 8),
            "usdEgress": round(self.usd_egress, 8),
            "complete": self.complete,
        }


def estimate(
    prices: PriceSheet,
    *,
    calls: int = 0,
    units_per_call: int = 1,
    bytes_touched: int = 0,
    egress_bytes: int = 0,
    complete: bool = True,
) -> Estimate:
    units = calls * units_per_call
    return Estimate(
        calls=calls,
        call_units=units,
        bytes_touched=bytes_touched,
        egress_bytes=egress_bytes,
        usd_calls=units * prices.call_usd,
        usd_active=prices.active_usd(bytes_touched),
        usd_egress=prices.egress_usd(egress_bytes),
        complete=complete,
    )


@dataclass(frozen=True)
class Budget:
    """A ceiling checked before anything runs. ``None`` means no limit on that meter."""

    max_usd: Optional[float] = None
    max_calls: Optional[int] = None
    max_bytes_touched: Optional[int] = None

    def check(self, est: Estimate, spent: Optional[Estimate] = None) -> None:
        total = est + spent if spent else est
        over = []
        if self.max_usd is not None and total.usd > self.max_usd:
            over.append(f"${total.usd:.5f} > ${self.max_usd:.5f}")
        if self.max_calls is not None and total.call_units > self.max_calls:
            over.append(f"{total.call_units} calls > {self.max_calls}")
        if self.max_bytes_touched is not None and total.bytes_touched > self.max_bytes_touched:
            over.append(f"{fmt_bytes(total.bytes_touched)} touched > {fmt_bytes(self.max_bytes_touched)}")
        if over:
            raise BudgetExceeded(
                "plan exceeds budget: " + "; ".join(over),
                suggestion="narrow the paths, use grep() for regex search, or raise the budget",
            )


@dataclass
class Ledger:
    """Running total of what a context has actually sent. Thread-safe.

    Calls add up. Active data does not: a file stays active for about an hour after its last
    touch, however many statements touch it in that hour. So the ledger remembers when this session
    last touched each file. A first touch pays for the whole window; a later one pays only for the
    time it adds. ``bytes_touched`` in the total is what the session made active, counted once.
    """

    prices: PriceSheet
    total: Estimate = field(default_factory=Estimate)
    statements: int = 0
    clock: Callable[[], float] = time.time
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _warm: dict = field(default_factory=dict, repr=False)  # path -> when this session last touched it

    def warm(self, files: dict) -> tuple[int, float]:
        """Record a touch of ``files`` (path -> size). Returns the bytes it newly made active and
        what the touch adds to the active-data bill."""
        window = self.prices.active_window_hours * 3600.0
        now, fresh, usd = self.clock(), 0, 0.0
        with self._lock:
            for path, size in files.items():
                last = self._warm.get(path)
                idle = window if last is None else max(0.0, now - last)
                if idle >= window:
                    fresh += size
                if window > 0:
                    usd += self.prices.active_usd(size) * min(window, idle) / window
                self._warm[path] = now
        return fresh, usd

    def add(self, est: Estimate, *, statement: bool = True) -> None:
        with self._lock:
            self.total = self.total + est
            if statement:
                self.statements += 1

    def snapshot(self) -> Estimate:
        with self._lock:
            return replace(self.total)

    def __str__(self) -> str:
        t = self.snapshot()
        return (
            f"{self.statements} statement(s): {t.call_units} call unit(s) {fmt_usd(t.usd_calls)}, "
            f"{fmt_bytes(t.bytes_touched)} kept active {fmt_usd(t.usd_active)}, "
            f"{fmt_bytes(t.egress_bytes)} egress {fmt_usd(t.usd_egress)}; total ≈ {fmt_usd(t.usd)}"
        )


def fmt_bytes(n: int) -> str:
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{int(value)} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{n} B"


def fmt_usd(x: float) -> str:
    if x == 0:
        return "$0"
    if x < 0.000005:
        return "<$0.00001"
    if x < 0.01:
        return f"${x:.5f}"
    return f"${x:.2f}"
