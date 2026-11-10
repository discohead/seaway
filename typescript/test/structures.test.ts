/** Logs and views: structures built from the same verbs. */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as archil from "../src/index.ts";
import { fixture, needsDuckdb } from "./helpers.ts";

const NOW = new Date("2026-11-09T14:30:00Z");
const HOUR = 3600 * 1000;

async function fill(ctx: archil.Context, hours = 4, writers = ["web-1", "web-2"]): Promise<void> {
  for (const writer of writers) {
    const log = ctx.log("logs/api", { writer });
    for (let h = 0; h < hours; h++) {
      const records = Array.from({ length: 20 }, (_, i) => ({ level: i % 10 === 0 ? "ERROR" : "INFO", ms: i }));
      await log.append(records, { at: new Date(NOW.getTime() - h * HOUR) });
    }
  }
}

test("log layout is an hour per directory and a file per writer", async () => {
  const { ctx } = await fixture();
  const paths = await ctx.log("logs/api", { writer: "web-1" }).append({ level: "INFO", msg: "hello" }, { at: NOW });
  assert.deepEqual(paths, ["logs/api/2026-11-09/14/web-1.ndjson"]);
  const record = JSON.parse(await ctx.readText(paths[0]));
  assert.equal(record.msg, "hello");
  assert.ok(record.ts.startsWith("2026-11-09T14:30"));
  assert.equal(record.id.length, 12);
});

test("a selection touches only the partitions the question needs", async () => {
  const { ctx } = await fixture();
  await fill(ctx);
  const log = ctx.log("logs/api");
  const recent = log.last("45m", { now: NOW });
  const files = await ctx.expand(recent);
  assert.deepEqual(files.map((f) => f.path).sort(), [
    "logs/api/2026-11-09/13/web-1.ndjson",
    "logs/api/2026-11-09/13/web-2.ndjson",
    "logs/api/2026-11-09/14/web-1.ndjson",
    "logs/api/2026-11-09/14/web-2.ndjson",
  ]);
  assert.equal((await ctx.expand(log.all())).length, 8);

  const plan = await ctx.sh("cat {events} | wc -l", { events: log.last("20m", { now: NOW }) }).explain();
  assert.equal(plan.files, 2);
  assert.deepEqual(Object.keys(plan.tasks[0].mounts), ["logs/api/2026-11-09/14"]); // one hour of one log, read-only
  const everything = await ctx.sh("cat {events} | wc -l", { events: log.all() }).explain();
  assert.equal(plan.estimate.bytesTouched * 4, everything.estimate.bytesTouched);
});

test("appending to a read only mount is refused", async () => {
  const { ctx } = await fixture();
  await assert.rejects(ctx.log("ref/events").append({ x: 1 }), archil.ValidationError);
});

test("sql over a log selection", needsDuckdb, async () => {
  const { ctx } = await fixture();
  await fill(ctx);
  const result = await ctx
    .sql("select level, count(*)::int as n from {events} group by 1 order by 1", {
      events: ctx.log("logs/api").last("20m", { now: NOW }),
    })
    .run({ check: true });
  assert.deepEqual(result.rows, [
    { level: "ERROR", n: 4 },
    { level: "INFO", n: 36 },
  ]);
});

test("a view rebuilds only when its inputs change", async () => {
  const { ctx, backend } = await fixture();
  await fill(ctx, 1);
  const log = ctx.log("logs/api");
  const view = ctx.view("work/reports/errors.txt", () => ctx.sh("cat {events} | grep -c ERROR", { events: log.all() }));
  assert.ok(!(await view.fresh()));
  const first = await view.refresh();
  assert.ok(first!.ok);
  assert.equal((await ctx.readText("work/reports/errors.txt")).trim(), "4");
  const calls = backend.execLog.length;
  assert.ok(await view.fresh());
  assert.equal(await view.refresh(), null); // nothing changed: nothing ran
  assert.equal(backend.execLog.length, calls);

  await ctx.log("logs/api", { writer: "web-3" }).append({ level: "ERROR" }, { at: NOW });
  assert.ok(!(await view.fresh()));
  assert.equal((await view.readText()).trim(), "5"); // reading a stale view refreshes it first
  assert.equal(backend.execLog.length, calls + 1);
});

test("durations are checked", async () => {
  const { ctx } = await fixture();
  assert.throws(() => ctx.log("logs/api").last("a while"), archil.ValidationError);
});

