/**
 * seaway-lint: what each rule catches, and what it leaves alone.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { LEVELS, lintText, usesSeaway } from "../scripts/lint.mjs";
import { scan } from "../scripts/lib/scan.mjs";
import { LINT, PLUGIN, scratch } from "./helpers.mjs";

const PY_HEAD = 'import seaway as archil\nctx = archil.context({"docs": "handbook"})\n';
const TS_HEAD = 'import * as archil from "seaway";\nconst ctx = await archil.context({ docs: "handbook" });\n';

/** The findings for a snippet, as "rule@line" with lines counted from the snippet's first. */
function py(body, options) {
  return lintText("x.py", PY_HEAD + body, options).map((f) => `${f.rule}@${f.line - 2}`);
}

function ts(body, options) {
  return lintText("x.ts", TS_HEAD + body, options).map((f) => `${f.rule}@${f.line - 2}`);
}

test("only files that import seaway are read", () => {
  assert.deepEqual(lintText("x.py", 'ctx.sh(f"cat {name}")\n'), []);
  assert.deepEqual(lintText("x.py", 'ctx.sh(f"cat {name}").run()\n', { all: true }).map((f) => f.rule), ["interpolated-command"]);
  assert.deepEqual(lintText("x.rb", PY_HEAD + 'ctx.sh(f"cat {name}")\n'), []);
  assert.equal(usesSeaway("from seaway import context, disk\n", "python"), true);
  assert.equal(usesSeaway("import seaway\n", "python"), true);
  assert.equal(usesSeaway("import seawayfarer\n", "python"), false);
  assert.equal(usesSeaway('const archil = require("seaway");', "js"), true);
  assert.equal(usesSeaway('import { context } from "seaway";', "js"), true);
  assert.equal(usesSeaway('import x from "./seaway.ts";', "js"), false);
});

test("every rule has a level and a message", () => {
  for (const finding of lintText("x.py", PY_HEAD + 'ctx.sh(f"cat {name}")\n')) {
    assert.ok(["warn", "note"].includes(finding.level));
    assert.ok(finding.message.length > 40);
  }
  assert.equal(Object.keys(LEVELS).length, 13);
});

// -- values in the command's text ----------------------------------------------------

test("python: a value pasted into a command", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh(f"cat docs/{name}").run()',
        'ctx.sh("cat docs/{}".format(name)).run()',
        'ctx.sh("cat docs/%s" % name).run()',
        'ctx.sh("cat docs/" + name).run()',
        'ctx.sql(f"""',
        "    select * from t where user = '{user}'",
        '""").run()',
        'ctx.sh("cat "',
        '       f"{name}").run()',
      ].join("\n"),
    ),
    ["interpolated-command@1", "interpolated-command@2", "interpolated-command@3", "interpolated-command@4", "interpolated-command@5", "interpolated-command@8"],
  );
});

test("python: what looks like pasting and is not", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh("cat {f}", f=ctx.path("docs/" + name)).run()',
        'ctx.sh("echo " + "x" * 300).run()',
        'ctx.sh(f"echo {{braces}} only").run()',
        "ctx.sh(\"awk '{print $1}' {f} | head -n {n}\", f=ctx.path(\"docs/a\"), n=3).run()",
        "ctx.sh(template, f=ctx.path(name)).run()",
        '# ctx.sh(f"cat {name}").run()',
        'note = "ctx.sh(f\\"cat {name}\\")"',
      ].join("\n"),
    ),
    [],
  );
});

test("typescript: a call with a template literal is not a tagged template", () => {
  assert.deepEqual(
    ts(
      [
        "await ctx.sh(`cat docs/${name}`);",
        'await ctx.sh("cat docs/" + name);',
        "await ctx.sql(`select * from t where user = '${user}'`).run();",
        "const out = await ctx.sh(`",
        "  rm -rf ${dir}",
        "`).run({ check: true });",
      ].join("\n"),
    ),
    ["untagged-template@1", "untagged-template@2", "untagged-template@3", "untagged-template@4"],
  );
  assert.deepEqual(
    ts(
      [
        'await ctx.sh`cat ${ctx.path("docs/" + name)}`;',
        'await ctx.sh("cat {f}", { f: ctx.path(`docs/${name}`) });',
        "await ctx.sh(`ls -la`);",
        'await ctx.sh("echo " + "x".repeat(300)).run();',
        "await ctx.sql`select * from ${ctx.glob(`logs/${day}/*.ndjson`)} where user = ${user}`;",
        "// await ctx.sh(`cat ${name}`);",
      ].join("\n"),
    ),
    [],
  );
});

