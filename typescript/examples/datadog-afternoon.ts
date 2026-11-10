/**
 * Observability on a disk, in one file.
 *
 * Services append JSON lines to a disk. Everything else is a statement against
 * it: a triage query, a search, a report that rebuilds itself only when the logs
 * change, an alert that polls for nothing. There is no collector, no ingest
 * service and no index, and nothing runs between questions.
 *
 *     node examples/datadog-afternoon.ts             # on the local backend, with generated logs
 *     node examples/datadog-afternoon.ts --archil    # the same code on Archil; see _where.ts
 *
 * Locally it needs the duckdb and jq CLIs on PATH. On Archil it needs neither from
 * you: jq is in the exec image, and the example puts DuckDB, which is not, on the
 * agent's disk.
 *
 * The disks, the layout and the incident follow Archil's "Agentic observability"
 * guide (docs.archil.com/guides/agents/agentic-observability), so the two can be
 * read side by side.
 */

import * as archil from "seaway";

import * as where from "./_where.ts";

const NOW = new Date("2026-11-09T14:30:00Z");
const MINUTE = 60 * 1000;
const SERVICES = ["api", "checkout", "search"];

/** A small seeded generator, so every run makes the same logs. */
function seeded(seed: number): { random(): number; gauss(mean: number, sd: number): number; choice<T>(items: T[]): T } {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (mean: number, sd: number): number =>
    mean + sd * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return { random, gauss, choice: (items) => items[Math.floor(random() * items.length)] };
}

/** Logs from three services on two hosts each, with an incident in checkout over the last ten minutes. */
async function generate(ctx: archil.Context, hours = 6): Promise<number> {
  const rng = seeded(7);
  let total = 0;
  for (const service of SERVICES) {
    for (const host of ["a", "b"]) {
      // One file per writer per hour: <date>/<hour>/<service>-<host>.ndjson. Each host appends
      // to its own file, so no two writers ever contend for a path.
      const log = ctx.log("logs", { writer: `${service}-${host}` });
      for (let minute = 0; minute < hours * 60; minute += 2) {
        const incident = service === "checkout" && minute < 10;
        const batch = [];
        for (let i = 0; i < 12; i++) {
          const failed = rng.random() < (incident ? 0.45 : 0.01);
          batch.push({
            level: failed ? "ERROR" : "INFO",
            service,
            path: rng.choice(["/cart", "/pay", "/search", "/item"]),
            ms: Math.trunc(rng.gauss(incident ? 900 : 120, 40)),
            msg: failed && incident ? "payments-gateway pool exhausted in_use=64/64" : failed ? "upstream timeout" : "ok",
          });
        }
        await log.append(batch, { at: new Date(NOW.getTime() - minute * MINUTE) });
        total += batch.length;
      }
    }
  }
  return total;
}

const backend = where.backend("obs");
// SQL needs an engine. Locally that is the duckdb on your PATH. Archil's exec image has none,
// so there the CLI lives on the agent's own disk, and the context is told where to find it.
const engine = where.onArchil ? { duckdb: "obs/bin/duckdb" } : null;
const ctx = await archil.context(
  {
    logs: where.disk("app-logs", "append", {
      create: true,
      description: "<date>/<hour>/<service>-<host>.ndjson, appended by the services",
    }),
    obs: where.disk("obs-agent", "owned", {
      create: true,
      description: "the observability agent's own disk: reports, cursors, journal",
    }),
  },
  { backend, name: "observability", journal: "obs/journal", tools: engine },
);
if (engine && !(await ctx.exists("obs/bin/duckdb"))) {
  await archil.duckdb(ctx, "obs/bin").run({ check: true }); // one call, once per disk: the binary stays
}
console.log(ctx.describe(), "\n");
console.log(`generated ${(await generate(ctx)).toLocaleString("en-US")} log lines\n`);
const log = ctx.log("logs");

// 0. The first question anyone asks. Building the statement runs nothing; explain() says what
//    running it would mount, how many calls it would make and what it would cost.
const errors = ctx.sql`
  select service, count(*) as errors
  from ${log.last("15m", { now: NOW }) /* the clock is pinned so the example prints the same thing every run */}
  where level = 'ERROR'
  group by 1 order by 2 desc`;
console.log("— errors in the last 15 minutes —");
console.log(String(await errors.explain()));
console.log(JSON.stringify((await errors.run({ check: true })).rows), "\n");

