"""Logs and views: structures built from the same verbs."""

import json
from datetime import datetime, timedelta, timezone

import pytest

import seaway as archil

from conftest import needs_duckdb

NOW = datetime(2026, 11, 9, 14, 30, tzinfo=timezone.utc)


def fill(ctx, hours=4, writers=("web-1", "web-2")):
    for writer in writers:
        log = ctx.log("logs/api", writer=writer)
        for h in range(hours):
            log.append([{"level": "ERROR" if i % 10 == 0 else "INFO", "ms": i} for i in range(20)],
                       at=NOW - timedelta(hours=h))


def test_log_layout_is_an_hour_per_directory_and_a_file_per_writer(ctx):
    paths = ctx.log("logs/api", writer="web-1").append({"level": "INFO", "msg": "hello"}, at=NOW)
    assert paths == ["logs/api/2026-11-09/14/web-1.ndjson"]
    record = json.loads(ctx.read_text(paths[0]))
    assert record["msg"] == "hello" and record["ts"].startswith("2026-11-09T14:30") and len(record["id"]) == 12


def test_a_selection_touches_only_the_partitions_the_question_needs(ctx):
    fill(ctx)
    log = ctx.log("logs/api")
    recent = log.last("45m", now=NOW)
    files = ctx.expand(recent)
    assert sorted(f.path for f in files) == ["logs/api/2026-11-09/13/web-1.ndjson", "logs/api/2026-11-09/13/web-2.ndjson",
                                            "logs/api/2026-11-09/14/web-1.ndjson", "logs/api/2026-11-09/14/web-2.ndjson"]
    assert len(ctx.expand(log.all())) == 8

    plan = ctx.sh("cat {events} | wc -l", events=log.last("20m", now=NOW)).explain()
    assert plan.files == 2
    assert list(plan.tasks[0].mounts) == ["logs/api/2026-11-09/14"]  # one hour of one log, read-only
    everything = ctx.sh("cat {events} | wc -l", events=log.all()).explain()
    assert plan.estimate.bytes_touched * 4 == everything.estimate.bytes_touched


def test_appending_to_a_read_only_mount_is_refused(ctx):
    with pytest.raises(archil.ValidationError):
        ctx.log("ref/events").append({"x": 1})


@needs_duckdb
def test_sql_over_a_log_selection(ctx):
    fill(ctx)
    rows = ctx.sql("select level, count(*)::int as n from {events} group by 1 order by 1",
                   events=ctx.log("logs/api").last("20m", now=NOW)).run(check=True).rows
    assert rows == [{"level": "ERROR", "n": 4}, {"level": "INFO", "n": 36}]


def test_a_view_rebuilds_only_when_its_inputs_change(ctx, backend):
    fill(ctx, hours=1)
    log = ctx.log("logs/api")
    view = ctx.view("work/reports/errors.txt",
                    lambda: ctx.sh("cat {events} | grep -c ERROR", events=log.all()))
    assert not view.fresh
    first = view.refresh()
    assert first.ok and ctx.read_text("work/reports/errors.txt").strip() == "4"
    calls = len(backend.exec_log)
    assert view.fresh and view.refresh() is None  # nothing changed: nothing ran
    assert len(backend.exec_log) == calls

    ctx.log("logs/api", writer="web-3").append({"level": "ERROR"}, at=NOW)
    assert not view.fresh
    assert view.read_text().strip() == "5"  # reading a stale view refreshes it first
    assert len(backend.exec_log) == calls + 1


def test_durations_are_checked(ctx):
    with pytest.raises(archil.ValidationError):
        ctx.log("logs/api").last("a while")


def test_a_feed_reports_what_changed_until_it_is_acknowledged(ctx):
    ctx.append("logs/inbox/a.txt", "one\n")
    ctx.append("logs/inbox/b.txt", "one\n")
    feed = ctx.feed("logs/inbox", cursor="work/cursors/inbox.json")

    first = feed.poll()
    assert [f.path for f in first.added] == ["logs/inbox/a.txt", "logs/inbox/b.txt"] and not first.modified
    again = feed.poll()  # not acknowledged yet: delivered again
    assert [f.path for f in again.added] == [f.path for f in first.added]
    first.ack()
    assert not feed.poll()

    ctx.append("logs/inbox/a.txt", "two\n")  # an existing file grows
    ctx.append("logs/inbox/c.txt", "new\n")
    changes = feed.poll()
    assert [f.path for f in changes.added] == ["logs/inbox/c.txt"]
    assert [f.path for f in changes.modified] == ["logs/inbox/a.txt"] and changes.previous == {"logs/inbox/a.txt": 4}
    # the changed files are statement parameters: only they are read, and only their directory is mounted
    result = ctx.sh("cat {new}", new=changes.refs()).run(check=True)
    assert sorted(result.lines) == ["new", "one", "two"]
    assert list(result.plan.tasks[0].mounts) == ["logs/inbox"]
    changes.ack()
    assert not feed.poll()


def test_a_feed_sees_removals_and_keeps_its_cursor_out_of_the_listing(ctx):
    ctx.write("work/drop/x.txt", "x")
    feed = ctx.feed("work", cursor="work/cursor.json")
    feed.poll().ack()
    ctx.rm("work/drop/x.txt")
    changes = feed.poll()
    assert changes.removed == ["work/drop/x.txt"] and not changes.added and not changes.modified