// -- statements that never run ---------------------------------------------------------

test("python: a statement built and dropped", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh("rm -rf {d}", d=ctx.out("notes/tmp"))',
        'ctx.grep("needle", "docs")',
        "ctx.sh(",
        '    "ls {d}",',
        '    d=ctx.path("docs"),',
        ")",
        'ctx.sh("cat {f}", f=ctx.glob("docs/*.md")).map(reduce="count")  # and then nothing',
        "self.ctx.batch([a, b])",
      ].join("\n"),
    ),
    ["never-run@1", "never-run@2", "never-run@3", "never-run@7", "never-run@8"],
  );
  assert.deepEqual(
    py(
      [
        'stmt = ctx.sh("ls")',
        'ctx.sh("ls").run()',
        'ctx.sh("ls").run(check=True).text',
        'print(ctx.sh("ls").explain())',
        'rows = [ctx.sql("select 1"),',
        '        ctx.sql("select 2")]',
        'ctx.sh("ls {d}",',
        '       d=ctx.path("docs")).run()',
        "with pytest.raises(archil.ValidationError):",
        '    ctx.sh("echo hi").map()',
        'report = ctx.view("notes/r.json", lambda: ctx.sql("select 1"))',
        "def build():",
        '    return ctx.sh("ls")',
      ].join("\n"),
    ),
    [],
  );
});

test("typescript: a statement that is never awaited", () => {
  assert.deepEqual(
    ts(
      [
        'ctx.sh`rm -rf ${ctx.out("notes/tmp")}`;',
        'ctx.sh("ls");',
        'ctx.sh`cat ${ctx.glob("docs/*.md")}`',
        '  .map({ reduce: "count" });',
        "if (stale) {",
        '  ctx.grep("needle", "docs");',
        "}",
      ].join("\n"),
    ),
    ["never-run@1", "never-run@2", "never-run@3", "never-run@6"],
  );
  assert.deepEqual(
    ts(
      [
        "await ctx.sh`ls`;",
        "const s = ctx.sh`ls`;",
        "ctx.sh`ls`.run();",
        'ctx.sh`cat ${ctx.glob("docs/*.md")}`',
        '  .map({ reduce: "count" })',
        "  .run();",
        "const build = () =>",
        "  ctx.sql`select 1`;",
        'const view = ctx.view("notes/r.json", () => ctx.sql`select 1`);',
        "ctx.sh`ls`.then((r) => console.log(r.text));",
        "const all = [",
        "  ctx.sh`ls`,",
        "];",
        "assert.throws(() => ctx.sh`ls`.map());",
      ].join("\n"),
    ),
    [],
  );
});

test("typescript: a statement returned from an async function", () => {
  assert.deepEqual(
    ts(
      [
        "async function count(ctx) {",
        "  return ctx.sh`ls | wc -l`;",
        "}",
        "const f = async (ctx) => ctx.sql`select 1`;",
        "const g = async (ctx: archil.Context): Promise<unknown> => {",
        "  if (ready) {",
        "    return ctx.sql`select 1`;",
        "  }",
        "  return (await ctx.sql`select 1`).rows;",
        "};",
        "class Agent {",
        '  async report() { return this.ctx.sh("ls"); }',
        "}",
      ].join("\n"),
    ),
    ["returned-statement@2", "returned-statement@4", "returned-statement@7", "returned-statement@12"],
  );
  assert.deepEqual(
    ts(
      [
        "function build(ctx) {",
        "  return ctx.sh`ls | wc -l`;",
        "}",
        "async function run(ctx) { return ctx.sh`ls`.run(); }",
        "async function plan(ctx) { return ctx.sh`ls`.explain(); }",
        "async function wrapped(ctx) { return { statement: ctx.sh`ls` }; }",
        "class Agent {",
        "  report() { return this.ctx.sh`ls`; }",
        "}",
        "const view = () => ctx.sql`select 1`;",
      ].join("\n"),
    ),
    [],
  );
});

