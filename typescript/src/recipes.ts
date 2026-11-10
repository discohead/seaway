/**
 * Recipes: how a system of record becomes files.
 *
 * A recipe is two things. An adapter with the shape of an object store
 * (`list` the keys, `get` one), and a short description of the layout it
 * produces, written for whoever reads the files next.
 *
 * The adapter shape is deliberate. It is the interface Archil has described for
 * backend extensions: "manifest and synchronize any data into a local file system
 * with a simple S3 interface adapter". Today `sync` runs the adapter and writes
 * the files into a mount. When extensions ship, the same recipe can be served
 * lazily by the file system itself, and nothing that reads the files changes.
 *
 * `sync` is incremental. Each entry carries a version (an etag, an updated-at
 * time, a hash); entries whose version has not changed are not fetched again.
 */

import { createHash } from "node:crypto";

import { dumps, repr, rstrip, str, strip } from "./compat.ts";
import { META } from "./context.ts";
import type { Context } from "./context.ts";
import { ValidationError } from "./errors.ts";
import { norm } from "./shell.ts";
import type { Statement } from "./statement.ts";

type MaybeAsync<T> = T | Promise<T>;

export interface Entry {
  /** path of the file this entry becomes, relative to the recipe's directory */
  key: string;
  /** anything that changes when the content changes */
  version?: string;
}

/** Implement `list` and `get`. `layout` becomes the directory's README. Either may be async. */
export interface Recipe {
  name: string;
  layout?: string;
  list(): MaybeAsync<Iterable<Entry>>;
  get(key: string): MaybeAsync<Uint8Array | string>;
}

