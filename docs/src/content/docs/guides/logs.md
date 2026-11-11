---
title: Logs
description: A log is an append-only stream of JSON lines, laid out by hour and by writer so that it is cheap to keep and cheap to question. A selection reads only the part of it a question needs.
---

A log is append-only records at `<path>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`, in UTC, one JSON object per line. The layout does the work: a question about the last fifteen minutes touches an hour or two of data, and many writers never contend for a file.

::example-context

## Append

```python
from datetime import datetime, timezone

# logs/<date>/<hour>/checkout-b.ndjson
log = ctx.log("logs", writer="checkout-b")
written = log.append(
    {
        "level": "ERROR",
        "service": "checkout",
        "path": "/pay",
        "ms": 5000,
        "msg": "payments-gateway unreachable",
    },
    at=datetime(2026, 11, 9, 14, 10, tzinfo=timezone.utc),
)
# several at once, stamped now
log.append([{"level": "INFO", "service": "checkout", "msg": "ok"}] * 3)

print(written)
print(ctx.read_text(written[0]).strip())
```

```ts
// logs/<date>/<hour>/checkout-b.ndjson
const log = ctx.log("logs", { writer: "checkout-b" });
const written = await log.append(
  {
    level: "ERROR",
    service: "checkout",
    path: "/pay",
    ms: 5000,
    msg: "payments-gateway unreachable",
  },
  { at: new Date("2026-11-09T14:10:00Z") },
);
// several at once, stamped now
await log.append(
  Array.from({ length: 3 }, () => ({ level: "INFO", service: "checkout", msg: "ok" })),
);

console.log(written);
console.log((await ctx.readText(written[0])).trim());
```

```text output
['logs/2026-11-09/14/checkout-b.ndjson']
{"ts":"2026-11-09T14:10:00.000Z","id":"…","level":"ERROR","service":"checkout","path":"/pay","ms":5000,"msg":"payments-gateway unreachable"}
```

`append` takes one record or several, and returns the files it wrote. An append uses no compute. It needs a mount in `append`, `owned` or `shared` mode.

## The layout

- **A directory per hour** is what lets a question about the last fifteen minutes touch one hour of data, or two when the fifteen minutes cross the hour. `partition="day"` drops the hour directory, and `partition="none"` drops both.
- **A file per writer** is what lets many machines append without contending for a path. Name the writer after its source: a host, a service instance, an agent.
- **Each record gets `ts` and `id`** unless it already has them. `ts` is ISO 8601 in UTC with milliseconds and a `Z`, so the strings sort in time order. `id` is 12 hex characters.

A few rules follow from that.

- **Give `writer` a stable name.** Left out, it is the context's session id, which is new for every context object, so each run would start a new file.
- **A record's own `ts` decides its partition,** and is kept exactly as written. Write it in the same form (`2026-11-09T14:10:00.000Z`), because selections compare `ts` as text. `at=` gives the time for records that carry none. The default is now.
- **Give a record its own `id` if you retry.** Archil's SDKs never retry an append, and a caller that does may send a record twice. The generated `id` is new on every call. Put an `id` of your own in the record, and a reader can recognise the copy.
- **Appends are sent in pieces of at most 1 MiB.** One record larger than that is refused with `record_too_large`: store the payload as a file and log its path.

Any JSON lines under that layout with an ISO `ts` are a log, whoever wrote them. The format is a directory convention and a two-field envelope.

## Selections

A selection is a time range of a log. It is a statement parameter: pass it where you would pass a path.

```python
from datetime import datetime, timedelta, timezone

log = ctx.log("logs")
now = datetime.now(timezone.utc)

# '30s', '15m', '2h', '7d', or a timedelta
recent = log.last("15m")
# start <= ts < end
earlier = log.between(now - timedelta(hours=2), now - timedelta(minutes=15))
everything = log.all()

spike = ctx.sql(
    """
    with recent as (
      select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n
      from {recent} group by 1
    ),
    base as (
      select service, avg((level = 'ERROR')::int) as rate
      from {before} group by 1
    )
    select r.service, round(r.rate, 3) as error_rate,
           round(b.rate, 3) as baseline, r.n as requests
    from recent r join base b using (service)
    where r.rate > greatest(4 * b.rate, 0.05)
    order by error_rate desc
    """,
    recent=recent, before=earlier,
)
print(spike.run(check=True).rows)
```

