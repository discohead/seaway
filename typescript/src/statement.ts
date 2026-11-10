/**
 * Statements: work that runs next to the data.
 *
 * `ctx.sh(...)`, `ctx.grep(...)` and `ctx.sql(...)` each return a statement.
 * A statement does nothing until you ask: `explain()` returns the plan,
 * `run()` executes it, and awaiting the statement itself is `run()`.
 * Statements are immutable values, so `map`, `into`, `sized` and `within` each
 * return a new one.
 *
 * The planner never guesses. A command is split across calls only when the caller
 * says which input to split on and how to put the pieces back together. A call
 * sees only the paths the statement declares; a statement that declares none sees
 * the whole context.
 */

import { MountSpec, Vm, egressPolicy, sameEgress } from "./backends.ts";
import type { Egress, ExecOutput, GrepOptions, VmOptions } from "./backends.ts";
import { dumps, head, intText, len, numberText, repr, round, sorted, splitlines, strip } from "./compat.ts";
import { META } from "./context.ts";
import type { Context, Mount } from "./context.ts";
import { ArchilError, ExecFailed, ValidationError } from "./errors.ts";
import { Plan, Task, canonical } from "./plan.ts";
import { Budget, Estimate, estimate, fmtBytes } from "./pricing.ts";
import type { BudgetLimits } from "./pricing.ts";
import { Glob, Raw, Ref, checkParams, parent, quote, render, sqlLiteral } from "./shell.ts";
import type { FileStat, Selectable } from "./shell.ts";

export const SHARD_BYTES = 256 * 1024 * 1024;
export const SHARD_FILES = 2000;
export const INLINE_LIST_BYTES = 48 * 1024;

// ----------------------------------------------------------------------------
// results

export class Meta {
  calls = 0;
  callUnits = 0;
  usd = 0;
  wallMs = 0;
  queueMs = 0;
  executeMs = 0;

  constructor(fields: Partial<Meta> = {}) {
    Object.assign(this, fields);
  }

  toJSON(): object {
    return {
      calls: this.calls,
      callUnits: this.callUnits,
      usd: round(this.usd, 6),
      wallMs: round(this.wallMs, 6),
      queueMs: round(this.queueMs, 6),
      executeMs: round(this.executeMs, 6),
    };
  }
}

/** One row of a query or a search. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface ResultFields {
  kind: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  value?: unknown;
  rows?: Row[] | null;
  paths?: string[];
  truncated?: boolean;
  results?: Result[];
  shards?: ExecOutput[];
  plan?: Plan | null;
  meta?: Meta;
}

export class Result {
  kind: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** what the reducer produced, or parsed output: its type follows the statement */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  /** sql and grep */
  rows: Row[] | null;
  /** files written by into() */
  paths: string[];
  truncated: boolean;
  /** batch: one per statement */
  results: Result[];
  /** fan-out: one per call */
  shards: ExecOutput[];
  plan: Plan | null;
  meta: Meta;

  constructor(fields: ResultFields) {
    this.kind = fields.kind;
    this.exitCode = fields.exitCode ?? 0;
    this.stdout = fields.stdout ?? "";
    this.stderr = fields.stderr ?? "";
    this.value = fields.value ?? null;
    this.rows = fields.rows ?? null;
    this.paths = fields.paths ?? [];
    this.truncated = fields.truncated ?? false;
    this.results = fields.results ?? [];
    this.shards = fields.shards ?? [];
    this.plan = fields.plan ?? null;
    this.meta = fields.meta ?? new Meta();
  }

  get ok(): boolean {
    return this.exitCode === 0;
  }

  get text(): string {
    return this.stdout;
  }

  get lines(): string[] {
    return splitlines(this.stdout);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any {
    return JSON.parse(this.stdout);
  }

  check(): this {
    if (!this.ok) throw new ExecFailed(this.exitCode, this.stderr, this.plan ? this.plan.statement : "");
    return this;
  }
}

// ----------------------------------------------------------------------------
// reducers: how the outputs of many calls become one answer

const NUM = /^-?\d+(?:\.\d+)?$/;

function badLine(reducer: string, line: string, expected: string): ArchilError {
  return new ArchilError(`the '${reducer}' reducer cannot read this line of output: ${repr(head(line, 120))}`, {
    code: "bad_reduce_input",
    suggestion: `each line must be ${expected}; change the command, or reduce with 'lines' and combine yourself`,
  });
}

/** One number per line. Anything else is an error: a reducer must not drop output quietly. */
function numbers(text: string): number[] {
  const out: number[] = [];
  for (const raw of splitlines(text)) {
    const line = strip(raw);
    if (!line) continue;
    if (!NUM.test(line)) throw badLine("sum", line, "a single number (for example the output of `wc -l < file`)");
    out.push(Number(line));
  }
  return out;
}

function fmtNum(x: number): string {
  return Number.isInteger(x) ? intText(x) : numberText(x);
}

function allLines(outs: string[]): string[] {
  return outs.flatMap(splitlines);
}

