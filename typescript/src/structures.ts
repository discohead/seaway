/**
 * Three structures built from the same verbs: a log, a view and a feed.
 *
 * A log is an append-only stream laid out so that it is cheap to keep and
 * cheap to ask questions of: one directory per hour, one file per writer. The
 * partition directory is what lets a question about the last fifteen minutes
 * touch fifteen minutes of data, and the per-writer file is what lets many
 * machines append without overwriting one another.
 *
 * A view is a statement with a name. It writes a derived file (a report, an
 * index, a dashboard) and remembers what it was built from, so refreshing it
 * when nothing has changed costs nothing, and rebuilding it never needs a model.
 *
 * A feed is a cursor over a listing: what was added, changed or removed under
 * a path since this reader last looked. It is how work starts from a change in
 * the data instead of from a clock.
 */

import { createHash, randomUUID } from "node:crypto";

import { decode, dumps, round, sorted, strip } from "./compat.ts";
import { META, PROVISIONAL } from "./context.ts";
import type { Context } from "./context.ts";
import { ValidationError } from "./errors.ts";
import { canonical } from "./plan.ts";
import { Ref, commonDir, parent } from "./shell.ts";
import type { FileStat, Glob, Selectable } from "./shell.ts";
import { describeParam, isSelection } from "./statement.ts";
import type { Result, Statement } from "./statement.ts";

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = { s: SECOND, m: 60 * SECOND, h: HOUR, d: DAY };

/** A span as milliseconds: "15m", "2h", "7d", or a number of milliseconds. */
function duration(spec: string | number): number {
  if (typeof spec === "number") return spec;
  const m = /^(\d+)\s*([smhd])$/.exec(strip(spec));
  if (!m) {
    throw new ValidationError(`cannot read '${spec}' as a duration`, {
      code: "bad_duration",
      suggestion: "use forms like '15m', '2h' or '7d'",
    });
  }
  return Number(m[1]) * UNITS[m[2]];
}

/** An ISO time as a Date. One without an offset is taken as UTC, as the Python SDK takes it. */
function parseTime(value: unknown): Date {
  let text = strip(String(value)).replace(" ", "T");
  if (text.includes("T") && !/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text)) text += "Z";
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError(`cannot read '${value}' as a time`, {
      code: "bad_time",
      suggestion: "use ISO 8601, like 2026-11-09T14:30:00.000Z",
    });
  }
  return at;
}

