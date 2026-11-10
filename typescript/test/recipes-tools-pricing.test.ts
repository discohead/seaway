/** Recipes, the tool surface for models, and the price model. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import * as archil from "../src/index.ts";
import { fixture, needsCurl, needsGit, seeded, thrown, tmp } from "./helpers.ts";

function close(got: number, want: number): void {
  assert.ok(Math.abs(got - want) <= 1e-12 + 1e-6 * Math.abs(want), `${got} is not ${want}`);
}

test("a recipe materialises incrementally", async () => {
  const { ctx } = await fixture();
  const skills = new archil.Static(
    { "review.md": "# How we review\n", "deploy.md": "# How we deploy\n" },
    { name: "skills", layout: "One Markdown file per skill." },
  );
  assert.deepEqual(await ctx.sync(skills, "work/skills"), { written: 2, unchanged: 0, deleted: 0, into: "work/skills" });
  assert.equal(await ctx.readText("work/skills/README.md"), "One Markdown file per skill.\n");
  assert.equal((await ctx.sync(skills, "work/skills")).unchanged, 2);

  const fewer = new archil.Static({ "review.md": "# How we review (v2)\n" }, { name: "skills" });
  assert.deepEqual(await ctx.sync(fewer, "work/skills"), { written: 1, unchanged: 0, deleted: 1, into: "work/skills" });
  assert.ok(!(await ctx.exists("work/skills/deploy.md")));
  assert.deepEqual((await ctx.ls("work/skills")).map((f) => f.path), ["work/skills/README.md", "work/skills/review.md"]);
});

test("records become markdown with front matter", async () => {
  const { ctx } = await fixture();
  const issues = [
    {
      id: "ENG-1",
      title: "Checkout fails: expired coupon",
      state: "open",
      labels: ["bug"],
      updated: "2026-11-01",
      body: "Steps to reproduce…",
    },
    { id: "ENG-2", title: "Add dark mode", state: "done", labels: [], updated: "2026-10-20", body: "" },
  ];
  const calls: number[] = [];
  const fetch = (): typeof issues => {
    calls.push(1);
    return issues;
  };

  const recipe = new archil.Records("issues", fetch, {
    key: "id",
    version: "updated",
    body: "body",
    layout: "One file per issue. Front matter holds the fields.",
  });
  assert.equal((await ctx.sync(recipe, "team/issues")).written, 2);
  const text = await ctx.readText("team/issues/ENG-1.md");
  assert.ok(text.startsWith('---\nid: ENG-1\ntitle: "Checkout fails: expired coupon"\nstate: open\nlabels: ["bug"]'));
  assert.ok(text.endsWith("---\nSteps to reproduce…\n"));
  // the files are ordinary files: every other verb works on them with no integration
  assert.equal((await ctx.grep("state: open", "team/issues").run()).rows![0].file, "team/issues/ENG-1.md");

  issues[1].updated = "2026-11-09";
  const again = new archil.Records("issues", async () => issues, { key: "id", version: "updated", body: "body" });
  const stats = await ctx.sync(again, "team/issues");
  assert.deepEqual([stats.written, stats.unchanged], [1, 1]);
  assert.deepEqual(calls, [1]); // one fetch served both the listing and the two files
});

test("a recipe can be a statement that runs next to the data", needsGit, async () => {
  const { ctx } = await fixture();
  const repo = join(tmp(), "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "hello from the repo\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  const stmt = archil.git(ctx, pathToFileURL(repo).href, "work/repos/demo");
  assert.deepEqual((await stmt.explain()).writes, ["work/repos/demo"]);
  await stmt.run({ check: true });
  assert.equal(await ctx.readText("work/repos/demo/README.md"), "hello from the repo\n");
});

test("records are fetched again on every sync", async () => {
  const { ctx } = await fixture();
  const source = [{ id: "A-1", updated: "1", body: "first" }];
  const recipe = new archil.Records("things", () => source.map((r) => ({ ...r })), { version: "updated", body: "body" });
  assert.equal((await ctx.sync(recipe, "work/things")).written, 1);
  source[0] = { id: "A-1", updated: "2", body: "second" };
  source.push({ id: "A-2", updated: "1", body: "new" });
  assert.deepEqual(await ctx.sync(recipe, "work/things"), { written: 2, unchanged: 0, deleted: 0, into: "work/things" });
  assert.ok((await ctx.readText("work/things/A-1.md")).endsWith("second\n"));
});

test("a context that cannot write offers no write tools", async () => {
  const { ctx } = await seeded();
  const reader = ctx.narrow(["ref/docs", "work"], { readOnly: true });
  assert.deepEqual(reader.tools().map((t) => t.name), ["read_file", "list_files", "grep", "run_bash", "sql", "plan"]);
  const [write] = reader.tools(["write_file"]); // asked for by name: given, and it refuses
  assert.equal(write.name, "write_file");
  assert.ok((await write.call({ path: "work/x.txt", content: "x" })).startsWith("error: read_only"));
});

test("tools have schemas and never raise", async () => {
  const { ctx } = await seeded();
  const tools = new Map(ctx.tools().map((t) => [t.name, t]));
  const tool = (name: string): archil.Tool => tools.get(name)!;
  assert.deepEqual([...tools.keys()], ["read_file", "write_file", "delete_file", "list_files", "grep", "run_bash", "sql", "plan"]);
  assert.deepEqual(tool("read_file").toOpenAI().function.parameters.required, ["path"]);
  assert.deepEqual(tool("read_file").toAnthropic().input_schema.properties, { path: { type: "string" } });

  assert.equal(await tool("read_file").call({ path: "ref/docs/b.md" }), "beta\n");
  assert.equal(await tool("list_files").call(), "logs/\nref/\nwork/\nteam/");
  assert.ok((await tool("grep").call({ pattern: "needle", path: "ref" })).includes("ref/docs/a.md:2:needle one"));
  assert.ok((await tool("run_bash").call({ command: "cat ref/docs/b.md" })).startsWith("exit 0\nbeta"));
  const plan = await tool("plan").call({ command: "ls" });
  assert.ok(plan.includes("scope") && plan.includes("price"));

  const refused = await tool("write_file").call({ path: "ref/docs/b.md", content: "x" });
  assert.ok(refused.startsWith("error: read_only") && refused.includes("owned")); // the model is told what to do instead
  assert.ok((await tool("read_file").call({ path: "nope/x" })).startsWith("error: unknown_mount"));
  assert.deepEqual(ctx.tools(["grep", "run_bash"]).map((t) => t.name), ["grep", "run_bash"]);

  // what Python turns into a TypeError: an argument left out, or one the tool does not take
  assert.equal(await tool("read_file").call({}), "error: bad arguments for read_file: missing 'path'");
  assert.equal(await tool("plan").call({ command: "ls", cwd: "/" }), "error: bad arguments for plan: unexpected 'cwd'");
});

test("tools carry the same names, descriptions and schemas as the Python SDK", async () => {
  const { ctx } = await seeded();
  const str = { type: "string" };
  const bool = { type: "boolean" };
  const schema = (required: string[], properties: object): object => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  assert.deepEqual(
    ctx.tools().map((t) => t.toAnthropic()),
    [
      {
        name: "read_file",
        description: "Read a file. Paths are <mount>/<path>; mounts: logs (append), ref (read), work (owned), team (shared).",
        input_schema: schema(["path"], { path: str }),
      },
      {
        name: "write_file",
        description: "Create or replace a file on a writable mount.",
        input_schema: schema(["path", "content"], { path: str, content: str }),
      },
      { name: "delete_file", description: "Delete a file on a writable mount.", input_schema: schema(["path"], { path: str }) },
      {
        name: "list_files",
        description: "List a directory. Directories end in '/'. Leave path empty to list the mounts.",
        input_schema: schema([], { path: str, recursive: bool }),
      },
      {
        name: "grep",
        description: "Regex search across files, run next to the data. One call however many files.",
        input_schema: schema(["pattern"], { pattern: str, path: str, ignore_case: bool }),
      },
      {
        name: "run_bash",
        description:
          "Run a bash command in a fresh VM with the context mounted at the working directory. " +
          "Only files on the mounts persist between calls.",
        input_schema: schema(["command"], { command: str }),
      },
      {
        name: "sql",
        description:
          "Run a DuckDB SQL query over files in the context, e.g. select count(*) from read_json_auto('logs/api/**/*.ndjson').",
        input_schema: schema(["query"], { query: str }),
      },
      {
        name: "plan",
        description: "Show what a bash command would mount and cost, without running it.",
        input_schema: schema(["command"], { command: str }),
      },
    ],
  );
});

