/**
 * The scaffolds `/seaway:new` starts from run as they are, on a local backend, in both languages.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { NO_SDK, PLUGIN, SDK, scratch } from "./helpers.mjs";

const TEMPLATES = path.join(PLUGIN, "templates");

function fill(text, values) {
  return text.replace(/__([A-Z]+)__/g, (whole, key) => values[key] ?? whole);
}

/** An environment in which nothing can reach an account. */
const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ARCHIL_BACKEND: "local", ...extra });

function python() {
  const named = process.env.SEAWAY_PYTHON;
  for (const candidate of named ? [named] : ["python3", "python"]) {
    if (!named && process.platform === "darwin" && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) continue;
    const out = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    const m = /Python (\d+)\.(\d+)/.exec(`${out.stdout ?? ""}${out.stderr ?? ""}`);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return candidate;
  }
  return null;
}

/** A run prints its context, a plan that mounts one hour of one disk, and the counts after `runs` runs. */
function expectRun(out, runs = 1) {
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /context "demo-app" on local/);
  assert.match(out.stdout, /data\/ +append +demo-app-data +records, appended as they arrive/);
  assert.match(out.stdout, /Commands run with egress denied\./);
  assert.match(out.stdout, /scope   data\/events\/\d{4}-\d\d-\d\d\/\d\d → demo-app-data:\/events\/\d{4}-\d\d-\d\d\/\d\d \(read-only\)/);
  assert.match(out.stdout, /not mounted: work/);
  assert.match(out.stdout, new RegExp(`${runs} "kind":"cancel"\\n\\s+${2 * runs} "kind":"signup"`));
  assert.match(out.stdout, /the report is fresh: [Tt]rue/);
  assert.match(out.stdout, /statement\(s\): \d+ call unit\(s\)/);
}

test("no placeholder is left unfilled, and the three files agree on the context", () => {
  const values = { NAME: "demo-app", SUMMARY: "Counts events.", RUN: "python app.py", RUNTIME: "Python 3.10 or later" };
  for (const file of ["python/app.py", "typescript/app.ts", "README.md"]) {
    const text = fill(readFileSync(path.join(TEMPLATES, file), "utf8"), values);
    assert.doesNotMatch(text, /__[A-Z]+__/, file);
    assert.match(text, /append/);
    assert.match(text, /work\/journal/);
  }
  assert.deepEqual(readdirSync(TEMPLATES).sort(), ["README.md", "python", "typescript"]);
});

const interpreter = python();

test("the python scaffold runs", { skip: NO_SDK || (interpreter ? false : "no Python 3.10 or later; name one with SEAWAY_PYTHON") }, () => {
  const dir = scratch("py-app");
  writeFileSync(path.join(dir, "app.py"), fill(readFileSync(path.join(TEMPLATES, "python", "app.py"), "utf8"), { NAME: "demo-app", SUMMARY: "Counts events." }));
  const run = () => spawnSync(interpreter, ["app.py"], { cwd: dir, encoding: "utf8", env: env({ PYTHONPATH: path.resolve(SDK, "..", "python", "src"), PYTHONDONTWRITEBYTECODE: "1" }) });
  expectRun(run());
  assert.ok(existsSync(path.join(dir, ".archil-local", "disks", "demo-app-work", "notes", "last-run.md")));
  expectRun(run(), 2); // and again, on the disks the first run left: a log only grows
});

test("the typescript scaffold runs", { skip: NO_SDK }, () => {
  const dir = scratch("ts-app");
  writeFileSync(path.join(dir, "app.ts"), fill(readFileSync(path.join(TEMPLATES, "typescript", "app.ts"), "utf8"), { NAME: "demo-app", SUMMARY: "Counts events." }));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo-app", private: true, type: "module" }));
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(SDK, path.join(dir, "node_modules", "seaway"), "dir"); // what `npm install <checkout>/typescript` leaves
  const run = () => spawnSync(process.execPath, ["app.ts"], { cwd: dir, encoding: "utf8", env: env() });
  expectRun(run());
  assert.ok(existsSync(path.join(dir, ".archil-local", "disks", "demo-app-work", "notes", "last-run.md")));
  expectRun(run(), 2);
});
