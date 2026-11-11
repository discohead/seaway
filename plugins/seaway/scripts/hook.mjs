#!/usr/bin/env node
/**
 * The plugin's hooks. One program, three events:
 *
 *   session-start   in a project that uses seaway, say where a context would act and what is missing
 *   pre-bash        ask before a command that runs against the live Archil account (--archil)
 *   pre-open        ask before the plugin's MCP server opens a context on the live account
 *   post-edit       after an edit: lint code that uses seaway, and in a seaway checkout say what
 *                   has to stay in step with the file that changed
 *
 * A hook must never get in the way of the work. Whatever goes wrong here, it says nothing and
 * exits 0. In a project that has nothing to do with seaway it says nothing at all.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { backend, checkoutOf, node, project, twin, which } from "./lib/detect.mjs";
import { lintFile } from "./lint.mjs";
import { lineText } from "./lib/scan.mjs";

const MAX_FINDINGS = 6;

function emit(event, fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }) + "\n");
}

function off(name) {
  return ["0", "false", "no", "off"].includes(String(process.env[name] ?? "").toLowerCase());
}

// -- session-start ---------------------------------------------------------------------

export function sessionStartText(root, env = process.env, platform = process.platform) {
  const found = project(root);
  if (found.kind === "none") return "";
  const lines = [];
  if (found.kind === "checkout") {
    lines.push(
      "This is the seaway repository. Python (python/src/seaway) is the reference SDK and TypeScript (typescript/src) is a port of it. " +
        "A change in behaviour goes into the Python first; then conformance/conformance.json is regenerated (python conformance/generate.py) " +
        "and the TypeScript is brought back in step. The seaway:contributing skill has the rules, and /seaway:parity runs the whole check.",
    );
  } else {
    lines.push(`This project uses seaway (${found.signs.slice(0, 3).join(", ")}). Load the seaway:sdk skill before writing or changing code that uses it.`);
  }

  const b = backend(env);
  if (b.live) {
    lines.push(
      `ARCHIL_API_KEY is set, so a context opened without a backend acts on the live Archil account${b.region ? ` (${b.region})` : ""} and bills per call. ` +
        "For a local run, set ARCHIL_BACKEND=local or pass a LocalBackend. The examples' --archil flag is live as well.",
    );
  } else if (b.forcedLocal && b.key) {
    lines.push("ARCHIL_BACKEND=local: contexts open on the local backend, although ARCHIL_API_KEY is set.");
  } else {
    lines.push("No ARCHIL_API_KEY is set: contexts open on the local backend (directories under .archil-local, or ARCHIL_LOCAL_ROOT).");
  }

  const missing = [];
  if (!which("duckdb", env)) missing.push("duckdb (ctx.sql cannot run on the local backend without it: pip install duckdb-cli, or brew install duckdb)");
  if (!which("jq", env)) missing.push("jq (the examples and most statements over JSON lines use it)");
  if (!which("sqlite3", env)) missing.push("sqlite3 (state kept in a SQLite file)");
  if (missing.length) lines.push(`Not on the PATH: ${missing.join("; ")}.`);

  const n = node();
  if (!n.ok) lines.push(`Node is ${n.version}: the TypeScript SDK and this plugin's MCP server need 22.19 or later.`);
  if (platform !== "linux" || (env.ARCHIL_LOCAL_ISOLATION ?? "") === "symlink") {
    lines.push(
      "Here the local backend mounts by symlink: a write to a read-only mount is reported after the command (exit 30) rather than refused, " +
        "a network policy is not enforced, and find and du need -L to cross a mount.",
    );
  }
  return lines.join("\n");
}

function sessionStart(input) {
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const text = sessionStartText(root);
  if (text) emit("SessionStart", { additionalContext: text });
}

// -- pre-bash ----------------------------------------------------------------------------

const RUNS_LIVE = /\b(?:python[\d.]*|node|npm|npx|pnpm|yarn|uv|bun|deno|tsx|pytest)\b[^|;&\n]*\s--archil(?=$|[\s"';&|)])/;

/** The reason to ask before `command` runs, or "" when there is none. */
export function liveRunReason(command, env = process.env) {
  if (!RUNS_LIVE.test(command)) return "";
  if (!env.ARCHIL_API_KEY) return ""; // it will fail on its own, having touched nothing
  const cleanup = /(^|\s)--cleanup(?=$|[\s"';&|)])/.test(command);
  return (
    `--archil runs this against the live Archil account${env.ARCHIL_REGION ? ` (${env.ARCHIL_REGION})` : ""}: ` +
    "it creates disks under a prefix that is new for the run, and bills per call (an example costs a fraction of a cent). " +
    (cleanup ? "--cleanup deletes those disks when it ends." : "Without --cleanup the disks it creates stay in the account.")
  );
}

function preBash(input) {
  if (off("CLAUDE_PLUGIN_OPTION_CONFIRM_LIVE_RUNS")) return;
  const reason = liveRunReason(String(input.tool_input?.command ?? ""));
  if (reason) emit("PreToolUse", { permissionDecision: "ask", permissionDecisionReason: reason });
}

// -- pre-open ----------------------------------------------------------------------------

/** The reason to ask before the MCP server's open_context runs with this input, or "" when there is none. */
export function liveOpenReason(input, env = process.env) {
  const asked = input?.backend ?? (env.CLAUDE_PLUGIN_OPTION_BACKEND || "local");
  if (String(asked).toLowerCase() !== "archil") return "";
  if (!env.ARCHIL_API_KEY) return ""; // the server refuses by itself, having opened nothing
  const mounts = input?.mounts && typeof input.mounts === "object" ? Object.values(input.mounts) : [];
  const names = mounts.map((m) => (typeof m === "string" ? m : m?.disk)).filter(Boolean);
  const creating = input?.create === true || mounts.some((m) => m && typeof m === "object" && m.create === true);
  return (
    `This opens the context on the live Archil account${env.ARCHIL_REGION ? ` (${env.ARCHIL_REGION})` : ""}. ` +
    "From then on statements, checkpoints and commits bill per call, and writes change real disks. " +
    (creating ? `It would also create any of these disks that do not exist: ${names.join(", ") || "those the manifest names"}.` : "It creates no disks.")
  );
}

function preOpen(input) {
  if (off("CLAUDE_PLUGIN_OPTION_CONFIRM_LIVE_RUNS")) return;
  const reason = liveOpenReason(input.tool_input ?? {});
  if (reason) emit("PreToolUse", { permissionDecision: "ask", permissionDecisionReason: reason });
}

// -- post-edit ----------------------------------------------------------------------------

/** What has to stay in step with a file of the seaway repository, as [key, text], or null. */
export function parityNote(file) {
  const checkout = checkoutOf(file);
  if (!checkout) return null;
  const rel = path.relative(checkout, file).split(path.sep).join("/");
  if (rel === "conformance/conformance.json") {
    return [
      "generated",
      "conformance/conformance.json is generated. Change the Python SDK or conformance/generate.py and run `python conformance/generate.py`; " +
        "an edit made by hand is overwritten by the next run, and until then the two test suites replay something neither SDK produced.",
    ];
  }
  const t = twin(file);
  if (t?.side === "python") {
    return [
      `py:${rel}`,
      `${rel} is the reference for ${t.other}. If what it does changed, and not only how it is written: port the change, ` +
        "regenerate the fixture (python conformance/generate.py), and run both test suites and ./interop/run.sh. /seaway:parity does all of that.",
    ];
  }
  if (t?.side === "typescript") {
    return [
      `ts:${rel}`,
      t.other
        ? `${rel} is a port of ${t.other}, which is the reference. A change in behaviour belongs in the Python first; then regenerate the fixture ` +
          "(python conformance/generate.py) and make the TypeScript tests pass against it. /seaway:parity runs the whole check."
        : `${rel} is where the TypeScript SDK reproduces what Python's built-ins do without being asked (how strings sort, how a float prints, ` +
          "where a line ends). A difference from Python in a plan, a message or a file belongs here and nowhere else.",
    ];
  }
  return null;
}

function seenFile(input) {
  const session = String(input.session_id ?? "session").replace(/[^\w-]/g, "");
  let dir = os.tmpdir();
  try {
    if (input.scratchpad_dir && statSync(input.scratchpad_dir).isDirectory()) dir = input.scratchpad_dir;
  } catch {
    // no scratchpad: the temporary directory will do
  }
  return path.join(dir, `seaway-plugin-seen-${session}.json`);
}

function loadSeen(file) {
  try {
    return new Set(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(file, seen) {
  try {
    writeFileSync(file, JSON.stringify([...seen].slice(-800)));
  } catch {
    // if it cannot be remembered, the note is repeated; that is all
  }
}

/** What to tell Claude after an edit to `file`, given what this session was already told. */
export function postEditText(file, seen, cwd = process.cwd()) {
  const parts = [];
  const parity = parityNote(file);
  if (parity && !seen.has(parity[0])) {
    seen.add(parity[0]);
    parts.push(parity[1]);
  }
  const findings = lintFile(file);
  if (findings.length) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // gone again: nothing to key the findings on
    }
    const lines = text.split("\n");
    const fresh = findings.filter((f) => {
      const key = `${file}|${f.rule}|${(lines[f.line - 1] ?? lineText(text, 0)).trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length) {
      const shown = path.relative(cwd, file).startsWith("..") ? file : path.relative(cwd, file) || file;
      const body = fresh.slice(0, MAX_FINDINGS).map((f) => `  line ${f.line}  ${f.level}  ${f.rule}: ${f.message}`);
      if (fresh.length > MAX_FINDINGS) body.push(`  … ${fresh.length - MAX_FINDINGS} more: seaway-lint ${shown}`);
      parts.push(
        [`seaway-lint, ${shown}:`, ...body, "These are advice, not errors. A line that is meant can say `seaway-lint: ignore`."].join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

function postEdit(input) {
  const given = input.tool_input?.file_path;
  if (typeof given !== "string" || !given) return;
  const file = path.resolve(input.cwd ?? process.cwd(), given);
  const store = seenFile(input);
  const seen = loadSeen(store);
  const before = seen.size;
  const text = off("CLAUDE_PLUGIN_OPTION_LINT_ON_EDIT") ? "" : postEditText(file, seen, input.cwd ?? process.cwd());
  if (seen.size !== before) saveSeen(store, seen);
  if (text) emit("PostToolUse", { additionalContext: text });
}

// -- the program ----------------------------------------------------------------------------

const EVENTS = { "session-start": sessionStart, "pre-bash": preBash, "pre-open": preOpen, "post-edit": postEdit };

/** With SEAWAY_HOOK_TRACE naming a file, each firing leaves a line there: which event, and what the hook was given. */
function trace(event, input) {
  const file = process.env.SEAWAY_HOOK_TRACE;
  if (!file) return;
  try {
    const options = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("CLAUDE_PLUGIN_OPTION_")));
    const line = { at: new Date().toISOString(), event, tool: input?.tool_name ?? null, keys: Object.keys(input ?? {}), options };
    appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    // tracing must never get in the way either
  }
}

function main() {
  const run = EVENTS[process.argv[2]];
  if (!run) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // no input, or not JSON: carry on with what the environment says
  }
  trace(process.argv[2], input);
  run(input ?? {});
}

if (process.argv[1] && path.basename(process.argv[1]) === "hook.mjs") {
  try {
    main();
  } catch {
    // never in the way
  }
  process.exitCode = 0;
}