function sha1(data: Uint8Array | string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Fixed files. Useful for skills, prompts and fixtures. */
export class Static implements Recipe {
  readonly name: string;
  readonly layout: string;
  readonly files = new Map<string, Uint8Array>();

  constructor(files: Record<string, string | Uint8Array>, options: { name?: string; layout?: string } = {}) {
    for (const [key, value] of Object.entries(files)) {
      this.files.set(norm(key), typeof value === "string" ? Buffer.from(value) : value);
    }
    this.name = options.name ?? "static";
    this.layout = options.layout ?? "";
  }

  list(): Entry[] {
    return Array.from(this.files, ([key, value]) => ({ key, version: sha1(value) }));
  }

  get(key: string): Uint8Array {
    const value = this.files.get(key);
    if (value === undefined) throw new ValidationError(`no such file: ${key}`, { code: "not_found", path: key });
    return value;
  }
}

function frontmatter(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "object") return dumps(value);
  const text = str(value);
  return !text || text !== strip(text) || /[:#\n"'[\]{}]/.test(text) ? dumps(text) : text;
}

type Record_ = Record<string, unknown>;

export interface RecordsOptions {
  /** the field that identifies a record */
  key?: string;
  /** the field that changes when the record does; left out, a hash of the record */
  version?: string | null;
  /** the field that becomes the text of the file */
  body?: string | null;
  layout?: string;
}

/**
 * Records from any API, one Markdown file each, with the fields as front matter.
 *
 * `fetch` returns the records (call the system of record however you like).
 */
export class Records implements Recipe {
  readonly name: string;
  readonly layout: string;
  #fetch: () => MaybeAsync<Iterable<Record_>>;
  #key: string;
  #version: string | null;
  #body: string | null;
  #cache: Promise<Map<string, Record_>> | null = null;

  constructor(name: string, fetch: () => MaybeAsync<Iterable<Record_>>, options: RecordsOptions = {}) {
    this.name = name;
    this.layout = options.layout ?? "";
    this.#fetch = fetch;
    this.#key = options.key ?? "id";
    this.#version = options.version ?? null;
    this.#body = options.body ?? null;
  }

  #records(): Promise<Map<string, Record_>> {
    this.#cache ??= (async () => {
      const cache = new Map<string, Record_>();
      for (const record of await this.#fetch()) {
        const id = str(record[this.#key]);
        const slug = Array.from(id, (c) => (/[\p{L}\p{N}_.-]/u.test(c) ? c : "-")).join("");
        cache.set(`${slug}.md`, record);
      }
      return cache;
    })();
    return this.#cache;
  }

  async list(): Promise<Entry[]> {
    this.#cache = null; // each listing fetches again; the gets that follow it read what it fetched
    const out: Entry[] = [];
    for (const [key, record] of await this.#records()) {
      const version = this.#version ? str(record[this.#version]) : sha1(dumps(record, { sortKeys: true }));
      out.push({ key, version });
    }
    return out;
  }

  async get(key: string): Promise<Uint8Array> {
    const record = (await this.#records()).get(key);
    if (record === undefined) throw new ValidationError(`no such record: ${key}`, { code: "not_found", path: key });
    const fields = Object.entries(record).filter(([k]) => k !== this.#body);
    const head = fields.map(([k, v]) => `${k}: ${frontmatter(v)}`).join("\n");
    const body = this.#body ? str(Object.hasOwn(record, this.#body) ? record[this.#body] : "") : "";
    return Buffer.from(`---\n${head}\n---\n${body}\n`);
  }
}

export interface SyncStats {
  written: number;
  unchanged: number;
  deleted: number;
  into: string;
}

/** Materialise a recipe under `into`. Returns what changed. */
export async function sync(ctx: Context, recipe: Recipe, into: string): Promise<SyncStats> {
  const [m, rel] = ctx._resolve(into, { write: true });
  const root = rel ? `${m.name}/${rel}` : m.name;
  const statePath = `${m.name}/${META}/recipes/${sha1(root).slice(0, 16)}.json`;
  const previous = new Map<string, string>(
    (await ctx.exists(statePath)) ? Object.entries(JSON.parse(await ctx.readText(statePath))) : [],
  );
  const entries = [...(await recipe.list())];
  const seen = new Map<string, string>();
  const stats: SyncStats = { written: 0, unchanged: 0, deleted: 0, into: root };
  for (const entry of entries) {
    const key = norm(entry.key);
    const version = entry.version ?? "";
    if (!key || key.startsWith(META)) {
      throw new ValidationError(`recipe '${recipe.name}' produced a bad key: ${repr(entry.key)}`, { code: "bad_key" });
    }
    seen.set(key, version);
    if (version && previous.get(key) === version) {
      stats.unchanged += 1;
      continue;
    }
    await ctx.write(`${root}/${key}`, await recipe.get(entry.key));
    stats.written += 1;
  }
  for (const key of previous.keys()) {
    if (!seen.has(key)) {
      await ctx.rm(`${root}/${key}`);
      stats.deleted += 1;
    }
  }
  const layout = recipe.layout ?? "";
  const readme = rstrip(layout) + "\n";
  const current = layout && (await ctx.exists(`${root}/README.md`)) ? await ctx.readText(`${root}/README.md`) : null;
  if (layout && current !== readme) await ctx.write(`${root}/README.md`, readme);
  await ctx.write(statePath, dumps(seen, { sortKeys: true }));
  await ctx._record({ kind: "sync", recipe: recipe.name, ...stats });
  return stats;
}

/**
 * A repository as a directory. Returns a statement, so it can be explained before it runs.
 *
 * This recipe runs next to the data: the clone happens in a call with the
 * target disk mounted, and nothing passes through the caller.
 */
export function git(ctx: Context, url: string, into: string, options: { depth?: number } = {}): Statement {
  return ctx.sh("rm -rf {dest} && git clone --quiet --depth {depth} {url} {dest}", {
    url,
    depth: options.depth ?? 1,
    dest: ctx.out(into),
  });
}

export const DUCKDB_VERSION = "2.0.0";

/**
 * The SHA-256 of the release archive, for each version this SDK has been run with. It is what
 * GitHub publishes for the release asset, and what the file hashed to when it was downloaded.
 */
export const DUCKDB_SHA256: Readonly<Record<string, string>> = {
  "2.0.0": "c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc",
};

const DUCKDB_INSTALL =
  'set -euo pipefail; t=$(mktemp -d); f="$t/duckdb.tar.gz"; want={sum}; curl -fsSL -o "$f" {url}; ' +
  'got=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1); ' +
  'if [ "$got" != "$want" ]; then echo "duckdb: the download has SHA-256 $got, not the pinned $want" >&2; exit 1; fi; ' +
  'tar -xzf "$f" -C "$t"; install -m 0755 "$t/duckdb" {dest}';

/**
 * The DuckDB command line on a disk, so that `ctx.sql` has an engine on Archil.
 *
 * Archil's exec image does not carry DuckDB. This puts the binary at `<into>/duckdb`; a context
 * opened with `tools: { duckdb: "<into>/duckdb" }` then runs its SQL with it. Run it once per
 * disk: the file stays. Returns a statement, so it can be explained before it runs. The download
 * happens in the call, next to the disk, so the call needs the network (GitHub, by default).
 *
 * The archive is checked against a SHA-256 before it is unpacked, and one that does not match
 * installs nothing. The hash of the default version is pinned in `DUCKDB_SHA256`. Another
 * `version`, or an archive at a `url` of your own, has to come with its `sha256`.
 *
 * It is the Linux x86-64 build, which is what Archil's exec VMs are. On the local backend SQL uses
 * the `duckdb` on your PATH and none of this is needed.
 */
export function duckdb(
  ctx: Context,
  into: string,
  options: { version?: string; url?: string | null; sha256?: string | null } = {},
): Statement {
  const version = options.version ?? DUCKDB_VERSION;
  const url = options.url || `https://github.com/duckdb/duckdb/releases/download/v${version}/duckdb-cli-linux-amd64.tar.gz`;
  const sum = (options.sha256 || (options.url ? "" : (DUCKDB_SHA256[version] ?? ""))).toLowerCase();
  if (!sum) {
    throw new ValidationError(`no SHA-256 is pinned for ${url}: pass sha256 with the archive's hash`, { code: "unpinned_download" });
  }
  if (!/^[0-9a-f]{64}$/.test(sum)) {
    throw new ValidationError("sha256 has to be the archive's SHA-256, as 64 hex characters", { code: "bad_sha256" });
  }
  return ctx.sh(DUCKDB_INSTALL, { url, sum, dest: ctx.out(`${norm(into)}/duckdb`) });
}