function joined(lines: string[]): string {
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function rConcat(outs: string[]): [string, string] {
  const text = outs.map((o) => (o.endsWith("\n") || !o ? o : o + "\n")).join("");
  return [text, text];
}

function rLines(outs: string[]): [string[], string] {
  const lines = allLines(outs);
  return [lines, joined(lines)];
}

function rSorted(outs: string[]): [string[], string] {
  const lines = sorted(allLines(outs));
  return [lines, joined(lines)];
}

function rUnique(outs: string[]): [string[], string] {
  const lines = sorted(new Set(allLines(outs)));
  return [lines, joined(lines)];
}

function rCount(outs: string[]): [number, string] {
  const n = allLines(outs).length;
  return [n, `${n}\n`];
}

function rSum(outs: string[]): [number, string] {
  let total = 0;
  for (const o of outs) for (const x of numbers(o)) total += x;
  return [total, fmtNum(total) + "\n"];
}

const UNIQ = /^\s+(\d+(?:\.\d+)?)\s+(.*)$/;
const LEAD = /^(\d+(?:\.\d+)?)\s+(.*)$/;

/**
 * Read one line as [key, count]. Three forms, tried in this order:
 *
 * `   12 key` (`uniq -c`: the count first, after leading spaces), `key:12` or
 * `key<TAB>12` (`rg -c --with-filename`, `awk`), and `12 key`.
 */
function keyCount(line: string): [string, number] | null {
  let m = UNIQ.exec(line);
  if (m) return [m[2], Number(m[1])];
  for (const sep of [":", "\t"]) {
    const cut = line.lastIndexOf(sep);
    if (cut >= 0 && NUM.test(strip(line.slice(cut + 1)))) return [line.slice(0, cut), Number(strip(line.slice(cut + 1)))];
  }
  m = LEAD.exec(line);
  if (m) return [m[2], Number(m[1])];
  return null;
}

/**
 * Add up counts per key across calls. See `keyCount` for the line forms it reads.
 *
 * The value is a Map, largest count first: that order is part of the answer, and
 * a plain object would put keys that look like integers (status codes, ports)
 * first whatever their counts.
 */
function rSumByKey(outs: string[]): [Map<string, number>, string] {
  const totals = new Map<string, number>();
  for (const o of outs) {
    for (const line of splitlines(o)) {
      if (!strip(line)) continue;
      const pair = keyCount(line);
      if (pair === null) {
        throw badLine(
          "sum_by_key",
          line,
          "'key:count', 'key<TAB>count' or 'count key' " +
            "(with rg -c, add --with-filename so a shard of one file still names it)",
        );
      }
      totals.set(pair[0], (totals.get(pair[0]) ?? 0) + pair[1]);
    }
  }
  const ordered = sorted(totals, ([key]) => key).sort((a, b) => b[1] - a[1]);
  const value = new Map(ordered);
  return [value, ordered.map(([k, v]) => `${k}\t${fmtNum(v)}\n`).join("")];
}

function rJson(outs: string[]): [unknown[], string] {
  const merged: unknown[] = [];
  for (const o of outs) {
    if (!strip(o)) continue;
    const parsed: unknown = JSON.parse(o);
    if (Array.isArray(parsed)) for (const item of parsed) merged.push(item);
    else merged.push(parsed);
  }
  return [merged, dumps(merged, { compact: true, ascii: false })];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reducer = (outs: string[]) => [value: any, stdout: string];
export type ReducerName = "concat" | "lines" | "sorted" | "unique" | "count" | "sum" | "sum_by_key" | "json";
export type Reduce = ReducerName | ((outs: string[]) => unknown);

export const REDUCERS: Record<ReducerName, Reducer> = {
  concat: rConcat,
  lines: rLines,
  sorted: rSorted,
  unique: rUnique,
  count: rCount,
  sum: rSum,
  sum_by_key: rSumByKey,
  json: rJson,
};

// ----------------------------------------------------------------------------
// the statement

export type Kind = "sh" | "grep" | "sql" | "batch";

export interface StatementFields {
  ctx: Context;
  kind: Kind;
  template: string;
  params?: readonly (readonly [string, unknown])[];
  split?: string | null;
  reduce?: Reduce | null;
  shards?: number | null;
  out?: Ref | null;
  vm?: Vm;
  budget?: Budget | null;
  opts?: GrepOptions;
  children?: readonly Statement[];
}

export class Statement implements PromiseLike<Result> {
  readonly ctx: Context;
  readonly kind: Kind;
  readonly template: string;
  readonly params: readonly (readonly [string, unknown])[];
  readonly split: string | null;
  readonly reduce: Reduce | null;
  readonly shards: number | null;
  readonly out: Ref | null;
  readonly vm: Vm;
  readonly budget: Budget | null;
  readonly opts: GrepOptions;
  readonly children: readonly Statement[];

  constructor(fields: StatementFields) {
    this.ctx = fields.ctx;
    this.kind = fields.kind;
    this.template = fields.template;
    this.params = fields.params ?? [];
    this.split = fields.split ?? null;
    this.reduce = fields.reduce ?? null;
    this.shards = fields.shards ?? null;
    this.out = fields.out ?? null;
    this.vm = fields.vm ?? new Vm();
    this.budget = fields.budget ?? null;
    this.opts = fields.opts ?? {};
    this.children = fields.children ?? [];
    Object.freeze(this);
  }

  #with(fields: Partial<StatementFields>): Statement {
    return new Statement({ ...this, ...fields });
  }

  // -- builders ----------------------------------------------------------------
  /**
   * Run once per shard of an input, in parallel, and combine the outputs.
   *
   * `on` names the parameter to split. It can be left out when exactly one
   * parameter is a glob or a selection. `reduce` says how to combine:
   * one of `concat`, `lines`, `sorted`, `unique`, `count`, `sum`,
   * `sum_by_key`, `json`, or a function of the list of outputs.
   */
  map(options: { on?: string | null; reduce?: Reduce; shards?: number | null } = {}): Statement {
    if (this.kind !== "sh") {
      throw new ValidationError("only sh statements can be mapped", {
        code: "bad_map",
        suggestion: "grep already fans out; give sql a larger VM with sized()",
      });
    }
    const reduce = options.reduce ?? "concat";
    let on = options.on ?? null;
    if (on === null) {
      const candidates = this.params.filter(([, v]) => isSelection(v)).map(([n]) => n);
      if (candidates.length !== 1) {
        throw new ValidationError(`map() needs to know which input to split; found ${candidates.length} candidates`, {
          code: "bad_map",
          suggestion: "pass { on: '<parameter name>' }, or pass exactly one glob",
        });
      }
      on = candidates[0];
    } else if (!this.params.some(([n]) => n === on)) {
      throw new ValidationError(`no parameter named '${on}'`, { code: "bad_map" });
    }
    if (typeof reduce === "string" && !Object.hasOwn(REDUCERS, reduce)) {
      throw new ValidationError(`unknown reducer '${reduce}'`, {
        code: "bad_map",
        suggestion: "use one of: " + Object.keys(REDUCERS).join(", "),
      });
    }
    return this.#with({ split: on, reduce, shards: options.shards ?? null });
  }

  /** Send output to a file in the context instead of returning it. Results become paths. */
  into(path: string | Ref): Statement {
    const ref = path instanceof Ref ? path : this.ctx.out(path);
    return this.#with({ out: new Ref(ref.mount, ref.rel, true) });
  }

  /** Choose the VM for each call. Anything above 2 vCPU / 4 GiB bills as a multiple of a call. */
  sized(options: Omit<VmOptions, "egress">): Statement {
    return this.#with({
      vm: new Vm({
        vcpu: options.vcpu || this.vm.vcpu,
        memMib: options.memMib || this.vm.memMib,
        image: options.image || this.vm.image,
        egress: this.vm.egress,
      }),
    });
  }

  /**
   * Say what this call may reach on the network: "deny" (nothing leaves), a list of hosts (only
   * those), or "allow" (open). Left alone, a statement has its context's policy, and a context
   * has Archil's default, which is open.
   *
   * The mount map decides what a command can read; this decides where it can send it.
   */
  egress(policy: Egress): Statement {
    const { vcpu, memMib, image } = this.vm;
    return this.#with({ vm: new Vm({ vcpu, memMib, image, egress: egressPolicy(policy) }) });
  }

  /** Refuse to run if the plan would exceed this budget. */
  within(budget: Budget | BudgetLimits = {}): Statement {
    return this.#with({ budget: budget instanceof Budget ? budget : new Budget(budget) });
  }

  // -- plan and run ------------------------------------------------------------
  async explain(): Promise<Plan> {
    return (await compile(this)).plan;
  }

  async run(options: { check?: boolean } = {}): Promise<Result> {
    const compiled = await compile(this);
    const plan = compiled.plan;
    const ctx = this.ctx;
    if (this.budget) this.budget.check(plan.estimate);
    if (ctx.budget) ctx.budget.check(plan.estimate, ctx.spentUnderBudget());
    const started = performance.now();
    const result = await compiled.execute();
    result.plan = plan;
    const units = plan.route === "exec" ? ctx.prices.callUnits(plan.vm.vcpu, plan.vm.memMib) : 1;
    // The plan priced every byte it touches as newly active for an hour. The ledger knows what
    // this session has already made active, and charges only for what is new or kept warm longer.
    const [fresh, usdActive] = result.meta.calls ? ctx.spend.warm(compiled.touched) : [0, 0];
    const called = estimate(ctx.prices, { calls: result.meta.calls, unitsPerCall: units });
    const actual = new Estimate({ ...called, bytesTouched: fresh, usdActive });
    result.meta.callUnits = actual.callUnits;
    result.meta.usd = actual.usd;
    result.meta.wallMs = performance.now() - started;
    ctx.spend.add(actual);
    await ctx._record({
      kind: this.kind,
      plan: plan.hash,
      statement: head(plan.statement, 240),
      reads: plan.reads,
      writes: plan.writes,
      calls: result.meta.calls,
      callUnits: result.meta.callUnits,
      usd: round(result.meta.usd, 8),
      ms: round(result.meta.wallMs, 1),
      exit: result.exitCode,
    });
    return options.check ? result.check() : result;
  }

  /**
   * Awaiting a statement runs it. Because of this, an async function must not
   * return a statement (its caller would get the result): return it from a
   * plain function, or inside an object.
   */
  then<A = Result, B = never>(
    onFulfilled?: ((result: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  toString(): string {
    return `<Statement ${this.kind}: ${repr(head(this.template, 60))}>`;
  }
}

export function isSelection(value: unknown): value is Glob | Selectable {
  if (value instanceof Glob) return true;
  return typeof value === "object" && value !== null && typeof (value as { resolve?: unknown }).resolve === "function";
}

/** A parameter as text, written the same way by both SDKs. Used to fingerprint a statement. */
export function describeParam(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(describeParam).join(",") + "]";
  if (value instanceof Ref) return (value.write ? "out:" : "path:") + value.path;
  if (value instanceof Glob) return "glob:" + value.path;
  if (value instanceof Raw) return "raw:" + value.text;
  if (isSelection(value)) return "sel:" + String(value);
  return "val:" + canonical(value);
}

// ----------------------------------------------------------------------------
// compiling statements into plans

type Pair = [mount: string, path: string];

interface Compiled {
  plan: Plan;
  execute: () => Promise<Result>;
  /** [mount, directory] */
  reads: Pair[];
  /** [mount, path] */
  writes: Pair[];
  declared: boolean;
  /** every file the statement reads: path -> size */
  touched: Map<string, number>;
}

function compile(s: Statement): Promise<Compiled> {
  return { sh: compileSh, sql: compileSql, grep: compileGrep, batch: compileBatch }[s.kind](s);
}

/** Run a plan's calls, at most `plan.parallel` at a time, and return the outputs in task order. */
async function runTasks(ctx: Context, plan: Plan): Promise<ExecOutput[]> {
  const tasks = plan.tasks;
  const outputs: ExecOutput[] = new Array(tasks.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < tasks.length && !failed) {
      const i = next++;
      try {
        outputs[i] = await ctx.backend.exec(tasks[i].mounts, tasks[i].command, plan.vm);
      } catch (error) {
        failed = true; // calls not yet started are not sent
        throw error;
      }
    }
  };
  const workers = Math.max(1, Math.min(tasks.length, plan.parallel));
  await Promise.all(Array.from({ length: workers }, worker));
  return outputs;
}

function unmounted(ctx: Context, mounts: Record<string, MountSpec>): string[] {
  const seen = new Set(Object.keys(mounts).map((key) => key.split("/")[0]));
  return [...ctx.mounts.keys()].filter((name) => !seen.has(name));
}

function sizeOf(files: FileStat[]): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}

