/**
 * The backend that talks to Archil, through the official `disk` package.
 *
 * Every plan compiles to calls that exist today:
 *
 *   framework       Archil
 *   --------------  ---------------------------------------------------------
 *   a task          client.exec({ disks: { path: ExecMountSpec }, command })
 *   grep            disk.grep({ directory, pattern, recursive: true })
 *   read / write    disk.getObject / disk.putObject (the S3-compatible API)
 *   append          disk.appendObject (server-side, at most 1 MiB, never retried)
 *   ls / expand     disk.listObjects (metadata only)
 *   branch          disk.createBranch({ name, fromCheckpoint })
 *   checkpoint      `archil checkpoints create` run inside an exec
 *
 * Status. This module is written against `disk` 1.12.0. It was first run against
 * a live account on 9 November 2026 (aws-us-west-2, Developer plan), and what
 * that run found is written into the code below:
 *
 * - `archil checkpoints create <mountpoint> <name>` works from inside a serverless
 *   exec, on a mount that is not read-only, and a branch can be made from the
 *   checkpoint straight after.
 * - A branch's `filesystem_id` is an ordinary disk id: it mounts in an exec and
 *   reads through the object API.
 * - Archil runs a command with `/bin/sh`. Statements are bash, as they are on the
 *   local backend, so the command is handed to bash (see `wrap`).
 * - An ETag follows a file's content only when the file was written through the
 *   object API. A file rewritten in place through a mount keeps its old ETag, so a
 *   version here is the ETag and the modification time (see `version`).
 *
 * A plan addresses files relative to the directory its disks are mounted under
 * (`cat ref/docs/a.md`), so every command starts in `/mnt/archil`, which is what
 * the official agent tools do.
 *
 * A few failures that are not the command's own are reported the way the local
 * backend reports them, as a result with an exit code, so code written against one
 * backend reads the same on the other: a mount that cannot be made (exit 1), a
 * checkout that could not be taken in time (exit 30), and a command that ran past
 * the time limit (exit 124).
 *
 * Two differences from the Python backend, both because the clients differ. A
 * checkout is requested with the mount spec's own `queueMs` and `checkoutPaths`;
 * the Python client has neither, so that backend runs `archil checkout` at the
 * start of the command instead, which only Archil's own exec image can do. And
 * there is no request timeout to raise here: the Python backend asks its client
 * for 330 seconds, while this client's transport gives up on a response after 300
 * by default, which is also the longest an exec may run. Either way a command
 * that runs too long comes back as exit 124.
 */

import type { ExecMountSpec, ExecOptions } from "disk";

import { Limits, MountSpec, ObjectInfo, TRUNCATED_MARK, Vm } from "./backends.ts";
import type { Backend, ExecOutput, GrepHit, GrepOptions } from "./backends.ts";
import { strip, tail } from "./compat.ts";
import { Busy, NotSupported, ValidationError } from "./errors.ts";
import { quote } from "./shell.ts";

/** Where a multi-disk exec mounts its disks. */
export const EXEC_ROOT = "/mnt/archil";
/** How a statement that never got its checkout ends. */
export const NO_CHECKOUT = "archil: could not take checkout";

/**
 * The text sent to Archil for `command`: start where the disks are mounted, then run it with bash.
 *
 * Archil runs a command with `/bin/sh`, which is dash on its image: no `[[ ]]`, no
 * `set -o pipefail`, no process substitution. The command travels in a quoted here-document, so
 * nothing in it is read by the outer shell and its size does not grow, and is handed to bash
 * unchanged. An image without bash runs it with its own `sh`. `prelude` is plain sh run first.
 */
export function wrap(command: string, prelude = ""): string {
  let mark = "PX_EOF";
  const lines = new Set(command.split("\n"));
  while (lines.has(mark)) mark += "_";
  return (
    `cd ${EXEC_ROOT} || exit 1\n` +
    prelude +
    `px_script=$(cat <<'${mark}'\n${command}\n${mark}\n)\n` +
    'if command -v bash >/dev/null 2>&1; then exec bash -c "$px_script"; else exec sh -c "$px_script"; fi'
  );
}

