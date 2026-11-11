#!/usr/bin/env node
/**
 * seaway-doctor: what this machine and this project would do with seaway.
 *
 *     seaway-doctor [--json] [directory]
 *
 * It answers the questions that otherwise get answered by a failed run: where would a context
 * act, is there a Python and a Node new enough, are the tools a statement leans on installed, and
 * what does the local backend really enforce here. It reads, and it runs `--version` on what it
 * finds. It contacts nothing and changes nothing, and it always exits 0.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { backend, isDir, isFile, node, project, which } from "./lib/detect.mjs";

function run(command, args, options = {}) {
  try {
    const out = spawnSync(command, args, { encoding: "utf8", timeout: 8000, ...options });
    if (out.error) return { ok: false, text: "" };
    return { ok: out.status === 0, text: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim() };
  } catch {
    return { ok: false, text: "" };
  }
}

/** Would running /usr/bin/python3 only raise the dialog that offers to install developer tools? */
function isMacStub(candidate) {
  if (process.platform !== "darwin" || candidate !== "/usr/bin/python3") return false;
  return !run("xcode-select", ["-p"]).ok;
}

function pythons(root, env) {
  const candidates = [
    env.VIRTUAL_ENV && path.join(env.VIRTUAL_ENV, "bin", "python"),
    path.join(root, ".venv", "bin", "python"),
    path.join(root, "venv", "bin", "python"),
    path.join(root, "python", ".venv", "bin", "python"),
    which("python3", env),
    which("python", env),
  ].filter((p) => p && isFile(p));
  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    let real = candidate;
    try {
      real = realpathSync(candidate);
    } catch {
      // keep the path as given
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (isMacStub(candidate)) {
      found.push({ path: candidate, version: null, ok: false, stub: true });
      continue;
    }
    const m = /Python (\d+)\.(\d+)(?:\.(\d+))?/.exec(run(candidate, ["--version"]).text);
    if (!m) continue;
    found.push({ path: candidate, version: `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ""}`, ok: Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10) });
  }
  return found;
}

function firstLine(text) {
  return text.split("\n").find((line) => line.trim() && !/agent mode/.test(line))?.trim() ?? "";
}

/** Everything the report says, as data. */
export async function examine(root = process.cwd(), env = process.env) {
  const report = { root, project: project(root), backend: backend(env) };

  const found = pythons(root, env);
  const python = found.find((p) => p.ok) ?? found[0] ?? null;
  report.python = python;
  if (python?.ok) {
    const sdk = run(python.path, ["-c", "import seaway; print(seaway.__version__)"], { cwd: root });
    report.python.seaway = sdk.ok ? sdk.text.split("\n").pop() : null;
    report.python.official = run(python.path, ["-c", "import archil"], { cwd: root }).ok;
  }

  report.node = { ...node(), path: process.execPath };
  try {
    const { findSdk } = await import("../servers/context-server.mjs");
    const sdk = findSdk(env, root);
    report.node.sdk = sdk.entry;
    if (sdk.entry) {
      const pkg = path.resolve(path.dirname(sdk.entry), "..");
      report.node.official = isDir(path.join(pkg, "node_modules", "disk")) || isDir(path.join(root, "node_modules", "disk"));
    }
  } catch {
    report.node.sdk = null;
  }

  report.tools = {};
  for (const [name, args] of [["duckdb", ["--version"]], ["jq", ["--version"]], ["sqlite3", ["--version"]], ["rg", ["--version"]]]) {
    const at = which(name, env);
    report.tools[name] = at ? { path: at, version: firstLine(run(at, args).text).slice(0, 60) } : null;
  }

  const forced = env.ARCHIL_LOCAL_ISOLATION ?? "";
  let isolation = "symlink";
  if (forced === "symlink" || forced === "namespace") isolation = forced;
  else if (process.platform === "linux" && which("unshare", env)) {
    isolation = run("unshare", ["--user", "--map-root-user", "--mount", "true"]).ok ? "namespace" : "symlink";
  }
  report.isolation = isolation;

  const local = path.resolve(root, env.ARCHIL_LOCAL_ROOT || ".archil-local");
  let disks = null;
  try {
    disks = readdirSync(path.join(local, "disks")).filter((name) => !name.startsWith(".")).length;
  } catch {
    // not created yet
  }
  report.local = { root: local, disks };
  return report;
}