function count(files: Map<string, FileStat[]>): number {
  let n = 0;
  for (const list of files.values()) n += list.length;
  return n;
}

interface Gathered {
  reads: Pair[];
  writes: Pair[];
  shownR: string[];
  shownW: string[];
  /** the same reads as paths and globs, for the plan's effects */
  pathsR: string[];
  files: Map<string, FileStat[]>;
  touched: number;
  /** every file read, once: path -> size */
  sizes: Map<string, number>;
}

/**
 * Walk the parameters: resolve inputs, and collect what the statement reads and writes.
 *
 * `files` holds the resolved file list for every glob or selection, for the
 * parameter being split, and (when `tables` is set) for every path that is read.
 */
async function gather(ctx: Context, params: Record<string, unknown>, split: string | null, tables = false): Promise<Gathered> {
  const g: Gathered = {
    reads: [],
    writes: [],
    shownR: [],
    shownW: [],
    pathsR: [],
    files: new Map(),
    touched: 0,
    sizes: new Map(),
  };
  const keep = (name: string, listed: FileStat[]): void => {
    if (!g.files.has(name)) g.files.set(name, []);
    for (const f of listed) g.files.get(name)!.push(f);
  };
  for (const [name, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item instanceof Ref) {
        ctx._resolve(item, { write: item.write });
        if (item.write) {
          g.writes.push([item.mount, item.rel]);
          g.shownW.push(item.path);
          continue;
        }
        g.shownR.push(item.path);
        g.pathsR.push(item.path);
        const listed = await ctx.expand(item);
        const isDir = listed.some((f) => f.path !== item.path);
        g.reads.push([item.mount, isDir ? item.rel : parent(item.rel)]);
        g.touched += sizeOf(listed);
        for (const f of listed) g.sizes.set(f.path, f.size);
        if (tables || name === split) keep(name, listed);
      } else if (isSelection(item)) {
        const listed = await ctx.expand(item);
        keep(name, listed);
        g.touched += sizeOf(listed);
        for (const f of listed) g.sizes.set(f.path, f.size);
        g.shownR.push(String(item));
        if (item instanceof Glob) {
          ctx._resolve(new Ref(item.mount, item.staticPrefix()));
          g.reads.push([item.mount, item.staticPrefix()]);
          g.pathsR.push(String(item));
        } else {
          const roots = await item.roots();
          for (const [m, d] of roots) {
            g.reads.push([m, d]);
            g.pathsR.push(d ? `${m}/${d}` : m);
          }
        }
      }
    }
  }
  return g;
}

