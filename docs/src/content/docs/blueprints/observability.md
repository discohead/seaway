---
title: Observability on a disk
description: Services append JSON lines to a disk, and everything else is a statement against it. There is no collector, no ingest service and no index, and nothing runs between questions.
---

Services append JSON lines to a disk. A triage is a query, a search is one call, a report is a view, and an alert is a feed. Nothing runs between questions.

| Disk | Mode | Layout |
|---|---|---|
| `app-logs` | `append` | `<date>/<hour>/<service>-<host>.ndjson`; one writer per file |
| `obs-agent` | `owned` | `reports/` (views), `cursors/` (feeds), `journal/`, and `bin/duckdb` on Archil |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

obs = archil.context(
    {
        "logs": archil.disk(
            "app-logs",
            "append",
            create=True,
            description="<date>/<hour>/<service>-<host>.ndjson",
        ),
        "obs": archil.disk(
            "obs-agent", "owned", create=True, description="reports, cursors, journal",
        ),
    },
    backend=backend, name="observability", journal="obs/journal",
)

# Ingest: each host appends to its own file. No collector, and no compute.
obs.log("logs", writer="checkout-a").append([
    {
        "level": "ERROR",
        "service": "checkout",
        "path": "/pay",
        "ms": 5000,
        "msg": "payments-gateway pool exhausted",
    },
    {"level": "INFO", "service": "checkout", "path": "/cart", "ms": 120, "msg": "ok"},
])
log = obs.log("logs")

# Triage: one call, one hour's directory, read-only.
triage = obs.sql(
    "select service, count(*)::int as errors from {recent} "
    "where level = 'ERROR' group by 1 order by 2 desc",
    recent=log.last("15m"),
)
# Search: one call, however many files.
search = obs.grep("pool exhausted", "logs", globs=["checkout-*.ndjson"])
# A report: rebuilt only when the logs changed.
report = obs.view(
    "obs/reports/errors-by-service.json",
    lambda: obs.sql(
        "select service, count(*)::int as errors from {e} "
        "where level = 'ERROR' group by 1",
        e=log.all(),
    ),
)
# An alert: a poll is a listing.
alerts = obs.feed("logs", cursor="obs/cursors/alerts.json")

print(triage.explain().unmounted)
print(triage.run(check=True).rows)
print(len(search.run().rows), report.refresh().meta.calls, bool(alerts.poll()))
print(obs.spend)
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const obs = await archil.context(
  {
    logs: archil.disk("app-logs", "append", {
      create: true,
      description: "<date>/<hour>/<service>-<host>.ndjson",
    }),
    obs: archil.disk("obs-agent", "owned", {
      create: true,
      description: "reports, cursors, journal",
    }),
  },
  { backend, name: "observability", journal: "obs/journal" },
);

// Ingest: each host appends to its own file. No collector, and no compute.
await obs.log("logs", { writer: "checkout-a" }).append([
  {
    level: "ERROR",
    service: "checkout",
    path: "/pay",
    ms: 5000,
    msg: "payments-gateway pool exhausted",
  },
  { level: "INFO", service: "checkout", path: "/cart", ms: 120, msg: "ok" },
]);
const log = obs.log("logs");

// Triage: one call, one hour's directory, read-only.
const triage = obs.sql`
  select service, count(*)::int as errors from ${log.last("15m")}
  where level = 'ERROR' group by 1 order by 2 desc`;
// Search: one call, however many files.
const search = obs.grep("pool exhausted", "logs", { globs: ["checkout-*.ndjson"] });
// A report: rebuilt only when the logs changed.
const report = obs.view("obs/reports/errors-by-service.json", () => obs.sql`
  select service, count(*)::int as errors from ${log.all()}
  where level = 'ERROR' group by 1`);
// An alert: a poll is a listing.
const alerts = obs.feed("logs", { cursor: "obs/cursors/alerts.json" });

console.log((await triage.explain()).unmounted);
console.log((await triage.run({ check: true })).rows);
console.log(
  (await search.run()).rows?.length,
  (await report.refresh())?.meta.calls,
  !(await alerts.poll()).empty,
);
console.log(String(obs.spend));
```

```text output
['obs']
[{'service': 'checkout', 'errors': 1}]
1 1 True
3 statement(s): 3 call unit(s) $0.00015, … kept active <$0.00001, 0 B egress $0; total ≈ $0.00015
```

Four questions, three calls. The triage mounted one hour's directory of one disk, and the agent's own disk was not mounted at all.

## What to watch

- **The hour directory is what keeps the recurring cost down.** A triage that reads the last fifteen minutes every five keeps between one and a quarter and two and a quarter hours of logs active, not the whole archive.
- **On Archil, `ctx.sql` needs DuckDB on a disk.** Put it at `obs/bin/duckdb` with `archil.duckdb(obs, "obs/bin")`, and open the context with `tools={"duckdb": "obs/bin/duckdb"}`. See [Run on Archil](/guides/archil/#sql-needs-duckdb-on-a-disk).
- **A question nobody planned for** is a [mapped `sh`](/guides/batch-and-map/#map-one-input-across-many-calls) over a glob, with a reducer.
- **The journal is the agent's own telemetry.** It is a log, so `obs.sql` can total it: what did the last hour of questions cost?

## What it costs

Thirty days of logs at 5 GiB a day comes to about $4.60 a month by the price sheet, nearly all of it archive. At 50 GiB a day the same shape is about $42. [Prices and budgets](/guides/prices/#what-a-workload-costs-in-a-month) has the arithmetic.

## What it is not

This is a back end, not a product. There is no UI, no alert routing, and no metrics or traces. The claim is narrower: the back end reduces to a layout and a handful of statements, and those are things an agent can write.

The repository's [`datadog_afternoon` example](/start/examples/#the-datadog-afternoon) is this at full length, over about thirteen thousand generated log lines.

## Next

:::cards
- [Logs](/guides/logs/) The layout, and selections over it.
- [Work that starts from a change](/blueprints/change-driven/) The alert, as a scheduled job.
:::