function dayText(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The start of a partition directory, in milliseconds, or null if the names are not a date (and an hour). */
function partitionStart(day: string | undefined, hour?: string): number | null {
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(day ?? "");
  if (!d) return null;
  const [year, month, date] = [Number(d[1]), Number(d[2]), Number(d[3])];
  let h = 0;
  if (hour !== undefined) {
    if (!/^\d{1,2}$/.test(hour) || Number(hour) > 23) return null;
    h = Number(hour);
  }
  const at = new Date(Date.UTC(year, month - 1, date, h));
  at.setUTCFullYear(year); // Date.UTC reads years 0 to 99 as 1900 to 1999
  const real = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
  return real ? at.getTime() : null;
}

export interface LogOptions {
  partition?: "hour" | "day" | "none";
  writer?: string | null;
}

/** Append-only records at `<path>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`. */
export class Log {
  readonly ctx: Context;
  readonly mount: string;
  readonly rel: string;
  readonly partition: "hour" | "day" | "none";
  readonly writer: string;

  constructor(ctx: Context, path: string, options: LogOptions = {}) {
    const partition = options.partition ?? "hour";
    if (!["hour", "day", "none"].includes(partition)) {
      throw new ValidationError(`unknown partition '${partition}'`, {
        code: "bad_partition",
        suggestion: "use 'hour', 'day' or 'none'",
      });
    }
    const [m, rel] = ctx._resolve(path);
    this.ctx = ctx;
    this.mount = m.name;
    this.rel = rel;
    this.partition = partition;
    this.writer = (options.writer || ctx.session).replace(/[^A-Za-z0-9_.-]/gu, "-");
  }

  get path(): string {
    return this.rel ? `${this.mount}/${this.rel}` : this.mount;
  }

  #dir(at: Date): string {
    const iso = at.toISOString();
    const parts = [this.rel];
    if (this.partition !== "none") parts.push(iso.slice(0, 10));
    if (this.partition === "hour") parts.push(iso.slice(11, 13));
    return parts.filter((p) => p).join("/");
  }

  /**
   * Add records. Each gets a `ts` and an `id` unless it already has them.
   *
   * The id is what makes a retry safe: an append that is sent twice can be
   * recognised and dropped by the reader.
   */
  async append(
    records: Record<string, unknown> | Iterable<Record<string, unknown>>,
    options: { at?: Date | null } = {},
  ): Promise<string[]> {
    const list = Symbol.iterator in records ? [...(records as Iterable<Record<string, unknown>>)] : [records];
    const limit = this.ctx.backend.limits.appendMaxBytes;
    const chunks = new Map<string, Buffer[]>();
    for (const record of list) {
      const stamp = Object.hasOwn(record, "ts") ? parseTime(record.ts) : (options.at ?? new Date());
      const line = { ts: stamp.toISOString(), id: randomUUID().replaceAll("-", "").slice(0, 12), ...record };
      const data = Buffer.from(dumps(line, { compact: true }) + "\n");
      if (data.length > limit) {
        throw new ValidationError(`one record is larger than an append can carry (${limit} bytes)`, {
          code: "record_too_large",
        });
      }
      const path = `${this.mount}/${this.#dir(stamp)}/${this.writer}.ndjson`;
      if (!chunks.has(path)) chunks.set(path, []);
      chunks.get(path)!.push(data);
    }
    const written: string[] = [];
    for (const [path, lines] of chunks) {
      let buffer: Buffer[] = [];
      let size = 0;
      for (const data of lines) {
        if (size && size + data.length > limit) {
          await this.ctx.append(path, Buffer.concat(buffer));
          buffer = [];
          size = 0;
        }
        buffer.push(data);
        size += data.length;
      }
      if (size) await this.ctx.append(path, Buffer.concat(buffer));
      written.push(path);
    }
    return written;
  }

  // -- selections: the part of the log a question needs ------------------------
  /** Records from the last `span` ("15m", "2h", "7d", or a number of milliseconds) up to now. */
  last(span: string | number, options: { now?: Date | null } = {}): Selection {
    const end = options.now ?? new Date();
    const label = typeof span === "number" ? `last ${span}ms` : `last ${span}`;
    return new Selection(this, new Date(end.getTime() - duration(span)), end, label, true, false);
  }

  /** Records with `start <= ts < end`. */
  between(start: Date, end: Date): Selection {
    const minute = (at: Date): string => at.toISOString().slice(0, 16).replace("T", " ");
    return new Selection(this, start, end, `${minute(start)}..${minute(end)}`);
  }

  all(): Selection {
    return new Selection(this, null, null, "all");
  }

  toString(): string {
    return `<Log ${this.path} by ${this.partition}>`;
  }
}

/**
 * The records of a log in a time range.
 *
 * The range does two jobs. From a listing, which reads nothing, it picks the
 * partitions that can hold such records, and those are the only files a
 * statement mounts and reads. In SQL it is also a filter on `ts`, so the
 * table is exactly the records in the range. In bash it is the files; a
 * partition is an hour or a day, so filter on `ts` there if the edges matter.
 */
export class Selection implements Selectable {
  readonly log: Log;
  readonly start: Date | null;
  readonly end: Date | null;
  readonly label: string;
  /** every file in a selected directory belongs to the selection */
  readonly dirComplete: boolean;
  /** false for last(): nothing is later than now, so there is no upper bound on ts */
  readonly bounded: boolean;

  constructor(log: Log, start: Date | null, end: Date | null, label: string, dirComplete = true, bounded = true) {
    this.log = log;
    this.start = start;
    this.end = end;
    this.label = label;
    this.dirComplete = dirComplete;
    this.bounded = bounded;
  }

  /** The SQL condition on `ts` that makes the table exactly this range, or null for the whole log. */
  predicate(): string | null {
    if (this.start === null) return null;
    const low = `ts >= '${this.start.toISOString()}'`;
    return this.bounded && this.end !== null ? `${low} and ts < '${this.end.toISOString()}'` : low;
  }