function renderValue(value: unknown, files: FileStat[] | undefined): string {
  if (files !== undefined && isSelection(value)) return files.map((f) => quote(f.path)).join(" ");
  if (value instanceof Ref) return quote(value.path);
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map((v) => renderValue(v, undefined)).join(" ");
  return quote(value);
}

/** Group files into shards of similar size, each small enough to fit in one command. */
export function makeShards(files: FileStat[], n: number | null | undefined, maxCommandBytes: number, baseLen: number): FileStat[][] {
  if (!files.length) return [];
  if (n == null) n = Math.max(Math.ceil(sizeOf(files) / SHARD_BYTES), Math.ceil(files.length / SHARD_FILES), 1);
  n = Math.max(1, Math.min(n, files.length));
  const bins: FileStat[][] = Array.from({ length: n }, () => []);
  const loads: number[] = new Array(n).fill(0);
  // largest first, each into the lightest bin so far
  for (const f of sorted(files, (f) => f.path).sort((a, b) => b.size - a.size)) {
    const i = loads.indexOf(Math.min(...loads));
    bins[i].push(f);
    loads[i] += Math.max(f.size, 1);
  }
  const room = Math.max(1024, maxCommandBytes - baseLen - 1024);
  const shards: FileStat[][] = [];
  for (const bin of bins) {
    let current: FileStat[] = [];
    let used = 0;
    for (const f of sorted(bin, (f) => f.path)) {
      const need = len(quote(f.path)) + 1;
      if (current.length && used + need > room) {
        shards.push(current);
        current = [];
        used = 0;
      }
      current.push(f);
      used += need;
    }
    if (current.length) shards.push(current);
  }
  return shards;
}

