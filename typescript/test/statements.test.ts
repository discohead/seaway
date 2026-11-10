/** Statements: prepared parameters, scope, fan-out, grep, sql, batch, budgets. */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as archil from "../src/index.ts";
import { FileStat } from "../src/shell.ts";
import { makeShards } from "../src/statement.ts";
import { needsDuckdb, newBackend, seeded, thrown } from "./helpers.ts";

function close(got: number, want: number): void {
  assert.ok(Math.abs(got - want) <= 1e-12 + 1e-6 * Math.abs(want), `${got} is not ${want}`);
}

test("values are quoted so they cannot become shell", async () => {
  const { ctx, backend } = await seeded();
  const hostile = "x'; touch work/owned; echo '";
  const result = await ctx.sh("printf '%s' {v}", { v: hostile }).run();
  assert.equal(result.text, hostile);
  assert.ok(!(await ctx.exists("work/owned")));
  // the parameter never reached the shell as code: one exec, and the value arrived intact
  assert.equal(backend.execLog.length, 1);
});

test("a parameter that is not in the command is an error", async () => {
  const { ctx } = await seeded();
  const error = await thrown(ctx.sh("cat {file}", { flie: ctx.path("ref/docs/a.md") }).explain());
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "unused_parameter");
});

test("declared paths decide what is mounted", async () => {
  const { ctx } = await seeded();
  let plan = await ctx.sh("cat {f}", { f: ctx.path("ref/docs/a.md") }).explain();
  const mounts = plan.tasks[0].mounts;
  assert.deepEqual(Object.keys(mounts), ["ref/docs"]);
  assert.ok(mounts["ref/docs"].readOnly);
  assert.deepEqual(plan.unmounted, ["logs", "work", "team"]);
  assert.equal(plan.estimate.calls, 1);
  assert.equal(plan.estimate.bytesTouched, Buffer.byteLength("alpha\nneedle one\n"));

  plan = await ctx.sh("ls").explain();
  assert.equal(Object.keys(plan.tasks[0].mounts).length, 4);
  assert.ok(plan.notes.some((note) => note.includes("no paths declared")));
  assert.ok(!plan.estimate.complete);
});

test("read only mounts are enforced", async () => {
  const { ctx, backend } = await seeded();
  const result = await ctx.sh("echo tamper >> {f}", { f: ctx.path("ref/docs/a.md") }).run();
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes("Read-only file system"));
  assert.ok((await ctx.readText("ref/docs/a.md")) === "alpha\nneedle one\n" || backend.isolation === "symlink");
});

test("into writes a file and returns its path", async () => {
  const { ctx } = await seeded();
  const result = await ctx
    .sh("sort -n {d}/n1.txt {d}/n2.txt", { d: ctx.path("ref/data") })
    .into("work/out/sorted.txt")
    .run({ check: true });
  assert.deepEqual(result.paths, ["work/out/sorted.txt"]);
  assert.equal(result.text, "");
  assert.deepEqual((await ctx.readText("work/out/sorted.txt")).split(/\s+/).filter(Boolean), ["1", "2", "3", "10", "20"]);
  const plan = await ctx.sh("sort {d}", { d: ctx.path("ref/data") }).into("work/out/x.txt").explain();
  assert.deepEqual(plan.writes, ["work/out/x.txt"]);
  assert.deepEqual(new Set(Object.keys(plan.tasks[0].mounts)), new Set(["ref/data", "work"]));
});

test("map splits only on request and combines as told", async () => {
  const { ctx, backend } = await seeded();
  const numbers = ctx.glob("ref/data/**/*.txt");
  const one = ctx.sh("cat {files}", { files: numbers });
  assert.equal((await one.explain()).tasks.length, 1); // a glob alone is expanded, not split

  const mapped = ctx.sh("cat {files}", { files: numbers }).map({ reduce: "sum", shards: 3 });
  const plan = await mapped.explain();
  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.reduce, "sum");
  assert.equal(plan.files, 3);
  assert.equal(plan.estimate.calls, 3);
  close(plan.estimate.usdCalls, 3 * 0.00005);
  const before = backend.execLog.length;
  const result = await mapped.run({ check: true });
  assert.equal(result.value, 136);
  assert.equal(result.meta.calls, 3);
  assert.equal(backend.execLog.length - before, 3);

  const counted = await ctx
    .sh("wc -l {files} | grep -v total | awk '{print $2 \":\" $1}'", { files: numbers })
    .map({ reduce: "sum_by_key" })
    .run();
  assert.deepEqual(Object.fromEntries(counted.value), {
    "ref/data/n1.txt": 3,
    "ref/data/n2.txt": 2,
    "ref/data/deep/n3.txt": 1,
  });
});

