/**
 * The small set of operations a backend must provide.
 *
 * Everything the framework does compiles down to these calls. They mirror what
 * Archil exposes today: object reads and writes through the S3-compatible API,
 * `exec` with a mount map, parallel `grep`, checkpoints and branches.
 *
 * Two backends ship with the prototype:
 *
 * - `LocalBackend` runs the same plans on plain directories and local bash, so
 *   the API can be tried, tested and developed against without an account.
 * - `ArchilBackend` sends them to Archil through the official `disk` package.
 */

import { floatRepr } from "./compat.ts";
import { ValidationError } from "./errors.ts";

/**
 * How a stream that was cut ends. Archil keeps the first bytes of stdout and of stderr and writes this
 * after them; the local backend does the same, so a reducer or a reader sees one behaviour.
 */
export const TRUNCATED_MARK = "\n[output truncated]";

export interface MountSpecOptions {
  subdirectory?: string | null;
  readOnly?: boolean;
  conditional?: boolean;
  checkoutPaths?: readonly string[];
  queueMs?: number | null;
}

/** One disk as a single call sees it. Field for field, Archil's exec mount spec. */
export class MountSpec {
  readonly disk: string;
  readonly subdirectory: string | null;
  readonly readOnly: boolean;
  readonly conditional: boolean;
  readonly checkoutPaths: readonly string[];
  readonly queueMs: number | null;

  constructor(disk: string, options: MountSpecOptions = {}) {
    this.disk = disk;
    this.subdirectory = options.subdirectory || null;
    this.readOnly = options.readOnly ?? false;
    this.conditional = options.conditional ?? false;
    this.checkoutPaths = [...(options.checkoutPaths ?? [])];
    this.queueMs = options.queueMs ?? null;
  }

  toJSON(): MountSpecJSON {
    const d: MountSpecJSON = { disk: this.disk, readOnly: this.readOnly, conditional: this.conditional };
    if (this.subdirectory) d.subdirectory = this.subdirectory;
    if (this.checkoutPaths.length) d.checkoutPaths = [...this.checkoutPaths];
    if (this.queueMs !== null) d.queueMs = this.queueMs;
    return d;
  }

  describe(): string {
    const where = this.subdirectory ? `${this.disk}:/${this.subdirectory}` : this.disk;
    let how: string;
    if (this.readOnly) how = "read-only";
    else if (this.conditional) how = "read-write, conditional";
    else if (this.checkoutPaths.length) how = "read-write, checkout " + this.checkoutPaths.map((p) => "/" + p).join(", ");
    else how = "read-write, checkout /";
    return `${where} (${how})`;
  }
}

/** A mount spec as JSON: the body Archil's exec endpoint takes for one disk. */
export interface MountSpecJSON {
  disk: string;
  readOnly: boolean;
  conditional: boolean;
  subdirectory?: string;
  checkoutPaths?: string[];
  queueMs?: number;
}

/** What a call may reach on the network, as a caller writes it. */
export type Egress = "deny" | "allow" | readonly string[] | null;

/**
 * Normalise an egress setting: `null` or `"allow"` (the network is open, Archil's default),
 * `"deny"` (nothing leaves), or a list of hosts (only those are reachable).
 *
 * The result is `null` for open, `[]` for deny, or the allowed hosts.
 */
export function egressPolicy(value: Egress | undefined): readonly string[] | null {
  if (value == null || value === "allow") return null;
  if (value === "deny") return [];
  if (typeof value === "string" || !Array.isArray(value) || !value.every((h) => typeof h === "string" && h)) {
    throw new ValidationError(`cannot read ${JSON.stringify(value)} as an egress policy`, {
      code: "bad_egress",
      suggestion: "use 'deny', 'allow', or a list of hosts such as ['pypi.org']",
    });
  }
  return [...value];
}

/** Two policies, as `egressPolicy` returns them, that allow the same thing. */
export function sameEgress(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((host, i) => host === b[i]);
}

export interface VmOptions {
  vcpu?: number;
  memMib?: number;
  image?: string | null;
  /** null: open. []: nothing leaves. hosts: only these. As `egressPolicy` returns it. */
  egress?: readonly string[] | null;
}

export interface VmJSON {
  vcpuCount: number;
  memSizeMib: number;
  baseImage?: string;
  /** the shape Archil's exec takes as `network` */
  network?: { egress: { default: "deny"; allow?: string[] } };
}

export class Vm {
  readonly vcpu: number;
  readonly memMib: number;
  readonly image: string | null;
  readonly egress: readonly string[] | null;

  constructor(options: VmOptions = {}) {
    this.vcpu = options.vcpu ?? 2;
    this.memMib = options.memMib ?? 4096;
    this.image = options.image ?? null;
    this.egress = options.egress ?? null;
  }