function wrapOut(command: string, target: string): string {
  const directory = parent(target);
  const prefix = directory ? `mkdir -p ${quote(directory)} && ` : "";
  return `${prefix}{\n${command}\n} > ${quote(target)}`;
}

function checkSize(ctx: Context, command: string): void {
  const limit = ctx.backend.limits.maxCommandBytes;
  const size = Buffer.byteLength(command);
  if (size > limit) {
    throw new ValidationError(`the compiled command is ${fmtBytes(size)}; the limit is ${fmtBytes(limit)}`, {
      code: "command_too_large",
      suggestion: "use .map() to spread the inputs across calls",
    });
  }
}

async function compileSh(s: Statement): Promise<Compiled> {
  const ctx = s.ctx;
  const params = Object.fromEntries(s.params);
  checkParams(s.template, params);
  if (s.split && !Object.hasOwn(params, s.split)) {
    throw new ValidationError(`no parameter named '${s.split}'`, { code: "bad_map" });
  }
  const { reads, writes, shownR, shownW, files, touched, pathsR, sizes } = await gather(ctx, params, s.split);
  const out = s.out;
  if (out) {
    ctx._resolve(out, { write: true });
    writes.push([out.mount, out.rel]);
    shownW.push(out.path);
  }
  const declared = reads.length > 0 || writes.length > 0;
  const mounts = ctx.scope(reads, writes);
  const limits = ctx.backend.limits;

  const groups: (FileStat[] | null)[] = s.split
    ? makeShards(files.get(s.split) ?? [], s.shards, limits.maxCommandBytes, len(s.template))
    : [null];

  // a declared output's directory is created first, so `> {out}` works on a path that is new
  const made = sorted(
    new Set(
      writes
        .filter(([m, rel]) => !out || m !== out.mount || rel !== out.rel)
        .map(([m, rel]) => parent(`${m}/${rel}`))
        .filter((d) => d.includes("/")),
    ),
  );

  const tasks: Task[] = [];
  const outPaths: string[] = [];
  groups.forEach((group, index) => {
    let command = render(s.template, params, (name, value) =>
      name === s.split ? (group ?? []).map((f) => quote(f.path)).join(" ") : renderValue(value, files.get(name)),
    );
    if (made.length) command = "mkdir -p " + made.map(quote).join(" ") + " && " + command;
    if (out) {
      const target = s.split ? `${out.path}/part-${String(index).padStart(5, "0")}` : out.path;
      command = wrapOut(command, target);
      outPaths.push(target);
    }
    checkSize(ctx, command);
    tasks.push(new Task(command, mounts, s.split ? `shard ${index}` : ""));
  });

  const units = ctx.prices.callUnits(s.vm.vcpu, s.vm.memMib);
  const reduce = s.reduce;
  const plan = new Plan({
    kind: "sh",
    route: "exec",
    statement: s.template,
    tasks,
    vm: s.vm,
    reads: shownR,
    writes: shownW,
    reduce: s.split ? (typeof reduce === "string" ? reduce : "function") : null,
    estimate: estimate(ctx.prices, { calls: tasks.length, unitsPerCall: units, bytesTouched: touched, complete: declared }),
    files: count(files),
    parallel: limits.maxParallel,
    unmounted: unmounted(ctx, mounts),
    readPaths: pathsR,
  });
  advise(s, plan, declared, files, touched, units);

  const execute = async (): Promise<Result> => {
    const outputs = await runTasks(ctx, plan);
    const stdouts = outputs.map((o) => o.stdout);
    let stdout: string;
    let value: unknown;
    if (!s.split) {
      stdout = outputs.length ? outputs[0].stdout : "";
      value = stdout;
    } else if (typeof reduce === "function") {
      value = await reduce(stdouts);
      stdout = typeof value === "string" ? value : dumps(value);
    } else {
      [value, stdout] = REDUCERS[reduce as ReducerName](stdouts);
    }
    return new Result({
      kind: "sh",
      exitCode: outputs.find((o) => o.exitCode !== 0)?.exitCode ?? 0,
      stdout,
      stderr: outputs.map((o) => o.stderr).join(""),
      value,
      // only the parts that were written: a shard that failed left no file, or half of one
      paths: outPaths.filter((_, i) => outputs[i]?.exitCode === 0),
      truncated: outputs.some((o) => o.truncated),
      shards: s.split ? outputs : [],
      meta: new Meta({
        calls: outputs.length,
        queueMs: outputs.reduce((sum, o) => sum + o.queueMs, 0),
        executeMs: outputs.reduce((sum, o) => sum + o.executeMs, 0),
      }),
    });
  };

  return { plan, execute, reads, writes, declared, touched: sizes };
}

