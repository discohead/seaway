#!/usr/bin/env node
/**
 * A seaway context as an MCP server, over stdio.
 *
 * It hands Claude Code the same thing `ctx.tools()` hands any model: a context to read, write and
 * run statements against. The difference is that statements keep their parameters here, so a call
 * can declare what it touches, be explained before it runs, and be priced.
 *
 * No dependencies. The seaway TypeScript SDK is loaded from disk on the first tool call (see
 * `findSdk`), which needs Node 22.19 or later because the SDK is run from its .ts sources.
 *
 * It speaks both eras of the protocol: the handshake-less revision (2026-07-28: `server/discover`,
 * and a version in every request's `_meta`) and the older one that begins with `initialize`.
 *
 * Environment (the plugin's .mcp.json sets these from the plugin's options):
 *   SEAWAY_SDK            a seaway checkout, its typescript/ directory, or src/index.ts
 *   SEAWAY_MANIFEST       a context manifest to open on first use
 *   SEAWAY_MCP_BACKEND    "local" (default) or "archil"
 *   SEAWAY_MCP_MAX_USD    a ceiling on what one session may spend; default 0.25, "none" for no ceiling
 *   SEAWAY_MCP_EGRESS     "deny" (default), "allow", or hosts separated by commas
 *   SEAWAY_MCP_READ_ONLY  "1" to open every context read-only
 *   SEAWAY_MCP_TRACE      a file to append every message to, for debugging
 */

import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// -- configuration -------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const PROJECT_DIR = setting("CLAUDE_PROJECT_DIR") || process.cwd();
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const MAX_OUTPUT = 12_000; // characters: what the SDK's own tools return at most
const DEFAULT_MAX_USD = 0.25;
const MIN_NODE = [22, 19];

