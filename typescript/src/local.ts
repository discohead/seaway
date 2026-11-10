/**
 * A backend that needs no account: disks are directories, exec is local bash.
 *
 * It exists so the framework can be tried and tested anywhere, and so an app
 * written against it can be developed locally and pointed at Archil unchanged.
 * It follows Archil's shape closely:
 *
 * - each call gets a fresh working directory with the mounted disks beneath it,
 *   at the same relative paths a serverless call sees under `/mnt/archil`;
 * - nothing but the disks survives a call;
 * - stdout and stderr are cut after their first bytes and end with a marker when
 *   they are, and commands time out.
 *
 * Mounts are realised in one of two ways. Where unprivileged user namespaces are
 * available (most Linux hosts), each call runs in its own mount namespace with the
 * disks bind-mounted, so a read-only mount really is read-only and tools such as
 * `find` cross mount points exactly as they do on Archil. Elsewhere (macOS) the
 * mounts are symlinks: writes to a read-only mount are detected after the
 * command, and `find`/`du` need `-L` or a path inside the mount to cross them.
 *
 * An egress policy on a call is enforced only in a namespace, and only bluntly: the
 * call gets no network at all, whether the policy denies everything or names the
 * hosts it allows. With symlinks the network stays open.
 *
 * Checkpoints and branches are full copies here. Archil's are copy-on-write and
 * take milliseconds at any size.
 *
 * The layout under the root, and the version string of a file, are the same as
 * the Python SDK's local backend, so both can work on one root.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants as osConstants } from "node:os";
import * as path from "node:path";

import { Limits, ObjectInfo, TRUNCATED_MARK } from "./backends.ts";
import type { Backend, ExecOutput, GrepHit, GrepOptions, MountSpec, MountSpecJSON, Vm } from "./backends.ts";
import { sorted } from "./compat.ts";
import { ValidationError } from "./errors.ts";
import { quote } from "./shell.ts";

/** Archil keeps an opaque directory of this name on every disk. */
export const RESERVED = ".archil";

export interface LocalBackendOptions {
  root?: string;
  name?: string;
  limits?: Limits;
  insideArchil?: boolean;
  verifyReadOnly?: boolean;
  /** "namespace" (bind mounts), "symlink", or "auto" to use namespaces when possible */
  isolation?: string;
  capabilities?: Iterable<string>;
}

export class LocalBackend implements Backend {
  readonly root: string;
  readonly name: string;
  readonly limits: Limits;
  readonly insideArchil: boolean;
  readonly verifyReadOnly: boolean;
  readonly isolation: string;
  readonly capabilities: ReadonlySet<string>;
  readonly checkpointCalls = 1;
  /** a version here is the modification time in nanoseconds: every write changes it */
  readonly versionGranularityS = 0;
  /** every exec this backend ran: handy in tests */
  readonly execLog: { mounts: Record<string, MountSpecJSON>; command: string }[] = [];
  #locks = new Map<string, Promise<void>>();

  constructor(options: LocalBackendOptions = {}) {
    const root = path.resolve(options.root ?? ".archil-local");
    fs.mkdirSync(path.join(root, "disks"), { recursive: true });
    this.root = fs.realpathSync(root);
    this.name = options.name ?? "local";
    this.limits = options.limits ?? new Limits();
    this.insideArchil = options.insideArchil ?? true;
    this.verifyReadOnly = options.verifyReadOnly ?? true;
    this.capabilities = new Set(options.capabilities ?? ["checkpoint", "branch", "grep", "share"]);
    const isolation = process.env.ARCHIL_LOCAL_ISOLATION ?? options.isolation ?? "auto";
    this.isolation = isolation === "auto" ? (namespacesWork() ? "namespace" : "symlink") : isolation;
  }