/** Notes that would change what a careful author does next. */
function advise(s: Statement, plan: Plan, declared: boolean, files: Map<string, FileStat[]>, touched: number, units: number): void {
  const ctx = s.ctx;
  const nfiles = count(files);
  if (!declared) {
    plan.notes.push(
      `no paths declared, so all ${ctx.mounts.size} mount(s) are attached; pass paths as parameters ` +
        "to mount only what the command needs",
    );
  }
  if (!s.split && nfiles && (touched > SHARD_BYTES || nfiles > SHARD_FILES)) {
    const calls = Math.max(Math.ceil(touched / SHARD_BYTES), Math.ceil(nfiles / SHARD_FILES));
    plan.notes.push(`${nfiles} files in one call; .map() would spread this over about ${calls} calls`);
  }
  if (s.split && plan.tasks.length && s.out && ctx.mounts.get(s.out.mount)!.mode === "owned") {
    plan.notes.push(
      "parallel calls writing to an 'owned' mount queue for its checkout; a 'shared' mount lets them write at once",
    );
  }
  if (units > 1) plan.notes.push(`this VM size bills as ${units} calls each`);
  if (/^\s*(rg|grep)\s/.test(s.template) && !s.template.includes("|") && !s.out && declared) {
    plan.notes.push("a plain regex search is one call per disk with ctx.grep(), however many files");
  }
  if (!ctx.backend.insideArchil && !s.out) {
    plan.notes.push("the caller is outside Archil: only stdout crosses the network, not the files");
  }
}

// -- sql -----------------------------------------------------------------------

const READERS = new Map([
  ["parquet", "read_parquet"],
  ["csv", "read_csv_auto"],
  ["tsv", "read_csv_auto"],
  ["json", "read_json_auto"],
  ["ndjson", "read_json_auto"],
  ["jsonl", "read_json_auto"],
]);
const COPY_FORMATS = new Map([
  ["parquet", "PARQUET"],
  ["csv", "CSV"],
  ["json", "JSON"],
  ["ndjson", "JSON"],
  ["jsonl", "JSON"],
]);