test("the price model follows the public price sheet", () => {
  const prices = new archil.PriceSheet();
  close(prices.callUsd, 0.00005);
  assert.equal(prices.callUnits(2, 4096), 1);
  assert.equal(prices.callUnits(4, 4096), 2); // the larger of the vCPU and memory multiples
  assert.equal(prices.callUnits(8, 16384), 4);
  close(prices.activeUsd(1024 ** 3), 0.2 / 730); // one GiB active for one hour
  close(prices.egressUsd(1000 ** 3), 0.07);
  close(prices.sandboxHourUsd(2, 4096), 0.19);
  assert.equal(prices.breakevenCallsPerHour(), 3800); // calls per hour at which a warm 2 vCPU sandbox is cheaper

  const cheap = new archil.PriceSheet({ callUsd: 0.00001 });
  const est = archil.estimate(cheap, { calls: 10, bytesTouched: 2 * 1024 ** 3 });
  close(est.usd, 10 * 0.00001 + (2 * 0.2) / 730);
});

test("reads from outside archil are counted as egress", async () => {
  const outside = new archil.LocalBackend({ root: join(tmp(), "o"), insideArchil: false });
  const ctx = await archil.context({ work: archil.disk("w", "owned", { create: true }) }, { backend: outside });
  await ctx.write("work/big.bin", Buffer.alloc(1_000_000, "x"));
  await ctx.read("work/big.bin");
  assert.equal(ctx.spend.snapshot().egressBytes, 1_000_000);
  close(ctx.spend.snapshot().usdEgress, 0.07 / 1000);
  const plan = await ctx.sh("wc -c {f}", { f: ctx.path("work/big.bin") }).explain();
  assert.ok(plan.notes.some((n) => n.includes("only stdout crosses the network")));
});

