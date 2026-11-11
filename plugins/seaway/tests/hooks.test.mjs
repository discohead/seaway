/**
 * The hooks, run the way Claude Code runs them: an event name, the event as JSON on stdin, and
 * whatever they print taken as the answer.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PLUGIN, scratch } from "./helpers.mjs";

const RUN = path.join(PLUGIN, "hooks", "run.sh");

/** Run one hook. Returns its parsed output (or null when it said nothing), and its exit status. */
function hook(event, input, env = {}) {
  const out = spawnSync(RUN, [event], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
  return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput : null;
}

/** A directory laid out like a seaway checkout, as far as the hooks look. */
function checkout() {
  const dir = scratch("checkout");
  for (const [file, text] of [
    ["python/src/seaway/__init__.py", ""],
    ["python/src/seaway/statement.py", "x = 1\n"],
    ["python/src/seaway/archil_backend.py", ""],
    ["python/examples/demo.py", ""],
    ["typescript/src/index.ts", ""],
    ["typescript/src/statement.ts", ""],
    ["typescript/src/compat.ts", ""],
    ["conformance/generate.py", ""],
    ["conformance/conformance.json", "{}"],
  ]) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

function userProject() {
  const dir = scratch("uses");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { seaway: "file:../seaway/typescript" } }));
  return dir;
}

// -- session-start ---------------------------------------------------------------------

test("session-start says nothing in a project that has nothing to do with seaway", () => {
  const dir = scratch("plain");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { express: "^5" } }));
  writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "app"\ndependencies = ["requests"]\n');
  assert.equal(hook("session-start", { cwd: dir, source: "startup" }, { ARCHIL_API_KEY: "key" }), null);
});

test("session-start in a checkout says which SDK is the reference", () => {
  const dir = checkout();
  const out = hook("session-start", { cwd: dir, source: "startup" });
  assert.equal(out.hookEventName, "SessionStart");
  assert.match(out.additionalContext, /^This is the seaway repository\. Python \(python\/src\/seaway\) is the reference SDK/);
  assert.match(out.additionalContext, /seaway:contributing/);
  assert.match(out.additionalContext, /No ARCHIL_API_KEY is set: contexts open on the local backend/);
  assert.ok(out.additionalContext.length < 2000);
});

test("session-start says when a context would act on the live account", () => {
  const dir = userProject();
  const live = hook("session-start", { cwd: dir }, { ARCHIL_API_KEY: "key-not-printed", ARCHIL_REGION: "aws-us-west-2" });
  assert.match(live.additionalContext, /^This project uses seaway \(package\.json dependencies\)\. Load the seaway:sdk skill/);
  assert.match(live.additionalContext, /acts on the live Archil account \(aws-us-west-2\) and bills per call/);
  assert.match(live.additionalContext, /ARCHIL_BACKEND=local/);
  assert.doesNotMatch(live.additionalContext, /key-not-printed/);
  const forced = hook("session-start", { cwd: dir }, { ARCHIL_API_KEY: "key", ARCHIL_BACKEND: "local" });
  assert.match(forced.additionalContext, /ARCHIL_BACKEND=local: contexts open on the local backend, although ARCHIL_API_KEY is set/);
});