/** The part of the official client this backend calls. `new Archil()` from "disk" satisfies it. */
export interface ArchilClient {
  disks: {
    list(options?: { name?: string }): Promise<ArchilDisk[]>;
    get(id: string): Promise<ArchilDisk>;
    create(request: { name: string }): Promise<{ disk: ArchilDisk }>;
  };
  exec(options: ExecOptions): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timing: { queueMs: number; executeMs: number; totalMs: number };
  }>;
}

interface ObjectMeta {
  size: number;
  etag?: string;
  lastModified?: Date;
}

/** The part of the official `Disk` this backend calls. */
export interface ArchilDisk {
  readonly id: string;
  grep(options: {
    directory: string;
    pattern: string;
    recursive?: boolean;
    ignoreCase?: boolean;
    globs?: string[];
    maxResults?: number;
  }): Promise<{ matches: { file: string; line: number; text: string }[]; stoppedReason: string }>;
  getObject(key: string): Promise<Uint8Array>;
  putObject(key: string, body: Uint8Array): Promise<unknown>;
  appendObject(key: string, body: Uint8Array): Promise<unknown>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<{ errors: { key: string; code?: string; message?: string }[] }>;
  objectExists(key: string): Promise<boolean>;
  headObject(key: string): Promise<ObjectMeta | null>;
  listObjects(
    prefix?: string,
    options?: { recursive?: boolean },
  ): Promise<{ objects: (ObjectMeta & { key: string })[]; commonPrefixes: string[] }>;
  share(key: string, options?: { expiresIn?: number }): Promise<{ url: string }>;
  createBranch(options: { name: string; fromCheckpoint: string }): Promise<{ filesystem_id: string }>;
  getBranch(name: string): Promise<{ filesystem_id: string }>;
}

export interface ArchilBackendOptions {
  /** An `Archil` client from "disk". Left out, one is made from `apiKey` and `region`, or from the environment. */
  client?: ArchilClient;
  apiKey?: string;
  region?: string;
  name?: string;
  limits?: Limits;
  /** set true when the caller runs in an Archil sandbox (no egress charge) */
  insideArchil?: boolean;
  capabilities?: Iterable<string>;
}

export class ArchilBackend implements Backend {
  readonly name: string;
  readonly limits: Limits;
  readonly insideArchil: boolean;
  readonly capabilities: ReadonlySet<string>;
  readonly checkpointCalls = 1;
  /** a listing reports modification times in whole seconds: see `version` */
  readonly versionGranularityS = 1;
  #options: ArchilBackendOptions;
  #client: Promise<ArchilClient> | null = null;
  #disks = new Map<string, Promise<ArchilDisk>>();

  constructor(options: ArchilBackendOptions = {}) {
    this.#options = options;
    this.name = options.name ?? "archil";
    this.limits = options.limits ?? new Limits();
    this.insideArchil = options.insideArchil ?? false;
    this.capabilities = new Set(options.capabilities ?? ["grep", "share", "checkpoint", "branch"]);
  }