// -- turns --------------------------------------------------------------------------------

test("a write through the outer context inside a turn", () => {
  assert.deepEqual(
    py(
      [
        "with ctx.transaction() as turn:",
        '    turn.write("notes/a.md", "x")',
        '    ctx.write("notes/b.md", "y")',
        '    print(ctx.ls("notes"))',
        '    ctx.sh("touch {f}", f=turn.out("notes/c")).run()',
        '    if ctx.exists("notes/d"):',
        '        ctx.rm("notes/d")',
        'ctx.write("notes/after.md", "z")',
        'with ctx.transaction(writes=["notes"]) as ctx2:',
        '    ctx2.write("notes/e.md", "fine")',
      ].join("\n"),
    ),
    ["turn-bypass@3", "turn-bypass@5", "turn-bypass@7"],
  );
  assert.deepEqual(
    ts(
      [
        "await ctx.transaction(async (turn) => {",
        '  await turn.write("notes/a.md", "x");',
        '  await ctx.write("notes/b.md", "y");',
        '  console.log(await ctx.ls("notes"));',
        '  await ctx.sh`touch ${turn.out("notes/c")}`;',
        "});",
        'await ctx.write("notes/after.md", "z");',
        'await ctx.transaction(async (turn: archil.Context) => { await ctx.rm("notes/x"); }, { writes: ["notes"] });',
        'await ctx.transaction(async (turn) => { await turn.sh`ls`; });',
      ].join("\n"),
    ),
    ["turn-bypass@3", "turn-bypass@5", "turn-bypass@8"],
  );
  const [finding] = lintText("x.py", PY_HEAD + 'with ctx.transaction() as turn:\n    ctx.write("a/b", "x")\n');
  assert.match(finding.message, /Use the turn's own context: turn\.write\(…\)\.$/);
});

test("a write inside a turn to a mount its writes does not name", () => {
  assert.deepEqual(
    py(
      [
        'with ctx.transaction(writes=["team"]) as turn:',
        '    turn.write("team/standup.md", "x")',
        '    turn.write("memory/eng-1.md", "y")',
        '    turn.sh("date > {f}", f=turn.out("memory/when.txt")).run()',
        '    turn.append("audit/log.txt", "z")',
        '    print(turn.read_text("docs/a.md"))',
        'with ctx.transaction(writes=["team/notes", "memory"]) as turn:',
        '    turn.write("memory/eng-1.md", "fine")',
        '    turn.rm("scratch/tmp")',
        "with ctx.transaction() as turn:",
        '    turn.write("memory/eng-1.md", "fine: every writable mount is in the turn")',
        "with ctx.transaction(writes=paths) as turn:",
        '    turn.write("memory/eng-1.md", "not ours to judge")',
        'with ctx.transaction(writes=["team"]) as turn:',
        '    turn.write(f"{mount}/x.md", "a name built from a value")',
      ].join("\n"),
    ),
    ["turn-undeclared-mount@3", "turn-undeclared-mount@4", "turn-undeclared-mount@9"],
  );
  assert.deepEqual(
    ts(
      [
        "await ctx.transaction(async (turn) => {",
        '  await turn.write("team/standup.md", "x");',
        '  await turn.write("memory/eng-1.md", "y");',
        '  await turn.sh`date > ${turn.out("memory/when.txt")}`;',
        '}, { writes: ["team"] });',
        "await ctx.transaction(",
        "  async (turn) => {",
        '    await turn.write("memory/eng-1.md", "fine");',
        "  },",
        '  { writes: ["team", "memory"], isolation: "snapshot" },',
        ");",
        'await ctx.transaction(async (turn) => { await turn.write("memory/x.md", "fine"); });',
      ].join("\n"),
    ),
    ["turn-undeclared-mount@3", "turn-undeclared-mount@4"], // the second is inside a tagged template's ${ }
  );
  const [finding] = lintText("x.py", PY_HEAD + 'with ctx.transaction(writes=["team"]) as turn:\n    turn.write("memory/a", "x")\n');
  assert.match(finding.message, /lands on the main line at once.*\(`writes` names team; this is on memory\.\)$/);
});

// -- the notes -----------------------------------------------------------------------------

test("a path written into SQL", () => {
  assert.deepEqual(
    py(
      [
        "ctx.sql(\"select count(*) from read_json_auto('logs/api/**/*.ndjson')\").run()",
        "ctx.sql(\"select * from 'logs/a.parquet'\").run()",
        "ctx.sql(\"select * from read_parquet(['a.parquet', 'b.parquet'])\").run()",
        'ctx.sql("select count(*) from {events} where level = \'ERROR\'", events=ctx.glob("logs/**/*.ndjson")).run()',
      ].join("\n"),
    ),
    ["sql-literal-path@1", "sql-literal-path@2", "sql-literal-path@3"],
  );
  assert.deepEqual(
    ts(
      [
        "await ctx.sql`select count(*) from read_json_auto('logs/api/**/*.ndjson')`;",
        'await ctx.sql`select count(*) from ${ctx.glob("logs/**/*.ndjson")} where level = ${"ERROR"}`;',
      ].join("\n"),
    ),
    ["sql-literal-path@1"],
  );
});

test("an out parameter in sql, which cannot be compiled", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sql("copy (select 1) to {dst} (format csv)", dst=ctx.out("memory/o.csv")).run()',
        'ctx.sql("select count(*) from {t}", t=ctx.glob("logs/**/*.ndjson")).into("memory/n.json").run()',
        'ctx.sql("select count(*) from {t}", t=ctx.path("logs")).into(ctx.out("memory/n.json")).run()',
        'ctx.sh("sort {src} > {dst}", src=ctx.path("docs/a.md"), dst=ctx.out("memory/a.md")).run()',
        "ctx.sql(",
        '    "copy (select * from {t}) to {dst}",',
        '    t=ctx.path("logs"),',
        '    dst=turn.out("memory/all.parquet"),',
        ").run()",
      ].join("\n"),
    ),
    ["sql-out-parameter@1", "sql-out-parameter@8"],
  );
  assert.deepEqual(
    ts(
      [
        'await ctx.sql`copy (select 1) to ${ctx.out("memory/o.csv")} (format csv)`;',
        'await ctx.sql("copy (select 1) to {dst}", { dst: ctx.out("memory/o.csv") });',
        'await ctx.sql`select count(*) from ${ctx.glob("logs/**/*.ndjson")}`.into("memory/n.json");',
        'await ctx.sh`sort ${ctx.path("docs/a.md")} > ${ctx.out("memory/a.md")}`;',
        'await ctx.sql`select ${"a string that says .out( and is only text"} as s`;',
      ].join("\n"),
    ),
    ["sql-out-parameter@1", "sql-out-parameter@2"],
  );
});