test("session-start finds the project by the signs a seaway project leaves", () => {
  const byManifest = scratch("manifest");
  writeFileSync(path.join(byManifest, "agent.json"), JSON.stringify({ archilContext: 0, name: "a", mounts: {} }));
  assert.match(hook("session-start", { cwd: byManifest }).additionalContext, /agent\.json \(a context manifest\)/);
  const byPython = scratch("py");
  writeFileSync(path.join(byPython, "requirements.txt"), "requests\nseaway @ file:///src/seaway/python\n");
  assert.match(hook("session-start", { cwd: byPython }).additionalContext, /requirements\.txt/);
  const byRoot = scratch("root");
  mkdirSync(path.join(byRoot, ".archil-local"));
  assert.match(hook("session-start", { cwd: byRoot }).additionalContext, /\.archil-local\//);
  // CLAUDE_PROJECT_DIR is the project even when the session's directory is below it
  const below = path.join(byRoot, "src");
  mkdirSync(below);
  assert.match(hook("session-start", { cwd: below }, { CLAUDE_PROJECT_DIR: byRoot }).additionalContext, /This project uses seaway/);
});

test("session-start names the tools a statement would miss", () => {
  const dir = userProject();
  const bare = hook("session-start", { cwd: dir }, { PATH: path.dirname(process.execPath) + ":/bin:/usr/bin" });
  // /usr/bin has jq and sqlite3 on a Mac and may not elsewhere; duckdb is in neither
  assert.match(bare.additionalContext, /Not on the PATH: duckdb \(ctx\.sql cannot run on the local backend without it/);
});

// -- pre-bash ------------------------------------------------------------------------------

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("pre-bash asks before a run against the live account", () => {
  const env = { ARCHIL_API_KEY: "key", ARCHIL_REGION: "aws-us-west-2" };
  const out = hook("pre-bash", bash("cd python && python examples/datadog_afternoon.py --archil"), env);
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.permissionDecisionReason, /live Archil account \(aws-us-west-2\)/);
  assert.match(out.permissionDecisionReason, /Without --cleanup the disks it creates stay in the account\./);
  const cleaned = hook("pre-bash", bash("node examples/quickstart.ts --archil --cleanup"), env);
  assert.match(cleaned.permissionDecisionReason, /--cleanup deletes those disks when it ends\./);
  assert.equal(hook("pre-bash", bash("PYTHONPATH=src python3.12 examples/quickstart.py --archil 2>&1 | head"), env).permissionDecision, "ask");
});

test("pre-bash keeps out of everything else", () => {
  const env = { ARCHIL_API_KEY: "key" };
  for (const command of [
    "python examples/quickstart.py",
    "grep -rn -- --archil python/examples",
    "echo 'run it with --archil'",
    "python examples/quickstart.py --archilish",
    "git log --oneline",
  ]) {
    assert.equal(hook("pre-bash", bash(command), env), null, command);
  }
  // with no key the run fails by itself, having touched nothing
  assert.equal(hook("pre-bash", bash("python examples/quickstart.py --archil"), {}), null);
  // and the plugin's option turns the question off
  assert.equal(hook("pre-bash", bash("python examples/quickstart.py --archil"), { ...env, CLAUDE_PLUGIN_OPTION_CONFIRM_LIVE_RUNS: "false" }), null);
});

// -- pre-open ------------------------------------------------------------------------------

const open = (tool_input) => ({ tool_name: "mcp__plugin_seaway_context__open_context", tool_input });

test("pre-open asks before the MCP server opens a context on the live account", () => {
  const env = { ARCHIL_API_KEY: "key", ARCHIL_REGION: "aws-us-west-2" };
  const out = hook("pre-open", open({ backend: "archil", mounts: { notes: { disk: "my-notes", mode: "owned" } } }), env);
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.permissionDecisionReason, /live Archil account \(aws-us-west-2\)/);
  assert.match(out.permissionDecisionReason, /It creates no disks\.$/);
  const creating = hook("pre-open", open({ backend: "archil", create: true, mounts: { notes: { disk: "my-notes", mode: "owned" }, docs: "handbook" } }), env);
  assert.match(creating.permissionDecisionReason, /create any of these disks that do not exist: my-notes, handbook\.$/);
  const perMount = hook("pre-open", open({ backend: "archil", mounts: { notes: { disk: "my-notes", create: true } } }), env);
  assert.match(perMount.permissionDecisionReason, /create any of these disks/);
  const byManifest = hook("pre-open", open({ backend: "archil", create: true, manifest: "agent.json" }), env);
  assert.match(byManifest.permissionDecisionReason, /those the manifest names/);
  // the plugin's Backend option set to archil means a call that says nothing is live too
  assert.equal(hook("pre-open", open({ mounts: { a: "a" } }), { ...env, CLAUDE_PLUGIN_OPTION_BACKEND: "archil" }).permissionDecision, "ask");
});

test("pre-open keeps out of a local open, and can be turned off", () => {
  const env = { ARCHIL_API_KEY: "key" };
  assert.equal(hook("pre-open", open({ mounts: { a: "a" } }), env), null);
  assert.equal(hook("pre-open", open({ backend: "local", create: true, mounts: { a: "a" } }), env), null);
  assert.equal(hook("pre-open", open({ backend: "archil", mounts: { a: "a" } }), {}), null); // no key: the server refuses by itself
  assert.equal(hook("pre-open", open({ backend: "archil", mounts: { a: "a" } }), { ...env, CLAUDE_PLUGIN_OPTION_CONFIRM_LIVE_RUNS: "false" }), null);
  assert.equal(hook("pre-open", { tool_name: "x" }, env), null);
});

// -- post-edit ------------------------------------------------------------------------------

const edit = (file, extra = {}) => ({ session_id: "s-1", tool_name: "Edit", tool_input: { file_path: file }, ...extra });

test("post-edit lints code that uses seaway, once per finding", () => {
  const dir = scratch("app");
  const pad = scratch("pad");
  const file = path.join(dir, "agent.py");
  const head = 'import seaway as archil\nctx = archil.context({"docs": "handbook"})\n';
  writeFileSync(file, head + 'ctx.sh(f"cat docs/{name}").run()\n');
  const input = edit(file, { cwd: dir, scratchpad_dir: pad });

  const first = hook("post-edit", input);
  assert.equal(first.hookEventName, "PostToolUse");
  assert.match(first.additionalContext, /^seaway-lint, agent\.py:\n  line 3  warn  interpolated-command: /);
  assert.match(first.additionalContext, /A line that is meant can say `seaway-lint: ignore`\.$/);
  assert.equal(hook("post-edit", input), null); // the same finding is not repeated

  // the line moves and a second mistake arrives: only the new one is reported
  writeFileSync(file, head + "\n" + 'ctx.sh(f"cat docs/{name}").run()\nctx.sh("ls")\n');
  const second = hook("post-edit", input);
  assert.match(second.additionalContext, /line 5  warn  never-run/);
  assert.doesNotMatch(second.additionalContext, /interpolated-command/);

  // another session starts from nothing
  assert.match(hook("post-edit", { ...input, session_id: "s-2" }).additionalContext, /interpolated-command/);
  // and the option turns it off
  assert.equal(hook("post-edit", { ...input, session_id: "s-3" }, { CLAUDE_PLUGIN_OPTION_LINT_ON_EDIT: "false" }), null);
});