  /** The client, made on first use so that the official package is only needed when it is used. */
  client(): Promise<ArchilClient> {
    this.#client ??= (async () => {
      if (this.#options.client) return this.#options.client;
      let sdk: typeof import("disk");
      try {
        sdk = await import("disk");
      } catch {
        throw new NotSupported("the Archil backend needs the official SDK", { suggestion: "npm install disk" });
      }
      return new sdk.Archil({ apiKey: this.#options.apiKey, region: this.#options.region });
    })();
    return this.#client;
  }

  // -- disks -----------------------------------------------------------------
  #disk(handle: string): Promise<ArchilDisk> {
    let disk = this.#disks.get(handle);
    if (!disk) {
      disk = this.client().then((client) => client.disks.get(handle));
      disk.catch(() => this.#disks.delete(handle)); // a failed lookup is not remembered
      this.#disks.set(handle, disk);
    }
    return disk;
  }

  async resolveDisk(ref: string, options: { create?: boolean } = {}): Promise<string> {
    if (ref.startsWith("dsk-")) return ref;
    const client = await this.client();
    const found = await client.disks.list({ name: ref });
    if (found.length) {
      this.#disks.set(found[0].id, Promise.resolve(found[0]));
      return found[0].id;
    }
    if (!options.create) {
      throw new ValidationError(`no disk named '${ref}' in this region`, {
        code: "unknown_disk",
        suggestion: "pass { create: true } to disk(...), or use its dsk- id",
      });
    }
    const created = (await client.disks.create({ name: ref })).disk;
    this.#disks.set(created.id, Promise.resolve(created));
    return created.id;
  }

  // -- compute ---------------------------------------------------------------
  #mount(spec: MountSpec): ExecMountSpec {
    const mount: ExecMountSpec = { disk: spec.disk, readOnly: spec.readOnly, conditional: spec.conditional };
    if (spec.subdirectory) mount.subdirectory = spec.subdirectory;
    if (spec.queueMs !== null) mount.queueMs = spec.queueMs;
    if (spec.checkoutPaths.length) mount.checkoutPaths = [...spec.checkoutPaths];
    return mount;
  }

