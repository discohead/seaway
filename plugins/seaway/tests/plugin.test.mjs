/**
 * The plugin as a whole: what the manifests promise is there, every skill and agent is well formed,
 * and every link in the documentation leads somewhere.
 */

import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PLUGIN } from "./helpers.mjs";

const REPO = path.resolve(PLUGIN, "..", "..");
const read = (...parts) => readFileSync(path.join(PLUGIN, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

/** The front matter of a Markdown file as a flat map of its top-level keys, and the body after it. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { fields: null, body: text };
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { fields, body: text.slice(m[0].length) };
}

function* files(dir, keep = () => true) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "results" || entry.name === ".DS_Store") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full, keep);
    else if (keep(full)) yield full;
  }
}

const manifest = json(".claude-plugin", "plugin.json");
const skills = readdirSync(path.join(PLUGIN, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const agents = readdirSync(path.join(PLUGIN, "agents")).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort();

// -- manifests ------------------------------------------------------------------------

test("the manifest names the plugin and nothing it should not", () => {
  assert.equal(manifest.name, "seaway");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 60);
  assert.deepEqual(Object.keys(manifest.author), ["name"]); // no address is published with the plugin
  for (const key of Object.keys(manifest)) {
    assert.ok(["name", "displayName", "version", "description", "author", "repository", "keywords", "userConfig"].includes(key), key);
  }
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")}$`, "m"));
});

test("every option has a type, a title, a description and a default", () => {
  const options = manifest.userConfig;
  assert.deepEqual(Object.keys(options), ["sdk_path", "manifest", "backend", "max_usd", "confirm_live_runs", "lint_on_edit"]);
  for (const [key, option] of Object.entries(options)) {
    assert.match(key, /^[a-z][a-z0-9_]*$/);
    assert.ok(["string", "number", "boolean", "directory", "file"].includes(option.type), key);
    assert.ok(option.title && option.description.length > 30, key);
    assert.ok("default" in option, `${key}: an option with no default leaves the MCP server without a value`);
  }
  assert.equal(options.backend.default, "local"); // an account is never the default
  assert.equal(options.confirm_live_runs.default, true);
});

test("the MCP server's settings are the options, and its program is in the plugin", () => {
  const { mcpServers } = json(".mcp.json");
  assert.deepEqual(Object.keys(mcpServers), ["context"]);
  const server = mcpServers.context;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/servers/context-server.mjs"]);
  assert.ok(existsSync(path.join(PLUGIN, "servers", "context-server.mjs")));
  for (const value of Object.values(server.env)) {
    const m = /^\$\{user_config\.([a-z_]+)\}$/.exec(value);
    assert.ok(m && m[1] in manifest.userConfig, value);
  }
});

test("the marketplace at the root of the repository lists this plugin, with no version of its own", { skip: existsSync(path.join(REPO, ".claude-plugin", "marketplace.json")) ? false : "not inside the repository" }, () => {
  const market = JSON.parse(readFileSync(path.join(REPO, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(market.name, "seaway");
  const [entry] = market.plugins;
  assert.equal(entry.name, manifest.name);
  assert.equal(path.resolve(REPO, entry.source), PLUGIN);
  assert.equal("version" in entry, false); // plugin.json is the one place a version lives
});

test("what should run can be run", () => {
  for (const file of ["bin/seaway-lint", "bin/seaway-doctor", "hooks/run.sh"]) {
    accessSync(path.join(PLUGIN, file), constants.X_OK);
    assert.match(read(file), /^#!\/bin\/sh\n/, file);
  }
  for (const file of ["scripts/hook.mjs", "scripts/lint.mjs", "scripts/doctor.mjs", "servers/context-server.mjs"]) {
    assert.match(read(file), /^#!\/usr\/bin\/env node\n/, file);
  }
});

// -- skills and agents -----------------------------------------------------------------

test("the skills are the eleven the README lists", () => {
  assert.deepEqual(skills, ["contributing", "cost", "design", "doctor", "explain", "new", "open", "parity", "port", "review", "sdk"]);
  const readme = read("README.md");
  for (const name of skills) assert.ok(readme.includes(`seaway:${name}`), `the README does not mention seaway:${name}`);
});

for (const name of skills) {
  test(`skill ${name} is well formed`, () => {
    const text = read("skills", name, "SKILL.md");
    const { fields, body } = frontmatter(text);
    assert.ok(fields, "no front matter");
    assert.equal(fields.name, name);
    assert.ok(fields.description.length >= 80, "a description has to say what the skill does and when");
    // what the skill listing shows is cut at 1,536 characters
    assert.ok((fields.description + (fields.when_to_use ?? "")).length <= 1536);
    assert.ok(text.split("\n").length <= 500, "keep SKILL.md under 500 lines; the long form goes in references/");
    assert.doesNotMatch(body, /\bTODO\b/);
    const called = ["new", "explain", "doctor", "review", "port", "parity", "cost", "open"].includes(name);
    assert.equal(fields["disable-model-invocation"], called ? "true" : undefined, "skills you call are not offered to the model, and the others are");
    if (!called) assert.ok(fields.when_to_use, "a skill Claude uses by itself says when");
  });
}

test("a skill that injects a command's output is allowed to run it, and the plugin provides it", () => {
  let injections = 0;
  for (const name of skills) {
    const { fields, body } = frontmatter(read("skills", name, "SKILL.md"));
    for (const m of body.replace(/```[\s\S]*?```/g, "").matchAll(/(?:^|\s)!`([^`]+)`/g)) {
      injections++;
      const program = m[1].trim().split(/\s+/)[0];
      // without this the command needs approval when the skill loads, and the skill stops there
      assert.ok((fields["allowed-tools"] ?? "").includes(`Bash(${program}:*)`), `${name}: allowed-tools does not cover ${program}`);
      assert.ok(existsSync(path.join(PLUGIN, "bin", program)), `${name}: ${program} is not in the plugin's bin/`);
    }
  }
  assert.equal(injections, 3);
});

test("the agents are the four the README lists, each with a name and a description", () => {
  assert.deepEqual(agents, ["context-explorer", "cost-analyst", "reviewer", "sdk-porter"]);
  for (const name of agents) {
    const { fields, body } = frontmatter(read("agents", `${name}.md`));
    assert.equal(fields.name, name);
    assert.ok(fields.description.length >= 120, name);
    assert.ok(body.trim().length > 800, name);
    for (const key of Object.keys(fields)) {
      assert.ok(["name", "description", "tools", "disallowedTools", "color", "model"].includes(key), `${name}: ${key} is ignored or refused in a plugin's agent`);
    }
    assert.ok(read("README.md").includes(`seaway:${name}`));
  }
  // the agents that must not edit have no way to
  for (const name of ["reviewer", "cost-analyst"]) {
    assert.doesNotMatch(frontmatter(read("agents", `${name}.md`)).fields.tools, /\b(Edit|Write)\b/, name);
  }
  assert.match(frontmatter(read("agents", "context-explorer.md")).fields.disallowedTools, /Edit, Write.*write_file.*commit_turn/);
});

test("the MCP tools an agent or a skill names are tools the server has", async () => {
  const { TOOLS } = await import("../servers/context-server.mjs");
  const names = new Set(TOOLS.map((t) => t.name));
  for (const file of [...files(path.join(PLUGIN, "agents")), ...files(path.join(PLUGIN, "skills"))].filter((f) => f.endsWith(".md"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/mcp__plugin_seaway_context__([a-z_]+)/g)) {
      assert.ok(names.has(m[1]), `${path.relative(PLUGIN, file)} names ${m[1]}`);
    }
  }
  assert.equal(names.size, 16);
});

// -- links ---------------------------------------------------------------------------------

/** A heading as GitHub turns it into an anchor. */
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

function anchors(file) {
  const out = new Set();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

test("every link between the plugin's documents leads to a file, and to a heading in it", () => {
  const docs = [...files(PLUGIN, (f) => f.endsWith(".md") && !f.includes(`${path.sep}evals${path.sep}`))];
  assert.ok(docs.length >= 30);
  for (const file of docs) {
    const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue; // a URL
      const [rel, anchor] = target.split("#");
      const to = rel ? path.resolve(path.dirname(file), rel) : file;
      const where = `${path.relative(PLUGIN, file)} → ${target}`;
      assert.ok(existsSync(to), where);
      if (anchor && statSync(to).isFile()) assert.ok(anchors(to).has(anchor), `${where}: no such heading`);
    }
  }
});

test("a contents list at the top of a reference matches its headings", () => {
  for (const file of files(path.join(PLUGIN, "skills"), (f) => f.includes(`${path.sep}references${path.sep}`))) {
    const text = readFileSync(file, "utf8");
    const contents = /^## Contents\n\n((?:- .*\n)+)/m.exec(text);
    if (!contents) continue;
    const listed = [...contents[1].matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    const real = [...anchors(file)].filter((a) => a !== "contents");
    const top = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/^## (.*)$/gm)].map((m) => slug(m[1])).filter((a) => a !== "contents");
    assert.deepEqual(listed, top, path.relative(PLUGIN, file));
    for (const a of listed) assert.ok(real.includes(a));
  }
});

// -- evals ----------------------------------------------------------------------------------

test("every eval case has a prompt, a rubric, and a check that the skill was used", () => {
  const cases = readdirSync(path.join(PLUGIN, "evals"), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "results").map((e) => e.name);
  assert.equal(cases.length, 8);
  for (const name of cases) {
    const prompt = frontmatter(read("evals", name, "prompt.md"));
    assert.ok(prompt.fields.max_turns && prompt.fields.allowed_tools.includes("Skill"), name);
    assert.ok(prompt.body.trim().length > 150, name);
    const graders = readdirSync(path.join(PLUGIN, "evals", name, "graders"));
    assert.ok(graders.includes("criteria.md") && graders.includes("skill-fired.md"), name);
    for (const grader of graders) {
      const { fields, body } = frontmatter(read("evals", name, "graders", grader));
      assert.ok(["llm", "regex", "tool_used"].includes(fields.type), `${name}/${grader}`);
      if (fields.type === "llm") assert.match(body, /PASS only if[\s\S]*FAIL if/, `${name}/${grader}`);
      if (fields.type === "regex") new RegExp(fields.pattern.replace(/^'|'$/g, "").replaceAll("''", "'")); // it compiles
      if (fields.type === "tool_used") assert.equal(fields.arm, "with-only");
    }
  }
});
