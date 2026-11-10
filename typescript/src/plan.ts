/**
 * A plan is what a statement will do, written down before it does it.
 *
 * It answers the four questions a harness author settles by hand today:
 *
 * - route: how the work reaches the data (an exec call, parallel grep, …)
 * - scope: which disks the call can see, and whether it can change them
 * - split: how many calls, over which inputs, and how results are combined
 * - price: what it will cost on each meter
 *
 * A plan is plain data. `plan.toJSON()` is the shape a server-side planner
 * could accept in place of the calls the client makes today.
 */

import { createHash } from "node:crypto";

import { MountSpec, Vm } from "./backends.ts";
import type { MountSpecJSON } from "./backends.ts";
import { dumps } from "./compat.ts";
import { Estimate, fmtBytes, fmtUsd } from "./pricing.ts";

/** JSON with sorted keys and no spaces. Both SDKs hash this form, so they agree on a plan's identity. */
export function canonical(value: unknown): string {
  return dumps(value, { sortKeys: true, compact: true, ascii: false });
}

/** One call: a command and the mount map it runs under. The same shape as an exec request. */
export class Task {
  readonly command: string;
  readonly mounts: Record<string, MountSpec>;
  readonly label: string;

  constructor(command: string, mounts: Record<string, MountSpec>, label = "") {
    this.command = command;
    this.mounts = mounts;
    this.label = label;
  }

  toJSON(): { command: string; disks: Record<string, MountSpecJSON> } {
    const disks: Record<string, MountSpecJSON> = {};
    for (const [key, spec] of Object.entries(this.mounts)) disks[key] = spec.toJSON();
    return { command: this.command, disks };
  }
}

export interface PlanFields {
  kind: string;
  route: string;
  statement: string;
  tasks: Task[];
  vm?: Vm;
  reads?: string[];
  writes?: string[];
  reduce?: string | null;
  estimate?: Estimate;
  notes?: string[];
  files?: number;
  parallel?: number;
  unmounted?: string[];
  readPaths?: string[] | null;
}

export class Plan {
  kind: string;
  route: string;
  statement: string;
  tasks: Task[];
  vm: Vm;
  reads: string[];
  writes: string[];
  reduce: string | null;
  estimate: Estimate;
  notes: string[];
  files: number;
  parallel: number;
  unmounted: string[];
  /** reads as paths and globs, when `reads` holds display labels */
  readPaths: string[] | null;

  constructor(fields: PlanFields) {
    this.kind = fields.kind;
    this.route = fields.route;
    this.statement = fields.statement;
    this.tasks = fields.tasks;
    this.vm = fields.vm ?? new Vm();
    this.reads = fields.reads ?? [];
    this.writes = fields.writes ?? [];
    this.reduce = fields.reduce ?? null;
    this.estimate = fields.estimate ?? new Estimate();
    this.notes = fields.notes ?? [];
    this.files = fields.files ?? 0;
    this.parallel = fields.parallel ?? 1;
    this.unmounted = fields.unmounted ?? [];
    this.readPaths = fields.readPaths ?? null;
  }

  get hash(): string {
    const body = {
      kind: this.kind,
      statement: this.statement,
      vm: this.vm.toJSON(),
      reduce: this.reduce,
      tasks: this.tasks.map((t) => t.toJSON()),
    };
    return createHash("sha256").update(canonical(body), "utf8").digest("hex").slice(0, 12);
  }

  toJSON(): object {
    return {
      plan: 0,
      hash: this.hash,
      kind: this.kind,
      route: this.route,
      statement: this.statement,
      vm: this.vm.toJSON(),
      parallel: this.parallel,
      reduce: this.reduce,
      effects: { reads: this.readPaths === null ? this.reads : this.readPaths, writes: this.writes },
      tasks: this.tasks.map((t) => t.toJSON()),
      estimate: this.estimate.toJSON(),
      notes: this.notes,
    };
  }

  toString(): string {
    const e = this.estimate;
    const n = this.tasks.length;
    let head = `plan ${this.hash}  ${this.kind}`;
    if (this.files) head += ` · ${this.files} file(s), ${fmtBytes(e.bytesTouched)}`;
    head += ` · ${n} call${n !== 1 ? "s" : ""}`;
    if (this.reduce && n > 1) head += `, combined by ${this.reduce}`;
    const lines = [head];

    let route: string;
    if (this.route === "exec") {
      const size = `${this.vm.vcpu} vCPU / ${Math.floor(this.vm.memMib / 1024)} GiB`;
      route = `exec · ${size}` + (this.vm.image ? ` · image ${this.vm.image}` : "");
      if (this.vm.egress !== null) route += ` · ${this.vm.describeEgress()}`;
      if (n > 1) route += ` · up to ${Math.min(n, this.parallel)} at once`;
    } else if (this.route === "grep") {
      route = "grep · one call per disk, fanned out next to the data";
    } else {
      route = this.route;
    }
    lines.push(`  route   ${route}`);

    const mounts: Record<string, MountSpec> = {};
    for (const task of this.tasks) Object.assign(mounts, task.mounts);
    const scope = Object.entries(mounts).map(([key, spec]) => `${key} → ${spec.describe()}`);
    if (!scope.length) scope.push("nothing mounted: nothing to run");
    if (this.unmounted.length) scope.push("not mounted: " + this.unmounted.join(", "));
    lines.push("  scope   " + scope[0]);
    for (const s of scope.slice(1)) lines.push(`          ${s}`);

    const nothing = this.writes.length || !this.tasks.length ? "—" : "— (not declared)";
    lines.push("  reads   " + (this.reads.length ? this.reads.join(", ") : nothing));
    lines.push("  writes  " + (this.writes.length ? this.writes.join(", ") : "—"));

    let price = `${e.callUnits} call unit${e.callUnits !== 1 ? "s" : ""} ${fmtUsd(e.usdCalls)}`;
    if (e.bytesTouched) price += ` + ${fmtBytes(e.bytesTouched)} active for an hour ${fmtUsd(e.usdActive)}`;
    if (e.egressBytes) price += ` + ${fmtBytes(e.egressBytes)} egress ${fmtUsd(e.usdEgress)}`;
    price += ` ≈ ${fmtUsd(e.usd)}` + (e.complete ? "" : " (input size unknown)");
    lines.push(`  price   ${price}`);
    for (const note of this.notes) lines.push(`  note    ${note}`);
    return lines.join("\n");
  }
}