test("post-edit lists at most a handful and says where the rest are", () => {
  const dir = scratch("many");
  const file = path.join(dir, "many.ts");
  const lines = Array.from({ length: 9 }, (_, i) => `await ctx.sh(\`cat \${name${i}}\`);`);
  writeFileSync(file, 'import * as archil from "seaway";\n' + lines.join("\n") + "\n");
  const out = hook("post-edit", edit(file, { cwd: dir, scratchpad_dir: scratch("pad") }));
  assert.equal(out.additionalContext.match(/untagged-template/g).length, 6);
  assert.match(out.additionalContext, /… 3 more: seaway-lint many\.ts/);
});

test("post-edit says nothing about files that are not its business", () => {
  const dir = scratch("other");
  const pad = scratch("pad");
  const plain = path.join(dir, "plain.py");
  writeFileSync(plain, 'ctx.sh(f"cat {name}").run()\n'); // looks the part, but does not import seaway
  assert.equal(hook("post-edit", edit(plain, { cwd: dir, scratchpad_dir: pad })), null);
  const readme = path.join(dir, "README.md");
  writeFileSync(readme, "# hi\n");
  assert.equal(hook("post-edit", edit(readme, { cwd: dir, scratchpad_dir: pad })), null);
  assert.equal(hook("post-edit", edit(path.join(dir, "gone.py"), { cwd: dir, scratchpad_dir: pad })), null);
  assert.equal(hook("post-edit", { session_id: "s", tool_name: "NotebookEdit", tool_input: { notebook_path: "x.ipynb" } }), null);
});

test("post-edit in a checkout says what has to stay in step, once per file", () => {
  const dir = checkout();
  const pad = scratch("pad");
  const at = (rel) => edit(path.join(dir, rel), { cwd: dir, scratchpad_dir: pad });

  const py = hook("post-edit", at("python/src/seaway/statement.py"));
  assert.match(py.additionalContext, /^python\/src\/seaway\/statement\.py is the reference for typescript\/src\/statement\.ts\./);
  assert.match(py.additionalContext, /python conformance\/generate\.py/);
  assert.equal(hook("post-edit", at("python/src/seaway/statement.py")), null);

  assert.match(hook("post-edit", at("python/src/seaway/archil_backend.py")).additionalContext, /typescript\/src\/archil-backend\.ts/);
  assert.match(hook("post-edit", at("python/src/seaway/__init__.py")).additionalContext, /typescript\/src\/index\.ts/);
  assert.match(hook("post-edit", at("typescript/src/statement.ts")).additionalContext, /is a port of python\/src\/seaway\/statement\.py, which is the reference/);
  assert.match(hook("post-edit", at("typescript/src/compat.ts")).additionalContext, /reproduces what Python's built-ins do/);
  assert.match(hook("post-edit", at("conformance/conformance.json")).additionalContext, /^conformance\/conformance\.json is generated\./);
  assert.equal(hook("post-edit", at("python/examples/demo.py")), null);
  assert.equal(hook("post-edit", at("conformance/generate.py")), null);
});

// -- whatever happens, a hook stays out of the way ------------------------------------------------

test("a hook given nonsense says nothing and exits 0", () => {
  assert.equal(hook("post-edit", "not json at all"), null);
  assert.equal(hook("pre-bash", ""), null);
  assert.equal(hook("pre-bash", { tool_input: null }), null);
  assert.equal(hook("no-such-event", {}), null);
  assert.equal(hook("session-start", { cwd: "/definitely/not/a/directory" }), null);
});

test("hooks.json points every hook at the wrapper, by the plugin's root", () => {
  const { hooks } = JSON.parse(readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "PreToolUse", "PostToolUse"]);
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      for (const h of group.hooks) {
        assert.equal(h.type, "command");
        assert.match(h.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.sh" (session-start|pre-bash|pre-open|post-edit)$/);
      }
    }
  }
  assert.equal(hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(hooks.PreToolUse[0].hooks[0].if, "Bash(*--archil*)"); // so the hook is not even started for other commands
  assert.equal(hooks.PreToolUse[1].matcher, "mcp__plugin_seaway_context__open_context");
  assert.equal(hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
});
