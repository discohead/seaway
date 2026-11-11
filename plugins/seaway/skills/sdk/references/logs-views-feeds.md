# Logs, views and feeds

Three structures built from the same verbs. A **log** is an append-only stream laid out so that it is cheap to keep and cheap to question. A **view** is a statement with a name: a derived file that rebuilds only when its inputs changed. A **feed** is a cursor over a listing: what was added, changed or removed since a reader last looked.

All three are plain files on the disk they concern, so either SDK, or an agent with only bash, can read them. See [files-on-disk.md](files-on-disk.md).

## Contents

- [Logs](#logs)
- [Selections: the part of a log a question needs](#selections-the-part-of-a-log-a-question-needs)
- [Views](#views)
- [Feeds](#feeds)
- [Putting them together](#putting-them-together)

## Logs

```python
log = ctx.log("logs", writer="checkout-a")          # logs/<date>/<hour>/checkout-a.ndjson
written = log.append({"level": "ERROR", "service": "checkout", "path": "/pay", "ms": 5000,
                      "msg": "payments-gateway unreachable"})
log.append([{"level": "INFO", "service": "checkout", "msg": "ok"}] * 3)     # several at once
print(written)                                      # ['logs/2026-11-10/09/checkout-a.ndjson']
```

```ts
const log = ctx.log("logs", { writer: "checkout-a" });
const written = await log.append({ level: "ERROR", service: "checkout", path: "/pay", ms: 5000, msg: "payments-gateway unreachable" });
await log.append([{ level: "INFO", service: "checkout", msg: "ok" }, { level: "INFO", service: "checkout", msg: "ok" }]);
console.log(written);
```

The layout is `<path>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`, in UTC, one JSON object per line.

- **A directory per hour** is what lets a question about the last fifteen minutes touch one hour of data. `partition="day"` drops the hour directory and `partition="none"` drops both.
- **A file per writer** is what lets many machines append without contending for a path. Name the writer after its source: a host, a service instance, an agent. Left out, it is the context's session id, which is new for every context object, so each run would start a new file.
- **Each record gets `ts` and `id`** unless it already has them: `ts` is ISO 8601 in UTC with milliseconds and a `Z` (`2026-11-09T14:10:00.000Z`), and `id` is 12 hex characters. A record's own `ts` decides its partition and is kept exactly as written, so write it in that same form: selections compare `ts`, and strings in one form sort in time order. `at=` gives the time for records that carry none; the default is now.
- **Give a record its own `id` if you retry.** Archil's SDKs never retry an append. A caller that does may send a record twice. The generated `id` is new on every call, so a second `append` of the same record gets a different one: put an `id` of your own in the record, and a reader can recognise the copy.
- An append uses no compute. It needs a mount in `append`, `owned` or `shared` mode. Appends are sent in pieces of at most 1 MiB, and one record larger than that is refused (`record_too_large`).

Any JSON lines under that layout with an ISO `ts` are a log, whoever wrote them. The format is a directory convention and a two-field envelope.

## Selections: the part of a log a question needs

```python
from datetime import datetime, timedelta, timezone

log = ctx.log("logs")
recent = log.last("15m")                                   # '30s', '15m', '2h', '7d', or a timedelta
now = datetime.now(timezone.utc)
earlier = log.between(now - timedelta(hours=2), now - timedelta(minutes=15))    # start <= ts < end
everything = log.all()

spike = ctx.sql(
    """
    with recent as (select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n from {recent} group by 1),
         base   as (select service, avg((level = 'ERROR')::int) as rate from {before} group by 1)
    select r.service, round(r.rate, 3) as error_rate, round(b.rate, 3) as baseline, r.n as requests
    from recent r join base b using (service)
    where r.rate > greatest(4 * b.rate, 0.05)
    order by error_rate desc
    """,
    recent=recent, before=earlier,
)
print(spike.explain())
print(spike.run(check=True).rows)
```

```ts
const log = ctx.log("logs");
const recent = log.last("15m");                            // "30s", "15m", "2h", "7d", or a number of milliseconds
const now = new Date();
const earlier = log.between(new Date(now.getTime() - 2 * 3600_000), new Date(now.getTime() - 15 * 60_000));
const everything = log.all();

const spike = ctx.sql`
  with recent as (select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n from ${recent} group by 1),
       base   as (select service, avg((level = 'ERROR')::int) as rate from ${earlier} group by 1)
  select r.service, round(r.rate, 3) as error_rate, round(b.rate, 3) as baseline, r.n as requests
  from recent r join base b using (service)
  where r.rate > greatest(4 * b.rate, 0.05)
  order by error_rate desc`;
console.log(String(await spike.explain()));
console.log((await spike.run({ check: true })).rows);
```

A selection is a time range, and the range does two jobs.

1. **From a listing, which reads nothing, it picks the partitions that can hold such records.** Those are the only files the statement mounts and reads, and the call mounts the smallest directory that covers them: an hour's directory, the day's when the range crosses hours, or the log's own when it crosses midnight.
2. **In `sql` it is also a filter on `ts`,** so the table is exactly the records in the range. `between` filters both ends; `last` filters from its start, since nothing is later than now.

In `sh` a selection is the files, and a partition is a whole hour (or day). If the edges matter there, filter on `ts` in the command.

A time without a zone is taken as UTC. `last(span, now=...)` pins the clock, which makes a script's output repeatable. A selection that matches no files makes a `sql` statement a no-op that returns no rows.

## Views

```python
log = ctx.log("logs")
report = ctx.view(
    "memory/reports/errors-by-service.json",
    lambda: ctx.sql("select service, count(*)::int as errors from {events} where level = 'ERROR' group by 1 order by 2 desc",
                    events=log.all()),
)
built = report.refresh()            # builds it: one call
again = report.refresh()            # nothing changed, so nothing runs: None
print(built.meta.calls, again, report.fresh)
print(report.read_text())           # refreshes if stale, then reads the file
link = report.share(expires_in=3600)
```

```ts
const log = ctx.log("logs");
const report = ctx.view(
  "memory/reports/errors-by-service.json",
  () => ctx.sql`select service, count(*)::int as errors from ${log.all()} where level = 'ERROR' group by 1 order by 2 desc`,
);
const built = await report.refresh();
const again = await report.refresh();     // null
console.log(built.meta.calls, again, await report.fresh());
console.log(await report.readText());
const link = await report.share({ expiresIn: 3600 });
```

- **The path** is where the derived file lives. It has to be on a mount the context can write.
- **The build** is a statement, or a function that returns one. A function is the better habit: it is called afresh each time, so a selection such as `last("1h")` is taken at the time of the refresh. The builder must be a plain function, not an `async` one, because an `async` function that returns a statement runs it.
- **Output.** If the statement neither has `into()` nor writes through an `out` parameter, the view sends its output into the view's path. For `sql` the format follows the path's extension: JSON lines, `.csv` or `.parquet`.
- **Freshness.** A view fingerprints its statement and its inputs: each input file's path, size and version, from a listing. `refresh()` compares that with the fingerprint recorded at the last build and skips the build when they match. Checking costs nothing, because a listing reads no data. `refresh(force=True)` builds regardless.
- **Inputs** are the statement's own read parameters: its paths, globs and selections. When the statement declares nothing, or depends on more than it names, say so: `ctx.view(path, build, inputs=["logs/**/*.ndjson", "docs/security"])`.
- **A changed statement is a stale view.** The template and the parameters are in the fingerprint.
- **A failed build records nothing,** so the next `refresh()` tries again.
- **`refresh()` returns** the build's `Result`, or `None`/`null` when nothing ran. `read()` and `read_text()` refresh first. `share()` returns a link to hand to a person.

A view's definition is not stored on the disk. Only its output and a small state file are, so rebuilding a view needs the code that defined it. That state file is under `.px/`, which a turn's commit does not carry over: a view refreshed inside a turn lands its output, and then builds once more the first time it is refreshed on the main line. On Archil, a view built from a file written under about a second and a half ago also builds once more on its next refresh; see [backends.md](backends.md#versions-rest-on-a-clock).

## Feeds

```python
feed = ctx.feed("logs", cursor="memory/cursors/alerts.json")
feed.poll().ack()                               # the first poll hands over everything; call it seen

ctx.log("logs", writer="checkout-b").append({"level": "ERROR", "service": "checkout", "msg": "payments-gateway unreachable"})

changes = feed.poll()                           # a listing: no call, no data read
if changes:
    print([f.path for f in changes.added], [f.path for f in changes.modified], changes.removed)
    alert = ctx.sh("cat {new} | jq -r 'select(.level == \"ERROR\") | .service + \": \" + .msg' | sort | uniq -c",
                   new=changes.refs())          # only the files that are new or have changed
    print(alert.run(check=True).text)
    changes.ack()                               # move the cursor; until then the next poll returns these again
```

```ts
const feed = ctx.feed("logs", { cursor: "memory/cursors/alerts.json" });
await (await feed.poll()).ack();

await ctx.log("logs", { writer: "checkout-b" }).append({ level: "ERROR", service: "checkout", msg: "payments-gateway unreachable" });

const changes = await feed.poll();
if (!changes.empty) {
  console.log(changes.added.map((f) => f.path), changes.modified.map((f) => f.path), changes.removed);
  const alert = ctx.sh`cat ${changes.refs()} | jq -r 'select(.level == "ERROR") | .service + ": " + .msg' | sort | uniq -c`;
  console.log((await alert.run({ check: true })).text);
  await changes.ack();
}
```

- **A poll is a listing** compared with what the cursor recorded. When nothing changed it reads no data and makes no call, so polling often is cheap.
- **`changes`** has `added` and `modified` (files, each with `path`, `size`, `modified` and `version`), `removed` (paths), and `files` (added then modified). In Python it is falsy when there is nothing to do; in TypeScript ask `changes.empty`.
- **`changes.refs()`** is the added and modified files as statement parameters, so the statement mounts and reads only those.
- **`changes.previous[path]`** is the size a modified file had before. A file that was appended to grew from there, so a reader can skip what it has seen: `tail -c +{start}` with `start = previous + 1`.
- **`ack()` moves the cursor.** Until then `poll()` returns the same changes, so a reader that stops half-way sees them again. Delivery is at least once: make the handling safe to repeat.
- **The cursor** is a small file on a mount the context can write. Each reader keeps its own. A cursor that lives under the watched path is left out of the changes.
- A changed file is handed over whole, not as a diff. A feed is a poll, not a push, and each poll lists the whole path.

## Putting them together

Services append to a log. A triage is a `sql` over two selections. A report is a view over the log. An alert is a feed that hands new files to a statement. The agent's own telemetry is a journal, which is a log too.

```python
obs = archil.context(
    {"logs": archil.disk("app-logs", "append"), "obs": archil.disk("obs-agent", "owned", create=True)},
    backend=backend, name="observability", journal="obs/journal",
)
log = obs.log("logs")
obs.view("obs/reports/by-level.json",
         lambda: obs.sql("select level, count(*)::int as n from {e} group by 1 order by 1", e=log.all())).refresh()
obs.sh("cat {f} | wc -l", f=obs.glob("logs/**/*.ndjson")).run(check=True)

# what did that cost, and where did it go? the journal answers with the same verbs
journal = obs.sql("select kind, count(*)::int as statements, sum(calls)::int as calls, sum(usd) as usd from {j} group by 1 order by 1",
                  j=obs.log("obs/journal", partition="day").all())
print(journal.run(check=True).rows)
print(obs.spend)
```

The SDK's `examples/datadog_afternoon` is this at full length: ingest, triage, search, a mapped question, a report and an alert, in one file per language.