  #covers(rel: string): boolean {
    if (this.start === null || this.end === null || this.log.partition === "none") return true;
    const names = rel.slice(this.log.rel.length).replace(/^\/+|\/+$/g, "").split("/");
    const hourly = this.log.partition === "hour";
    if (hourly && names.length < 2) return false;
    const at = partitionStart(names[0], hourly ? names[1] : undefined);
    if (at === null) return false;
    return at + (hourly ? HOUR : DAY) > this.start.getTime() && at <= this.end.getTime();
  }

  async resolve(ctx: Context): Promise<FileStat[]> {
    const log = this.log;
    const roots: string[] = [];
    if (this.start === null || this.end === null || log.partition === "none") {
      roots.push(log.rel);
    } else {
      const last = dayText(this.end);
      for (let day = Date.parse(dayText(this.start)); dayText(day) <= last; day += DAY) {
        roots.push(`${log.rel}/${dayText(day)}`.replace(/^\/+|\/+$/g, ""));
      }
    }
    const out: FileStat[] = [];
    for (const root of roots) {
      for (const f of await ctx.expand(new Ref(log.mount, root))) {
        const rel = f.path.slice(log.mount.length + 1);
        if (rel.endsWith(".ndjson") && this.#covers(rel)) out.push(f);
      }
    }
    return out;
  }

  async roots(): Promise<[string, string][]> {
    const files = await this.resolve(this.log.ctx);
    if (!files.length) return [[this.log.mount, this.log.rel]];
    const rels = files.map((f) => parent(f.path.slice(this.log.mount.length + 1)));
    return [[this.log.mount, commonDir(rels)]];
  }

  toString(): string {
    return `${this.log.path}[${this.label}]`;
  }
}

/** What a view is built from, when the statement's own parameters do not say: paths, globs or selections. */
export type ViewInput = string | Ref | Glob | Selectable;

/** A derived file that knows how to rebuild itself and whether it needs to. */
export class View {
  readonly ctx: Context;
  readonly ref: Ref;
  readonly inputs: ViewInput[];
  #build: Statement | (() => Statement);

  constructor(ctx: Context, path: string, build: Statement | (() => Statement), options: { inputs?: ViewInput[] } = {}) {
    this.ctx = ctx;
    this.ref = ctx.out(path);
    this.#build = build;
    this.inputs = options.inputs ?? [];
  }

  get path(): string {
    return this.ref.path;
  }

  statement(): Statement {
    const stmt = typeof this.#build === "function" ? this.#build() : this.#build;
    const writes = stmt.params.some(([, v]) => v instanceof Ref && v.write);
    return stmt.out || writes ? stmt : stmt.into(this.ref);
  }

  #statePath(): string {
    const id = createHash("sha1").update(this.path).digest("hex").slice(0, 16);
    return `${this.ref.mount}/${META}/views/${id}.json`;
  }

  #inputs(stmt: Statement): (Ref | Glob | Selectable)[] {
    if (this.inputs.length) {
      return this.inputs.map((i) => {
        if (typeof i !== "string") return i;
        return /[*?[]/.test(i) ? this.ctx.glob(i) : this.ctx.path(i);
      });
    }
    const out: (Ref | Glob | Selectable)[] = [];
    for (const [, v] of stmt.params) {
      if (isSelection(v) || (v instanceof Ref && !v.write)) out.push(v);
    }
    return out;
  }

  /** Changes when the inputs change or the statement changes. Built from a listing: free to compute. */
  async fingerprint(): Promise<string> {
    return (await this.#fingerprint())[0];
  }

  /**
   * The fingerprint, and whether it can be trusted later: not if an input is so new that it
   * could still be rewritten without its version changing (see `Context._unsettled`).
   */
  async #fingerprint(): Promise<[fingerprint: string, settled: boolean]> {
    const stmt = this.statement();
    const params = stmt.params.map(([k, v]) => [k, describeParam(v)]);
    const h = createHash("sha256").update(canonical([stmt.kind, strip(stmt.template), params]));
    let settled = true;
    for (const item of this.#inputs(stmt)) {
      for (const f of sorted(await this.ctx.expand(item), (f) => f.path)) {
        h.update(["\n" + f.path, f.size, f.version].join(NUL));
        settled &&= !this.ctx._unsettled(f.modified);
      }
    }
    return [h.digest("hex"), settled];
  }

  async fresh(): Promise<boolean> {
    const state = this.#statePath();
    if (!((await this.ctx.exists(state)) && (await this.ctx.exists(this.path)))) return false;
    return JSON.parse(await this.ctx.readText(state)).fingerprint === (await this.fingerprint());
  }

  /** Rebuild if the inputs changed. Returns the result of the build, or null if nothing ran. */
  async refresh(options: { force?: boolean } = {}): Promise<Result | null> {
    if (!options.force && (await this.fresh())) return null;
    let [fingerprint, settled] = await this.#fingerprint();
    // Built from an input written this very second. Recorded as it is, a rewrite within the same
    // second would leave the view looking fresh. So record it as provisional: the next refresh
    // builds once more, from versions that can be trusted.
    if (!settled) fingerprint += PROVISIONAL;
    const result = await this.statement().run();
    if (result.ok) {
      const state = {
        path: this.path,
        fingerprint,
        plan: result.plan!.hash,
        builtAt: new Date().toISOString().replace("Z", "000+00:00"), // the shape Python's isoformat() writes
        usd: round(result.meta.usd, 8),
      };
      await this.ctx.write(this.#statePath(), dumps(state));
    }
    return result;
  }

  async read(): Promise<Uint8Array> {
    await this.refresh();
    return this.ctx.read(this.path);
  }

  async readText(): Promise<string> {
    return decode(await this.read());
  }

  share(options: { expiresIn?: number } = {}): Promise<string> {
    return this.ctx.share(this.path, options);
  }

  toString(): string {
    return `<View ${this.path}>`;
  }
}