function ext(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** The DuckDB table expression for a path, a glob or a selection. */
function table(value: unknown, files: FileStat[]): string {
  const e = ext(files[0].path);
  const reader = READERS.get(e) ?? "read_json_auto";
  if (value instanceof Glob) return `${reader}(${sqlLiteral(value.path)}, union_by_name=true)`;
  if (value instanceof Ref && files.some((f) => f.path !== value.path)) {
    // a directory
    const pattern = e ? `${value.path}/**/*.${e}` : `${value.path}/**/*`;
    return `${reader}(${sqlLiteral(pattern)}, union_by_name=true)`;
  }
  let names = "[" + files.map((f) => sqlLiteral(f.path)).join(", ") + "]";
  if (len(names) > INLINE_LIST_BYTES && (value as Selectable).dirComplete) {
    const dirs = sorted(new Set(files.map((f) => `${parent(f.path)}\0${ext(f.path)}`)));
    names = "[" + dirs.map((d) => sqlLiteral(d.replace("\0", "/*."))).join(", ") + "]";
  }
  const table = `${reader}(${names}, union_by_name=true)`;
  // a log selection is a time range: the files are the partitions that cover it, and this makes
  // the table exactly the records inside it
  const where = (value as Selectable).predicate?.() ?? null;
  return where ? `(select * from ${table} where ${where})` : table;
}

function parseRows(stdout: string): Row[] | null {
  try {
    return strip(stdout) ? JSON.parse(stdout) : [];
  } catch {
    return null;
  }
}

async function compileSql(s: Statement): Promise<Compiled> {
  const ctx = s.ctx;
  const params = Object.fromEntries(s.params);
  checkParams(s.template, params);
  // any path parameter is a table: a file, a directory, a glob or a selection
  const { reads, writes, shownR, shownW, files, touched, pathsR, sizes } = await gather(ctx, params, null, true);
  const isTable = (value: unknown): boolean => (value instanceof Ref && !value.write) || isSelection(value);
  const empty = Object.entries(params)
    .filter(([name, value]) => isTable(value) && !files.get(name)?.length)
    .map(([name]) => name);

  const out = s.out;
  if (out) {
    ctx._resolve(out, { write: true });
    writes.push([out.mount, out.rel]);
    shownW.push(out.path);
  }
  const declared = reads.length > 0 || writes.length > 0;

  // DuckDB is not in Archil's exec image, so it usually lives on a disk in the context. Mount its
  // directory beside what the query declares. It is a tool, not an input: a query that declares
  // nothing still sees the whole context, which already includes the tool's disk.
  const engine = Object.hasOwn(ctx.toolsMap, "duckdb") ? ctx.toolsMap.duckdb : "duckdb";
  let engineCmd = engine;
  if (engine.includes("/") && ctx.mounts.has(engine.split("/")[0])) {
    const ref = ctx.path(engine);
    if (declared) reads.push([ref.mount, parent(ref.rel)]);
    engineCmd = quote(ref.path);
  }

  const tasks: Task[] = [];
  const mounts = ctx.scope(reads, writes);
  if (!empty.length) {
    const rendered = render(s.template, params, (name, value) => {
      if (value instanceof Ref || isSelection(value)) return table(value, files.get(name)!);
      if (value instanceof Raw) return value.text;
      return sqlLiteral(value);
    });
    const query = strip(rendered).replace(/;+$/, "");
    let command = `${engineCmd} -json -c ${quote(query)}`;
    if (out) {
      const fmt = COPY_FORMATS.get(ext(out.path)) ?? "JSON";
      const copy = `COPY (${query}) TO ${sqlLiteral(out.path)} (FORMAT ${fmt})`;
      const directory = parent(out.path);
      command = (directory ? `mkdir -p ${quote(directory)} && ` : "") + `${engineCmd} -c ${quote(copy)}`;
    }
    checkSize(ctx, command);
    tasks.push(new Task(command, mounts));
  }

  const units = ctx.prices.callUnits(s.vm.vcpu, s.vm.memMib);
  const plan = new Plan({
    kind: "sql",
    route: "exec",
    statement: strip(s.template),
    tasks,
    vm: s.vm,
    reads: shownR,
    writes: shownW,
    estimate: estimate(ctx.prices, {
      calls: tasks.length,
      unitsPerCall: units,
      bytesTouched: touched,
      complete: declared,
    }),
    files: count(files),
    parallel: 1,
    unmounted: tasks.length ? unmounted(ctx, mounts) : [],
    readPaths: pathsR,
  });
  if (empty.length) plan.notes.push("no input files for " + empty.join(", ") + ": nothing to run, zero rows returned");
  if (units > 1) plan.notes.push(`this VM size bills as ${units} calls`);

  const execute = async (): Promise<Result> => {
    if (empty.length) return new Result({ kind: "sql", stdout: "[]", rows: [], value: [] });
    const res = await ctx.backend.exec(tasks[0].mounts, tasks[0].command, s.vm);
    const rows = res.exitCode === 0 && !out ? parseRows(res.stdout) : null;
    return new Result({
      kind: "sql",
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      rows,
      value: rows,
      paths: out && res.exitCode === 0 ? [out.path] : [],
      truncated: res.truncated,
      meta: new Meta({ calls: 1, queueMs: res.queueMs, executeMs: res.executeMs }),
    });
  };

  return { plan, execute, reads, writes, declared, touched: sizes };
}

// -- grep ----------------------------------------------------------------------

/** How a grep task is written in a plan. It is a description: the grep route takes the fields, not this line. */
function grepCommand(pattern: string, where: string, opts: GrepOptions): string {
  const words = ["grep"];
  if (opts.ignoreCase) words.push("-i");
  if (!(opts.recursive ?? true)) words.push("--no-recursive");
  for (const g of opts.globs ?? []) words.push("--glob", quote(g));
  if (opts.maxResults != null) words.push("--max-results", String(Math.trunc(opts.maxResults)));
  return [...words, "-e", quote(pattern), quote(where)].join(" ");
}

/** A file name as a ripgrep glob that matches that name and nothing else. */
function globLiteral(name: string): string {
  return name.replace(/([\\*?[\]{}!])/g, "\\$1");
}

async function compileGrep(s: Statement): Promise<Compiled> {
  const ctx = s.ctx;
  const over = (s.params.find(([name]) => name === "over")?.[1] ?? null) as Ref | null;
  const opts: GrepOptions = { ...s.opts, recursive: s.opts.recursive ?? true };
  const targets: [Mount, string][] =
    over !== null ? [[ctx.mounts.get(over.mount)!, over.rel]] : Array.from(ctx.mounts.values(), (m) => [m, m.allow]);
  let touched = 0;
  let nfiles = 0;
  const tasks: Task[] = [];
  const shown: string[] = [];
  const sizes = new Map<string, number>();
  /** what the backend is asked: [mount, directory, options] */
  const searches: [Mount, string, GrepOptions][] = [];
  for (const [m, rel] of targets) {
    const found = await ctx.expand(new Ref(m.name, rel));
    touched += sizeOf(found);
    nfiles += found.length;
    for (const f of found) sizes.set(f.path, f.size);
    const where = rel ? `${m.name}/${rel}` : m.name;
    shown.push(where);
    // Search takes a directory. One file is searched as its directory, not below it, for that name.
    const oneFile = Boolean(rel) && found.length === 1 && found[0].path === where;
    const directory = oneFile ? parent(rel) : rel;
    const asked: GrepOptions = oneFile
      ? { ...opts, recursive: false, globs: [globLiteral(rel.slice(rel.lastIndexOf("/") + 1))] }
      : opts;
    searches.push([m, directory, asked]);
    const mounted = directory ? `${m.name}/${directory}` : m.name;
    tasks.push(
      new Task(grepCommand(s.template, where, opts), {
        [mounted]: new MountSpec(m.handle, { subdirectory: m.key(directory) || null, readOnly: true }),
      }),
    );
  }
  const searched = new Set(targets.map(([m]) => m.name));
  const plan = new Plan({
    kind: "grep",
    route: "grep",
    statement: s.template,
    tasks,
    reads: shown,
    estimate: estimate(ctx.prices, { calls: tasks.length, bytesTouched: touched }),
    files: nfiles,
    unmounted: [...ctx.mounts.keys()].filter((n) => !searched.has(n)),
  });

  const execute = async (): Promise<Result> => {
    const rows: Row[] = [];
    const reasons: string[] = [];
    for (const [m, directory, asked] of searches) {
      const [hits, reason] = await ctx.backend.grep(m.handle, m.key(directory), s.template, asked);
      reasons.push(reason);
      for (const h of hits) {
        const r = m.rel(h.file);
        if (!r.startsWith(META + "/")) rows.push({ file: `${m.name}/${r}`, line: h.line, text: h.text });
      }
    }
    return new Result({
      kind: "grep",
      stdout: rows.map((r) => `${r.file}:${r.line}:${r.text}\n`).join(""),
      rows,
      value: {
        exhaustive: reasons.every((r) => r === "completed"),
        stoppedReason: reasons.find((r) => r !== "completed") ?? "completed",
      },
      meta: new Meta({ calls: targets.length }),
    });
  };

  const reads: Pair[] = targets.map(([m, rel]) => [m.name, rel]);
  return { plan, execute, reads, writes: [], declared: true, touched: sizes };
}

// -- batch ---------------------------------------------------------------------

async function compileBatch(s: Statement): Promise<Compiled> {
  const ctx = s.ctx;
  if (!s.children.length) throw new ValidationError("batch() needs at least one statement", { code: "bad_batch" });
  const parts: Compiled[] = [];
  for (const child of s.children) {
    if ((child.kind !== "sh" && child.kind !== "sql") || child.split) {
      throw new ValidationError("batch() takes plain sh and sql statements", {
        code: "bad_batch",
        suggestion: "run mapped and grep statements on their own",
      });
    }
    // One VM, so one network policy: the batch's. A statement that asked for its own is refused
    // rather than quietly run under another.
    if (!sameEgress(child.vm.egress, s.vm.egress) && !sameEgress(child.vm.egress, ctx.egress)) {
      throw new ValidationError("the statements in a batch run in one VM, so they share its network policy", {
        code: "bad_batch",
        suggestion: "set egress on the batch or on the context, not on one statement",
      });
    }
    parts.push(await compile(child));
  }
  const declared = parts.every((p) => p.declared);
  const reads = declared ? parts.flatMap((p) => p.reads) : [];
  const writes = declared ? parts.flatMap((p) => p.writes) : [];
  const mounts = ctx.scope(reads, writes);
  const runnable = parts.map((p, i) => [i, p] as const).filter(([, p]) => p.plan.tasks.length);

  // Each statement runs in a subshell with its output and exit code kept apart; one line per
  // statement comes back: index, exit code, stdout and stderr in base64.
  const lines = ["__d=$(mktemp -d)"];
  for (const [i, p] of runnable) {
    lines.push(`(\n${p.plan.tasks[0].command}\n) >"$__d/${i}.out" 2>"$__d/${i}.err"; echo $? >"$__d/${i}.rc"`);
  }
  const ids = runnable.map(([i]) => i).join(" ");
  lines.push(
    `for i in ${ids}; do printf '%s %s %s %s\\n' "$i" "$(cat "$__d/$i.rc")" ` +
      `"$(base64 < "$__d/$i.out" | tr -d '\\n')" "$(base64 < "$__d/$i.err" | tr -d '\\n')"; done`,
  );
  const command = lines.join("\n");
  checkSize(ctx, command);
  const tasks = runnable.length ? [new Task(command, mounts)] : [];
  const plan = new Plan({
    kind: "batch",
    route: "exec",
    statement: `${parts.length} statements`,
    tasks,
    vm: s.vm,
    reads: parts.flatMap((p) => p.plan.reads),
    writes: parts.flatMap((p) => p.plan.writes),
    readPaths: parts.flatMap((p) => (p.plan.readPaths === null ? p.plan.reads : p.plan.readPaths)),
    estimate: estimate(ctx.prices, {
      calls: tasks.length,
      unitsPerCall: ctx.prices.callUnits(s.vm.vcpu, s.vm.memMib),
      bytesTouched: parts.reduce((sum, p) => sum + p.plan.estimate.bytesTouched, 0),
      complete: declared,
    }),
    unmounted: unmounted(ctx, mounts),
  });
  plan.notes.push(`${parts.length} statements in one call instead of ${parts.length}`);

  const execute = async (): Promise<Result> => {
    const results = parts.map((p) => new Result({ kind: p.plan.kind, plan: p.plan, rows: p.plan.kind === "sql" ? [] : null }));
    if (!tasks.length) return new Result({ kind: "batch", results, value: results });
    const res = await ctx.backend.exec(mounts, command, s.vm);
    for (const line of splitlines(res.stdout)) {
      const words = line.split(" ");
      const fields = [...words.slice(0, 3), ...(words.length > 3 ? [words.slice(3).join(" ")] : [])];
      if (fields.length !== 4 || !/^\d+$/.test(fields[0])) continue;
      const child = results[Number(fields[0])];
      child.exitCode = Number.parseInt(fields[1] || "1", 10);
      child.stdout = Buffer.from(fields[2], "base64").toString();
      child.stderr = Buffer.from(fields[3], "base64").toString();
      child.value = child.stdout;
      if (child.kind === "sql" && child.exitCode === 0) {
        const rows = parseRows(child.stdout);
        if (rows !== null) {
          child.rows = rows;
          child.value = rows;
        }
      }
    }
    return new Result({
      kind: "batch",
      exitCode: res.exitCode || (results.find((r) => r.exitCode)?.exitCode ?? 0),
      stdout: results.map((r) => r.stdout).join(""),
      stderr: res.stderr,
      results,
      value: results,
      truncated: res.truncated,
      meta: new Meta({ calls: 1, queueMs: res.queueMs, executeMs: res.executeMs }),
    });
  };

  const touchedByAll = new Map<string, number>();
  for (const p of parts) for (const [path, size] of p.touched) touchedByAll.set(path, size);
  return { plan, execute, reads, writes, declared, touched: touchedByAll };
}