test("a glob inside a list, where it is not expanded", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh("cat {fs}", fs=[ctx.glob("docs/*.md"), ctx.path("docs/security/keys.md")]).run()',
        'ctx.sh("cat {fs}", fs=[ctx.path("docs/a.md"), ctx.path("docs/b.md")]).run()',
        'ctx.sh("cat {a} {b}", a=ctx.glob("docs/*.md"), b=ctx.glob("team/*.md")).run()',
        'ctx.sh("cat {fs}", fs=[ctx.glob(p) for p in patterns]).run()',
        'ctx.batch([ctx.sh("cat {f}", f=ctx.glob("docs/*.md")), ctx.sh("ls {d}", d=ctx.path("docs"))]).run()',
        'globs = [ctx.glob("docs/*.md"), ctx.glob("team/*.md")]',
        'ctx.sh("cat {fs}", fs=[join(ctx.glob("docs/*.md"))]).run()',
        'ctx.sql("select * from {t}", t=[ctx.glob("logs/**/*.ndjson")]).run()',
      ].join("\n"),
    ),
    ["glob-in-list@1", "glob-in-list@4", "glob-in-list@8"],
  );
  assert.deepEqual(
    ts(
      [
        'await ctx.sh`cat ${[ctx.glob("docs/*.md"), ctx.path("docs/a.md")]}`;',
        'await ctx.sh("cat {fs}", { fs: [ctx.glob("docs/*.md")] });',
        'await ctx.sh`cat ${ctx.glob("docs/*.md")} ${ctx.glob("team/*.md")}`;',
        'await ctx.sh("cat {f}", { f: ctx.glob("docs/*.md") });',
        'await ctx.batch([ctx.sh`cat ${ctx.glob("docs/*.md")}`, ctx.sh`ls ${ctx.path("docs")}`]);',
        'await ctx.sh`cat ${[ctx.path("docs/a.md"), ctx.path("docs/b.md")]}`;',
      ].join("\n"),
    ),
    ["glob-in-list@1", "glob-in-list@2"],
  );
});