  toJSON(): VmJSON {
    const d: VmJSON = { vcpuCount: this.vcpu, memSizeMib: this.memMib };
    if (this.image) d.baseImage = this.image;
    if (this.egress !== null) {
      d.network = { egress: this.egress.length ? { default: "deny", allow: [...this.egress] } : { default: "deny" } };
    }
    return d;
  }

  describeEgress(): string {
    if (this.egress === null) return "";
    return this.egress.length ? "egress only to " + this.egress.join(", ") : "egress denied";
  }
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  queueMs: number;
  executeMs: number;
  totalMs: number;
  truncated: boolean;
}

export class ObjectInfo {
  readonly key: string;
  readonly size: number;
  /** seconds since the epoch */
  readonly modified: number;
  /** a version identifier, when the backend has one */
  readonly etag: string;

  constructor(key: string, size: number, modified = 0, etag = "") {
    this.key = key;
    this.size = size;
    this.modified = modified;
    this.etag = etag;
  }

  /** A string that changes when the content changes: the etag, or failing that the modification time. */
  get version(): string {
    return this.etag || floatRepr(this.modified);
  }
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface GrepOptions {
  ignoreCase?: boolean;
  recursive?: boolean;
  globs?: string[];
  maxResults?: number | null;
}

/** Platform limits the planner designs around. Defaults follow Archil's documentation. */
export class Limits {
  readonly maxCommandBytes: number;
  /** per stream; the first bytes are kept, then TRUNCATED_MARK */
  readonly maxOutputBytes: number;
  readonly execTimeoutS: number;
  /** "hundreds" by default on Archil; kept modest here */
  readonly maxParallel: number;
  readonly appendMaxBytes: number;
  readonly grepMaxResults: number;
  readonly checkoutQueueMs: number;

  constructor(overrides: Partial<Limits> = {}) {
    this.maxCommandBytes = overrides.maxCommandBytes ?? 100 * 1024;
    this.maxOutputBytes = overrides.maxOutputBytes ?? 4 * 1024 * 1024;
    this.execTimeoutS = overrides.execTimeoutS ?? 300.0;
    this.maxParallel = overrides.maxParallel ?? 64;
    this.appendMaxBytes = overrides.appendMaxBytes ?? 1024 * 1024;
    this.grepMaxResults = overrides.grepMaxResults ?? 1000;
    this.checkoutQueueMs = overrides.checkoutQueueMs ?? 5000;
  }
}

/**
 * What a backend provides. A backend that cannot share, checkpoint or branch
 * throws `NotSupported` from that method, with a reason, and leaves the name out
 * of `capabilities`.
 */
export interface Backend {
  readonly name: string;
  readonly limits: Limits;
  /** false when the caller is outside Archil and reads pay egress */
  readonly insideArchil: boolean;
  readonly capabilities: ReadonlySet<string>;
  /**
   * What one checkpoint bills as. Archil has no REST call for a checkpoint yet, so it is taken by
   * an exec, which is one call. The local backend prices it the same way.
   */
  readonly checkpointCalls: number;
  /**
   * How coarse a file's version is, in seconds. 0 means every write changes it. Archil's is 1: a
   * file rewritten in place, at the same size, twice within one second keeps the same version.
   */
  readonly versionGranularityS: number;

  // -- disks -----------------------------------------------------------------
  resolveDisk(ref: string, options?: { create?: boolean }): Promise<string>;

  // -- compute next to the data ----------------------------------------------
  exec(mounts: Record<string, MountSpec>, command: string, vm: Vm): Promise<ExecOutput>;
  /** The matches, and why the search stopped (`completed` when it saw every file). */
  grep(disk: string, directory: string, pattern: string, options?: GrepOptions): Promise<[hits: GrepHit[], reason: string]>;

  // -- objects (the data plane) ----------------------------------------------
  get(disk: string, key: string): Promise<Uint8Array>;
  put(disk: string, key: string, data: Uint8Array, options?: { ifAbsent?: boolean }): Promise<void>;
  append(disk: string, key: string, data: Uint8Array): Promise<void>;
  /** Remove a file, or a directory and everything under it. A key that is not there is not an error. */
  delete(disk: string, key: string): Promise<void>;
  /** Files under `prefix`. When not recursive, sub-directories are returned too, as keys ending in `/`. */
  list(disk: string, prefix?: string, options?: { recursive?: boolean }): Promise<ObjectInfo[]>;
  head(disk: string, key: string): Promise<ObjectInfo | null>;
  share(disk: string, key: string, expiresIn: number): Promise<string>;

  // -- time ------------------------------------------------------------------
  checkpoint(disk: string, name: string): Promise<string>;
  /** Create a writable copy-on-write fork and return a disk handle for it. */
  branch(disk: string, name: string, fromCheckpoint: string, options?: { existOk?: boolean }): Promise<string>;
  /**
   * Held while a transaction validates and applies; the returned function releases it.
   *
   * On Archil the storage layer provides this: the commit runs under a checkout
   * of the paths it writes. Backends without that need their own lock.
   */
  commitLock(disk: string): Promise<() => void>;
}