test("map into writes one part per shard", async () => {
  const { ctx } = await seeded();
  const result = await ctx
    .sh("cat {files}", { files: ctx.glob("ref/data/**/*.txt") })
    .map({ shards: 2 })
    .into("team/parts")
    .run({ check: true });
  assert.deepEqual(result.paths, ["team/parts/part-00000", "team/parts/part-00001"]);
  const merged: number[] = [];
  for (const p of result.paths) merged.push(...(await ctx.readText(p)).split(/\s+/).filter(Boolean).map(Number));
  assert.deepEqual(merged.sort((a, b) => a - b), [1, 2, 3, 10, 20, 100]);
});

test("map needs to know what to split", async () => {
  const { ctx } = await seeded();
  assert.throws(() => ctx.sh("echo hi").map(), archil.ValidationError);
  assert.throws(
    // @ts-expect-error: the reducer names are checked by the compiler too
    () => ctx.sh("cat {f}", { f: ctx.glob("ref/data/*.txt") }).map({ reduce: "no-such-reducer" }),
    archil.ValidationError,
  );
});

test("shards balance bytes and fit in a command", () => {
  const sizes = [900, 100, 100, 100, 100, 100, 100, 100, 100, 100];
  const files = sizes.map((size, i) => new FileStat(`m/f${String(i).padStart(3, "0")}`, size));
  const shards = makeShards(files, 2, 100_000, 10);
  assert.deepEqual(shards.map((s) => s.length).sort((a, b) => a - b), [1, 9]); // the big file alone; the small ones together
  const many = Array.from({ length: 1000 }, (_, i) => new FileStat(`m/${"x".repeat(40)}${String(i).padStart(5, "0")}`, 1));
  for (const shard of makeShards(many, 1, 8_000, 10)) {
    // one shard was asked for; the limit forced more
    assert.ok(shard.reduce((sum, f) => sum + f.path.length + 3, 0) < 8_000);
  }
});

test("a command too large for one call says to map", async () => {
  const { backend } = await seeded();
  for (let i = 0; i < 300; i++) {
    await backend.put("reference", `many/${"long-name-".repeat(8)}${i}.txt`, Buffer.from("x"));
  }
  const tight = await archil.context(
    { ref: archil.disk("reference") },
    { backend: new archil.LocalBackend({ root: backend.root, limits: new archil.Limits({ maxCommandBytes: 4096 }) }) },
  );
  const error = await thrown(tight.sh("cat {f}", { f: tight.glob("ref/many/*.txt") }).explain());
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "command_too_large");
  assert.ok(error.suggestion!.includes("map()"));
  const result = await tight.sh("cat {f}", { f: tight.glob("ref/many/*.txt") }).map().run({ check: true });
  assert.ok(result.meta.calls > 1);
  assert.equal(result.text.split("x").length - 1, 300); // every file read once, across several calls
});

test("budgets stop a plan before it runs", async () => {
  const { ctx, backend } = await seeded();
  const stmt = ctx.sh("cat {files}", { files: ctx.glob("ref/data/**/*.txt") }).map({ shards: 3 });
  await assert.rejects(stmt.within({ maxCalls: 2 }).run(), archil.BudgetExceeded);
  assert.deepEqual(backend.execLog, []);
  const capped = ctx.withBudget(new archil.Budget({ maxUsd: 0.00012 }));
  await capped.sh("true").run();
  await capped.sh("true").run();
  await assert.rejects(capped.sh("true").run(), archil.BudgetExceeded); // the context budget is cumulative
  // a budget counts from when it was set: a helper is not charged for what its parent already spent
  const helper = ctx.withBudget(new archil.Budget({ maxCalls: 1 }));
  await helper.sh("true").run();
  await assert.rejects(helper.sh("true").run(), archil.BudgetExceeded);
  assert.equal(ctx.spend.snapshot().calls, 3); // and everything still lands on the one ledger
});

