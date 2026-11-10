/**
 * What a statement costs, worked out before it runs.
 *
 * The numbers come from Archil's public price sheet as read in November 2026.
 * They are estimates: the invoice is the authority. Every figure can be
 * overridden by passing your own `PriceSheet` to `context(...)`.
 *
 * The model has three meters, because those are the three a statement can move:
 *
 * - calls: each exec, grep or SQLite query is one serverless tool call.
 *   A call on a VM larger than the default bills as a multiple of one call.
 * - active data: bytes a statement reads or writes stay on the SSD tier for
 *   about an hour and are billed at the active rate for that hour.
 * - egress: bytes that leave Archil. Free when the caller runs inside Archil.
 */

import { fixed, round } from "./compat.ts";
import { BudgetExceeded } from "./errors.ts";

export const GIB = 1024 ** 3;
export const GB = 1000 ** 3;

/** Copy the fields that were given; a field passed as `undefined` keeps its default. */
function assign<T extends object>(target: T, fields: Partial<T>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

export interface Prices {
  asOf: string;
  source: string;
  /** per default-size serverless tool call */
  callUsd: number;
  callVcpu: number;
  callMemMib: number;
  activeGibMonthUsd: number;
  archiveGbMonthUsd: number;
  sandboxVcpuHourUsd: number;
  sandboxGibHourUsd: number;
  egressGbUsd: number;
  /** data stays "active" about an hour after a touch */
  activeWindowHours: number;
  hoursPerMonth: number;
}

export class PriceSheet implements Prices {
  readonly asOf: string = "2026-11";
  readonly source: string = "https://archil.com/pricing";
  readonly callUsd: number = 0.05 / 1000;
  readonly callVcpu: number = 2;
  readonly callMemMib: number = 4096;
  readonly activeGibMonthUsd: number = 0.2;
  readonly archiveGbMonthUsd: number = 0.025;
  readonly sandboxVcpuHourUsd: number = 0.055;
  readonly sandboxGibHourUsd: number = 0.02;
  readonly egressGbUsd: number = 0.07;
  readonly activeWindowHours: number = 1.0;
  readonly hoursPerMonth: number = 730.0;

  constructor(overrides: Partial<Prices> = {}) {
    assign<Prices>(this, overrides);
  }

  /** A larger VM bills as the larger of its vCPU or memory multiple, rounded up. */
  callUnits(vcpu = 2, memMib = 4096): number {
    return Math.max(1, Math.ceil(Math.max(vcpu / this.callVcpu, memMib / this.callMemMib)));
  }

  /** Cost of keeping `nbytes` active for one active window. */
  activeUsd(nbytes: number): number {
    return ((nbytes / GIB) * this.activeGibMonthUsd * this.activeWindowHours) / this.hoursPerMonth;
  }

  egressUsd(nbytes: number): number {
    return (nbytes / GB) * this.egressGbUsd;
  }

  sandboxHourUsd(vcpu: number, memMib: number): number {
    return vcpu * this.sandboxVcpuHourUsd + (memMib / 1024) * this.sandboxGibHourUsd;
  }

  /** Calls per hour above which a warm sandbox of this size is cheaper than per-call execution. */
  breakevenCallsPerHour(vcpu = 2, memMib = 4096): number {
    return Math.trunc(this.sandboxHourUsd(vcpu, memMib) / this.callUsd);
  }
}

export interface EstimateFields {
  calls: number;
  callUnits: number;
  bytesTouched: number;
  egressBytes: number;
  usdCalls: number;
  usdActive: number;
  usdEgress: number;
  complete: boolean;
}

/** The predicted cost of a plan. `complete` is false when sizes were unknown. */
export class Estimate implements EstimateFields {
  readonly calls: number = 0;
  readonly callUnits: number = 0;
  readonly bytesTouched: number = 0;
  readonly egressBytes: number = 0;
  readonly usdCalls: number = 0;
  readonly usdActive: number = 0;
  readonly usdEgress: number = 0;
  readonly complete: boolean = true;

  constructor(fields: Partial<EstimateFields> = {}) {
    assign<EstimateFields>(this, fields);
  }

  get usd(): number {
    return this.usdCalls + this.usdActive + this.usdEgress;
  }

  plus(other: Estimate): Estimate {
    return new Estimate({
      calls: this.calls + other.calls,
      callUnits: this.callUnits + other.callUnits,
      bytesTouched: this.bytesTouched + other.bytesTouched,
      egressBytes: this.egressBytes + other.egressBytes,
      usdCalls: this.usdCalls + other.usdCalls,
      usdActive: this.usdActive + other.usdActive,
      usdEgress: this.usdEgress + other.usdEgress,
      complete: this.complete && other.complete,
    });
  }

  /** What was added after `earlier`, for a budget that starts counting part-way through a session. */
  since(earlier: Estimate): Estimate {
    return new Estimate({
      calls: this.calls - earlier.calls,
      callUnits: this.callUnits - earlier.callUnits,
      bytesTouched: this.bytesTouched - earlier.bytesTouched,
      egressBytes: this.egressBytes - earlier.egressBytes,
      usdCalls: this.usdCalls - earlier.usdCalls,
      usdActive: this.usdActive - earlier.usdActive,
      usdEgress: this.usdEgress - earlier.usdEgress,
      complete: this.complete,
    });
  }

  toJSON(): object {
    return {
      calls: this.calls,
      callUnits: this.callUnits,
      bytesTouched: this.bytesTouched,
      egressBytes: this.egressBytes,
      usd: round(this.usd, 8),
      usdCalls: round(this.usdCalls, 8),
      usdActive: round(this.usdActive, 8),
      usdEgress: round(this.usdEgress, 8),
      complete: this.complete,
    };
  }
}

export interface EstimateInput {
  calls?: number;
  unitsPerCall?: number;
  bytesTouched?: number;
  egressBytes?: number;
  complete?: boolean;
}

export function estimate(prices: PriceSheet, input: EstimateInput = {}): Estimate {
  const { calls = 0, unitsPerCall = 1, bytesTouched = 0, egressBytes = 0, complete = true } = input;
  const units = calls * unitsPerCall;
  return new Estimate({
    calls,
    callUnits: units,
    bytesTouched,
    egressBytes,
    usdCalls: units * prices.callUsd,
    usdActive: prices.activeUsd(bytesTouched),
    usdEgress: prices.egressUsd(egressBytes),
    complete,
  });
}

export interface BudgetLimits {
  maxUsd?: number | null;
  maxCalls?: number | null;
  maxBytesTouched?: number | null;
}

/** A ceiling checked before anything runs. `null` means no limit on that meter. */
export class Budget {
  readonly maxUsd: number | null;
  readonly maxCalls: number | null;
  readonly maxBytesTouched: number | null;

  constructor(limits: BudgetLimits = {}) {
    this.maxUsd = limits.maxUsd ?? null;
    this.maxCalls = limits.maxCalls ?? null;
    this.maxBytesTouched = limits.maxBytesTouched ?? null;
  }

  check(est: Estimate, spent?: Estimate | null): void {
    const total = spent ? est.plus(spent) : est;
    const over: string[] = [];
    if (this.maxUsd !== null && total.usd > this.maxUsd) {
      over.push(`$${fixed(total.usd, 5)} > $${fixed(this.maxUsd, 5)}`);
    }
    if (this.maxCalls !== null && total.callUnits > this.maxCalls) {
      over.push(`${total.callUnits} calls > ${this.maxCalls}`);
    }
    if (this.maxBytesTouched !== null && total.bytesTouched > this.maxBytesTouched) {
      over.push(`${fmtBytes(total.bytesTouched)} touched > ${fmtBytes(this.maxBytesTouched)}`);
    }
    if (over.length) {
      throw new BudgetExceeded("plan exceeds budget: " + over.join("; "), {
        suggestion: "narrow the paths, use grep() for regex search, or raise the budget",
      });
    }
  }
}

/**
 * Running total of what a context has actually sent.
 *
 * Calls add up. Active data does not: a file stays active for about an hour after its last
 * touch, however many statements touch it in that hour. So the ledger remembers when this session
 * last touched each file. A first touch pays for the whole window; a later one pays only for the
 * time it adds. `bytesTouched` in the total is what the session made active, counted once.
 */
export class Ledger {
  readonly prices: PriceSheet;
  total: Estimate = new Estimate();
  statements = 0;
  /** seconds since the epoch; a test can put its own clock here */
  clock: () => number = () => Date.now() / 1000;
  /** path -> when this session last touched it */
  #warm = new Map<string, number>();

  constructor(prices: PriceSheet) {
    this.prices = prices;
  }

  /**
   * Record a touch of `files` (path -> size). Returns the bytes it newly made active and what
   * the touch adds to the active-data bill.
   */
  warm(files: ReadonlyMap<string, number>): [fresh: number, usd: number] {
    const window = this.prices.activeWindowHours * 3600;
    const now = this.clock();
    let fresh = 0;
    let usd = 0;
    for (const [path, size] of files) {
      const last = this.#warm.get(path);
      const idle = last === undefined ? window : Math.max(0, now - last);
      if (idle >= window) fresh += size;
      if (window > 0) usd += (this.prices.activeUsd(size) * Math.min(window, idle)) / window;
      this.#warm.set(path, now);
    }
    return [fresh, usd];
  }

  add(est: Estimate, options: { statement?: boolean } = {}): void {
    this.total = this.total.plus(est);
    if (options.statement ?? true) this.statements += 1;
  }

  snapshot(): Estimate {
    return this.total;
  }

  toString(): string {
    const t = this.snapshot();
    return (
      `${this.statements} statement(s): ${t.callUnits} call unit(s) ${fmtUsd(t.usdCalls)}, ` +
      `${fmtBytes(t.bytesTouched)} kept active ${fmtUsd(t.usdActive)}, ` +
      `${fmtBytes(t.egressBytes)} egress ${fmtUsd(t.usdEgress)}; total ≈ ${fmtUsd(t.usd)}`
    );
  }
}

export function fmtBytes(n: number): string {
  let value = n;
  for (const unit of ["B", "KiB", "MiB", "GiB", "TiB"]) {
    if (value < 1024 || unit === "TiB") {
      return unit === "B" ? `${Math.trunc(value)} ${unit}` : `${fixed(value, 1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${n} B`;
}

export function fmtUsd(x: number): string {
  if (x === 0) return "$0";
  if (x < 0.000005) return "<$0.00001";
  if (x < 0.01) return `$${fixed(x, 5)}`;
  return `$${fixed(x, 2)}`;
}