test("raw() given something other than a constant", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh("cat {f} {flags}", f=ctx.path("docs/a.md"), flags=archil.raw("| wc -l")).run()',
        'ctx.sh("cat {f} {flags}", f=ctx.path("docs/a.md"), flags=archil.raw(user_flags)).run()',
        'ctx.sh("cat {f} {flags}", f=ctx.path("docs/a.md"), flags=archil.Raw(f"| head -n {n}")).run()',
      ].join("\n"),
    ),
    ["raw-fragment@2", "raw-fragment@3"],
  );
  assert.deepEqual(
    lintText("x.ts", 'import { context, raw } from "seaway";\nconst a = raw("| wc -l");\nconst b = raw(flags);\nconst c = String.raw`x`;\n').map((f) => `${f.rule}@${f.line}`),
    ["raw-fragment@3"],
  );
});

test("tools on their way to a model with no network policy", () => {
  assert.deepEqual(py("tools = [t.to_anthropic() for t in ctx.tools()]"), ["tools-without-egress@1"]);
  assert.deepEqual(py('tools = [t.to_anthropic() for t in ctx.with_egress("deny").tools()]'), []);
  assert.deepEqual(py("print([t.name for t in ctx.tools()])"), []);
  assert.deepEqual(ts("const tools = ctx.tools().map((t) => t.toOpenAI());"), ["tools-without-egress@1"]);
  assert.deepEqual(ts("const fs = archil.asFileSystem(ctx);"), ["tools-without-egress@1"]);
  assert.deepEqual(ts('const tools = ctx.withEgress("deny").tools().map((t) => t.toAnthropic());'), []);
});

test("a sqlite read that takes no checkout, and a path only Archil has", () => {
  assert.deepEqual(
    py(
      [
        'rows = ctx.sh("sqlite3 -readonly -json {db} {q}", db=ctx.path("memory/state.db"), q="select 1").run().json()',
        'rows = ctx.sh("sqlite3 -readonly -json {db} {q}", db=ctx.out("memory/state.db"), q="select 1").run().json()',
        'ctx.sh("sqlite3 {db} {q}", db=ctx.out("memory/state.db"), q="insert into t values (1)").run()',
        'ctx.sh("cat /mnt/archil/docs/a.md").run()',
      ].join("\n"),
    ),
    ["sqlite-unlocked-read@1", "absolute-mount-path@4"],
  );
  assert.deepEqual(
    ts(
      [
        'await ctx.sh`sqlite3 -readonly -json ${ctx.path("memory/state.db")} ${"select 1"}`;',
        'await ctx.sh`sqlite3 -readonly -json ${ctx.out("memory/state.db")} ${"select 1"}`;',
        "await ctx.sql`select * from read_json_auto('/mnt/archil/logs/*.ndjson')`;",
      ].join("\n"),
    ),
    ["sqlite-unlocked-read@1", "absolute-mount-path@3", "sql-literal-path@3"],
  );
});

test("a line can say it is meant", () => {
  assert.deepEqual(
    py(
      [
        'ctx.sh(f"cat docs/{name}").run()  # seaway-lint: ignore',
        'ctx.sh(f"cat docs/{name}").run()  # seaway-lint: ignore interpolated-command',
        'ctx.sh(f"cat docs/{name}").run()  # seaway-lint: ignore never-run',
      ].join("\n"),
    ),
    ["interpolated-command@3"],
  );
  assert.deepEqual(ts("await ctx.sh(`cat ${name}`); // seaway-lint: ignore"), []);
});