// -- the text both SDKs print

test("prices and sizes are written the way the Python SDK writes them", () => {
  assert.deepEqual([0, 17, 1023, 1024, 1280, 1792, 552_960, 3 * 1024 ** 2, 5 * 1024 ** 4].map(archil.fmtBytes), [
    "0 B",
    "17 B",
    "1023 B",
    "1.0 KiB",
    "1.2 KiB", // 1.25 exactly: Python rounds the tie to the even digit, toFixed() would say 1.3
    "1.8 KiB",
    "540.0 KiB",
    "3.0 MiB",
    "5.0 TiB",
  ]);
  assert.deepEqual([0, 0.000004, 0.00005, 0.00015, 0.0002, 0.0099, 0.01, 12.5].map(archil.fmtUsd), [
    "$0",
    "<$0.00001",
    "$0.00005",
    "$0.00015",
    "$0.00020",
    "$0.00990",
    "$0.01",
    "$12.50",
  ]);
  const ledger = new archil.Ledger(new archil.PriceSheet());
  ledger.add(archil.estimate(ledger.prices, { calls: 6, bytesTouched: 729 }));
  assert.equal(
    String(ledger),
    "1 statement(s): 6 call unit(s) $0.00030, 729 B kept active <$0.00001, 0 B egress $0; total ≈ $0.00030",
  );
  const over = new archil.Budget({ maxUsd: 0.0001, maxCalls: 2, maxBytesTouched: 1024 });
  assert.throws(
    () => over.check(archil.estimate(ledger.prices, { calls: 3, bytesTouched: 4096 })),
    (e: archil.ArchilError) =>
      e instanceof archil.BudgetExceeded &&
      e.code === "budget_exceeded" &&
      e.message === "plan exceeds budget: $0.00015 > $0.00010; 3 calls > 2; 4.0 KiB touched > 1.0 KiB",
  );
});