// 1. Triage. Compare the last 15 minutes with the hour before. Each selection is a time range:
//    the call mounts and reads only the partitions that cover it, and in SQL the table is
//    exactly the records inside it.
const since = new Date(NOW.getTime() - 15 * MINUTE);
const recent = log.last("15m", { now: NOW });
const before = log.between(new Date(since.getTime() - 60 * MINUTE), since);
const triage = ctx.sql`
  with recent as (select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n from ${recent} group by 1),
       base   as (select service, avg((level = 'ERROR')::int) as rate from ${before} group by 1)
  select r.service, round(r.rate, 3) as error_rate, round(b.rate, 3) as baseline, r.n as requests
  from recent r join base b using (service)
  where r.rate > greatest(4 * b.rate, 0.05)
  order by error_rate desc
`;
console.log("— triage: what will it do, and what will it cost? —");
console.log(String(await triage.explain()), "\n");
const anomalies = (await triage.run({ check: true })).rows;
console.log("anomalies:", JSON.stringify(anomalies), "\n");

// 2. Search. A regex over every log line is one call, however many files there are.
const search = ctx.grep("pool exhausted", "logs", { globs: ["checkout-*.ndjson"] });
console.log("— search —");
console.log(String(await search.explain()));
const hits = (await search).rows!;
console.log(`${hits.length} matching lines; first: ${hits[0].file}:${hits[0].line}\n`);

// 3. A question nobody planned for, split across calls and summed. The planner splits
//    only because map() says how to put the pieces back together.
const byPath = ctx.sh`cat ${ctx.glob("logs/**/checkout-*.ndjson")} | jq -r 'select(.level == "ERROR") | .path' | sort | uniq -c`.map({
  reduce: "sum_by_key",
  shards: 4,
});
console.log("— errors by path, mapped over the files —");
console.log(String(await byPath.explain()));
const counts: Map<string, number> = (await byPath.run({ check: true })).value; // a Map, largest count first
console.log(Object.fromEntries(counts), "\n");

// 4. A report that knows when it is stale. Refreshing it when nothing changed costs nothing,
//    because checking is a listing and a listing reads no data.
const report = ctx.view(
  "obs/reports/errors-by-service.json",
  () => ctx.sql`select service, count(*)::int as errors from ${log.all()} where level = 'ERROR' group by 1 order by 2 desc`,
);
const built = await report.refresh();
console.log("— report —");
console.log(
  `built in ${built!.meta.calls} call; fresh now: ${await report.fresh()}; second refresh ran: ${(await report.refresh()) !== null}`,
);
console.log((await report.readText()).trim());
console.log("share link:", (await report.share({ expiresIn: 3600 })).slice(0, 60) + "…", "\n");

// 5. An alert that polls for nothing. The feed is a cursor over a listing: when nothing has
//    changed the poll reads no data and makes no call, and when something has, only the files
//    that are new or have grown are handed to the statement. (Here the new records land in a
//    new hour's file. For a file that grew, changes.previous holds its earlier size, so a
//    reader can skip what it has already seen.)
const feed = ctx.feed("logs", { cursor: "obs/cursors/alerts.json" });
await (await feed.poll()).ack(); // everything so far has been seen
console.log("— alert —");
console.log("nothing new:", (await feed.poll()).empty);
await ctx.log("logs", { writer: "checkout-a" }).append(
  Array.from({ length: 3 }, () => ({ level: "ERROR", service: "checkout", path: "/pay", ms: 5000, msg: "payments-gateway unreachable" })),
  { at: new Date(NOW.getTime() + 31 * MINUTE) },
);
const changes = await feed.poll();
console.log("new since the last look:", changes.added.map((f) => f.path));
const alert = ctx.sh`cat ${changes.refs()} | jq -r 'select(.level == "ERROR") | .service + ": " + .msg' | sort | uniq -c`;
console.log((await alert.run({ check: true })).text);
await changes.ack();

// 6. What did all of that cost? The context kept count, and the journal on the agent's own
//    disk has one line per statement, which is itself just a log to query.
console.log("— the bill, as estimated from the public price sheet —");
console.log(String(ctx.spend));
const journal = await ctx.sql`select kind, count(*)::int as statements, sum(calls)::int as calls from ${ctx.log("obs/journal", { partition: "day" }).all()} group by 1 order by 1`.run({ check: true });
console.log("journal:", JSON.stringify(journal.rows));