```ts
const log = ctx.log("logs");
const now = Date.now();

// "30s", "15m", "2h", "7d", or a number of milliseconds
const recent = log.last("15m");
// start <= ts < end
const earlier = log.between(new Date(now - 2 * 3600_000), new Date(now - 15 * 60_000));
const everything = log.all();

const spike = ctx.sql`
  with recent as (
    select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n
    from ${recent} group by 1
  ),
  base as (
    select service, avg((level = 'ERROR')::int) as rate
    from ${earlier} group by 1
  )
  select r.service, round(r.rate, 3) as error_rate,
         round(b.rate, 3) as baseline, r.n as requests
  from recent r join base b using (service)
  where r.rate > greatest(4 * b.rate, 0.05)
  order by error_rate desc`;
console.log((await spike.run({ check: true })).rows);
```

```text output
[{'service': 'checkout', 'error_rate': 0.6, 'baseline': 0.0, 'requests': 5}]
```

That is a triage in one call: the last fifteen minutes against the hour and three quarters before.

### What a range does

The range does two jobs.

1. **From a listing, which reads nothing, it picks the partitions that can hold such records.** Those are the only files the statement mounts and reads. The call mounts the smallest directory that covers them: an hour's directory, the day's when the range crosses hours, or the log's own when it crosses midnight.
2. **In `sql` it is also a filter on `ts`,** so the table is exactly the records in the range. `between` filters both ends. `last` filters from its start, since nothing is later than now.

In `sh` a selection is the files, and a partition is a whole hour or day. If the edges matter there, filter on `ts` in the command.

```plan
plan 9af6b2227225  sql · 3 file(s), 1.9 KiB · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   logs/2026-11-10/14 → app-logs:/2026-11-10/14 (read-only)
          not mounted: docs, memory, team
  reads   logs[last 15m]
```

- A time without a zone is taken as UTC.
- `last(span, now=...)` pins the clock, which makes a script's output repeatable.
- A selection that matches no files makes a `sql` statement a no-op that returns no rows.

## Other partitions

```python
# memory/audit/<date>/agent-7.ndjson
audit = ctx.log("memory/audit", partition="day", writer="agent-7")
# memory/events/agent-7.ndjson
flat = ctx.log("memory/events", partition="none", writer="agent-7")
when = datetime(2026, 11, 9, tzinfo=timezone.utc)
print(audit.append({"did": "rotated the keys"}, at=when))
print(flat.append({"did": "filed expenses"}))
```

```ts
// memory/audit/<date>/agent-7.ndjson
const audit = ctx.log("memory/audit", { partition: "day", writer: "agent-7" });
// memory/events/agent-7.ndjson
const flat = ctx.log("memory/events", { partition: "none", writer: "agent-7" });
const when = new Date("2026-11-09T00:00:00Z");
console.log(await audit.append({ did: "rotated the keys" }, { at: when }));
console.log(await flat.append({ did: "filed expenses" }));
```

```text output
['memory/audit/2026-11-09/agent-7.ndjson']
['memory/events/agent-7.ndjson']
```

Use `day` for a log that is read a day at a time, such as a [journal](/guides/journal/). Use `none` for a small log that is always read whole. To query a log, open it with the partition it was written with.

## With only bash

To write a log from something that is not the SDK, append lines of that shape to a file of that name.

```bash
printf '{"ts":"%s","id":"%s","level":"INFO","msg":"hello"}\n' \
  "$(date -u +%FT%T.000Z)" "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')" \
  >> "logs/$(date -u +%F)/$(date -u +%H)/shell-1.ndjson"
```

To read one, any tool that reads JSON lines will do:

```bash
cat logs/$(date -u +%F)/$(date -u +%H)/*.ndjson \
  | jq -r 'select(.level == "ERROR") | .ts + " " + .service + " " + .msg'
```

Inside a statement those paths are as written. The first needs the mount to be writable in the call, and on an `append` mount it is not: commands see append-only data read-only, and records go in through `append`.

## Next

:::cards
- [Views](/guides/views/) A report over a log, rebuilt only when the log changed.
- [Feeds](/guides/feeds/) Start work from new records, not from a clock.
- [Observability on a disk](/blueprints/observability/) Ingest, triage, search, a report and an alert.
:::