test("larger vms bill as multiples", async () => {
  const { ctx } = await seeded();
  const plan = await ctx.sh("true").sized({ vcpu: 8, memMib: 16384 }).explain();
  assert.equal(plan.estimate.callUnits, 4);
  assert.ok(plan.notes.some((n) => n.includes("bills as 4 calls")));
});

test("grep is one call and returns context paths", async () => {
  const { ctx } = await seeded();
  const stmt = ctx.grep("needle", "ref/docs");
  assert.equal((await stmt.explain()).estimate.calls, 1);
  const result = await stmt.run();
  assert.deepEqual(result.rows, [{ file: "ref/docs/a.md", line: 2, text: "needle one" }]);
  assert.equal(result.value.exhaustive, true);
  assert.equal((await ctx.grep("NEEDLE", "ref", { ignoreCase: true }).run()).rows![0].file, "ref/docs/a.md");
});

test("plan notes point at the cheaper route", async () => {
  const { ctx } = await seeded();
  const plan = await ctx.sh("rg -c needle {d}", { d: ctx.path("ref/docs") }).explain();
  assert.ok(plan.notes.some((n) => n.includes("ctx.grep()")));
});

test("sql reads files as tables and binds values", needsDuckdb, async () => {
  const { ctx, backend } = await seeded();
  await backend.put("reference", "events/a.ndjson", Buffer.from('{"user":"ana","n":1}\n{"user":"bo","n":5}\n'));
  await backend.put("reference", "events/b.ndjson", Buffer.from('{"user":"ana","n":2}\n'));
  const stmt = ctx.sql("select user, sum(n)::int as total from {events} where user <> {skip} group by 1 order by 1", {
    events: ctx.path("ref/events"),
    skip: "o'brien",
  });
  const plan = await stmt.explain();
  assert.deepEqual(Object.keys(plan.tasks[0].mounts), ["ref/events"]);
  assert.deepEqual((await stmt.run({ check: true })).rows, [
    { user: "ana", total: 3 },
    { user: "bo", total: 5 },
  ]);

  const out = ctx.sql("select user, n from {events} where n > {min}", { events: ctx.glob("ref/events/*.ndjson"), min: 1 });
  const result = await out.into("work/big.parquet").run({ check: true });
  assert.deepEqual(result.paths, ["work/big.parquet"]);
  assert.equal(result.rows, null);
  const back = await ctx.sql("select count(*)::int as c from {t}", { t: ctx.path("work/big.parquet") }).run({ check: true });
  assert.deepEqual(back.rows, [{ c: 2 }]);
});

test("sql over nothing costs nothing", needsDuckdb, async () => {
  const { ctx, backend } = await seeded();
  const stmt = ctx.sql("select count(*) from {events}", { events: ctx.glob("ref/none/*.ndjson") });
  assert.equal((await stmt.explain()).estimate.calls, 0);
  const result = await stmt.run();
  assert.deepEqual(result.rows, []);
  assert.equal(result.meta.calls, 0);
  assert.deepEqual(backend.execLog, []);
});

test("batch runs many statements in one call", async () => {
  const { ctx, backend } = await seeded();
  const batch = ctx.batch([
    ctx.sh("cat {f}", { f: ctx.path("ref/docs/b.md") }),
    ctx.sh("echo oops >&2; exit 3"),
    ctx.sh("wc -l < {f}", { f: ctx.path("ref/data/n1.txt") }),
  ]);
  assert.equal((await batch.explain()).estimate.calls, 1);
  const result = await batch.run();
  assert.equal(backend.execLog.length, 1);
  assert.equal(result.meta.calls, 1);
  const [first, second, third] = result.results;
  assert.equal(first.text, "beta\n");
  assert.ok(first.ok);
  assert.equal(second.exitCode, 3);
  assert.equal(second.stderr.trim(), "oops");
  assert.equal(third.text.trim(), "3");
  assert.equal(result.exitCode, 3); // the batch reports the first failure
});

