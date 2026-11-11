/**
 * Every example in the skills is run.
 *
 * A fenced block marked `python` or `ts` in a skill's Markdown is an example: it has to run as
 * written against the SDK, given the context the sdk skill describes (`archil`, `ctx`, `backend`).
 * A block marked `py` or `typescript` is there to be read (a signature, a fragment, something not
 * to do) and is not run.
 *
 *     node --test plugins/seaway/tests/docs.test.mjs
 *     SEAWAY_DOCS_SHOW=1 node --test …         # also print what each example printed
 *
 * It needs the SDK beside the plugin, and duckdb and jq on the PATH. The Python half needs a
 * Python 3.10 or later: the one named by SEAWAY_PYTHON, or the first found by `seaway-doctor`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { NO_SDK, PLUGIN, SDK, has, scratch } from "./helpers.mjs";

// An example must never reach an account, whatever this shell's environment holds.
delete process.env.ARCHIL_API_KEY;
process.env.ARCHIL_BACKEND = "local";
process.env.ARCHIL_LOCAL_ROOT = scratch("unused-default-root");

const SHOW = Boolean(process.env.SEAWAY_DOCS_SHOW);
const TOOLS = has("duckdb") && has("jq") ? false : "the examples need duckdb and jq on the PATH";

// -- the examples -----------------------------------------------------------------

function* markdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdown(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

/** The fenced blocks of a Markdown file, with the language each names and the line it starts on. */
export function blocks(file) {
  const found = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^(\s*)(`{3,})\s*([\w-]*)\s*$/.exec(line);
    if (!open) {
      if (fence) open = { lang: fence[3], indent: fence[1].length, ticks: fence[2].length, line: i + 2, body: [] };
      return;
    }
    if (fence && !fence[3] && fence[2].length >= open.ticks) {
      found.push({ lang: open.lang, line: open.line, code: open.body.map((l) => l.slice(open.indent)).join("\n") });
      open = null;
    } else {
      open.body.push(line);
    }
  });
  return found;
}

const examples = [];
for (const file of markdown(path.join(PLUGIN, "skills"))) {
  for (const block of blocks(file)) {
    if (block.lang === "python" || block.lang === "ts") {
      examples.push({ ...block, id: `${path.relative(PLUGIN, file)}:${block.line}` });
    }
  }
}

// -- what the examples run against ------------------------------------------------------

const MINUTE = 60_000;

/** Records for the last three hours: two steady services, and one whose three errors are all in the last quarter of an hour. */
function records(now) {
  const at = (minutes) => new Date(now - minutes * MINUTE);
  const out = [];
  let n = 0;
  const add = (writer, minutes, fields) => {
    const when = at(minutes);
    const iso = when.toISOString();
    const record = { ts: iso, id: (++n).toString(16).padStart(12, "0"), ...fields };
    out.push({ file: `${iso.slice(0, 10)}/${iso.slice(11, 13)}/${writer}.ndjson`, record });
  };
  for (const m of [1, 3, 5, 8, 12, 20, 40, 65, 95, 130, 160]) add("api-a", m, { level: "INFO", service: "api", path: "/item", ms: 120, msg: "ok" });
  for (const m of [2, 6, 25, 70, 110, 150]) add("checkout-a", m, { level: "INFO", service: "checkout", path: "/cart", ms: 140, msg: "ok" });
  for (const m of [4, 9, 13]) add("checkout-a", m, { level: "ERROR", service: "checkout", path: "/pay", ms: 5000, msg: "payments-gateway pool exhausted in_use=64/64" });
  for (const m of [7, 33]) add("search-a", m, { level: "INFO", service: "search", path: "/search", ms: 90, msg: "ok" });
  return out;
}

/** A local root with the disks the sdk skill's examples name. */
export function seed(now = Date.now()) {
  const root = scratch("docs");
  const files = {
    "handbook/onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
    "handbook/expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
    "handbook/security/keys.md": "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
    "agent-memory/notes/eng-1.md": "Closed after the coupon fix.\n",
    "team-notes/standup.md": "- nothing yet\n",
    "team-notes/leads/emea.csv": "name,region\nAda,emea\nBo,emea\n",
    "team-notes/leads/amer.csv": "name,region\nCy,amer\nAda,emea\n",
  };
  const logs = new Map();
  for (const { file, record } of records(now)) {
    logs.set(file, (logs.get(file) ?? "") + JSON.stringify(record) + "\n");
  }
  for (const [file, text] of logs) files[`app-logs/${file}`] = text;
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, "disks", file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

function python() {
  const named = process.env.SEAWAY_PYTHON;
  const candidates = named ? [named] : ["python3", "python"];
  for (const candidate of candidates) {
    if (!named && process.platform === "darwin" && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) continue;
    const out = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    const m = /Python (\d+)\.(\d+)/.exec(`${out.stdout ?? ""}${out.stderr ?? ""}`);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return candidate;
  }
  return null;
}

// -- running them ---------------------------------------------------------------------------

test("the skills have examples in both languages", () => {
  assert.ok(examples.filter((e) => e.lang === "python").length >= 20);
  assert.ok(examples.filter((e) => e.lang === "ts").length >= 20);
});

test("a fence is read with its language and its indentation", () => {
  const file = path.join(scratch("md"), "a.md");
  writeFileSync(file, ["# t", "```python", "x = 1", "```", "1. item", "", "   ```ts", "   const a = 1;", "   ```", "```text", "not code", "```"].join("\n"));
  assert.deepEqual(blocks(file), [
    { lang: "python", line: 3, code: "x = 1" },
    { lang: "ts", line: 8, code: "const a = 1;" },
    { lang: "text", line: 11, code: "not code" },
  ]);
});

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

test("typescript examples run", { skip: NO_SDK || TOOLS }, async (t) => {
  const archil = await import(pathToFileURL(path.join(SDK, "src", "index.ts")).href);
  for (const example of examples.filter((e) => e.lang === "ts")) {
    await t.test(example.id, async () => {
      const backend = new archil.LocalBackend({ root: seed() });
      const ctx = await archil.context(
        {
          docs: archil.disk("handbook"),
          logs: archil.disk("app-logs", "append"),
          memory: archil.disk("agent-memory", "owned"),
          team: archil.disk("team-notes", "shared"),
        },
        { backend },
      );
      const printed = [];
      const log = (...parts) => printed.push(parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" "));
      // the import is the reader's; here the SDK is handed in
      const code = example.code.replace(/^\s*import\s+[^;\n]*\bfrom\s+["']seaway["'];?\s*$/gm, "");
      // an inner block, so an example may declare a `ctx` or a `backend` of its own
      const run = new AsyncFunction("__given", `let { archil, ctx, backend, console } = __given;\n{\n${code}\n}`);
      await run({ archil, ctx, backend, console: { log, error: log, warn: log, info: log } });
      if (SHOW) console.log(`--- ${example.id}\n${printed.join("\n")}`);
    });
  }
});

function inspect(value) {
  if (value instanceof Map) return `Map ${JSON.stringify([...value])}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const interpreter = python();

test("python examples run", { skip: NO_SDK || TOOLS || (interpreter ? false : "no Python 3.10 or later; name one with SEAWAY_PYTHON") }, async (t) => {
  const wanted = examples.filter((e) => e.lang === "python").map((e) => ({ id: e.id, code: e.code, root: seed() }));
  const sdk = path.resolve(SDK, "..", "python", "src");
  assert.ok(statSync(sdk).isDirectory(), `the Python SDK is expected beside the TypeScript one, at ${sdk}`);
  const out = spawnSync(interpreter, [path.join(PLUGIN, "tests", "docs_blocks.py")], {
    input: JSON.stringify({ sdk, blocks: wanted }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(out.status, 0, out.stderr);
  for (const result of JSON.parse(out.stdout)) {
    await t.test(result.id, () => {
      if (SHOW) console.log(`--- ${result.id}\n${result.stdout}`);
      assert.ok(result.ok, `${result.error}\n${result.stdout}`);
    });
  }
});
