/**
 * Context: a value that says what data an agent has, and under what rules.
 *
 * A context composes several disks into one tree. Each mount names a disk and a
 * mode, which is the mutation strategy for that part of the tree:
 *
 *   mode     meaning, and how it is enforced on Archil
 *   -------  -----------------------------------------------------------------
 *   read     Live data, read-only. Mounted `readOnly`.
 *   frozen   Read-only and pinned to a checkpoint, so every run sees the same
 *            bytes. Backed by a branch of that checkpoint, mounted `readOnly`.
 *   owned    This context is the only writer. Calls take a checkout, so writes
 *            run at local-disk speed and a second writer waits its turn (for a
 *            few seconds, then it is refused). It is never overwritten.
 *   shared   Many writers. Mounted `conditional`: no checkout, last write to
 *            reach the disk wins, so each writer should keep to its own paths.
 *   append   Records are only ever added (logs, journals, histories). Appends go
 *            through the server-side append; commands see the data read-only.
 *
 * A context is a plain value: it serialises to a manifest, can be narrowed to a
 * subset of itself before it is handed to a sub-agent, and can be locked to a set
 * of checkpoints so a run is reproducible.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { ArchilBackend } from "./archil-backend.ts";
import { MountSpec, Vm, egressPolicy } from "./backends.ts";
import type { Backend, Egress, GrepOptions, Limits } from "./backends.ts";
import { decode, fixed, len, ljust, sorted } from "./compat.ts";
import { ValidationError } from "./errors.ts";
import { LocalBackend } from "./local.ts";
import { Budget, Estimate, Ledger, PriceSheet, estimate } from "./pricing.ts";
import type { BudgetLimits } from "./pricing.ts";
import { sync } from "./recipes.ts";
import type { Recipe, SyncStats } from "./recipes.ts";
import { FileStat, Glob, Ref, commonDir, norm, splitMount, tagged } from "./shell.ts";
import type { Selectable } from "./shell.ts";
import { Statement } from "./statement.ts";
import { Feed, Log, View } from "./structures.ts";
import type { LogOptions, ViewInput } from "./structures.ts";
import { buildTools } from "./tools.ts";
import type { Tool } from "./tools.ts";
import { Transaction } from "./transaction.ts";
import type { Commit, TransactionOptions } from "./transaction.ts";

export const MODES = ["read", "frozen", "owned", "shared", "append"] as const;
export type Mode = (typeof MODES)[number];

/** The framework's own bookkeeping on a disk (Archil reserves ".archil"). */
export const META = ".px";
/** Ends a recorded version that was too new to trust: it never equals a later one. */
export const PROVISIONAL = "~";
/** How far the caller's clock may differ from the backend's and versions still be read safely. */
export const CLOCK_SLACK_S = 0.5;
/** The clock and the wait, in one place so a test can put its own there. */
export const clock = {
  now: (): number => Date.now() / 1000,
  sleep: (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

export interface SourceOptions {
  subdirectory?: string;
  at?: string | null;
  create?: boolean;
  description?: string;
}

export interface SourceJSON {
  disk: string;
  mode: string;
  subdirectory?: string;
  at?: string;
  description?: string;
}

/** One disk, as a context wants to see it. */
export class Source {
  readonly disk: string;
  readonly mode: Mode;
  readonly subdirectory: string;
  readonly at: string | null;
  readonly create: boolean;
  readonly description: string;

  constructor(disk: string, mode: Mode = "read", options: SourceOptions = {}) {
    this.disk = disk;
    this.mode = mode;
    this.subdirectory = options.subdirectory ?? "";
    this.at = options.at ?? null;
    this.create = options.create ?? false;
    this.description = options.description ?? "";
  }

  toJSON(): SourceJSON {
    const d: SourceJSON = { disk: this.disk, mode: this.mode };
    if (this.subdirectory) d.subdirectory = this.subdirectory;
    if (this.at) d.at = this.at;
    if (this.description) d.description = this.description;
    return d;
  }
}

/** Describe a disk to mount: by name or id, with a mode. Nothing is contacted yet. */
export function disk(ref: string, mode: Mode = "read", options: SourceOptions = {}): Source {
  if (!MODES.includes(mode)) {
    throw new ValidationError(`unknown mode '${mode}'`, {
      code: "bad_mode",
      suggestion: `use one of: ${MODES.join(", ")}`,
    });
  }
  if (mode === "frozen" && !options.at) {
    throw new ValidationError("a frozen mount needs { at: <checkpoint> }", {
      code: "bad_mode",
      suggestion: "take one with ctx.lock(name), which returns a manifest with every mount frozen",
    });
  }
  return new Source(ref, mode, { ...options, subdirectory: norm(options.subdirectory ?? "") });
}

export class Mount {
  readonly name: string;
  readonly source: Source;
  /** the backend's handle for the disk (a branch handle when frozen or forked) */
  readonly handle: string;
  /** narrowed to this sub-tree; "" means the whole mount */
  readonly allow: string;
  /** forced read-only by narrow() */
  readonly readOnly: boolean;

  constructor(name: string, source: Source, handle: string, allow = "", readOnly = false) {
    this.name = name;
    this.source = source;
    this.handle = handle;
    this.allow = allow;
    this.readOnly = readOnly;
  }

  /** A copy with some fields replaced. */
  with(fields: { handle?: string; allow?: string; readOnly?: boolean; source?: Source }): Mount {
    return new Mount(
      this.name,
      fields.source ?? this.source,
      fields.handle ?? this.handle,
      fields.allow ?? this.allow,
      fields.readOnly ?? this.readOnly,
    );
  }

  get mode(): Mode {
    return this.readOnly && this.source.mode !== "read" && this.source.mode !== "frozen" ? "read" : this.source.mode;
  }

  get writable(): boolean {
    return this.mode === "owned" || this.mode === "shared";
  }

  get appendable(): boolean {
    return this.mode === "owned" || this.mode === "shared" || this.mode === "append";
  }

  /** Path within the mount -> key on the disk. */
  key(rel: string): string {
    return [this.source.subdirectory, rel].filter((p) => p).join("/");
  }

  rel(key: string): string {
    const base = this.source.subdirectory;
    return base && key.startsWith(base + "/") ? key.slice(base.length + 1) : key;
  }

  within(rel: string): boolean {
    return !this.allow || rel === this.allow || rel.startsWith(this.allow + "/");
  }

  /** The [in-VM path, mount spec] for a call. `sub` narrows a read-only mount further. */
  spec(limits: Limits, options: { write: boolean; sub?: string }): [vmKey: string, spec: MountSpec] {
    const sub = options.sub && this.within(options.sub) ? options.sub : this.allow;
    const vmKey = sub ? `${this.name}/${sub}` : this.name;
    const subdirectory = this.key(sub) || null;
    if (!options.write || !this.writable) return [vmKey, new MountSpec(this.handle, { subdirectory, readOnly: true })];
    if (this.mode === "shared") return [vmKey, new MountSpec(this.handle, { subdirectory, conditional: true })];
    return [vmKey, new MountSpec(this.handle, { subdirectory, queueMs: limits.checkoutQueueMs })];
  }
}

export function defaultBackend(): Backend {
  const choice = (process.env.ARCHIL_BACKEND ?? "").toLowerCase();
  if (choice !== "local" && process.env.ARCHIL_API_KEY) return new ArchilBackend();
  return new LocalBackend({ root: process.env.ARCHIL_LOCAL_ROOT ?? ".archil-local" });
}

export interface ContextOptions {
  backend?: Backend;
  name?: string;
  prices?: PriceSheet;
  /** a ceiling for everything this context runs: a `Budget`, or its limits, e.g. { maxUsd: 0.05 } */
  budget?: Budget | BudgetLimits | null;
  /** a path in the context where every statement is logged, e.g. "obs/journal" */
  journal?: string | null;
  /** where tools live when they are not on the VM's PATH, e.g. { duckdb: "obs/bin/duckdb" } */
  tools?: Record<string, string> | null;
  /**
   * What a statement's VM may reach on the network: "deny" (nothing leaves), a list of hosts
   * (only those), or "allow" / left out (open, which is Archil's default).
   */
  egress?: Egress;
}

export interface MountManifest extends SourceJSON {
  allow?: string;
  readOnly?: boolean;
}

export interface Manifest {
  archilContext: 0;
  name: string;
  mounts: Record<string, MountManifest>;
  journal?: string;
  tools?: Record<string, string>;
  egress?: "deny" | string[];
  locked?: string;
}

type Params = Record<string, unknown>;

function hex(n: number): string {
  return randomUUID().replaceAll("-", "").slice(0, n);
}

export class Context {
  readonly backend: Backend;
  readonly name: string;
  readonly prices: PriceSheet;
  readonly budget: Budget | null;
  readonly toolsMap: Record<string, string>;
  readonly spend: Ledger;
  readonly session: string;
  readonly journal: string | null;
  readonly mounts: Map<string, Mount>;
  /** null: open. []: nothing leaves. hosts: only these. A statement can set its own with .egress(). */
  readonly egress: readonly string[] | null;
  #journalLog: Log | null = null;
  /** entries the journal could not take yet */
  #journalBacklog: Record<string, unknown>[] = [];
  /** what had been spent when the budget was set */
  #budgetFrom: Estimate;

  /**
   * Takes mounts that are already resolved. Use `context(...)`: resolving a disk
   * waits on the backend, which a constructor cannot do.
   */
  constructor(
    mounts: Map<string, Mount>,
    options: ContextOptions & { backend: Backend; ledger?: Ledger; budgetFrom?: Estimate },
  ) {
    this.backend = options.backend;
    this.name = options.name ?? "context";
    this.prices = options.prices ?? new PriceSheet();
    this.budget = asBudget(options.budget);
    this.toolsMap = { ...(options.tools ?? {}) };
    this.egress = egressPolicy(options.egress);
    this.spend = options.ledger ?? new Ledger(this.prices);
    this.#budgetFrom = options.budgetFrom ?? new Estimate();
    this.session = hex(8);
    this.journal = options.journal ? norm(options.journal) : null;
    this.mounts = mounts;
  }

  /** Compose disks into a context. A bare string is a read mount of the disk of that name. */
  static async open(mounts: Record<string, Source | string>, options: ContextOptions = {}): Promise<Context> {
    const backend = options.backend ?? defaultBackend();
    const given = Object.entries(mounts);
    if (!given.length) throw new ValidationError("a context needs at least one mount", { code: "empty_context" });
    const resolved = new Map<string, Mount>();
    for (const [rawName, value] of given) {
      const mountName = norm(rawName);
      // "__proto__" cannot be a key of the mount map a call takes
      if (!mountName || mountName.includes("/") || mountName === META || mountName === "__proto__") {
        throw new ValidationError(`bad mount name '${rawName}'`, {
          code: "bad_mount",
          suggestion: "mount names are single path segments, like 'logs'",
        });
      }
      const source = typeof value === "string" ? disk(value) : value;
      let handle = await backend.resolveDisk(source.disk, { create: source.create });
      if (source.mode === "frozen") {
        handle = await backend.branch(handle, `frozen-${source.at}`, source.at!, { existOk: true });
      }
      resolved.set(mountName, new Mount(mountName, source, handle));
    }
    return new Context(resolved, { ...options, backend });
  }

  // -- composition -----------------------------------------------------------
  _derive(
    mounts: Map<string, Mount>,
    over: { name?: string; budget?: Budget | null; budgetFrom?: Estimate; egress?: readonly string[] | null } = {},
  ): Context {
    return new Context(mounts, {
      backend: this.backend,
      name: over.name ?? this.name,
      prices: this.prices,
      budget: "budget" in over ? over.budget : this.budget,
      journal: this.journal,
      tools: this.toolsMap,
      egress: "egress" in over ? over.egress : this.egress,
      ledger: this.spend,
      budgetFrom: over.budgetFrom ?? this.#budgetFrom,
    });
  }

  /** A new context with one more mount (or one replaced). */
  async mount(name: string, source: Source | string): Promise<Context> {
    const extra = (await Context.open({ [name]: source }, { backend: this.backend })).mounts;
    return this._derive(new Map([...this.mounts, ...extra]));
  }

  /**
   * A context that can reach only the given sub-trees, under the same path names.
   *
   * Narrowing can only take access away. Use it before handing a context to a
   * sub-agent or a tool call that should see less than you do.
   */
  narrow(paths: string[] = [], options: { readOnly?: boolean } = {}): Context {
    const readOnly = options.readOnly ?? false;
    const mounts = new Map<string, Mount>();
    if (!paths.length) {
      for (const [n, m] of this.mounts) mounts.set(n, m.with({ readOnly: m.readOnly || readOnly }));
      return this._derive(mounts);
    }
    const byMount = new Map<string, string[]>();
    for (const p of paths) {
      const [m, rel] = this._resolve(p);
      if (!byMount.has(m.name)) byMount.set(m.name, []);
      byMount.get(m.name)!.push(rel);
    }
    for (const [mountName, rels] of byMount) {
      const m = this.mounts.get(mountName)!;
      mounts.set(mountName, m.with({ allow: commonDir(rels), readOnly: m.readOnly || readOnly }));
    }
    return this._derive(mounts);
  }

  /**
   * The same context under a ceiling. The budget counts what is spent from now on, so a
   * helper handed a budgeted context is not charged for what its parent already did.
   */
  withBudget(budget: Budget | BudgetLimits | null): Context {
    return this._derive(this.mounts, { budget: asBudget(budget), budgetFrom: this.spend.snapshot() });
  }

  /**
   * The same context with a network policy for everything it runs: "deny" (nothing leaves), a
   * list of hosts (only those), or "allow" (open, which is Archil's default).
   *
   * A mount map limits what a command can read. This limits where what it read can go. Hand a
   * model the tools of `ctx.withEgress("deny")` unless its commands need the network.
   */
  withEgress(egress: Egress): Context {
    return this._derive(this.mounts, { egress: egressPolicy(egress) });
  }

  spentUnderBudget(): Estimate {
    return this.spend.snapshot().since(this.#budgetFrom);
  }

  // -- paths -----------------------------------------------------------------
  _resolve(path: string | Ref, options: { write?: boolean; append?: boolean } = {}): [mount: Mount, rel: string] {
    const [mountName, rel] = path instanceof Ref ? [path.mount, path.rel] : splitMount(path);
    const m = this.mounts.get(mountName);
    if (!m) {
      throw new ValidationError(`no mount named '${mountName}'`, {
        code: "unknown_mount",
        path: String(path),
        suggestion: "paths start with a mount name: " + Array.from(this.mounts.keys(), (n) => `${n}/…`).join(", "),
      });
    }
    if (!m.within(rel)) {
      throw new ValidationError(`outside this context: it is narrowed to ${m.name}/${m.allow}`, {
        code: "out_of_scope",
        path: String(path),
        suggestion: "ask the owner of the wider context for this path",
      });
    }
    if (options.write && !m.writable) {
      const hint =
        m.mode === "append"
          ? "use append() or log() for an append-only mount"
          : "mount the disk as 'owned' or 'shared' to write to it";
      throw new ValidationError(`'${m.name}' is ${m.mode}; it cannot be written`, {
        code: "read_only",
        path: String(path),
        suggestion: hint,
      });
    }
    if (options.append && !m.appendable) {
      throw new ValidationError(`'${m.name}' is ${m.mode}; it cannot be appended to`, {
        code: "read_only",
        path: String(path),
        suggestion: "mount the disk as 'append', 'owned' or 'shared'",
      });
    }
    return [m, rel];
  }

  /** A path the command reads. */
  path(path: string): Ref {
    const [m, rel] = this._resolve(path);
    return new Ref(m.name, rel);
  }

  /** A path the command writes. Declaring it is what makes the mount writable for that call. */
  out(path: string): Ref {
    const [m, rel] = this._resolve(path, { write: true });
    return new Ref(m.name, rel, true);
  }

  /** Files matching a pattern. `**` crosses directories; `*` does not. */
  glob(pattern: string): Glob {
    const [mountName, pat] = splitMount(pattern);
    const g = new Glob(mountName, pat);
    this._resolve(new Ref(mountName, g.staticPrefix()));
    return g;
  }

  /** The files a path or glob covers right now, sorted by path. Metadata only: nothing is read. */
  async expand(sel: Ref | Glob | Selectable | string): Promise<FileStat[]> {
    if (typeof sel === "string") sel = /[*?[]/.test(sel) ? this.glob(sel) : this.path(sel);
    if (!(sel instanceof Ref) && !(sel instanceof Glob)) return sel.resolve(this);
    const m = this.mounts.get(sel.mount) ?? this._resolve(new Ref(sel.mount))[0];
    const stat = (rel: string, o: { size: number; modified: number; version: string }): FileStat =>
      new FileStat(`${m.name}/${rel}`, o.size, o.modified, o.version);
    const found: FileStat[] = [];
    if (sel instanceof Glob) {
      const regex = sel.regex();
      for (const o of await this.backend.list(m.handle, m.key(sel.staticPrefix()), { recursive: true })) {
        const rel = m.rel(o.key);
        if (regex.test(rel) && !rel.startsWith(META + "/") && m.within(rel)) found.push(stat(rel, o));
      }
    } else {
      for (const o of await this.backend.list(m.handle, m.key(sel.rel), { recursive: true })) {
        const rel = m.rel(o.key);
        const inside = !sel.rel || rel === sel.rel || rel.startsWith(sel.rel + "/");
        if (inside && !rel.startsWith(META + "/")) found.push(stat(rel, o));
      }
    }
    return sorted(found, (f) => f.path); // one order on every backend, so plans are reproducible
  }

  // -- scope: which disks a call sees, and how ---------------------------------
  /**
   * Compile declared reads and writes into the smallest mount map that satisfies them.
   *
   * `reads` are [mount, directory] pairs; `writes` are [mount, path] pairs.
   * With neither, the call sees the whole context, each mount in its own mode.
   */
  scope(reads: Iterable<[string, string]>, writes: Iterable<[string, string]>): Record<string, MountSpec> {
    const r = [...reads];
    const w = [...writes];
    const limits = this.backend.limits;
    const out: Record<string, MountSpec> = {};
    if (!r.length && !w.length) {
      for (const m of this.mounts.values()) {
        const [vmKey, spec] = m.spec(limits, { write: true });
        out[vmKey] = spec;
      }
      return out;
    }
    const written = new Set(w.map(([m]) => m));
    for (const mountName of new Set([...r.map(([m]) => m), ...w.map(([m]) => m)])) {
      const m = this.mounts.get(mountName)!;
      const dirs = r.filter(([mm]) => mm === mountName).map(([, d]) => d);
      const [vmKey, spec] = written.has(mountName)
        ? m.spec(limits, { write: true })
        : m.spec(limits, { write: false, sub: commonDir(dirs) });
      out[vmKey] = spec;
    }
    return out;
  }

  // -- the data plane: reads and writes that need no compute -------------------
  async read(path: string): Promise<Uint8Array> {
    const [m, rel] = this._resolve(path);
    const data = await this.backend.get(m.handle, m.key(rel));
    if (!this.backend.insideArchil) {
      this.spend.add(estimate(this.prices, { egressBytes: data.length }), { statement: false });
    }
    return data;
  }

  async readText(path: string): Promise<string> {
    return decode(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string, options: { ifAbsent?: boolean } = {}): Promise<string> {
    const [m, rel] = this._resolve(path, { write: true });
    await this.backend.put(m.handle, m.key(rel), bytes(data), { ifAbsent: options.ifAbsent ?? false });
    return `${m.name}/${rel}`;
  }

  async append(path: string, data: Uint8Array | string): Promise<string> {
    const [m, rel] = this._resolve(path, { append: true });
    await this.backend.append(m.handle, m.key(rel), bytes(data));
    return `${m.name}/${rel}`;
  }

  async exists(path: string): Promise<boolean> {
    const [m, rel] = this._resolve(path);
    return (await this.backend.head(m.handle, m.key(rel))) !== null;
  }

  /** Remove a file, or a directory and everything under it. */
  async rm(path: string): Promise<void> {
    const [m, rel] = this._resolve(path, { write: true });
    if (!rel) {
      throw new ValidationError("rm needs a path below the mount", {
        code: "bad_path",
        path: String(path),
        suggestion: "name a file or a directory; a whole disk is not removed this way",
      });
    }
    await this.backend.delete(m.handle, m.key(rel));
  }

  /** List a directory. Directories end in '/'. Listing never makes data active. */
  async ls(path = "", options: { recursive?: boolean } = {}): Promise<FileStat[]> {
    if (!norm(path)) return Array.from(this.mounts.keys(), (n) => new FileStat(`${n}/`, 0));
    const [m, rel] = this._resolve(path);
    const out: FileStat[] = [];
    for (const o of await this.backend.list(m.handle, m.key(rel), { recursive: options.recursive ?? false })) {
      const r = m.rel(o.key);
      if (r.startsWith(META + "/") || r.replace(/\/+$/, "") === META) continue;
      out.push(new FileStat(`${m.name}/${r}`, o.size, o.modified, o.key.endsWith("/") ? "" : o.version));
    }
    return out;
  }

  async share(path: string, options: { expiresIn?: number } = {}): Promise<string> {
    const [m, rel] = this._resolve(path);
    return this.backend.share(m.handle, m.key(rel), options.expiresIn ?? 86400);
  }

  // -- statements: work that runs next to the data -----------------------------
  /**
   * A bash command, as a statement. `await` it (or call `.run()`) to run it, or
   * `.explain()` to see the plan first. Write it as a template with named
   * parameters, or as a tagged template, where each `${...}` is a parameter.
   */
  sh(command: string, params?: Params): Statement;
  sh(strings: TemplateStringsArray, ...values: unknown[]): Statement;
  sh(first: string | TemplateStringsArray, ...rest: unknown[]): Statement {
    const [template, params] = templateOf(first, rest);
    return new Statement({ ctx: this, kind: "sh", template, params, vm: new Vm({ egress: this.egress }) });
  }

  /** Regex search fanned out next to the data. One call per disk, however many files. */
  grep(pattern: string, over?: string | Ref | null, options: GrepOptions = {}): Statement {
    const target = over == null || over instanceof Ref ? (over ?? null) : this.path(over);
    return new Statement({ ctx: this, kind: "grep", template: pattern, params: [["over", target]], opts: { ...options } });
  }

  /** SQL over files in the context (JSON lines, Parquet, CSV), run by DuckDB next to the data. */
  sql(query: string, params?: Params): Statement;
  sql(strings: TemplateStringsArray, ...values: unknown[]): Statement;
  sql(first: string | TemplateStringsArray, ...rest: unknown[]): Statement {
    const [template, params] = templateOf(first, rest);
    return new Statement({ ctx: this, kind: "sql", template, params, vm: new Vm({ egress: this.egress }) });
  }

  /** Run several small statements in one call. Each still gets its own result. */
  batch(statements: Statement[]): Statement {
    return new Statement({
      ctx: this,
      kind: "batch",
      template: "",
      children: [...statements],
      vm: new Vm({ egress: this.egress }),
    });
  }

  // -- versions that are coarser than writes -------------------------------------
  /**
   * Could a file last modified at `modified` still change without its version changing?
   *
   * Where a version carries a time in whole seconds (Archil), a file rewritten in place at the
   * same size keeps its version until the clock has left the second it was last modified in.
   * Until then a recorded version of it proves nothing.
   */
  _unsettled(modified: number): boolean {
    const coarse = this.backend.versionGranularityS ?? 0;
    return coarse > 0 && clock.now() - modified < coarse + CLOCK_SLACK_S;
  }

  /**
   * Wait until a file modified at `newest` can no longer change behind its version. At most a
   * second and a half, and only when something was written that recently.
   */
  async _settle(newest: number): Promise<void> {
    const coarse = this.backend.versionGranularityS ?? 0;
    if (coarse <= 0) return;
    const wait = Math.min(newest + coarse + CLOCK_SLACK_S - clock.now(), coarse + CLOCK_SLACK_S);
    if (wait > 0) await clock.sleep(wait);
  }

  // -- time --------------------------------------------------------------------
  /** Take one checkpoint and count what it cost: on Archil today it is an exec, so it is a call. */
  async _checkpoint(handle: string, name: string): Promise<string> {
    try {
      return await this.backend.checkpoint(handle, name);
    } finally {
      // a checkpoint that was refused was still a call
      const calls = this.backend.checkpointCalls ?? 0;
      if (calls) this.spend.add(estimate(this.prices, { calls }), { statement: false });
    }
  }

  /** Checkpoint every writable mount under one name. */
  async checkpoint(name: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const m of this.mounts.values()) {
      if (m.appendable) out.set(m.name, await this._checkpoint(m.handle, name));
    }
    return out;
  }

  /**
   * Checkpoint every mount and return a manifest with all of them frozen at that point.
   *
   * Opening the returned manifest gives a context that reads the same bytes every
   * time, which is what an eval, a replay or a reproducible build needs.
   */
  async lock(name: string): Promise<Manifest> {
    const manifest = this.manifest();
    for (const m of this.mounts.values()) {
      if (m.source.mode === "frozen") continue; // already pinned: a lock keeps the pin a mount has
      await this._checkpoint(m.handle, name);
      const { subdirectory, description } = m.source;
      manifest.mounts[m.name] = mountManifest(m, new Source(m.source.disk, "frozen", { subdirectory, description, at: name }));
    }
    manifest.locked = name;
    return manifest;
  }

  /**
   * A copy of this context whose writable mounts are private branches.
   *
   * Use one fork per attempt when several agents try the same task: each sees
   * the same starting state and none sees another's writes.
   */
  async fork(name: string): Promise<Context> {
    const mounts = new Map(this.mounts);
    for (const m of this.mounts.values()) {
      if (m.writable) {
        const cp = await this._checkpoint(m.handle, `fork-${name}`);
        const branch = await this.backend.branch(m.handle, name, cp);
        // The fork's source names the branch, so its manifest opens the fork and not the original.
        const { mode, subdirectory, at, description } = m.source;
        mounts.set(m.name, m.with({ handle: branch, source: new Source(branch, mode, { subdirectory, at, description }) }));
      }
    }
    return this._derive(mounts, { name: `${this.name}@${name}` });
  }

  /**
   * All of a turn's changes, or none of them. `turn` is the turn's own context:
   * what it writes stays on a branch until the callback returns, then lands
   * together. If the callback throws, nothing lands. See `Transaction`.
   */
  async transaction(fn: (turn: Context) => unknown, options: TransactionOptions = {}): Promise<Commit> {
    const tx = new Transaction(this, options);
    await tx.begin();
    try {
      await fn(tx.ctx);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    return tx.commit();
  }

  // -- structures ----------------------------------------------------------------
  log(path: string, options: LogOptions = {}): Log {
    return new Log(this, path, options);
  }

  view(path: string, build: Statement | (() => Statement), options: { inputs?: ViewInput[] } = {}): View {
    return new View(this, path, build, { inputs: options.inputs ?? [] });
  }

  /** What changed under `path` since the reader holding `cursor` last looked. */
  feed(path: string, options: { cursor: string }): Feed {
    return new Feed(this, path, options);
  }

  sync(recipe: Recipe, into: string): Promise<SyncStats> {
    return sync(this, recipe, into);
  }

  tools(names?: string[] | null): Tool[] {
    return buildTools(this, names);
  }

  // -- manifest --------------------------------------------------------------------
  manifest(): Manifest {
    const mounts: Record<string, MountManifest> = {};
    for (const m of this.mounts.values()) mounts[m.name] = mountManifest(m);
    const out: Manifest = { archilContext: 0, name: this.name, mounts };
    if (this.journal) out.journal = this.journal;
    if (Object.keys(this.toolsMap).length) out.tools = this.toolsMap;
    if (this.egress !== null) out.egress = this.egress.length ? [...this.egress] : "deny";
    return out;
  }

  /** Open a context from a manifest (an object, a JSON string, or a path to a file). */
  static async fromManifest(
    manifest: object | string,
    options: Pick<ContextOptions, "backend" | "prices" | "budget"> = {},
  ): Promise<Context> {
    if (typeof manifest === "string" && !manifest.trimStart().startsWith("{")) manifest = readFileSync(manifest, "utf8");
    const data = (typeof manifest === "string" ? JSON.parse(manifest) : manifest) as Partial<Manifest>;
    if (data.archilContext !== 0) {
      throw new ValidationError("not a context manifest (expected archilContext: 0)", { code: "bad_manifest" });
    }
    const sources: Record<string, Source> = {};
    const narrowed = new Map<string, [allow: string, readOnly: boolean]>();
    for (const [mountName, d] of Object.entries(data.mounts!)) {
      sources[mountName] = disk(d.disk, (d.mode ?? "read") as Mode, {
        subdirectory: d.subdirectory ?? "",
        at: d.at,
        description: d.description ?? "",
      });
      if (d.allow || d.readOnly) narrowed.set(mountName, [d.allow ?? "", Boolean(d.readOnly)]);
    }
    const ctx = await Context.open(sources, {
      backend: options.backend,
      prices: options.prices,
      budget: options.budget,
      name: data.name ?? "context",
      journal: data.journal,
      tools: data.tools,
      egress: data.egress,
    });
    for (const [mountName, [allow, readOnly]] of narrowed) {
      ctx.mounts.set(mountName, ctx.mounts.get(mountName)!.with({ allow, readOnly }));
    }
    return ctx;
  }

  /** What a model needs to know about this context, in a few lines. */
  describe(): string {
    const lines = [`context "${this.name}" on ${this.backend.name}`];
    const mounts = [...this.mounts.values()];
    const where = mounts.map((m) => (m.allow ? `${m.name}/${m.allow}/` : `${m.name}/`));
    const width = Math.max(...where.map(len));
    mounts.forEach((m, i) => {
      const note = m.source.description ? `  ${m.source.description}` : "";
      const pin = m.source.at ? ` @${m.source.at}` : "";
      lines.push(`  ${ljust(where[i], width)}  ${ljust(m.mode, 7)} ${m.source.disk}${pin}${note}`);
    });
    lines.push(
      "Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to " +
        `the data and bill per call (≈ $${fixed(this.prices.callUsd, 5)}). explain() prices a statement first.`,
    );
    if (this.egress !== null) lines.push(`Commands run with ${new Vm({ egress: this.egress }).describeEgress()}.`);
    return lines.join("\n");
  }

  async _record(entry: Record<string, unknown>): Promise<void> {
    if (!this.journal) return;
    // An entry carries the time it happened, because it may be written later: the journal's disk
    // can be busy (on Archil, while a statement holds its checkout). What cannot be written now
    // is kept, in order, and goes out with the next entry.
    this.#journalBacklog.push({ ts: new Date().toISOString(), ...entry });
    try {
      this.#journalLog ??= this.log(this.journal, { partition: "day", writer: this.session });
      const pending = [...this.#journalBacklog];
      await this.#journalLog.append(pending);
      this.#journalBacklog.splice(0, pending.length);
    } catch {
      // a journal must never break the work it records
    }
  }

  /** Journal entries not yet on the disk. They are written with the next entry that can be. */
  get journalPending(): number {
    return this.#journalBacklog.length;
  }

  toString(): string {
    return `<Context ${this.name}: ` + Array.from(this.mounts.values(), (m) => `${m.name}(${m.mode})`).join(", ") + ">";
  }
}

/** Compose disks into a context. See the top of this file for the modes. */
export function context(mounts: Record<string, Source | string>, options: ContextOptions = {}): Promise<Context> {
  return Context.open(mounts, options);
}

/** [bytes, files] under a path, from a metadata listing. */
export async function treeSize(ctx: Context, mount: string, rel: string): Promise<[bytes: number, files: number]> {
  const files = await ctx.expand(new Ref(mount, rel));
  return [files.reduce((sum, f) => sum + f.size, 0), files.length];
}

/** A budget given as a `Budget` or as its limits. */
function asBudget(budget: Budget | BudgetLimits | null | undefined): Budget | null {
  if (budget == null) return null;
  return budget instanceof Budget ? budget : new Budget(budget);
}

/** One mount as a manifest writes it. */
function mountManifest(m: Mount, source: Source = m.source): MountManifest {
  const d: MountManifest = source.toJSON();
  if (m.allow) d.allow = m.allow;
  if (m.readOnly) d.readOnly = true;
  return d;
}

function templateOf(first: string | TemplateStringsArray, rest: unknown[]): [string, [string, unknown][]] {
  if (typeof first === "string") return [first, Object.entries((rest[0] ?? {}) as Params)];
  return tagged(first, rest);
}

function bytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? Buffer.from(data) : data;
}