export function render(r) {
  const rows = [];
  const row = (label, text) => rows.push(`${label.padEnd(10)} ${text}`);

  if (r.project.kind === "checkout") row("project", "a seaway checkout: python/ (the reference), typescript/, conformance/, interop/");
  else if (r.project.kind === "uses") row("project", `uses seaway: ${r.project.signs.join(", ")}`);
  else row("project", "no sign of seaway here (no dependency on it, no context manifest, no .archil-local)");

  const b = r.backend;
  if (b.live) {
    row(
      "backend",
      `LIVE by default. ARCHIL_API_KEY is set${b.region ? ` (region ${b.region})` : " (ARCHIL_REGION is not)"}: a context opened without a backend acts on the Archil account and bills per call. ARCHIL_BACKEND=local forces the local one.`,
    );
  } else if (b.forcedLocal) {
    row("backend", `local (ARCHIL_BACKEND=local${b.key ? ", although ARCHIL_API_KEY is set" : ""})`);
  } else {
    row("backend", "local: no ARCHIL_API_KEY is set, so contexts open on directories under the local root. Set ARCHIL_API_KEY and ARCHIL_REGION to reach Archil.");
  }

  const p = r.python;
  if (!p) row("python", "MISSING: no python3 on the PATH and no virtualenv in the project. The Python SDK needs 3.10 or later.");
  else if (p.stub) row("python", `MISSING: ${p.path} is the macOS placeholder that offers to install developer tools. The Python SDK needs a real Python, 3.10 or later.`);
  else if (!p.ok) row("python", `TOO OLD: ${p.version} at ${p.path}. The Python SDK needs 3.10 or later.`);
  else {
    const sdk = p.seaway
      ? `seaway ${p.seaway} imports`
      : r.project.kind === "checkout"
        ? "seaway does NOT import: pip install -e 'python[dev]', or run with PYTHONPATH=python/src"
        : "seaway does NOT import from this interpreter";
    const official = p.official ? "archil (the official SDK) is installed" : "archil (the official SDK) is not installed, and is needed only to reach Archil: pip install archil";
    row("python", `${p.version} at ${p.path}, ok. ${sdk}. ${official}.`);
  }

  const n = r.node;
  const nodeOk = n.ok ? "ok" : "TOO OLD: the TypeScript SDK and this plugin's MCP server need 22.19 or later";
  const sdk = n.sdk ? `TypeScript SDK at ${n.sdk}` : "TypeScript SDK NOT FOUND from here (the MCP server looks in the project and above it; or set the plugin's \"seaway checkout\" option)";
  const disk = n.sdk ? (n.official ? " disk (the official SDK) is installed." : " disk (the official SDK) is not installed, and is needed only to reach Archil: npm install.") : "";
  row("node", `${n.version}, ${nodeOk}. ${sdk}.${disk}`);

  const t = r.tools;
  row("duckdb", t.duckdb ? `${t.duckdb.version || "found"}, ok` : "MISSING: ctx.sql on the local backend runs the duckdb CLI from the PATH (pip install duckdb-cli, or brew install duckdb). On Archil it lives on a disk: archil.duckdb(ctx, \"<mount>/bin\").");
  row("jq", t.jq ? `${t.jq.version || "found"}, ok` : "MISSING: the examples and most statements over JSON lines use it. Archil's exec image has it.");
  row("sqlite3", t.sqlite3 ? `${t.sqlite3.version.split(" ")[0] || "found"}, ok (Archil's exec image has 3.37.2: json_extract but no ->>)` : "missing: only matters for state kept in a SQLite file");
  row("rg", t.rg ? "ok" : "not installed: search uses the SDK's own implementation, which gives the same answers");

  row(
    "isolation",
    r.isolation === "namespace"
      ? "namespace: each local call gets its own mounts, so a read-only mount is read-only and a denied network is cut"
      : "symlink: on the local backend a write to a read-only mount is reported after the command (exit 30) rather than refused, a network policy is not enforced, and find and du need -L to cross a mount. Archil enforces all three.",
  );
  row("local root", r.local.disks === null ? `${r.local.root} (not created yet)` : `${r.local.root} (${r.local.disks} disk${r.local.disks === 1 ? "" : "s"})`);
  return `seaway doctor: ${r.root}\n${rows.join("\n")}`;
}

async function main(argv) {
  const json = argv.includes("--json");
  const root = path.resolve(argv.find((a) => !a.startsWith("--")) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  try {
    const report = await examine(root);
    console.log(json ? JSON.stringify(report, null, 2) : render(report));
  } catch (error) {
    console.log(`seaway doctor could not finish: ${error?.message ?? error}`);
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  await main(process.argv.slice(2));
  process.exitCode = 0;
}