test("every run is added to the ledger and the journal", async () => {
  const backend = newBackend();
  const ctx = await archil.context({ work: archil.disk("w", "owned", { create: true }) }, { backend, journal: "work/journal" });
  await ctx.sh("true").run();
  await ctx.sh("echo hi > {f}", { f: ctx.out("work/hi.txt") }).run();
  assert.equal(ctx.spend.statements, 2);
  assert.equal(ctx.spend.snapshot().calls, 2);
  const entries = [];
  for (const f of await ctx.ls("work/journal", { recursive: true })) {
    for (const line of (await ctx.readText(f.path)).split("\n").filter(Boolean)) entries.push(JSON.parse(line));
  }
  assert.deepEqual(entries.map((e) => e.kind), ["sh", "sh"]);
  assert.deepEqual(entries[1].writes, ["work/hi.txt"]);
  assert.equal(entries[1].calls, 1);
  assert.ok("plan" in entries[1]);
});

test("plans are plain data", async () => {
  const { ctx } = await seeded();
  const plan = await ctx.sh("cat {f}", { f: ctx.path("ref/docs/a.md") }).explain();
  const data = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(data.tasks[0].disks, {
    "ref/docs": { disk: "reference", readOnly: true, conditional: false, subdirectory: "docs" },
  });
  assert.deepEqual(data.effects, { reads: ["ref/docs/a.md"], writes: [] });
  assert.equal(data.hash, (await ctx.sh("cat {f}", { f: ctx.path("ref/docs/a.md") }).explain()).hash);
  assert.ok(String(plan).includes("scope") && String(plan).includes("price"));
});

// -- the two things this SDK adds to the surface: tagged templates, and statements that can be awaited

test("a tagged template is the same statement as the named form", async () => {
  const { ctx } = await seeded();
  const files = ctx.glob("ref/data/**/*.txt");
  const tagged = ctx.sh`cat ${files} | head -n ${2}`;
  assert.equal(tagged.template, "cat {p0} | head -n {p1}");
  assert.deepEqual(tagged.params.map(([name]) => name), ["p0", "p1"]);
  const named = ctx.sh("cat {p0} | head -n {p1}", { p0: files, p1: 2 });
  const plan = await tagged.explain();
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), JSON.parse(JSON.stringify(await named.explain())));
  assert.equal(plan.tasks[0].command, "cat ref/data/deep/n3.txt ref/data/n1.txt ref/data/n2.txt | head -n 2");
});

test("a tagged template quotes values and declares paths", async () => {
  const { ctx, backend } = await seeded();
  const hostile = "x'; touch work/owned; echo '";
  const result = await ctx.sh`printf '%s' ${hostile}`.run();
  assert.equal(result.text, hostile);
  assert.ok(!(await ctx.exists("work/owned")));
  assert.equal(backend.execLog.length, 1);

  // a path read and a path written: only those two mounts are attached, and only one can be changed
  const plan = await ctx.sh`sort -n ${ctx.path("ref/data/n1.txt")} > ${ctx.out("work/out/sorted.txt")}`.explain();
  assert.deepEqual(plan.reads, ["ref/data/n1.txt"]);
  assert.deepEqual(plan.writes, ["work/out/sorted.txt"]);
  assert.deepEqual(Object.keys(plan.tasks[0].mounts), ["ref/data", "work"]);
  assert.ok(plan.tasks[0].mounts["ref/data"].readOnly && !plan.tasks[0].mounts.work.readOnly);
  assert.equal(plan.tasks[0].command, "mkdir -p work/out && sort -n ref/data/n1.txt > work/out/sorted.txt");

  // raw text is inserted as written, and a list of paths is a list of words
  const listed = await ctx.sh`cat ${[ctx.path("ref/docs/a.md"), ctx.path("ref/docs/b.md")]} ${archil.raw("| wc -l")}`.explain();
  assert.equal(listed.tasks[0].command, "cat ref/docs/a.md ref/docs/b.md | wc -l");
});

test("a tagged template leaves braces in its text alone, and takes the text as written", async () => {
  const { ctx } = await seeded();
  // {print $1}, {a,b} and {missing} are text; only the interpolated value is a parameter
  const stmt = ctx.sh`awk '{print $1}' ${ctx.path("ref/data/n1.txt")}; echo {a,b} {missing} \${HOME}`;
  assert.equal(stmt.template, "awk '{print $1}' {p0}; echo {a,b} {missing} \\${HOME}");
  assert.equal((await stmt.explain()).tasks[0].command, "awk '{print $1}' ref/data/n1.txt; echo {a,b} {missing} \\${HOME}");
  // a backslash reaches bash as a backslash
  assert.equal((await ctx.sh`printf 'a\nb\n' | grep -c '\.' ; echo ${"done"}`.run()).text, "0\ndone\n");
  // text that would collide with a generated name, or hide a value behind '$', is refused, not guessed at
  assert.throws(() => ctx.sh`echo {p0} ${1}`, (e: archil.ArchilError) => e.code === "bad_template");
  assert.throws(() => ctx.sh`echo $${1}`, (e: archil.ArchilError) => e.code === "bad_template");
  assert.equal(ctx.sh`echo {p1} ${1}`.template, "echo {p1} {p0}"); // {p1} names no value here: it stays text
});