test("duckdb can be put on a disk for archil", async () => {
  const { ctx } = await fixture();
  const plan = await archil.duckdb(ctx, "work/bin").explain();
  assert.deepEqual([plan.writes, Object.keys(plan.tasks[0].mounts)], [["work/bin/duckdb"], ["work"]]);
  const command = plan.tasks[0].command;
  assert.ok(command.startsWith("mkdir -p work/bin && set -euo pipefail; "));
  assert.ok(command.includes("releases/download/v2.0.0/duckdb-cli-linux-amd64.tar.gz") && command.endsWith("work/bin/duckdb"));
  // the archive is checked against the pinned hash before anything is unpacked
  assert.ok(command.includes(`want=${archil.DUCKDB_SHA256["2.0.0"]}; `));
  assert.ok(command.indexOf("sha256sum") < command.indexOf("exit 1") && command.indexOf("exit 1") < command.indexOf("tar -xzf"));
  // another version, or an archive from somewhere else, has to bring its own hash
  for (const other of [{ version: "9.9.9" }, { url: "https://mirror.example/duckdb.tgz" }]) {
    const refused = (await thrown(() => archil.duckdb(ctx, "work/bin", other))) as archil.ValidationError;
    assert.ok(refused instanceof archil.ValidationError);
    assert.equal(refused.issues[0].code, "unpinned_download");
  }
  const mirrored = archil.duckdb(ctx, "work/bin", { url: "https://mirror.example/duckdb.tgz", sha256: "AB".repeat(32) });
  assert.ok((await mirrored.explain()).tasks[0].command.includes(`want=${"ab".repeat(32)}; curl -fsSL -o "$f" https://mirror.example/duckdb.tgz; `));
  const malformed = (await thrown(() => archil.duckdb(ctx, "work/bin", { sha256: "not a hash" }))) as archil.ValidationError;
  assert.equal(malformed.issues[0].code, "bad_sha256");
  assert.throws(() => archil.duckdb(ctx, "ref/bin"), archil.ValidationError); // it has to go somewhere the context can write
  // the same statement, to the character, as the Python SDK's recipe
  assert.equal(
    (await archil.duckdb(ctx, "work/bin").explain()).statement,
    'set -euo pipefail; t=$(mktemp -d); f="$t/duckdb.tar.gz"; want={sum}; curl -fsSL -o "$f" {url}; ' +
      'got=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1); ' +
      'if [ "$got" != "$want" ]; then echo "duckdb: the download has SHA-256 $got, not the pinned $want" >&2; exit 1; fi; ' +
      'tar -xzf "$f" -C "$t"; install -m 0755 "$t/duckdb" {dest}',
  );
});

test("the duckdb recipe installs only what matches its hash", needsCurl, async () => {
  const { ctx } = await fixture();
  // a stand-in for the release: an archive that holds one executable called duckdb
  const dir = tmp();
  writeFileSync(join(dir, "duckdb"), "#!/bin/sh\necho stand-in\n");
  const archive = join(dir, "duckdb-cli.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "duckdb"]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const url = pathToFileURL(archive).href;

  const installed = await archil.duckdb(ctx, "work/bin", { url, sha256: digest }).run();
  assert.ok(installed.ok, installed.stderr);
  assert.equal(await ctx.readText("work/bin/duckdb"), "#!/bin/sh\necho stand-in\n");
  assert.equal((await ctx.sh("test -x {tool} && echo executable", { tool: ctx.path("work/bin/duckdb") }).run()).text, "executable\n");

  const refused = await archil.duckdb(ctx, "work/other", { url, sha256: "0".repeat(64) }).run();
  assert.equal(refused.exitCode, 1);
  assert.ok(refused.stderr.includes(`the download has SHA-256 ${digest}, not the pinned ${"0".repeat(64)}`));
  assert.ok(!(await ctx.exists("work/other/duckdb")));
});
