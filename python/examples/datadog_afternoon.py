"""Observability on a disk, in one file.

Services append JSON lines to a disk. Everything else is a statement against
it: a triage query, a search, a report that rebuilds itself only when the logs
change, an alert that starts from new data instead of from a clock. There is no
collector, no ingest service and no index, and nothing runs between questions.

    python examples/datadog_afternoon.py             # on the local backend, with generated logs
    python examples/datadog_afternoon.py --archil    # the same code on Archil; see _where.py

Locally it needs the duckdb CLI on PATH (pip install duckdb-cli) and jq. On Archil
it needs neither from you: jq is in the exec image, and the example puts DuckDB,
which is not, on the agent's disk.

The disks, the layout and the incident follow Archil's "Agentic observability"
guide (docs.archil.com/guides/agents/agentic-observability), so the two can be
read side by side.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import seaway as archil

import _where as where

NOW = datetime(2026, 11, 9, 14, 30, tzinfo=timezone.utc)
SERVICES = ("api", "checkout", "search")
random.seed(7)


def generate(ctx: archil.Context, hours: int = 6) -> int:
    """Logs from three services on two hosts each, with an incident in checkout over the last ten minutes."""
    total = 0
    for service in SERVICES:
        for host in ("a", "b"):
            # One file per writer per hour: <date>/<hour>/<service>-<host>.ndjson. Each host appends
            # to its own file, so no two writers ever contend for a path.
            log = ctx.log("logs", writer=f"{service}-{host}")
            for minute in range(0, hours * 60, 2):
                incident = service == "checkout" and minute < 10
                batch = []
                for _ in range(12):
                    failed = random.random() < (0.45 if incident else 0.01)
                    batch.append({
                        "level": "ERROR" if failed else "INFO", "service": service,
                        "path": random.choice(["/cart", "/pay", "/search", "/item"]),
                        "ms": int(random.gauss(900 if incident else 120, 40)),
                        "msg": "payments-gateway pool exhausted in_use=64/64" if failed and incident
                        else ("upstream timeout" if failed else "ok"),
                    })
                log.append(batch, at=NOW - timedelta(minutes=minute))
                total += len(batch)
    return total


def main() -> None:
    backend = where.backend("obs")
    # SQL needs an engine. Locally that is the duckdb on your PATH. Archil's exec image has none,
    # so there the CLI lives on the agent's own disk, and the context is told where to find it.
    engine = {"duckdb": "obs/bin/duckdb"} if where.ON_ARCHIL else None
    ctx = archil.context(
        {
            "logs": where.disk("app-logs", "append", create=True,
                               description="<date>/<hour>/<service>-<host>.ndjson, appended by the services"),
            "obs": where.disk("obs-agent", "owned", create=True,
                              description="the observability agent's own disk: reports, cursors, journal"),
        },
        backend=backend, name="observability", journal="obs/journal", tools=engine,
    )
    if engine and not ctx.exists("obs/bin/duckdb"):
        archil.duckdb(ctx, "obs/bin").run(check=True)  # one call, once per disk: the binary stays
    print(ctx.describe(), "\n")
    print(f"generated {generate(ctx):,} log lines\n")
    log = ctx.log("logs")

    # 0. The first question anyone asks. Building the statement runs nothing; explain() says what
    #    running it would mount, how many calls it would make and what it would cost.
    errors = ctx.sql(
        """
        select service, count(*) as errors
        from {recent}
        where level = 'ERROR'
        group by 1 order by 2 desc
        """,
        recent=log.last("15m", now=NOW),  # the clock is pinned so the example prints the same thing every run
    )
    print("— errors in the last 15 minutes —")
    print(errors.explain())
    print(errors.run(check=True).rows, "\n")

    # 1. Triage. Compare the last 15 minutes with the hour before. Each selection is a time range:
    #    the call mounts and reads only the partitions that cover it, and in SQL the table is
    #    exactly the records inside it.
    since = NOW - timedelta(minutes=15)
    triage = ctx.sql(
        """
        with recent as (select service, avg((level = 'ERROR')::int) as rate, count(*)::int as n from {recent} group by 1),
             base   as (select service, avg((level = 'ERROR')::int) as rate from {before} group by 1)
        select r.service, round(r.rate, 3) as error_rate, round(b.rate, 3) as baseline, r.n as requests
        from recent r join base b using (service)
        where r.rate > greatest(4 * b.rate, 0.05)
        order by error_rate desc
        """,
        recent=log.last("15m", now=NOW),
        before=log.between(since - timedelta(hours=1), since),
    )
    print("— triage: what will it do, and what will it cost? —")
    print(triage.explain(), "\n")
    anomalies = triage.run(check=True).rows
    print("anomalies:", anomalies, "\n")

    # 2. Search. A regex over every log line is one call, however many files there are.
    search = ctx.grep("pool exhausted", "logs", globs=["checkout-*.ndjson"])
    print("— search —")
    print(search.explain())
    hits = search.run().rows
    print(f"{len(hits)} matching lines; first: {hits[0]['file']}:{hits[0]['line']}\n")

    # 3. A question nobody planned for, split across calls and summed. The planner splits
    #    only because map() says how to put the pieces back together.
    by_path = ctx.sh(
        "cat {files} | jq -r 'select(.level == \"ERROR\") | .path' | sort | uniq -c",
        files=ctx.glob("logs/**/checkout-*.ndjson"),
    ).map(reduce="sum_by_key", shards=4)
    print("— errors by path, mapped over the files —")
    print(by_path.explain())
    print(by_path.run(check=True).value, "\n")

    # 4. A report that knows when it is stale. Refreshing it when nothing changed costs nothing,
    #    because checking is a listing and a listing reads no data.
    report = ctx.view(
        "obs/reports/errors-by-service.json",
        lambda: ctx.sql("select service, count(*)::int as errors from {events} where level = 'ERROR' "
                        "group by 1 order by 2 desc", events=log.all()),
    )
    built = report.refresh()
    print("— report —")
    print(f"built in {built.meta.calls} call; fresh now: {report.fresh}; second refresh ran: {report.refresh() is not None}")
    print(report.read_text().strip())
    print("share link:", report.share(expires_in=3600)[:60] + "…", "\n")

    # 5. An alert that polls for nothing. The feed is a cursor over a listing: when nothing has
    #    changed the poll reads no data and makes no call, and when something has, only the files
    #    that are new or have grown are handed to the statement. (Here the new records land in a
    #    new hour's file. For a file that grew, changes.previous holds its earlier size, so a
    #    reader can skip what it has already seen.)
    feed = ctx.feed("logs", cursor="obs/cursors/alerts.json")
    feed.poll().ack()  # everything so far has been seen
    print("— alert —")
    print("nothing new:", not feed.poll())
    ctx.log("logs", writer="checkout-a").append(
        [{"level": "ERROR", "service": "checkout", "path": "/pay", "ms": 5000, "msg": "payments-gateway unreachable"}] * 3,
        at=NOW + timedelta(minutes=31))
    changes = feed.poll()
    print("new since the last look:", [f.path for f in changes.added])
    alert = ctx.sh("cat {new} | jq -r 'select(.level == \"ERROR\") | .service + \": \" + .msg' | sort | uniq -c",
                   new=changes.refs())
    print(alert.run(check=True).text)
    changes.ack()

    # 6. What did all of that cost? The context kept count, and the journal on the agent's own
    #    disk has one line per statement, which is itself just a log to query.
    print("— the bill, as estimated from the public price sheet —")
    print(ctx.spend)
    journal = ctx.sql("select kind, count(*)::int as statements, sum(calls)::int as calls from {j} group by 1 order by 1",
                      j=ctx.log("obs/journal", partition="day").all()).run(check=True)
    print("journal:", journal.rows)


if __name__ == "__main__":
    main()
