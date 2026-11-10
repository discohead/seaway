/** The TypeScript half of the interop check. Usage: node side.ts <root> <step> <outfile> [args] */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as archil from "../typescript/src/index.ts";

const [root, step, outfile, ...args] = process.argv.slice(2);
const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-11-09T14:30:00Z");
const MINUTE = 60_000;
const backend = new archil.LocalBackend({ root });
const ctx = await archil.context(
  {
    logs: archil.disk("app-logs", "append", { create: true, description: "service logs" }),
    ref: archil.disk("reference", "read", { create: true }),
    work: archil.disk("workspace", "owned", { create: true }),
    team: archil.disk("team-shared", "shared", { create: true }),
  },
  { backend, name: "interop", journal: "work/journal" },
);

const ISSUES = [
  { id: "ENG-1", title: "Checkout fails: expired coupon", state: "open", labels: ["bug", "p1"], n: 3, ok: true, none: null, body: "Steps…" },
  { id: "ENG-2", title: "Añadir modo oscuro", state: "done", labels: [], n: 0, ok: false, none: null, body: "" },
];
const SKILLS = { "review.md": "# How we review\n", "deploy.md": "# How we deploy\n", "sub/ünï.md": "x\n" };

const triple = (f: archil.FileStat): [string, number, string] => [f.path, f.size, f.version];

async function listing(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const sel of ["ref", "logs", "work", "team", "ref/**/*.txt", "logs/api/**/*.ndjson"]) out[sel] = (await ctx.expand(sel)).map(triple);
  out["ls work"] = (await ctx.ls("work")).map(triple);
  out["ls ref -r"] = (await ctx.ls("ref", { recursive: true })).map(triple);
  return out;
}

function statements(): Record<string, archil.Statement> {
  const log = ctx.log("logs/api");
  return {
    cat: ctx.sh("cat {f}", { f: ctx.path("ref/docs/a.md") }),
    glob: ctx.sh("wc -c {files}", { files: ctx.glob("ref/**/*") }),
    map: ctx.sh("cat {files}", { files: ctx.glob("ref/data/**/*.txt") }).map({ reduce: "sum", shards: 2 }),
    sql: ctx.sql("select level, count(*)::int as n from {events} group by 1 order by 1", { events: log.between(new Date(NOW.getTime() - 90 * MINUTE), NOW) }),
    "sql-all": ctx.sql("select count(*)::int as n from {events} where ms > {min}", { events: log.all(), min: 1.5 }),
    grep: ctx.grep("ERROR", "logs/api", { ignoreCase: true }),
    "grep-all": ctx.grep("needle"),
    into: ctx.sh("sort -n {d}/n1.txt", { d: ctx.path("ref/data") }).into("work/out/sorted.txt"),
    batch: ctx.batch([ctx.sh("cat {f}", { f: ctx.path("ref/docs/b.md") }), ctx.sql("select count(*)::int as c from {t}", { t: ctx.path("logs/api") })]),
  };
}

const errorsView = (): archil.View => ctx.view("work/reports/errors.txt", () => ctx.sh("cat {events} | grep -c ERROR", { events: ctx.log("logs/api").all() }));
const countView = (): archil.View => ctx.view("work/reports/count.txt", () => ctx.sh("cat {events} | wc -l", { events: ctx.log("logs/api").all() }));

async function dump(out: Record<string, unknown>): Promise<void> {
  out.listing = await listing();
  const plans: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(statements())) {
    const plan = await s.explain();
    plans[name] = { plan: JSON.parse(JSON.stringify(plan)), text: String(plan) };
  }
  out.plans = plans;
  out.errors_fingerprint = await errorsView().fingerprint();
  out.errors_fresh = await errorsView().fresh();
  out.manifest = ctx.manifest();
  out.describe = ctx.describe();
  out.issue_files = { "ENG-1.md": await ctx.readText("team/issues/ENG-1.md"), "ENG-2.md": await ctx.readText("team/issues/ENG-2.md") };
  out.state_files = {};
}