const NUL = String.fromCharCode(0);

type Listing = Record<string, [size: number, version: string]>;

/** What a feed found. `empty` is false when there is something to do. `ack()` marks it as handled. */
export class Changes {
  readonly feed: Feed;
  readonly added: FileStat[];
  readonly modified: FileStat[];
  readonly removed: string[];
  /** size before, for each modified file: an appended-to file grew from here */
  readonly previous: Record<string, number>;
  #listing: Listing;

  constructor(
    feed: Feed,
    added: FileStat[],
    modified: FileStat[],
    removed: string[],
    previous: Record<string, number>,
    listing: Listing,
  ) {
    this.feed = feed;
    this.added = added;
    this.modified = modified;
    this.removed = removed;
    this.previous = previous;
    this.#listing = listing;
  }

  get empty(): boolean {
    return !(this.added.length || this.modified.length || this.removed.length);
  }

  get files(): FileStat[] {
    return [...this.added, ...this.modified];
  }

  /** The added and modified files as statement parameters. */
  refs(): Ref[] {
    return this.files.map((f) => this.feed.ctx.path(f.path));
  }

  ack(): Promise<void> {
    return this.feed._save(this.#listing);
  }

  toString(): string {
    return `<Changes +${this.added.length} ~${this.modified.length} -${this.removed.length} under ${this.feed.path}>`;
  }
}

/**
 * What changed under a path since this reader last looked.
 *
 * A feed is a cursor over a listing. `poll()` lists the path, which reads no
 * data, and compares it with what the cursor recorded. `ack()` moves the
 * cursor. Until then `poll()` returns the same changes again, so a reader
 * that stops half-way sees them again: delivery is at-least-once.
 */
export class Feed {
  readonly ctx: Context;
  readonly ref: Ref;
  readonly cursor: string;

  constructor(ctx: Context, path: string, options: { cursor: string }) {
    this.ctx = ctx;
    this.ref = ctx.path(path);
    this.cursor = ctx.out(options.cursor).path;
  }

  get path(): string {
    return this.ref.path;
  }

  async #seen(): Promise<Map<string, [number, string]>> {
    if (!(await this.ctx.exists(this.cursor))) return new Map();
    return new Map(Object.entries(JSON.parse(await this.ctx.readText(this.cursor)).seen ?? {}));
  }

  async _save(listing: Listing): Promise<void> {
    await this.ctx.write(this.cursor, canonical({ feed: 0, path: this.path, seen: listing }));
  }

  async poll(): Promise<Changes> {
    const seen = await this.#seen();
    const now = (await this.ctx.expand(this.ref)).filter((f) => f.path !== this.cursor);
    const paths = new Set(now.map((f) => f.path));
    const added = now.filter((f) => !seen.has(f.path));
    const modified = now.filter((f) => {
      const before = seen.get(f.path);
      return before !== undefined && (before[0] !== f.size || before[1] !== f.version);
    });
    const removed = sorted([...seen.keys()].filter((p) => !paths.has(p)));
    const previous = Object.fromEntries(modified.map((f) => [f.path, seen.get(f.path)![0]]));
    // A file written this very second is remembered with a provisional version, so the next poll
    // hands it over again: it could still change without its version changing. At least once.
    const listing: Listing = Object.fromEntries(
      now.map((f) => [f.path, [f.size, f.version + (this.ctx._unsettled(f.modified) ? PROVISIONAL : "")]]),
    );
    return new Changes(this, added, modified, removed, previous, listing);
  }

  toString(): string {
    return `<Feed ${this.path} cursor=${this.cursor}>`;
  }
}