test("sql takes a tagged template too", needsDuckdb, async () => {
  const { ctx, backend } = await seeded();
  await backend.put("reference", "events/a.ndjson", Buffer.from('{"user":"ana","n":1}\n{"user":"bo","n":5}\n'));
  const stmt = ctx.sql`select user from ${ctx.path("ref/events")} where n > ${1} and user <> ${"o'brien"}`;
  assert.equal(stmt.template, "select user from {p0} where n > {p1} and user <> {p2}");
  const plan = await stmt.explain();
  assert.ok(plan.tasks[0].command.includes("where n > 1 and user <> "));
  assert.deepEqual((await stmt.run({ check: true })).rows, [{ user: "bo" }]);
});

test("awaiting a statement runs it", async () => {
  const { ctx, backend } = await seeded();
  const stmt = ctx.sh`cat ${ctx.path("ref/docs/b.md")}`;
  assert.deepEqual(backend.execLog, []); // building a statement runs nothing
  const result = await stmt;
  assert.ok(result instanceof archil.Result);
  assert.equal(result.text, "beta\n");
  assert.equal(backend.execLog.length, 1);
  const { rows } = await ctx.grep("needle", "ref/docs");
  assert.equal(rows![0].file, "ref/docs/a.md");
  // a statement is a value: awaiting it again runs it again
  await stmt;
  assert.equal(backend.execLog.length, 2);
  // and a failure to plan rejects the await
  await assert.rejects(Promise.resolve(ctx.sh("cat {file}", { flie: 1 })), archil.ValidationError);
});

/** Run `fn` as if ripgrep were not installed, so the backend's own search runs. */
async function withoutRipgrep<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("a tool on a disk does not narrow what an undeclared query sees", async () => {
  const { backend } = await seeded();
  await backend.put("workspace", "bin/duckdb", Buffer.from("#!/bin/sh\n"));
  const ctx = await archil.context(
    { ref: archil.disk("reference"), work: archil.disk("workspace", "owned") },
    { backend, tools: { duckdb: "work/bin/duckdb" } },
  );
  // a declared query sees what it declares, and the tool's directory beside it, read-only
  const declared = await ctx.sql("select count(*) from {t}", { t: ctx.path("ref/data") }).explain();
  assert.deepEqual(Object.keys(declared.tasks[0].mounts), ["ref/data", "work/bin"]);
  assert.equal(declared.tasks[0].mounts["work/bin"].readOnly, true);
  assert.ok(declared.tasks[0].command.startsWith("work/bin/duckdb -json -c "));
  // a query that names its files in its own text declares nothing, so it sees the whole context:
  // the tool is not an input, and must not become the only thing mounted
  const free = await ctx.sql("select count(*) from read_json_auto('ref/events/*.ndjson')").explain();
  assert.deepEqual(Object.keys(free.tasks[0].mounts), ["ref", "work"]);
  assert.equal(free.estimate.complete, false);
  // written with into(), the output is declared, so the tool's disk has to be asked for again
  const out = await ctx.sql("select 1 as one").into("work/one.json").explain();
  assert.deepEqual(Object.keys(out.tasks[0].mounts), ["work"]);
});