const out: Record<string, unknown> = {};
if (step === "write") {
  await ctx.write(args[0], args[1]);
} else if (step === "seed") {
  const files: Record<string, string> = {
    "docs/a.md": "alpha\nneedle one\n", "docs/b.md": "beta\n", "data/n1.txt": "1\n2\n3\n", "data/n2.txt": "10\n20\n", "data/deep/n3.txt": "100\n",
    "names/it's here.txt": "quoted\n", "names/ünïcode.txt": "utf8\n",
    ["names/" + String.fromCodePoint(0x1f600) + ".txt"]: "astral\n", ["names/" + String.fromCodePoint(0xffff) + ".txt"]: "high\n",
  };
  for (const [key, text] of Object.entries(files)) {
    try {
      await backend.put("reference", key, Buffer.from(text));
    } catch (error) {
      // a file system that cannot hold the name: macOS refuses U+FFFF. Both SDKs skip it.
      if ((error as NodeJS.ErrnoException).code !== "EILSEQ") throw error;
    }
  }
  for (let h = 0; h < 3; h++) {
    const records = Array.from({ length: 10 }, (_, i) => ({ level: i % 5 === 0 ? "ERROR" : "INFO", ms: i, msg: "héllo" }));
    await ctx.log("logs/api", { writer: "py-1" }).append(records, { at: new Date(NOW.getTime() - h * 60 * MINUTE) });
  }
  out.view_first = (await errorsView().refresh())!.stdout;
  const changes = await ctx.feed("logs/api", { cursor: "work/cursors/api.json" }).poll();
  out.feed_added = changes.added.map((f) => f.path);
  await changes.ack();
  out.sync_skills = await ctx.sync(new archil.Static(SKILLS, { name: "skills", layout: "One Markdown file per skill." }), "work/skills");
  out.sync_issues = await ctx.sync(new archil.Records("issues", () => ISSUES, { key: "id", body: "body", layout: "One file per issue." }), "team/issues");
  await ctx.sh("true").run();
  await ctx.write("work/tmp/old.md", "old\n");
  const tx = await new archil.Transaction(ctx, { writes: ["work"], name: "tx-py" }).begin();
  await tx.ctx.write("work/from-py.md", "py\n");
  await tx.ctx.rm("work/tmp/old.md");
  const commit = await tx.commit();
  out.commit = [commit.applied, commit.deleted, commit.calls];
  out.apply_script = backend.execLog.at(-1)!.command;
  out.apply_mounts = backend.execLog.at(-1)!.mounts;
  out.tx_manifest = Buffer.from(await backend.get("workspace@tx-py", ".px/tx/tx-py.changes")).toString();
  await dump(out);
} else if (step === "dump") {
  await dump(out);
} else if (step === "check-and-change") {
  // 1. everything the other SDK left is as this SDK would have left it
  await dump(out);
  out.sync_skills_same = await ctx.sync(new archil.Static(SKILLS, { name: "skills", layout: "One Markdown file per skill." }), "work/skills");
  out.sync_issues_same = await ctx.sync(new archil.Records("issues", () => ISSUES, { key: "id", body: "body", layout: "One file per issue." }), "team/issues");
  const feed = ctx.feed("logs/api", { cursor: "work/cursors/api.json" });
  out.feed_empty = (await feed.poll()).empty;
  out.errors_refresh_ran = (await errorsView().refresh()) !== null;
  // 2. now change things from this side
  await ctx.log("logs/api", { writer: "ts-1" }).append([{ level: "ERROR", ms: 99, msg: "from ts ✓" }, { level: "INFO", ms: 1 }], { at: NOW });
  const changes = await feed.poll();
  out.feed_added = changes.added.map((f) => f.path);
  await changes.ack();
  await countView().refresh();
  out.count_first = await ctx.readText("work/reports/count.txt");
  out.sync_skills_changed = await ctx.sync(new archil.Static({ ...SKILLS, "review.md": "# How we review (v2)\n" }, { name: "skills", layout: "One Markdown file per skill." }), "work/skills");
  const commit = await ctx.transaction(async (turn) => {
    await turn.write("work/from-ts.md", "ts\n");
    await turn.rm("work/from-py.md");
  }, { writes: ["work"], name: "tx-ts" });
  out.commit = [commit.applied, commit.deleted, commit.calls];
  writeFileSync(args[0], JSON.stringify(await ctx.lock("interop-lock")));
  // 3. a turn begun here, a write from the other SDK in between: the commit must name the path
  const tx = await new archil.Transaction(ctx, { writes: ["work"] }).begin();
  await tx.ctx.write("work/contested-ts.md", "ts\n");
  execFileSync("python3", [`${HERE}/side.py`, root, "write", "/dev/null", "work/contested-ts.md", "py\n"]);
  out.conflict = await tx.commit().then(() => "committed", (e) => (e instanceof archil.Conflict ? e.paths : String(e)));
  out.after = await listing();
} else if (step === "verify") {
  await dump(out);
  out.count_fresh = await countView().fresh();
  out.feed_empty_after_ts_ack = (await ctx.feed("logs/api", { cursor: "work/cursors/api.json" }).poll()).empty;
  out.sync_skills_again = await ctx.sync(new archil.Static({ ...SKILLS, "review.md": "# How we review (v2)\n" }, { name: "skills", layout: "One Markdown file per skill." }), "work/skills");
  out.sync_issues_again = await ctx.sync(new archil.Records("issues", () => ISSUES, { key: "id", body: "body", layout: "One file per issue." }), "team/issues");
  const frozen = await archil.fromManifest(args[0], { backend });
  out.frozen_modes = [...new Set([...frozen.mounts.values()].map((m) => m.mode))].sort();
  out.frozen_read = await frozen.readText("work/from-ts.md");
  const journal = [];
  for (const f of await ctx.ls("work/journal", { recursive: true })) for (const line of (await ctx.readText(f.path)).split("\n").filter(Boolean)) journal.push(JSON.parse(line));
  out.journal_kinds = [...new Set(journal.map((e) => e.kind))].sort();
  out.journal_sql = (await ctx.sql("select kind, count(*)::int as n from {j} group by 1 order by 1", { j: ctx.path("work/journal") }).run({ check: true })).rows;
  out.log_sql = (await ctx.sql("select count(*)::int as n, count(distinct id)::int as ids, count(distinct ts)::int as stamps from {e}", { e: ctx.log("logs/api").all() }).run({ check: true })).rows;
  out.ts_tx_manifest = Buffer.from(await backend.get("workspace@tx-ts", ".px/tx/tx-ts.changes")).toString();
  const state = "work/.px/views/" + createHash("sha1").update("work/reports/count.txt").digest("hex").slice(0, 16) + ".json";
  out.ts_view_state = await ctx.readText(state);
  const tx = await new archil.Transaction(ctx, { writes: ["work"] }).begin();
  await tx.ctx.write("work/contested.md", "py\n");
  execFileSync("python3", [`${HERE}/side.py`, root, "write", "/dev/null", "work/contested.md", "ts\n"]);
  out.conflict = await tx.commit().then(() => "committed", (e) => (e instanceof archil.Conflict ? e.paths : String(e)));
  out.contested = await ctx.readText("work/contested.md");
}
if (outfile !== "/dev/null") writeFileSync(outfile, JSON.stringify(out, null, 1));
console.log("typescript", step, "done");