  // -- disks -----------------------------------------------------------------
  #dir(disk: string): string {
    return path.join(this.root, "disks", disk);
  }

  #file(disk: string, key: string): string {
    return path.join(this.#dir(disk), key);
  }

  async resolveDisk(ref: string, options: { create?: boolean } = {}): Promise<string> {
    const dir = this.#dir(ref);
    if (!isDir(dir)) {
      if (!options.create) {
        throw new ValidationError(`no disk named '${ref}'`, {
          code: "unknown_disk",
          suggestion: "pass { create: true } to disk(...) to create it on first use",
        });
      }
      fs.mkdirSync(dir, { recursive: true });
    }
    return ref;
  }

  // -- compute ---------------------------------------------------------------
  async exec(mounts: Record<string, MountSpec>, command: string, vm: Vm): Promise<ExecOutput> {
    const limit = this.limits.maxOutputBytes;
    if (Buffer.byteLength(command) > this.limits.maxCommandBytes) {
      return output(1, "", `command exceeds ${this.limits.maxCommandBytes} bytes`);
    }
    const call = path.join(this.root, "calls", hex32());
    const mnt = path.join(call, "mnt");
    fs.mkdirSync(mnt, { recursive: true });
    const namespace = this.isolation === "namespace";
    const setup: string[] = [];
    const watched: [key: string, target: string, before: Map<string, string>][] = [];
    try {
      // shortest mount point first, so a parent is in place before anything below it
      for (const [key, spec] of Object.entries(mounts).sort((a, b) => a[0].length - b[0].length)) {
        const target = path.join(this.#dir(spec.disk), spec.subdirectory ?? "");
        if (!isDir(target)) {
          if (spec.readOnly) return output(1, "", `mount failed: ${key}: no such directory on ${spec.disk}`);
          fs.mkdirSync(target, { recursive: true });
        }
        const point = path.join(mnt, key);
        if (namespace) {
          fs.mkdirSync(point, { recursive: true });
          setup.push(`mount --bind ${quote(target)} ${quote(point)}`);
          if (spec.readOnly) setup.push(`mount -o remount,bind,ro ${quote(point)}`);
        } else {
          fs.mkdirSync(path.dirname(point), { recursive: true });
          fs.symlinkSync(target, point);
          if (spec.readOnly && this.verifyReadOnly) watched.push([key, target, fingerprint(target)]);
        }
      }
      const env: NodeJS.ProcessEnv = { ...process.env, ARCHIL_ROOT: mnt };
      let argv: string[];
      if (namespace) {
        env.ARCHIL_COMMAND = command;
        const script = [...setup, `cd ${quote(mnt)}`, 'exec bash -c "$ARCHIL_COMMAND"'].join(" && ");
        const offline = vm.egress !== null ? ["--net"] : []; // an empty network namespace
        argv = ["unshare", "--user", "--map-root-user", "--mount", ...offline, "bash", "-c", script];
      } else {
        argv = ["bash", "-c", command];
      }
      const started = performance.now();
      const ran = await run(argv, { cwd: mnt, env, timeoutMs: this.limits.execTimeoutS * 1000, keep: limit });
      const elapsed = performance.now() - started;
      let code = ran.code;
      const stdout = ran.stdout;
      const stderr = ran.stderr;
      let notes = ""; // the backend's own words, not the command's output: never cut
      if (ran.timedOut) {
        code = 124;
        notes += "\nExec timed out";
      }
      for (const [key, target, before] of watched) {
        const changed = changedPaths(before, fingerprint(target));
        if (changed.length) {
          code = 30; // EROFS
          notes +=
            `\nRead-only file system: ${key}/${changed[0]} was modified. ` +
            "(Without mount namespaces the local backend detects this after the command; " +
            "Archil refuses the write.)";
        }
      }
      this.execLog.push({
        mounts: Object.fromEntries(Object.entries(mounts).map(([k, v]) => [k, v.toJSON()])),
        command,
      });
      return {
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text() + notes,
        queueMs: 0,
        executeMs: elapsed,
        totalMs: elapsed,
        truncated: stdout.cut() || stderr.cut(),
      };
    } finally {
      fs.rmSync(call, { recursive: true, force: true });
    }
  }

  async grep(disk: string, directory: string, pattern: string, options: GrepOptions = {}): Promise<[GrepHit[], string]> {
    const base = this.#dir(disk);
    const start = path.join(base, directory);
    // search takes a directory, as Archil's does: anything else has no files in it
    if (!isDir(start)) return [[], "completed"];
    const limit = Math.trunc(options.maxResults || this.limits.grepMaxResults);
    const recursive = options.recursive ?? true;
    const below = directory ? directory.replace(/\/+$/, "") + "/" : "";
    const hits: GrepHit[] = [];
    if (which("rg")) {
      // As Archil's search runs it: hidden files are searched and ignore files are not read.
      // It runs in the directory itself, because that is what globs are relative to.
      const argv = ["rg", "--json", "--no-config", "--hidden", "--no-ignore", "-n"];
      if (options.ignoreCase) argv.push("-i");
      if (!recursive) argv.push("--max-depth", "1");
      for (const g of options.globs ?? []) argv.push("-g", g);
      argv.push("-e", pattern, ".");
      const ran = await run(argv, { cwd: start, env: process.env, timeoutMs: 0, keep: Infinity });
      // rg writes one JSON event per line. Split on "\n" alone: a matched line may itself hold
      // U+2028 or U+0085, which JSON leaves as they are.
      for (const line of ran.stdout.text().split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type !== "match") continue;
        const data = event.data;
        let file: string = data.path.text ?? Buffer.from(data.path.bytes, "base64").toString();
        if (file.startsWith("./")) file = file.slice(2);
        file = below + file;
        if (file.split("/").includes(RESERVED)) continue;
        hits.push({ file, line: data.line_number, text: (data.lines.text ?? "").replace(/\n+$/, "") });
        if (hits.length >= limit) return [hits, "max_results"];
      }
      return [hits, "completed"];
    }
    // No ripgrep here: the same search in JavaScript. Lines end at "\n", as they do for rg, and
    // globs are matched against the path below the directory, as rg's -g does.
    const regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
    const globs = options.globs ?? [];
    for (const info of await this.list(disk, directory, { recursive })) {
      if (info.key.endsWith("/")) continue;
      if (!globKeep(info.key.startsWith(below) ? info.key.slice(below.length) : info.key, globs)) continue;
      let raw: Buffer;
      try {
        raw = fs.readFileSync(this.#file(disk, info.key));
      } catch {
        continue;
      }
      if (raw.includes(0)) continue; // a binary file is not searched, as with rg
      const text = raw.toString();
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      let number = 0;
      for (const line of lines) {
        number += 1;
        if (regex.test(line)) {
          hits.push({ file: info.key, line: number, text: line });
          if (hits.length >= limit) return [hits, "max_results"];
        }
      }
    }
    return [hits, "completed"];
  }

  // -- objects ---------------------------------------------------------------
  async get(disk: string, key: string): Promise<Uint8Array> {
    try {
      return fs.readFileSync(this.#file(disk, key));
    } catch (error) {
      if (errno(error) === "ENOENT" || errno(error) === "EISDIR") {
        throw new ValidationError(`no such file: ${key}`, { code: "not_found", path: key });
      }
      throw error;
    }
  }

  async put(disk: string, key: string, data: Uint8Array, options: { ifAbsent?: boolean } = {}): Promise<void> {
    const file = this.#file(disk, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (options.ifAbsent) {
      try {
        fs.writeFileSync(file, data, { flag: "wx", mode: 0o644 });
      } catch (error) {
        if (errno(error) === "EEXIST") throw new ValidationError(`already exists: ${key}`, { code: "exists", path: key });
        throw error;
      }
      return;
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${hex32()}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  async append(disk: string, key: string, data: Uint8Array): Promise<void> {
    if (data.length > this.limits.appendMaxBytes) {
      throw new ValidationError(`append larger than ${this.limits.appendMaxBytes} bytes`, { path: key });
    }
    const file = this.#file(disk, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, data);
  }

  async delete(disk: string, key: string): Promise<void> {
    fs.rmSync(this.#file(disk, key), { recursive: true, force: true });
  }

  async list(disk: string, prefix = "", options: { recursive?: boolean } = {}): Promise<ObjectInfo[]> {
    const recursive = options.recursive ?? true;
    const base = this.#dir(disk);
    const start = path.join(base, prefix);
    const out: ObjectInfo[] = [];
    const top = stat(start);
    if (top?.isFile()) return [info(prefix, top)];
    if (!top?.isDirectory()) return out;
    const key = (full: string): string => path.relative(base, full).split(path.sep).join("/");
    // Top-down, each directory's files before its sub-directories, both in sorted order:
    // one listing order on every host, and the same one the Python backend produces.
    const walk = (dir: string): void => {
      const [dirs, files] = entries(dir);
      const below = dirs.filter((d) => d !== RESERVED);
      if (!recursive) {
        const rel = key(dir);
        for (const d of below) out.push(new ObjectInfo(rel ? `${rel}/${d}/` : `${d}/`, 0));
      }
      for (const name of files) {
        const full = path.join(dir, name);
        const st = stat(full);
        if (st) out.push(info(key(full), st));
      }
      if (!recursive) return;
      for (const d of below) {
        const full = path.join(dir, d);
        if (!fs.lstatSync(full).isSymbolicLink()) walk(full);
      }
    };
    walk(start);
    return out;
  }

  async head(disk: string, key: string): Promise<ObjectInfo | null> {
    const st = stat(this.#file(disk, key));
    return st?.isFile() ? info(key, st) : null;
  }

  async share(disk: string, key: string, _expiresIn: number): Promise<string> {
    // a file: URL, percent-encoded the way Python's Path.as_uri() does it
    let url = "file://";
    for (const byte of Buffer.from(this.#file(disk, key))) {
      const ch = String.fromCharCode(byte);
      url += /[A-Za-z0-9_.~/-]/.test(ch) ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
    return url;
  }

  // -- time ------------------------------------------------------------------
  async checkpoint(disk: string, name: string): Promise<string> {
    const dst = path.join(this.root, "checkpoints", disk, name);
    if (fs.existsSync(dst)) {
      throw new ValidationError(`checkpoint '${name}' already exists on ${disk}`, { code: "exists" });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyTree(this.#dir(disk), dst);
    return name;
  }

  async branch(disk: string, name: string, fromCheckpoint: string, options: { existOk?: boolean } = {}): Promise<string> {
    const src = path.join(this.root, "checkpoints", disk, fromCheckpoint);
    if (!isDir(src)) {
      throw new ValidationError(`no checkpoint '${fromCheckpoint}' on ${disk}`, { code: "not_found" });
    }
    const handle = `${disk}@${name}`;
    const dst = this.#dir(handle);
    if (fs.existsSync(dst)) {
      if (options.existOk) return handle;
      throw new ValidationError(`branch '${name}' already exists on ${disk}`, { code: "exists" });
    }
    copyTree(src, dst);
    return handle;
  }

  /** One commit at a time per disk. A branch shares its disk's lock. */
  async commitLock(disk: string): Promise<() => void> {
    const key = disk.split("@")[0];
    const before = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(key, before.then(() => held));
    await before;
    return release;
  }
}

// -- helpers -----------------------------------------------------------------

function hex32(): string {
  return randomUUID().replaceAll("-", "");
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function stat(file: string): fs.BigIntStats | null {
  try {
    return fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
}

function isDir(file: string): boolean {
  return stat(file)?.isDirectory() ?? false;
}

/** Modification time in nanoseconds and size, in hex. The Python SDK computes the same string. */
function version(st: fs.BigIntStats): string {
  return `${st.mtimeNs.toString(16)}-${st.size.toString(16)}`;
}

function info(key: string, st: fs.BigIntStats): ObjectInfo {
  const second = 1_000_000_000n;
  const modified = Number(st.mtimeNs / second) + 1e-9 * Number(st.mtimeNs % second);
  return new ObjectInfo(key, Number(st.size), modified, version(st));
}

/** The names in a directory, sorted: [directories, everything else]. A symlink to a directory counts as one. */
function entries(dir: string): [dirs: string[], files: string[]] {
  const dirs: string[] = [];
  const files: string[] = [];
  let listed: fs.Dirent[];
  try {
    listed = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [dirs, files];
  }
  for (const entry of listed) {
    const directory = entry.isDirectory() || (entry.isSymbolicLink() && isDir(path.join(dir, entry.name)));
    (directory ? dirs : files).push(entry.name);
  }
  return [sorted(dirs), sorted(files)];
}

/** Copy a tree with its timestamps, so a file's version is the same on a checkpoint or a branch as on its source. */
function copyTree(src: string, dst: string): void {
  const done = spawnSync("cp", ["-a", src, dst], { encoding: "utf8" });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`could not copy ${src} to ${dst}: ${done.stderr.trim()}`);
}

let namespaces: boolean | null = null;

/** Can this host give a call its own mount namespace without privileges? */
function namespacesWork(): boolean {
  if (namespaces === null) {
    const probe = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    namespaces = probe.status === 0;
  }
  return namespaces;
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const full = path.join(dir || ".", name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return null;
}

function output(exitCode: number, stdout: string, stderr: string): ExecOutput {
  return { exitCode, stdout, stderr, queueMs: 0, executeMs: 0, totalMs: 0, truncated: false };
}

/**
 * A stream as Archil returns it: whole if it fits, else its first bytes and a marker, `limit`
 * bytes in all. Only the bytes that can be returned are held.
 */
class Head {
  #limit: number;
  #chunks: Buffer[] = [];
  #kept = 0;
  #total = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    if (this.#kept >= this.#limit) return;
    const room = this.#limit - this.#kept;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#chunks.push(part);
    this.#kept += part.length;
  }

  cut(): boolean {
    return this.#total > this.#limit;
  }

  text(): string {
    const all = Buffer.concat(this.#chunks);
    if (!this.cut()) return all.toString();
    const mark = Buffer.from(TRUNCATED_MARK);
    return Buffer.concat([all.subarray(0, Math.max(0, this.#limit - mark.length)), mark]).toString();
  }
}

/**
 * A ripgrep `-g` glob as a regular expression over a path relative to the search directory.
 *
 * A glob with no `/` matches a file name at any depth; one with a `/` matches the whole path (a
 * leading `/` anchors it). `*` and `?` stay inside one path segment, `**` crosses them, `[...]` is
 * a character class, `{a,b}` is alternation and a backslash makes the next character literal.
 */
export function globRegex(glob: string): RegExp {
  const anchored = glob.includes("/");
  glob = glob.replace(/^\/+/, "");
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    const close = c === "[" ? glob.indexOf("]", i + 2) : -1;
    if (c === "\\" && i + 1 < glob.length) {
      out += escape(glob[i + 1]);
      i += 2;
    } else if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (close > 0) {
      const body = glob.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      out += "[" + (negated ? "^" : "") + (negated ? body.slice(1) : body).replace(/[\\\]]/g, "\\$&") + "]";
      i = close + 1;
    } else if (c === "{") {
      out += "(?:";
      depth += 1;
      i += 1;
    } else if (c === "}" && depth) {
      out += ")";
      depth -= 1;
      i += 1;
    } else if (c === "," && depth) {
      out += "|";
      i += 1;
    } else {
      out += escape(c);
      i += 1;
    }
  }
  return new RegExp((anchored ? "^" : "(?:^|.*/)") + out + ")".repeat(depth) + "$", "s");
}

/**
 * Would ripgrep search `rel` under these `-g` globs? The last glob that matches decides; with no
 * match, a file is searched unless some glob asks for files by name (one without a leading `!`).
 */
export function globKeep(rel: string, globs: readonly string[]): boolean {
  let keep = !globs.some((g) => !g.startsWith("!"));
  for (const g of globs) {
    const negated = g.startsWith("!");
    if (globRegex(negated ? g.slice(1) : g).test(rel)) keep = !negated;
  }
  return keep;
}

interface Ran {
  code: number;
  stdout: Head;
  stderr: Head;
  timedOut: boolean;
}

/** Run a command with no stdin and capture what it prints. `timeoutMs` of 0 means no timeout. */
function run(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; keep: number }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new Head(options.keep);
    const stderr = new Head(options.keep);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, Math.min(options.timeoutMs, 2 ** 31 - 1))
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // a process ended by a signal reports the negative signal number, as Python's subprocess does
      const status = code ?? -(osConstants.signals[signal as NodeJS.Signals] ?? 1);
      resolve({ code: status, stdout, stderr, timedOut });
    };
    // Normally wait for the output to end. After a timeout, stop at the death of the command
    // itself: something it started may still hold the pipes open, and must not hold the caller.
    child.on("close", done);
    child.on("exit", (code, signal) => {
      if (!timedOut) return;
      child.stdout.destroy();
      child.stderr.destroy();
      done(code, signal);
    });
  });
}

function fingerprint(root: string, cap = 20_000): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string): boolean => {
    let listed: fs.Dirent[];
    try {
      listed = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    const dirs: string[] = [];
    for (const entry of listed) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        continue;
      }
      const st = stat(full);
      if (!st || st.isDirectory()) continue;
      seen.set(path.relative(root, full).split(path.sep).join("/"), `${st.size}:${st.mtimeNs}`);
      if (seen.size >= cap) return false;
    }
    return dirs.every(walk);
  };
  walk(root);
  return seen;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return sorted([...keys].filter((k) => before.get(k) !== after.get(k)));
}