test("grep over one file matches that file only", async () => {
  const { ctx, backend } = await seeded();
  await backend.put("reference", "docs/sub/a.md", Buffer.from("needle in a file of the same name, one level down\n"));
  await backend.put("reference", "docs/we*ird[1].md", Buffer.from("needle in a name full of glob characters\n"));
  const check = async (): Promise<void> => {
    const one = await ctx.grep("needle", "ref/docs/a.md").run();
    assert.deepEqual(one.rows!.map((r) => [r.file, r.line]), [["ref/docs/a.md", 2]]);
    assert.equal(one.value.exhaustive, true);
    const odd = await ctx.grep("needle", "ref/docs/we*ird[1].md").run();
    assert.deepEqual(odd.rows!.map((r) => r.file), ["ref/docs/we*ird[1].md"]);
    const everything = await ctx.grep("needle", "ref/docs").run();
    assert.deepEqual(everything.rows!.map((r) => r.file).sort(), ["ref/docs/a.md", "ref/docs/sub/a.md", "ref/docs/we*ird[1].md"]);
  };
  await check(); // with ripgrep, where it is installed
  await withoutRipgrep(check); // and with the search written in JavaScript
  const plan = await ctx.grep("needle", "ref/docs/a.md").explain();
  assert.deepEqual([plan.reads, plan.files], [["ref/docs/a.md"], 1]);
  assert.equal(plan.tasks[0].mounts["ref/docs"].subdirectory, "docs"); // its directory is what is searched
});

test("search without ripgrep reads lines and globs the way ripgrep does", async () => {
  const { ctx, backend } = await seeded();
  const separator = String.fromCodePoint(0x2028); // a line separator inside a line is part of the line
  await backend.put("reference", "lines/a.txt", Buffer.from(`one\nNeedle two\nneedle${separator}three\n`));
  await backend.put("reference", "lines/b.md", Buffer.from("needle in b\n"));
  await backend.put("reference", "lines/gen/c.txt", Buffer.from("needle in c\n"));
  // what Archil's search does with these was checked against the live service: hidden files are
  // searched, ignore files are not honoured, and a binary file is passed over
  await backend.put("reference", "odd/.hidden.txt", Buffer.from("needle hidden\n"));
  await backend.put("reference", "odd/.gitignore", Buffer.from("ignored.txt\n"));
  await backend.put("reference", "odd/ignored.txt", Buffer.from("needle ignored\n"));
  await backend.put("reference", "odd/binary.dat", Buffer.from("needle\0binary\n"));
  const hits = async (options: archil.GrepOptions = {}, where = "ref/lines"): Promise<[string, number, string][]> =>
    (await ctx.grep("needle", where, options).run())
      .rows!.map((r) => [r.file, r.line, r.text] as [string, number, string])
      .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  const all = () =>
    Promise.all([
      hits(),
      hits({ globs: ["*.txt"] }),
      hits({ globs: ["*.txt", "!gen/**"] }),
      hits({ ignoreCase: true, recursive: false }),
      hits({}, "ref/odd"),
    ]);
  const withRg = await all();
  const without = await withoutRipgrep(all);
  assert.deepEqual(without[4].map((h) => h[0]), ["ref/odd/.hidden.txt", "ref/odd/ignored.txt"]);
  assert.deepEqual(without[0], [
    ["ref/lines/a.txt", 3, `needle${separator}three`],
    ["ref/lines/b.md", 1, "needle in b"],
    ["ref/lines/gen/c.txt", 1, "needle in c"],
  ]);
  assert.deepEqual(without[1].map((h) => h[0]), ["ref/lines/a.txt", "ref/lines/gen/c.txt"]);
  assert.deepEqual(without[2].map((h) => h[0]), ["ref/lines/a.txt"]);
  assert.deepEqual(without[3].map((h) => [h[0], h[1]]), [["ref/lines/a.txt", 2], ["ref/lines/a.txt", 3], ["ref/lines/b.md", 1]]);
  assert.deepEqual(withRg, without); // with ripgrep or without it, the same answer
});

test("paths name only the parts that were written", async () => {
  const { ctx, backend } = await seeded();
  await backend.put("reference", "parts/good.txt", Buffer.from("1\n"));
  await backend.put("reference", "parts/bad.txt", Buffer.from("bad\n"));
  const result = await ctx
    .sh("grep -q bad {files} && exit 3; cat {files}", { files: ctx.glob("ref/parts/*.txt") })
    .map({ shards: 2 })
    .into("team/parts")
    .run();
  assert.deepEqual([result.exitCode, result.meta.calls, result.paths.length], [3, 2, 1]);
  assert.equal(await ctx.readText(result.paths[0]), "1\n"); // the shard that failed is not offered as output
});