test("a feed reports what changed until it is acknowledged", async () => {
  const { ctx } = await fixture();
  await ctx.append("logs/inbox/a.txt", "one\n");
  await ctx.append("logs/inbox/b.txt", "one\n");
  const feed = ctx.feed("logs/inbox", { cursor: "work/cursors/inbox.json" });

  const first = await feed.poll();
  assert.deepEqual(first.added.map((f) => f.path), ["logs/inbox/a.txt", "logs/inbox/b.txt"]);
  assert.equal(first.modified.length, 0);
  const again = await feed.poll(); // not acknowledged yet: delivered again
  assert.deepEqual(again.added.map((f) => f.path), first.added.map((f) => f.path));
  await first.ack();
  assert.ok((await feed.poll()).empty);

  await ctx.append("logs/inbox/a.txt", "two\n"); // an existing file grows
  await ctx.append("logs/inbox/c.txt", "new\n");
  const changes = await feed.poll();
  assert.ok(!changes.empty);
  assert.deepEqual(changes.added.map((f) => f.path), ["logs/inbox/c.txt"]);
  assert.deepEqual(changes.modified.map((f) => f.path), ["logs/inbox/a.txt"]);
  assert.deepEqual(changes.previous, { "logs/inbox/a.txt": 4 });
  // the changed files are statement parameters: only they are read, and only their directory is mounted
  const result = await ctx.sh("cat {new}", { new: changes.refs() }).run({ check: true });
  assert.deepEqual([...result.lines].sort(), ["new", "one", "two"]);
  assert.deepEqual(Object.keys(result.plan!.tasks[0].mounts), ["logs/inbox"]);
  await changes.ack();
  assert.ok((await feed.poll()).empty);
});

test("a feed sees removals and keeps its cursor out of the listing", async () => {
  const { ctx } = await fixture();
  await ctx.write("work/drop/x.txt", "x");
  const feed = ctx.feed("work", { cursor: "work/cursor.json" });
  await (await feed.poll()).ack();
  await ctx.rm("work/drop/x.txt");
  const changes = await feed.poll();
  assert.deepEqual(changes.removed, ["work/drop/x.txt"]);
  assert.equal(changes.added.length, 0);
  assert.equal(changes.modified.length, 0);
});

// -- the formats both SDKs write

test("a log line is the envelope both SDKs write", async () => {
  const { ctx } = await fixture();
  const log = ctx.log("logs/app", { writer: "host/a b" }); // a writer becomes a safe file name
  const [path] = await log.append({ msg: "héllo", n: 1.5, nested: { ok: true, none: null } }, { at: NOW });
  assert.equal(path, "logs/app/2026-11-09/14/host-a-b.ndjson");
  const line = await ctx.readText(path);
  // ts first, then a 12-hex id, then the record; compact, and ASCII-only as Python's json.dumps writes it
  assert.match(
    line,
    /^\{"ts":"2026-11-09T14:30:00\.000Z","id":"[0-9a-f]{12}","msg":"h\\u00e9llo","n":1\.5,"nested":\{"ok":true,"none":null\}\}\n$/,
  );
  // a record's own ts decides its partition; one with no offset is UTC
  const own = await ctx.log("logs/app", { writer: "w", partition: "day" }).append([
    { ts: "2026-11-08T23:59:59.999Z", id: "000000000001" },
    { ts: "2026-11-09T00:00:00", id: "000000000002" },
  ]);
  assert.deepEqual(own, ["logs/app/2026-11-08/w.ndjson", "logs/app/2026-11-09/w.ndjson"]);
  assert.equal(await ctx.readText(own[1]), '{"ts":"2026-11-09T00:00:00","id":"000000000002"}\n');
});

test("selections cover whole partitions, in UTC", async () => {
  const { ctx } = await fixture();
  await fill(ctx);
  const log = ctx.log("logs/api");
  const at = (text: string): Date => new Date(text);
  const paths = async (sel: archil.Selection): Promise<string[]> => (await ctx.expand(sel)).map((f) => f.path.slice(9, 22));
  // the hour that holds the start is in; an hour that starts exactly at the end is in too
  assert.deepEqual(await paths(log.between(at("2026-11-09T12:59:00Z"), at("2026-11-09T13:00:00Z"))), [
    "2026-11-09/12",
    "2026-11-09/12",
    "2026-11-09/13",
    "2026-11-09/13",
  ]);
  assert.deepEqual(await paths(log.between(at("2026-11-08T00:00:00Z"), at("2026-11-09T10:59:59Z"))), []);
  assert.equal(String(log.between(at("2026-11-09T13:15:00+02:00"), at("2026-11-09T14:30:00Z"))), "logs/api[2026-11-09 11:15..2026-11-09 14:30]");
  assert.equal(String(log.last("15m", { now: NOW })), "logs/api[last 15m]");
  assert.equal(String(log.all()), "logs/api[all]");
});