  async exec(mounts: Record<string, MountSpec>, command: string, vm: Vm): Promise<ExecOutput> {
    const wire = wrap(command);
    if (Buffer.byteLength(wire) > this.limits.maxCommandBytes) {
      return notRun(1, `command exceeds ${this.limits.maxCommandBytes} bytes`);
    }
    const request: ExecOptions = { disks: {}, command: wire };
    for (const [path, spec] of Object.entries(mounts)) request.disks[path] = this.#mount(spec);
    if (vm.vcpu !== 2) request.vcpuCount = vm.vcpu;
    if (vm.memMib !== 4096) request.memSizeMib = vm.memMib;
    if (vm.image) request.baseImage = vm.image;
    if (vm.egress !== null) {
      request.network = { egress: vm.egress.length ? { default: "deny", allow: [...vm.egress] } : { default: "deny" } };
    }
    let res: Awaited<ReturnType<ArchilClient["exec"]>>;
    try {
      res = await (await this.client()).exec(request);
    } catch (error) {
      const failed = notStarted(error);
      if (failed === null) throw error;
      return failed;
    }
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      queueMs: res.timing.queueMs,
      executeMs: res.timing.executeMs,
      totalMs: res.timing.totalMs,
      truncated: this.#cut(res.stdout) || this.#cut(res.stderr),
    };
  }

  /** Archil keeps the first bytes of a stream and ends it with a marker when it drops the rest. */
  #cut(text: string): boolean {
    return text.endsWith(TRUNCATED_MARK.trim()) && Buffer.byteLength(text) >= this.limits.maxOutputBytes - 8;
  }

  async grep(disk: string, directory: string, pattern: string, options: GrepOptions = {}): Promise<[GrepHit[], string]> {
    const request: Parameters<ArchilDisk["grep"]>[0] = { directory, pattern };
    if (options.recursive != null) request.recursive = options.recursive;
    if (options.ignoreCase != null) request.ignoreCase = options.ignoreCase;
    if (options.globs != null) request.globs = options.globs;
    if (options.maxResults != null) request.maxResults = options.maxResults;
    const res = await (await this.#disk(disk)).grep(request);
    return [res.matches.map((m) => ({ file: m.file, line: m.line, text: m.text })), res.stoppedReason];
  }

  // -- objects ---------------------------------------------------------------
  /** Run one write through the object API. A path under someone's checkout is `Busy`, not a raw 409. */
  async #write<T>(key: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (status(error) === 409) throw busy(key);
      throw error;
    }
  }

  async get(disk: string, key: string): Promise<Uint8Array> {
    try {
      return await (await this.#disk(disk)).getObject(key);
    } catch (error) {
      // by status, not by class: a bundler can hand each package its own copy of ArchilS3Error
      if (status(error) === 404) throw new ValidationError(`no such file: ${key}`, { code: "not_found", path: key });
      throw error;
    }
  }

  async put(disk: string, key: string, data: Uint8Array, options: { ifAbsent?: boolean } = {}): Promise<void> {
    const d = await this.#disk(disk);
    if (options.ifAbsent && (await d.objectExists(key))) {
      // The S3 API supports a create-only put (If-None-Match: *); the SDK does not expose it
      // yet, so this check is not atomic.
      throw new ValidationError(`already exists: ${key}`, { code: "exists", path: key });
    }
    await this.#write(key, () => d.putObject(key, data));
  }

  async append(disk: string, key: string, data: Uint8Array): Promise<void> {
    if (data.length > this.limits.appendMaxBytes) {
      throw new ValidationError(`append larger than ${this.limits.appendMaxBytes} bytes`, { path: key });
    }
    const d = await this.#disk(disk);
    await this.#write(key, () => d.appendObject(key, data));
  }

  async delete(disk: string, key: string): Promise<void> {
    const d = await this.#disk(disk);
    key = key.replace(/\/+$/, "");
    if (!key) {
      throw new ValidationError("refusing to delete everything on a disk", {
        code: "bad_path",
        suggestion: "name a file or a directory below the mount",
      });
    }
    await this.#write(key, () => d.deleteObject(key));
    // The key may be a directory, which the object API only removes once it is empty: its files
    // first, then the directories themselves, deepest first.
    const below = (await d.listObjects(key + "/", { recursive: true })).objects;
    if (!below.length) return;
    const files = below.filter((o) => !o.key.endsWith("/")).map((o) => o.key);
    if (files.length) {
      const failed = (await this.#write(key, () => d.deleteObjects(files))).errors;
      if (failed.length) {
        const first = failed[0];
        if (first.code === "OperationAborted") throw busy(first.key);
        throw new ValidationError(`could not delete ${first.key}: ${first.message ?? first.code ?? "refused"}`, {
          code: "delete_failed",
          path: first.key,
        });
      }
    }
    const markers = new Set(below.filter((o) => o.key.endsWith("/")).map((o) => o.key));
    markers.add(key + "/");
    for (const marker of [...markers].sort((a, b) => b.length - a.length)) {
      await this.#write(marker, () => d.deleteObject(marker));
    }
  }

  async list(disk: string, prefix = "", options: { recursive?: boolean } = {}): Promise<ObjectInfo[]> {
    // S3 prefixes match by string, so "logs/api" would also match "logs/api-old". Ask for the
    // directory, and for the file of that exact name.
    const recursive = options.recursive ?? true;
    const d = await this.#disk(disk);
    const out: ObjectInfo[] = [];
    if (prefix) {
      const meta = await d.headObject(prefix);
      if (meta !== null) return [info(prefix, meta)];
    }
    const res = await d.listObjects(prefix ? prefix.replace(/\/+$/, "") + "/" : undefined, { recursive });
    if (!recursive) {
      for (const p of res.commonPrefixes) {
        if (!p.startsWith(".archil/")) out.push(new ObjectInfo(p.endsWith("/") ? p : p + "/", 0));
      }
    }
    // a listing also carries an entry for each directory, as a key ending in "/"
    for (const o of res.objects) {
      if (!o.key.endsWith("/") && !o.key.startsWith(".archil/")) out.push(info(o.key, o));
    }
    return out;
  }

  async head(disk: string, key: string): Promise<ObjectInfo | null> {
    const meta = await (await this.#disk(disk)).headObject(key);
    return meta === null ? null : info(key, meta);
  }

  async share(disk: string, key: string, expiresIn: number): Promise<string> {
    return (await (await this.#disk(disk)).share(key, { expiresIn })).url;
  }

  // -- time ------------------------------------------------------------------
  async checkpoint(disk: string, name: string): Promise<string> {
    // Not read-only: Archil refuses a checkpoint from a read-only mount. Conditional, so that
    // taking one never waits for, or takes, a checkout.
    const out = await this.exec(
      { disk: new MountSpec(disk, { conditional: true }) },
      `archil checkpoints create disk ${quote(name)}`,
      new Vm(),
    );
    if (out.exitCode !== 0) {
      const said = tail(strip(out.stderr), 200);
      if (said.includes("InvalidArguments")) {
        throw new ValidationError(`Archil refused the checkpoint name '${name}' on ${disk}`, {
          code: "bad_checkpoint",
          suggestion: "a checkpoint name has to be new on its disk, and made of letters, digits, - and _",
        });
      }
      throw new NotSupported(`could not checkpoint ${disk}: ${said}`, {
        suggestion: "checkpoints need an Archil-managed disk in an AWS region",
      });
    }
    return name;
  }

  async branch(disk: string, name: string, fromCheckpoint: string, options: { existOk?: boolean } = {}): Promise<string> {
    const d = await this.#disk(disk);
    try {
      return (await d.createBranch({ name, fromCheckpoint })).filesystem_id;
    } catch (error) {
      if (status(error) === 404) {
        throw new ValidationError(`no checkpoint '${fromCheckpoint}' on ${disk}`, { code: "not_found" });
      }
      if (options.existOk && status(error) === 409) {
        // 409 is also what a checkpoint that has not finished committing gets; then there is
        // no branch of this name to return, and the first error is the one to report
        try {
          return (await d.getBranch(name)).filesystem_id;
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  /** Nothing to hold: on Archil a commit runs under a checkout of the paths it writes. */
  async commitLock(_disk: string): Promise<() => void> {
    return () => {};
  }
}

function status(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function busy(key: string): Busy {
  return new Busy(`another client holds a checkout that covers ${key}`, {
    path: key,
    suggestion: "retry when the statement writing this disk has finished, or mount the disk as 'shared'",
  });
}

function epoch(value: Date | undefined | null): number {
  return value instanceof Date ? value.getTime() / 1000 : 0;
}

/**
 * A string that changes whenever the file's content can have changed.
 *
 * On Archil an ETag is the hash of the content only for a file written through the object API. A
 * file written through a mount gets an ETag when it is created and keeps it while it is rewritten
 * in place; only its modification time moves, and a listing reports that in whole seconds. So the
 * version is both. Two rewrites of the same size inside one second still look alike.
 */
function version(etag: string | undefined, modified: number): string {
  return etag ? `${etag}@${Math.trunc(modified)}` : "";
}

function info(key: string, meta: ObjectMeta): ObjectInfo {
  const modified = epoch(meta.lastModified);
  return new ObjectInfo(key, meta.size, modified, version(meta.etag, modified));
}

function notRun(exitCode: number, stderr: string): ExecOutput {
  return { exitCode, stdout: "", stderr, queueMs: 0, executeMs: 0, totalMs: 0, truncated: false };
}

/** A call Archil answered with an error instead of a result, as the result the local backend gives. */
function notStarted(error: unknown): ExecOutput | null {
  const code = status(error);
  const said = error instanceof Error ? error.message : String(error);
  // Archil answers 504 when a command passes five minutes. This client's transport stops waiting
  // for an answer at the same moment, and usually gets there first: seen live as "fetch failed",
  // caused by undici's headers timeout.
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  if (code === 504 || cause?.code === "UND_ERR_HEADERS_TIMEOUT") return notRun(124, "Exec timed out");
  if (code === 400 && said.includes("subdirectory does not exist")) return notRun(1, `mount failed: ${said}`);
  if (code === 400 && said.includes("delegation") && (said.includes("queued") || said.includes("timed out"))) {
    return notRun(30, `${NO_CHECKOUT}: ${said}`);
  }
  return null;
}

export function fromEnv(): ArchilBackend {
  return new ArchilBackend({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
}