test("egress is part of what a plan does", async () => {
  const { ctx } = await seeded();
  const json = (plan: archil.Plan) => JSON.parse(JSON.stringify(plan));
  const plain = await ctx.sh("true").explain();
  const denied = await ctx.sh("true").egress("deny").explain();
  const listed = await ctx.sh("true").egress(["pypi.org", "files.pythonhosted.org"]).explain();
  assert.ok(!("network" in json(plain).vm) && !String(plain).includes("egress"));
  assert.deepEqual(json(denied).vm.network, { egress: { default: "deny" } });
  assert.deepEqual(json(listed).vm.network, { egress: { default: "deny", allow: ["pypi.org", "files.pythonhosted.org"] } });
  assert.ok(String(denied).includes("  route   exec · 2 vCPU / 4 GiB · egress denied"));
  assert.ok(String(listed).includes("· egress only to pypi.org, files.pythonhosted.org"));
  assert.equal(new Set([plain.hash, denied.hash, listed.hash]).size, 3); // a different network is a different plan
  // the policy survives the other builders, and a context can set it for everything it runs
  assert.deepEqual(ctx.sh("true").egress("deny").sized({ vcpu: 4 }).vm.egress, []);
  const offline = ctx.withEgress("deny");
  assert.equal((await offline.sh("true").explain()).hash, denied.hash);
  assert.deepEqual(offline.sql("select 1").vm.egress, []);
  assert.equal((await offline.sh("true").egress("allow").explain()).hash, plain.hash);
  assert.deepEqual([offline.narrow(["ref/docs"]).egress, offline.manifest().egress], [[], "deny"]);
  assert.ok(offline.describe().includes("Commands run with egress denied."));
  const reopened = await archil.fromManifest(ctx.withEgress(["pypi.org"]).manifest(), { backend: ctx.backend });
  assert.deepEqual(reopened.egress, ["pypi.org"]);
  assert.equal((await thrown(() => ctx.sh("true").egress("sometimes" as "deny"))).code, "bad_egress");
  // one VM, one network: a batch cannot mix policies
  assert.equal((await thrown(ctx.batch([ctx.sh("true"), ctx.sh("true").egress("deny")]).explain())).code, "bad_batch");
  assert.deepEqual(json(await ctx.batch([ctx.sh("true")]).egress("deny").explain()).vm.network, { egress: { default: "deny" } });
});

test("a denied network is enforced where the local backend can", async (t) => {
  const { ctx, backend } = await seeded();
  if (backend.isolation !== "namespace") return t.skip("this host has no unprivileged namespaces: the local backend cannot cut the network");
  const interfaces = "tail -n +3 /proc/net/dev | wc -l";
  assert.equal(Number((await ctx.sh(interfaces).egress("deny").run({ check: true })).text), 1); // the loopback, and nothing else
  assert.equal(Number((await ctx.sh(interfaces).egress(["example.com"]).run({ check: true })).text), 1); // a list is all or nothing here
  assert.ok(Number((await ctx.sh(interfaces).run({ check: true })).text) >= 1);
});

test("the ledger counts bytes once while they are warm", async () => {
  const { ctx } = await seeded();
  let now = 1_000_000;
  ctx.spend.clock = () => now;
  const files = ctx.glob("ref/data/**/*.txt"); // 6 + 6 + 4 bytes
  const first = await ctx.sh("cat {f}", { f: files }).run();
  const again = await ctx.sh("wc -c {f}", { f: files }).run();
  const spent = ctx.spend.snapshot();
  assert.deepEqual([spent.calls, spent.bytesTouched], [2, 16]); // two statements, the same sixteen bytes
  const hour = ctx.prices.activeUsd(16);
  close(first.meta.usd, ctx.prices.callUsd + hour);
  close(again.meta.usd, ctx.prices.callUsd); // already warm: the second look added no time
  now += 1800; // half an hour on, a touch keeps them warm for half an hour more
  close((await ctx.sh("cat {f}", { f: files }).run()).meta.usd, ctx.prices.callUsd + hour / 2);
  now += 7200; // two hours on they have gone cold, and are made active again
  close((await ctx.grep("1", "ref/data").run()).meta.usd, ctx.prices.callUsd + hour);
  assert.equal(ctx.spend.snapshot().bytesTouched, 32);
  assert.ok(String(ctx.spend).includes("32 B kept active"));
  // a plan still prices a statement on its own, as if nothing were warm
  close((await ctx.sh("cat {f}", { f: files }).explain()).estimate.usdActive, hour);
});