// -- the reader underneath --------------------------------------------------------------------

test("strings and comments are blanked, and nothing moves", () => {
  for (const [lang, text] of [
    ["python", 'a = f"x{y}(" # ) not code\nb = \'\'\'multi\n(line\'\'\' + rb"\\"q"\n'],
    ["js", "const a = `x${f(`inner ${g(\"(\")}`)}(`; // ) not code\nconst re = /[`\"']\\//g; const b = 'it\\'s (';\n/* ( */ call(a);\n"],
  ]) {
    const { masked, strings } = scan(text, lang);
    assert.equal(masked.length, text.length);
    assert.deepEqual([...masked].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0), [...text].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0));
    const brackets = masked.replace(/[^()]/g, "");
    assert.equal(brackets, lang === "python" ? "" : "()", `${lang}: ${JSON.stringify(masked)}`);
    // python: three literals. js: the template (what is nested in it is part of it) and the quoted string.
    assert.equal(strings.length, lang === "python" ? 3 : 2);
  }
  const { strings } = scan('x = f"a{b}" + "c" + f"{{d}}"\n', "python");
  assert.deepEqual(strings.map((s) => [s.prefix, s.interpolated]), [["f", true], ["", false], ["f", false]]);
  const js = scan("const a = `one ${two} three`; const b = `plain`;", "js");
  assert.deepEqual(js.strings.map((s) => [s.template, s.interpolated]), [[true, true], [true, false]]);
  // two views of a template: opaque, and with the code in its ${ } kept
  const tagged = "ctx.sh`cat ${turn.out(\"a/b\")} > ${f(`x${y}`)}`;";
  const both = scan(tagged, "js");
  assert.equal(both.masked, "ctx.sh`" + " ".repeat(tagged.length - 9) + "`;");
  assert.equal(both.code, 'ctx.sh`      turn.out("   ")      f(`   y `) `;');
  assert.deepEqual([both.strings.length, both.nested.length], [1, 3]);
});

// -- the command -------------------------------------------------------------------------------

test("the command reads directories, prints findings and exits 1 on a warn", () => {
  const dir = scratch("lint");
  mkdirSync(path.join(dir, "src", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(dir, "src", "bad.py"), PY_HEAD + 'ctx.sh(f"cat {name}").run()\n');
  writeFileSync(path.join(dir, "src", "noted.ts"), TS_HEAD + "await ctx.sql`select * from read_csv_auto('a.csv')`;\n");
  writeFileSync(path.join(dir, "src", "other.py"), 'ctx.sh(f"cat {name}").run()\n');
  writeFileSync(path.join(dir, "src", "node_modules", "dep", "x.ts"), TS_HEAD + "ctx.sh(`cat ${name}`);\n");

  const run = (...args) => spawnSync(process.execPath, [LINT, ...args], { encoding: "utf8" });
  const bad = run(path.join(dir, "src"));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /bad\.py:3  warn  interpolated-command  /);
  assert.match(bad.stdout, /noted\.ts:3  note  sql-literal-path  /);
  assert.match(bad.stdout, /seaway-lint: 3 file\(s\) read, 1 warn, 1 note/);
  assert.doesNotMatch(bad.stdout, /node_modules|other\.py:/);

  const noted = run(path.join(dir, "src", "noted.ts"));
  assert.equal(noted.status, 0);
  const json = JSON.parse(run("--json", "--all", path.join(dir, "src")).stdout);
  assert.equal(json.files, 3);
  assert.deepEqual(json.findings.map((f) => path.basename(f.file)).sort(), ["bad.py", "noted.ts", "other.py"]);
  assert.equal(run().status, 2);
});

test("the wrapper on the PATH runs the same command", { skip: existsSync(path.join(PLUGIN, "bin", "seaway-lint")) ? false : "bin/seaway-lint is not there" }, () => {
  const out = spawnSync(path.join(PLUGIN, "bin", "seaway-lint"), ["--help"], { encoding: "utf8" });
  assert.match(out.stdout, /usage: seaway-lint/);
});