/** An environment variable, or "" when it is unset or holds a placeholder nothing filled in. */
function setting(name) {
  const value = (process.env[name] ?? "").trim();
  return value.includes("${") ? "" : value;
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVER_INFO = { name: "seaway-context", version: pluginVersion() };

const INSTRUCTIONS = [
  "A seaway context: disks composed under mount names, each with a mode (read, frozen, owned, shared, append). Paths are <mount>/<path>.",
  "Begin with describe_context. If no context is open, open_context takes a manifest file or a map of mounts. The backend is local unless open_context is told \"archil\", which acts on the live account and bills per call.",
  "list_files and read_file go straight to the disk and use no compute: use them to look around.",
  "Work that computes is a statement. Call explain_statement before run_statement: it shows what would be mounted and what it would cost, and runs nothing.",
  "Say what a statement touches by passing paths as params: {\"path\"}, {\"glob\"}, {\"out\"} or {\"log\"}. Anything else is a value and is quoted for you. A statement with no path params mounts every disk, and its plan says so.",
  "kind \"grep\" is a regex search in one call per disk; \"sql\" is DuckDB over files; \"batch\" runs several small statements in one call.",
  "For changes that have to land together: begin_turn, do the work, commit_turn. A conflict applies nothing; begin a new turn and redo the work from the new state.",
  "On the local backend a statement is bash on this machine, run as you.",
].join("\n");

// -- errors --------------------------------------------------------------------

/** A mistake in how a tool was called. Its message is the whole answer. */
class Usage extends Error {}

function usage(message) {
  return new Usage(message);
}

/** JSON-RPC failures, as opposed to a tool that ran and reported an error. */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function describeError(error) {
  if (error instanceof Usage) return `error: ${error.message}`;
  // The SDK's own errors print as `code [path]: message — suggestion`, which is safe to show a model.
  if (error && typeof error.code === "string" && typeof error.toString === "function" && "suggestion" in error) {
    return `error: ${String(error)}`;
  }
  if (error instanceof Error) return `error: ${error.name}: ${error.message}`;
  return `error: ${String(error)}`;
}

// -- finding and loading the SDK ---------------------------------------------------

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The SDK's entry point under `given`: a checkout, its typescript/ directory, or the file itself. */
function entryUnder(given) {
  if (isFile(given)) return given;
  for (const rel of ["typescript/src/index.ts", "src/index.ts", "index.ts"]) {
    const candidate = path.join(given, rel);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Where the TypeScript SDK is, and where it was looked for. */
export function findSdk(env = process.env, projectDir = PROJECT_DIR) {
  const tried = [];
  const configured = (env.SEAWAY_SDK ?? "").trim();
  if (configured && !configured.includes("${")) {
    const given = path.resolve(projectDir, configured);
    const entry = entryUnder(given);
    tried.push(`SEAWAY_SDK=${given}`);
    return { entry, tried, configured: true };
  }
  // The project, and the directories above it: a seaway checkout, or a project that installed it.
  let dir = path.resolve(projectDir);
  for (let depth = 0; depth < 8; depth++) {
    const checkout = path.join(dir, "typescript");
    if (packageName(checkout) === "seaway" && isFile(path.join(checkout, "src", "index.ts"))) {
      return { entry: path.join(checkout, "src", "index.ts"), tried, configured: false };
    }
    if (packageName(dir) === "seaway" && isFile(path.join(dir, "src", "index.ts"))) {
      return { entry: path.join(dir, "src", "index.ts"), tried, configured: false };
    }
    const installed = path.join(dir, "node_modules", "seaway");
    if (packageName(installed) === "seaway") {
      const real = realpathSync(installed);
      const entry = entryUnder(real);
      if (entry) return { entry, tried, configured: false };
    }
    tried.push(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // The plugin used in place, from inside a checkout (plugins/seaway/servers/…).
  const beside = path.resolve(PLUGIN_ROOT, "..", "..", "typescript", "src", "index.ts");
  tried.push(path.dirname(path.dirname(beside)));
  if (isFile(beside) && packageName(path.resolve(PLUGIN_ROOT, "..", "..", "typescript")) === "seaway") {
    return { entry: beside, tried, configured: false };
  }
  return { entry: null, tried, configured: false };
}

function nodeIsOldEnough() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const HOW_TO_POINT = [
  "Point the plugin at the SDK in one of these ways:",
  "  - run /seaway:setup, which finds a checkout or clones one and sets the option for you;",
  "  - run Claude Code from inside a seaway checkout (the SDK is found at typescript/src/index.ts);",
  "  - set the plugin's \"seaway checkout\" option (claude plugin configure seaway), or SEAWAY_SDK, to a checkout;",
  "  - install it into the project as a link: npm install /path/to/seaway/typescript.",
].join("\n");

let sdkPromise = null;
let sdkEntry = null;

/** The SDK, loaded once. A failure is remembered and explained on every call. */
function loadSdk() {
  sdkPromise ??= (async () => {
    if (!nodeIsOldEnough()) {
      throw usage(
        `the seaway SDK runs from TypeScript sources, which needs Node ${MIN_NODE.join(".")} or later; this is Node ${process.versions.node}`,
      );
    }
    const found = findSdk();
    if (!found.entry) {
      const where = found.configured ? `nothing at ${found.tried[0]}` : "no seaway checkout in or above the project";
      throw usage(`the seaway SDK was not found: ${where}.\n${HOW_TO_POINT}`);
    }
    let sdk;
    try {
      sdk = await import(pathToFileURL(found.entry).href);
    } catch (error) {
      const inModules = found.entry.split(path.sep).includes("node_modules");
      const hint = inModules
        ? "Node does not run TypeScript from a copy under node_modules. Install seaway as a link (npm install /path/to/seaway/typescript) or set the plugin's \"seaway checkout\" option."
        : HOW_TO_POINT;
      throw usage(`could not load the seaway SDK from ${found.entry}: ${error.message}\n${hint}`);
    }
    for (const name of ["context", "disk", "fromManifest", "LocalBackend", "ArchilBackend", "Transaction", "raw"]) {
      if (!(name in sdk)) throw usage(`${found.entry} does not look like the seaway SDK: it has no '${name}'`);
    }
    sdkEntry = found.entry;
    return sdk;
  })();
  return sdkPromise;
}

// -- the session's state ---------------------------------------------------------

const state = {
  /** the context that was opened */
  base: null,
  /** an open turn, whose context every tool works in until it ends */
  tx: null,
  /** changes a feed returned and nobody acknowledged yet, by cursor path */
  polled: new Map(),
  /** how the context was opened, for describe_context */
  opened: null,
};

function clip(text, limit = MAX_OUTPUT) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return (
    chars.slice(0, limit).join("") +
    `\n… ${chars.length - limit} more characters. Narrow the request, or send the output to a file with "into" and read part of it.`
  );
}

/** The session's ceiling in dollars, or null for none. Zero is a ceiling: plans can be read, nothing runs. */
function budgetSetting(given) {
  const raw = given !== undefined && given !== null ? given : setting("SEAWAY_MCP_MAX_USD");
  if (raw === "" || raw === undefined) return DEFAULT_MAX_USD;
  if (typeof raw === "string" && ["none", "off", "unlimited"].includes(raw.trim().toLowerCase())) return null;
  const value = typeof raw === "string" && !raw.trim() ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw usage(`max_usd has to be a number of dollars, or "none": got ${JSON.stringify(raw)}`);
  return value;
}

function egressSetting(given) {
  if (given !== undefined && given !== null) return given;
  const raw = setting("SEAWAY_MCP_EGRESS") || "deny";
  if (raw === "deny" || raw === "allow") return raw;
  return raw.split(",").map((host) => host.trim()).filter(Boolean);
}

function truthy(value) {
  return value === true || ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function time(text, what) {
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) throw usage(`${what}: cannot read ${JSON.stringify(text)} as a time; use ISO 8601, like 2026-11-09T14:30:00Z`);
  return at;
}

/** The context tools act on: the open turn's, or the one that was opened. */
async function current() {
  if (state.tx) return state.tx.ctx;
  if (!state.base) {
    const manifest = setting("SEAWAY_MANIFEST");
    if (!manifest) {
      throw usage(
        "no context is open. Call open_context with a manifest (a path to a context manifest, or the manifest itself) " +
          "or with mounts, for example { \"mounts\": { \"notes\": { \"disk\": \"my-notes\", \"mode\": \"owned\", \"create\": true } } }.",
      );
    }
    await openContext({ manifest });
  }
  return state.base;
}

// -- opening a context -------------------------------------------------------------

async function openContext(args) {
  if (state.tx) throw usage(`turn ${state.tx.id} is open: commit_turn or rollback_turn before opening another context`);
  const sdk = await loadSdk();
  const kind = String(args.backend ?? (setting("SEAWAY_MCP_BACKEND") || "local")).toLowerCase();
  if (kind !== "local" && kind !== "archil") throw usage(`backend has to be "local" or "archil": got ${JSON.stringify(kind)}`);
  if (args.manifest != null && args.mounts != null) throw usage("pass a manifest or mounts, not both");

  let backend;
  let where;
  if (kind === "archil") {
    if (!process.env.ARCHIL_API_KEY) {
      throw usage(
        "backend \"archil\" needs ARCHIL_API_KEY (and ARCHIL_REGION) in the environment Claude Code was started from. " +
          "Nothing was opened.",
      );
    }
    backend = new sdk.ArchilBackend();
    where = `archil${process.env.ARCHIL_REGION ? ` (${process.env.ARCHIL_REGION})` : ""}`;
  } else {
    const root = path.resolve(PROJECT_DIR, args.local_root || setting("ARCHIL_LOCAL_ROOT") || ".archil-local");
    backend = new sdk.LocalBackend({ root });
    where = `local, under ${backend.root}`;
  }

  // The mounts, from a manifest or given directly.
  let manifest = null;
  let source = "mounts given to open_context";
  if (args.manifest != null) {
    manifest = args.manifest;
    if (typeof manifest === "string") {
      const file = path.resolve(PROJECT_DIR, manifest);
      if (!existsSync(file)) throw usage(`no manifest at ${file}`);
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw usage(`${file} is not JSON: ${error.message}`);
      }
      source = file;
    } else {
      source = "a manifest given to open_context";
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw usage("a manifest is a JSON object");
  } else if (args.mounts == null) {
    throw usage("open_context needs a manifest (a path, or the manifest itself) or mounts");
  }
  const mounts = manifest ? (manifest.mounts ?? {}) : args.mounts;
  if (typeof mounts !== "object" || mounts === null || !Object.keys(mounts).length) throw usage("a context needs at least one mount");

  if (truthy(args.create)) {
    for (const mount of Object.values(mounts)) {
      const name = typeof mount === "string" ? mount : mount?.disk;
      if (name) await backend.resolveDisk(name, { create: true });
    }
  }

  let ctx;
  if (manifest) {
    ctx = await sdk.fromManifest(manifest, { backend });
  } else {
    const sources = {};
    for (const [name, mount] of Object.entries(mounts)) {
      if (typeof mount === "string") {
        sources[name] = sdk.disk(mount);
        continue;
      }
      if (typeof mount !== "object" || mount === null || typeof mount.disk !== "string") {
        throw usage(`mounts.${name}: expected a disk name, or { "disk": name, "mode": … }`);
      }
      sources[name] = sdk.disk(mount.disk, mount.mode ?? "read", {
        at: mount.at ?? null,
        subdirectory: mount.subdirectory ?? "",
        description: mount.description ?? "",
        create: truthy(mount.create),
      });
    }
    ctx = await sdk.context(sources, {
      backend,
      name: args.name ?? "context",
      journal: args.journal ?? null,
      tools: args.tools ?? null,
    });
  }

  // What a model's commands may reach, what it may change, and what it may spend.
  const ownEgress = manifest && "egress" in manifest && args.egress == null;
  if (!ownEgress) ctx = ctx.withEgress(egressSetting(args.egress));
  const readOnly = truthy(args.read_only ?? setting("SEAWAY_MCP_READ_ONLY"));
  if (readOnly) ctx = ctx.narrow([], { readOnly: true });
  const maxUsd = budgetSetting(args.max_usd);
  if (maxUsd !== null) ctx = ctx.withBudget({ maxUsd });

  state.base = ctx;
  state.polled.clear();
  state.opened = { source, where, kind, maxUsd, readOnly, isolation: backend.isolation ?? null };
  return describe();
}

function describe() {
  const ctx = state.tx ? state.tx.ctx : state.base;
  const o = state.opened;
  const lines = [ctx.describe(), ""];
  lines.push(`opened from: ${o.source}`);
  lines.push(`backend: ${o.where}`);
  if (o.kind === "archil") {
    lines.push("This is the live account: statements, checkpoints and commits bill per call, and writes change real disks.");
  } else {
    lines.push("Statements here are bash on this machine, run as you. Prices are what the same plan would cost on Archil.");
    if (ctx.egress !== null) {
      lines.push(
        o.isolation === "namespace"
          ? "An egress policy cuts the network for a call entirely here, whatever hosts it names."
          : "An egress policy is not enforced by the local backend on this host; on Archil it is.",
      );
    }
    if (o.isolation === "symlink") {
      lines.push("Mounts are symlinks here: a write to a read-only mount is reported after the command (exit 30), not refused.");
    }
  }
  const writable = [...ctx.mounts.values()].filter((m) => m.writable).map((m) => `${m.name} (${m.mode})`);
  lines.push(writable.length ? `writable: ${writable.join(", ")}` : "writable: nothing" + (o.readOnly ? " (opened read-only)" : ""));
  if (ctx.journal) {
    // A context narrowed read-only writes its journal through itself, and so cannot: say it, rather than
    // let a reader think that what runs here is on record.
    lines.push(
      o.readOnly
        ? `journal: none while the context is read-only (${ctx.journal} is not written: a journal is a write)`
        : `journal: ${ctx.journal}`,
    );
  }
  const spent = ctx.spentUnderBudget();
  lines.push(
    o.maxUsd === null
      ? `budget: none; spent so far ≈ $${spent.usd.toFixed(5)}`
      : `budget: $${o.maxUsd} for this session; spent so far ≈ $${spent.usd.toFixed(5)}`,
  );
  if (state.tx) lines.push(`turn ${state.tx.id} is open: everything acts on its branch until commit_turn or rollback_turn`);
  return lines.join("\n");
}

async function describeContext() {
  if (!state.base && !setting("SEAWAY_MANIFEST")) {
    const lines = ["No context is open."];
    try {
      const sdk = await loadSdk();
      lines.push(`seaway ${sdk.VERSION ?? "?"} from ${sdkEntry}`);
    } catch (error) {
      lines.push(describeError(error));
    }
    lines.push(
      "Call open_context with a manifest (a path to a context manifest, or the manifest itself), or with mounts:",
      '  { "mounts": { "docs": { "disk": "handbook" }, "notes": { "disk": "my-notes", "mode": "owned", "create": true } } }',
      `Backend when not given: ${setting("SEAWAY_MCP_BACKEND") || "local"}.`,
    );
    return lines.join("\n");
  }
  const ctx = await current();
  const sdk = await loadSdk();
  return [
    describe(),
    "",
    `spend: ${String(ctx.spend)}`,
    `manifest: ${JSON.stringify(ctx.manifest())}`,
    `seaway ${sdk.VERSION ?? "?"} from ${sdkEntry}`,
  ].join("\n");
}

// -- statements ----------------------------------------------------------------------

/**
 * One parameter. A path is marked as one: {path}, {glob}, {out}, or {log} for a log selection.
 * {value} and anything that is not an object is a value, which the SDK quotes. {raw} is text put
 * into the command as written. A list is a list of these.
 */
function param(sdk, ctx, spec, where) {
  if (Array.isArray(spec)) return spec.map((item, i) => param(sdk, ctx, item, `${where}[${i}]`));
  if (spec === null || typeof spec !== "object") return spec;
  if (typeof spec.path === "string") return ctx.path(spec.path);
  if (typeof spec.out === "string") return ctx.out(spec.out);
  if (typeof spec.glob === "string") return ctx.glob(spec.glob);
  if ("raw" in spec) return sdk.raw(String(spec.raw));
  if (typeof spec.log === "string") {
    const log = ctx.log(spec.log, { partition: spec.partition ?? "hour" });
    if (spec.between != null) {
      if (!Array.isArray(spec.between) || spec.between.length !== 2) throw usage(`params.${where}: between is [start, end]`);
      return log.between(time(spec.between[0], `params.${where}.between`), time(spec.between[1], `params.${where}.between`));
    }
    if (spec.last != null) return log.last(spec.last, spec.now != null ? { now: time(spec.now, `params.${where}.now`) } : {});
    return log.all();
  }
  if ("value" in spec) return spec.value;
  throw usage(
    `params.${where}: a parameter is { "path" }, { "glob" }, { "out" }, { "log" }, { "value" } or { "raw" }, ` +
      `or a plain value; got an object with ${Object.keys(spec).join(", ") || "no keys"}`,
  );
}

/**
 * A statement from its description. Never async, and never awaited: a statement is thenable, and
 * awaiting one runs it.
 */
function statement(sdk, ctx, spec, where = "statement") {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) throw usage(`${where}: expected an object with a kind`);
  let stmt;
  if (spec.kind === "batch") {
    if (!Array.isArray(spec.children) || !spec.children.length) throw usage(`${where}: a batch needs children, each an sh or sql statement`);
    stmt = ctx.batch(spec.children.map((child, i) => statement(sdk, ctx, child, `${where}.children[${i}]`)));
  } else if (spec.kind === "grep") {
    if (typeof spec.pattern !== "string" || !spec.pattern) throw usage(`${where}: a grep needs a pattern`);
    const o = spec.options ?? {};
    const options = {};
    if (o.ignoreCase ?? o.ignore_case) options.ignoreCase = true;
    if (o.globs) options.globs = o.globs;
    if ((o.maxResults ?? o.max_results) != null) options.maxResults = o.maxResults ?? o.max_results;
    if (o.recursive != null) options.recursive = o.recursive;
    stmt = ctx.grep(spec.pattern, spec.over ?? null, options);
  } else if (spec.kind === "sh" || spec.kind === "sql") {
    if (typeof spec.template !== "string" || !spec.template.trim()) throw usage(`${where}: an ${spec.kind} statement needs a template`);
    const params = {};
    for (const [name, value] of Object.entries(spec.params ?? {})) params[name] = param(sdk, ctx, value, name);
    stmt = spec.kind === "sh" ? ctx.sh(spec.template, params) : ctx.sql(spec.template, params);
  } else {
    throw usage(`${where}: kind has to be "sh", "sql", "grep" or "batch"; got ${JSON.stringify(spec.kind)}`);
  }
  if (spec.map) {
    stmt = stmt.map({ on: spec.map.on ?? null, reduce: spec.map.reduce ?? "concat", shards: spec.map.shards ?? null });
  }
  if (spec.into) stmt = stmt.into(spec.into);
  if (spec.sized) {
    stmt = stmt.sized({ vcpu: spec.sized.vcpu, memMib: spec.sized.memMib ?? spec.sized.mem_mib, image: spec.sized.image });
  }
  if (spec.egress != null) stmt = stmt.egress(spec.egress);
  if (spec.within) {
    const w = spec.within;
    stmt = stmt.within({
      maxUsd: w.maxUsd ?? w.max_usd ?? null,
      maxCalls: w.maxCalls ?? w.max_calls ?? null,
      maxBytesTouched: w.maxBytesTouched ?? w.max_bytes_touched ?? null,
    });
  }
  return stmt;
}

function usd(x) {
  if (!x) return "$0";
  return x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(2)}`;
}

function resultText(result) {
  const meta = result.meta;
  const calls = `${meta.calls} call${meta.calls === 1 ? "" : "s"}`;
  const units = meta.callUnits !== meta.calls ? ` (${meta.callUnits} units)` : "";
  const head = [
    `exit ${result.exitCode}`,
    result.kind,
    calls + units,
    `≈ ${usd(meta.usd)}`,
    `${Math.round(meta.wallMs)} ms`,
    result.plan ? `plan ${result.plan.hash}` : null,
  ].filter(Boolean);
  const lines = [head.join(" · ")];
  if (result.kind === "batch") {
    result.results.forEach((child, i) => {
      lines.push(`--- [${i}] ${child.kind} · exit ${child.exitCode}`);
      if (child.stdout) lines.push(child.stdout.trimEnd());
      if (child.stderr.trim()) lines.push("[stderr]", child.stderr.trimEnd());
    });
  } else {
    if (result.kind === "sql" && result.rows) lines.push(`rows: ${result.rows.length}`);
    if (result.kind === "grep") {
      lines.push(`matches: ${result.rows.length}`);
      if (!result.value.exhaustive) lines.push(`(stopped early: ${result.value.stoppedReason}; these are a sample)`);
    }
    if (result.stdout) lines.push(result.stdout.trimEnd());
    else if (!result.paths.length && result.kind !== "grep") lines.push("(no output)");
  }
  if (result.paths.length) lines.push(`written: ${result.paths.join(", ")}`);
  if (result.kind !== "batch" && result.stderr.trim()) lines.push("[stderr]", result.stderr.trimEnd());
  if (result.truncated) lines.push("(output was cut: only its first bytes are here)");
  for (const note of result.plan?.notes ?? []) lines.push(`note: ${note}`);
  return lines.join("\n");
}

async function explainStatement(args) {
  const sdk = await loadSdk();
  const ctx = await current();
  const plan = await statement(sdk, ctx, args).explain();
  const format = args.format ?? "text";
  if (format === "json") return JSON.stringify(plan, null, 2);
  if (format === "both") return `${String(plan)}\n\n${JSON.stringify(plan, null, 2)}`;
  return String(plan);
}

async function runStatement(args) {
  const sdk = await loadSdk();
  const ctx = await current();
  const result = await statement(sdk, ctx, args).run();
  return { text: resultText(result), failed: result.exitCode !== 0 };
}

// -- the data plane, through the SDK's own tools ----------------------------------------

async function sdkTool(name, args) {
  const ctx = await current();
  const [tool] = ctx.tools([name]);
  if (!tool) throw usage(`this seaway SDK has no '${name}' tool`);
  const text = await tool.call(args ?? {});
  return { text, failed: text.startsWith("error: ") };
}

// -- turns ---------------------------------------------------------------------------

/**
 * The writes a turn should be begun with. When the journal is on a disk the turn branches, the journal's own lines are
 * changes the turn makes, so a turn that names its writes has to name the journal's directory among them: without it
 * the commit is refused (undeclared_write) and the turn's work is lost. Returns the directory when it had to be added.
 */
function writesWithJournal(ctx, writes) {
  if (!Array.isArray(writes) || !ctx.journal) return { writes, added: null };
  const clean = (p) => String(p).replace(/^\/+|\/+$/g, "");
  const journal = clean(ctx.journal);
  const mount = journal.split("/")[0];
  const roots = writes.map(clean);
  const branched = roots.some((root) => root.split("/")[0] === mount);
  const covered = roots.some((root) => journal === root || journal.startsWith(`${root}/`));
  if (!branched || covered || !ctx.mounts.get(mount)?.writable) return { writes, added: null };
  return { writes: [...writes, journal], added: journal };
}

async function beginTurn(args) {
  if (state.tx) throw usage(`turn ${state.tx.id} is already open: commit_turn or rollback_turn first`);
  const sdk = await loadSdk();
  const ctx = await current();
  const { writes: declared, added } = writesWithJournal(ctx, args.writes ?? null);
  const tx = new sdk.Transaction(ctx, {
    writes: declared,
    reads: args.reads ?? null,
    isolation: args.isolation ?? "snapshot",
    name: args.name ?? null,
  });
  await tx.begin();
  state.tx = tx;
  state.polled.clear();
  const writes = [...tx.writeRoots].map(([mount, roots]) => roots.map((r) => (r ? `${mount}/${r}` : mount)).join(", ")).join(", ");
  const lines = [`turn ${tx.id} is open (${tx.isolation} isolation). It may write: ${writes}.`];
  if (added) lines.push(`${added} was added to what it may write: the journal's lines are changes on that disk, and the commit would be refused without it.`);
  lines.push("Every tool now acts on the turn's branch: nothing is visible outside it until commit_turn. rollback_turn drops it.");
  return lines.join("\n");
}

function openTurn() {
  if (!state.tx) throw usage("no turn is open: call begin_turn first");
  return state.tx;
}

async function turnChanges() {
  const tx = openTurn();
  const changes = await tx.changes();
  if (!changes.size) return `turn ${tx.id} has changed nothing yet`;
  const lines = [`turn ${tx.id} has changed:`];
  for (const [mount, { written, deleted }] of changes) {
    for (const rel of written) lines.push(`  W ${mount}/${rel}`);
    for (const rel of deleted) lines.push(`  D ${mount}/${rel}`);
  }
  return lines.join("\n");
}

async function commitTurn() {
  const tx = openTurn();
  const sdk = await loadSdk();
  try {
    const commit = await tx.commit();
    if (commit.empty) return `turn ${tx.id} committed: it had changed nothing`;
    const lines = [`turn ${tx.id} committed in ${commit.calls} call${commit.calls === 1 ? "" : "s"}:`];
    for (const p of commit.applied) lines.push(`  W ${p}`);
    for (const p of commit.deleted) lines.push(`  D ${p}`);
    return lines.join("\n");
  } catch (error) {
    if (error instanceof sdk.Conflict) {
      throw usage(
        `conflict: turn ${tx.id} was not applied, none of it. These paths changed on the main line since it began: ` +
          `${error.paths.join(", ")}. Begin a new turn and redo the work from the current state.`,
      );
    }
    throw error;
  } finally {
    // Committed, aborted or failed: either way this turn is over.
    state.tx = null;
    state.polled.clear();
  }
}

async function rollbackTurn() {
  const tx = openTurn();
  try {
    await tx.rollback();
  } finally {
    state.tx = null;
    state.polled.clear();
  }
  return `turn ${tx.id} was rolled back. Nothing it did reached the main line.`;
}

// -- logs, feeds and views -------------------------------------------------------------

async function appendLog(args) {
  const ctx = await current();
  if (typeof args.log !== "string") throw usage("append_log needs log: the log's path, like \"audit/agent-7\"");
  const records = Array.isArray(args.records) ? args.records : args.records != null ? [args.records] : [];
  if (!records.length || records.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
    throw usage("append_log needs records: one or more JSON objects");
  }
  const log = ctx.log(args.log, { partition: args.partition ?? "hour", writer: args.writer ?? null });
  const written = await log.append(records, args.at != null ? { at: time(args.at, "at") } : {});
  return `appended ${records.length} record${records.length === 1 ? "" : "s"} to ${written.join(", ")}`;
}

function sample(items, limit = 100) {
  const shown = items.slice(0, limit).map((item) => `  ${item}`);
  if (items.length > limit) shown.push(`  … ${items.length - limit} more`);
  return shown;
}

async function pollFeed(args) {
  const ctx = await current();
  if (typeof args.path !== "string" || typeof args.cursor !== "string") throw usage("poll_feed needs path and cursor");
  const feed = ctx.feed(args.path, { cursor: args.cursor });
  const changes = await feed.poll();
  if (changes.empty) return `nothing has changed under ${feed.path} since cursor ${feed.cursor} last looked`;
  state.polled.set(feed.cursor, changes);
  const lines = [`changes under ${feed.path} since cursor ${feed.cursor} last looked:`];
  if (changes.added.length) lines.push(`added (${changes.added.length}):`, ...sample(changes.added.map((f) => `${f.path}\t${f.size}`)));
  if (changes.modified.length) {
    lines.push(
      `modified (${changes.modified.length}), with the size each had before:`,
      ...sample(changes.modified.map((f) => `${f.path}\t${f.size}\twas ${changes.previous[f.path]}`)),
    );
  }
  if (changes.removed.length) lines.push(`removed (${changes.removed.length}):`, ...sample(changes.removed));
  lines.push(`Handle them, then call ack_feed with cursor "${feed.cursor}". Until then a poll returns them again.`);
  return lines.join("\n");
}

async function ackFeed(args) {
  const ctx = await current();
  if (typeof args.cursor !== "string") throw usage("ack_feed needs cursor");
  const cursor = ctx.out(args.cursor).path;
  const changes = state.polled.get(cursor);
  if (!changes) throw usage(`nothing polled with cursor ${cursor} is waiting: call poll_feed first (a turn beginning or ending drops what was polled)`);
  await changes.ack();
  state.polled.delete(cursor);
  return `cursor ${cursor} now stands after ${changes.files.length + changes.removed.length} change(s)`;
}

async function refreshView(args) {
  const sdk = await loadSdk();
  const ctx = await current();
  if (typeof args.path !== "string") throw usage("refresh_view needs path: where the view's file lives");
  const view = ctx.view(args.path, () => statement(sdk, ctx, args.statement), { inputs: args.inputs ?? [] });
  const result = await view.refresh({ force: truthy(args.force) });
  const lines = [];
  if (result === null) lines.push(`${view.path} is fresh: its inputs and its statement are unchanged, so nothing ran`);
  else if (result.ok) lines.push(`${view.path} was rebuilt`, resultText(result));
  else lines.push(`${view.path} could not be rebuilt`, resultText(result));
  if (truthy(args.read) && (result === null || result.ok)) lines.push("", await ctx.readText(view.path));
  return { text: lines.join("\n"), failed: result !== null && !result.ok };
}

// -- the tools, as a client sees them ------------------------------------------------------

const STR = { type: "string" };
const BOOL = { type: "boolean" };
const NUM = { type: "number" };

function schema(required, properties) {
  return { type: "object", properties, required, additionalProperties: false };
}

const STATEMENT = {
  kind: { type: "string", enum: ["sh", "sql", "grep", "batch"], description: "sh: bash. sql: DuckDB over files. grep: regex search, one call per disk. batch: several sh/sql statements in one call." },
  template: {
    ...STR,
    description:
      "sh, sql: the command or query, with {name} where a parameter goes. Only names in params are substituted, so awk '{print $1}' and ${HOME} pass through.",
  },
  params: {
    type: "object",
    description:
      'sh, sql: name → parameter. A path the statement reads is {"path": "docs/a.md"} (a file or a directory) or {"glob": "logs/**/*.ndjson"}; ' +
      'one it writes is {"out": "notes/report.txt"}; a log\'s records are {"log": "logs", "last": "15m"}, {"log": "logs", "between": [start, end]} or {"log": "logs"} for all of it. ' +
      'These decide what the call mounts. Anything else is a value and is quoted: {"value": "it\'s"} or just "it\'s", 5, true. ' +
      '{"raw": "| wc -l"} is put in as written. A list of these becomes several words. In sql a path is a table.',
    additionalProperties: true,
  },
  pattern: { ...STR, description: "grep: the regular expression." },
  over: { ...STR, description: "grep: the path to search, like \"logs\" or \"docs/security\". Left out, every mount is searched." },
  options: {
    type: "object",
    description: "grep: { ignoreCase, globs: [\"checkout-*.ndjson\"], maxResults, recursive }.",
    additionalProperties: true,
  },
  children: { type: "array", items: { type: "object" }, description: "batch: the statements, each in this same shape. Plain sh and sql only." },
  map: {
    type: "object",
    description:
      'sh only: run once per shard of one input, in parallel, and combine the outputs. { "on": parameter (optional when exactly one is a glob or a log), ' +
      '"reduce": concat | lines | sorted | unique | count | sum | sum_by_key | json, "shards": n }.',
    additionalProperties: true,
  },
  into: { ...STR, description: "Send the output to this path in the context and return the path instead. A mapped statement writes part-00000, part-00001, … under it." },
  sized: { type: "object", description: "The VM for each call: { vcpu, memMib, image }. Above 2 vCPU / 4096 MiB a call bills as a multiple.", additionalProperties: true },
  egress: { description: 'What this call may reach on the network: "deny", "allow", or a list of hosts. Left out, the context\'s policy applies.' },
  within: { type: "object", description: "Refuse to run if the plan exceeds { maxUsd, maxCalls, maxBytesTouched }.", additionalProperties: true },
};

const TOOLS = [
  {
    name: "describe_context",
    description:
      "What the open context is: its mounts and their modes, the backend, what is writable, the budget and what has been spent, and its manifest. Start here.",
    inputSchema: schema([], {}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: () => describeContext(),
  },
  {
    name: "open_context",
    description:
      "Open a seaway context for this session, replacing the one that was open. Give a manifest (a path to a context manifest, or the manifest itself) or mounts. " +
      'The backend is "local" (directories under the project\'s .archil-local; statements are bash on this machine) unless "archil" is asked for, ' +
      "which opens the disks in the live Archil account. Commands are denied the network and the session is held to a budget unless told otherwise.",
    inputSchema: schema([], {
      manifest: { description: 'A path to a context manifest, or the manifest itself: { "archilContext": 0, "name", "mounts": { name: { "disk", "mode", … } } }.' },
      mounts: {
        type: "object",
        description:
          'In place of a manifest: name → a disk name (read-only), or { "disk", "mode": read | frozen | owned | shared | append, "at" (a checkpoint, for frozen), "subdirectory", "description", "create" }.',
        additionalProperties: true,
      },
      name: { ...STR, description: "With mounts: the context's name." },
      journal: { ...STR, description: 'With mounts: a path in the context where every statement is logged, like "notes/journal". Not written when the context is opened read-only.' },
      tools: { type: "object", description: 'With mounts: where tools live when not on the PATH, like { "duckdb": "notes/bin/duckdb" }.', additionalProperties: true },
      backend: { type: "string", enum: ["local", "archil"], description: 'Left out, the plugin\'s setting, which is "local" unless changed.' },
      create: { ...BOOL, description: "Create any disk the mounts name that does not exist yet. On archil this creates real disks." },
      local_root: { ...STR, description: "local backend: the directory that holds the disks. Left out, ARCHIL_LOCAL_ROOT or .archil-local in the project." },
      egress: { description: 'What statements may reach on the network: "deny", "allow", or a list of hosts. Left out, the manifest\'s own policy, else "deny".' },
      max_usd: { description: 'A ceiling in dollars on what this session may spend, by the plans\' estimates. 0 lets plans be read and nothing run; "none" lifts the ceiling. Left out, the plugin\'s setting (0.25).' },
      read_only: { ...BOOL, description: "Open every mount read-only, whatever its mode. A journal is then not written." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (args) => openContext(args),
  },
  {
    name: "list_files",
    description: "List a directory in the context. Directories end in '/'; files come with their size. Leave path empty to list the mounts. A listing uses no compute and makes no data active.",
    inputSchema: schema([], { path: { ...STR, description: "<mount>/<path>" }, recursive: BOOL }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => sdkTool("list_files", args),
  },
  {
    name: "read_file",
    description: "Read a file in the context, as text. Direct: no compute. A long file is cut; use a statement to read part of one.",
    inputSchema: schema(["path"], { path: { ...STR, description: "<mount>/<path>" } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => sdkTool("read_file", args),
  },
  {
    name: "write_file",
    description: "Create or replace a file on an owned or shared mount. Direct: no compute. Inside a turn the write stays on the turn's branch until it commits.",
    inputSchema: schema(["path", "content"], { path: { ...STR, description: "<mount>/<path>" }, content: STR }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args) => sdkTool("write_file", args),
  },
  {
    name: "delete_file",
    description: "Delete a file, or a directory and everything under it, on an owned or shared mount.",
    inputSchema: schema(["path"], { path: { ...STR, description: "<mount>/<path>" } }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args) => sdkTool("delete_file", args),
  },
  {
    name: "explain_statement",
    description:
      "The plan for a statement, without running it: how it reaches the data (route), which disks the call would see and whether it could change them (scope), " +
      "how many calls and how they combine, what it reads and writes, what it costs, and notes on doing it better. Costs nothing but a listing.",
    inputSchema: schema(["kind"], { ...STATEMENT, format: { type: "string", enum: ["text", "json", "both"], description: "text (the default) is the printed plan; json is the plan document, tasks included." } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => explainStatement(args),
  },
  {
    name: "run_statement",
    description:
      "Run a statement next to the data and return its result: exit code, output or rows, files written, calls and cost. Refused before it runs if its plan exceeds the budget. " +
      "Explain it first when it is not obvious what it will mount or cost. On the local backend this is bash on this machine.",
    inputSchema: schema(["kind"], STATEMENT),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: (args) => runStatement(args),
  },
  {
    name: "begin_turn",
    description:
      "Begin a turn: a transaction over files. Until it ends, every tool acts on a private branch of the disks the turn may write. commit_turn lands all of its changes or none.",
    inputSchema: schema([], {
      writes: { type: "array", items: STR, description: 'The paths the turn may write, like ["team", "memory/notes"]. Left out, every writable mount. The journal\'s directory is added when the journal is on a disk the turn writes.' },
      reads: { type: "array", items: STR, description: "With serializable isolation: the paths the turn's decisions depend on." },
      isolation: { type: "string", enum: ["snapshot", "serializable"], description: "snapshot (the default): the commit fails if a path the turn changed was changed by someone else. serializable also fails if anything under reads changed." },
      name: { ...STR, description: "A name for the turn. It names a branch and a checkpoint, so it has to be new." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (args) => beginTurn(args),
  },
  {
    name: "turn_changes",
    description: "What the open turn has written and deleted so far.",
    inputSchema: schema([], {}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: () => turnChanges(),
  },
  {
    name: "commit_turn",
    description:
      "Commit the open turn: apply everything it changed to the main line, or nothing. It is refused with a conflict if any path it changed was changed by someone else since it began; then begin a new turn and redo the work.",
    inputSchema: schema([], {}),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: () => commitTurn(),
  },
  {
    name: "rollback_turn",
    description: "Abandon the open turn. Nothing it did reached the main line, so there is nothing to undo.",
    inputSchema: schema([], {}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: () => rollbackTurn(),
  },
  {
    name: "append_log",
    description:
      "Append records to a log: JSON lines at <log>/<date>/<hour>/<writer>.ndjson, each given a ts and an id. Works on append, owned and shared mounts, and uses no compute.",
    inputSchema: schema(["log", "records"], {
      log: { ...STR, description: 'The log\'s path, like "audit/agent-7".' },
      records: { type: "array", items: { type: "object" }, description: "The records: JSON objects." },
      writer: { ...STR, description: "Names the file within a partition. One writer per source, so no two ever append to the same file." },
      partition: { type: "string", enum: ["hour", "day", "none"] },
      at: { ...STR, description: "The time to file records under when they carry no ts of their own. ISO 8601." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (args) => appendLog(args),
  },
  {
    name: "poll_feed",
    description:
      "What was added, changed or removed under a path since the reader holding this cursor last looked. A poll is a listing: it reads no data and makes no call. " +
      "The cursor does not move until ack_feed, so changes are handed over at least once.",
    inputSchema: schema(["path", "cursor"], {
      path: { ...STR, description: "The path to watch, like \"logs\"." },
      cursor: { ...STR, description: 'Where the cursor is kept: a file on a writable mount, like "notes/cursors/logs.json".' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => pollFeed(args),
  },
  {
    name: "ack_feed",
    description: "Mark the changes the last poll_feed returned for this cursor as handled, so the next poll starts after them.",
    inputSchema: schema(["cursor"], { cursor: STR }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (args) => ackFeed(args),
  },
  {
    name: "refresh_view",
    description:
      "Rebuild a derived file if its inputs or its statement changed, and do nothing if they did not. The check is a listing, so a refresh of a fresh view is free. " +
      "The statement is not stored on the disk: pass the same one each time.",
    inputSchema: schema(["path", "statement"], {
      path: { ...STR, description: 'Where the view\'s file lives, on a writable mount: "notes/reports/errors.json".' },
      statement: { type: "object", description: "The statement that builds it, in the shape run_statement takes. Its output goes to path.", additionalProperties: true },
      inputs: { type: "array", items: STR, description: "What the view depends on, when the statement's own parameters do not say: paths or globs." },
      force: { ...BOOL, description: "Rebuild even if it is fresh." },
      read: { ...BOOL, description: "Also return the view's content." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (args) => refreshView(args),
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** One tool call at a time: the tools share a context and a turn. */
let queue = Promise.resolve();

function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const run = async () => {
    try {
      const out = await tool.run(args ?? {});
      const text = typeof out === "string" ? out : out.text;
      const failed = typeof out === "string" ? false : out.failed;
      return { content: [{ type: "text", text: clip(text) }], isError: Boolean(failed) };
    } catch (error) {
      return { content: [{ type: "text", text: clip(describeError(error)) }], isError: true };
    }
  };
  const done = queue.then(run, run);
  queue = done.catch(() => undefined);
  return done;
}

// -- the protocol ------------------------------------------------------------------------

let legacy = false; // an `initialize` request selects the older era for the life of the process

function trace(direction, message) {
  const file = setting("SEAWAY_MCP_TRACE");
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${direction} ${JSON.stringify(message)}\n`);
  } catch {
    // tracing must never break the server
  }
}

function send(message) {
  trace(">", message);
  process.stdout.write(JSON.stringify(message) + "\n");
}

/**
 * The fields the newer revision asks of every result, left out for a client of the older one.
 * What a client may cache (the tool list, the answer to discover) holds nothing about the user and
 * does not change while this process lives; a minute keeps a restarted server from looking stale.
 */
function complete(result, cached = false) {
  if (legacy) return result;
  return cached ? { resultType: "complete", ...result, ttlMs: 60_000, cacheScope: "public" } : { resultType: "complete", ...result };
}

function publicTools() {
  return TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

async function handle(method, params) {
  if (method === "initialize") {
    legacy = true;
    const asked = params?.protocolVersion;
    return {
      protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    };
  }
  if (!legacy) {
    // Without a handshake, every request names the revision it is written in.
    const version = params?._meta?.[VERSION_KEY];
    if (typeof version !== "string") throw new RpcError(-32602, `Invalid params: _meta["${VERSION_KEY}"] is required`);
    if (!MODERN.includes(version)) {
      throw new RpcError(-32022, "Unsupported protocol version", { supported: MODERN, requested: version });
    }
  }
  switch (method) {
    case "server/discover":
      return complete(
        {
          supportedVersions: MODERN,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        },
        true,
      );
    case "ping":
      return complete({});
    case "tools/list":
      return complete({ tools: publicTools() }, true);
    case "tools/call": {
      if (typeof params?.name !== "string") throw new RpcError(-32602, "Invalid params: tools/call needs a name");
      return complete(await callTool(params.name, params.arguments));
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function receive(message) {
  if (message === null || typeof message !== "object" || typeof message.method !== "string") return; // a response, or noise
  const isRequest = message.id !== undefined && message.id !== null;
  if (!isRequest) return; // a notification: initialized, cancelled and the rest need no answer here
  try {
    send({ jsonrpc: "2.0", id: message.id, result: await handle(message.method, message.params) });
  } catch (error) {
    const rpc = error instanceof RpcError ? error : new RpcError(-32603, `Internal error: ${error?.message ?? error}`);
    const body = { code: rpc.code, message: rpc.message };
    if (rpc.data !== undefined) body.data = rpc.data;
    send({ jsonrpc: "2.0", id: message.id, error: body });
  }
}

function serve() {
  // stdout carries the protocol and nothing else
  console.log = (...parts) => console.error(...parts);
  console.info = console.log;
  console.debug = console.log;
  process.on("uncaughtException", (error) => console.error("seaway-context:", error));
  process.on("unhandledRejection", (error) => console.error("seaway-context:", error));
  process.stdout.on("error", () => process.exit(0)); // the client went away
  // What this process was started with, for a trace to begin from. The API key is never written, only whether there is one.
  trace("#", {
    node: process.version,
    cwd: process.cwd(),
    project: PROJECT_DIR,
    settings: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("SEAWAY_"))),
    archilKey: Boolean(process.env.ARCHIL_API_KEY),
  });

  let pending = 0;
  let closed = false;
  const finish = () => {
    if (closed && pending === 0) process.exit(0);
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    trace("<", message);
    for (const one of Array.isArray(message) ? message : [message]) {
      pending += 1;
      receive(one).finally(() => {
        pending -= 1;
        finish();
      });
    }
  });
  lines.on("close", () => {
    closed = true;
    finish();
  });
}

/** Run as a program, this serves; imported (by the tests), it only defines. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) serve();

export { TOOLS, INSTRUCTIONS, MODERN, LEGACY };
