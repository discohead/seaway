# Blueprints

Worked designs to start from. Each gives the context, the layout and the statements that matter, and says what to watch. The code is Python, the reference SDK; the TypeScript is the same calls in camel case, and the SDK's `examples/` have full twins of the first two.

In every example `archil` is `import seaway as archil` and `backend` is the backend the program runs on. Each creates the disks it names (`create=True`), so it runs on an empty local root.

## Contents

- [An agent's context](#an-agents-context)
- [Observability on a disk](#observability-on-a-disk)
- [A mirror of a system of record](#a-mirror-of-a-system-of-record)
- [Several attempts, and adopting one](#several-attempts-and-adopting-one)
- [A helper that is handed less](#a-helper-that-is-handed-less)
- [A run that can be replayed](#a-run-that-can-be-replayed)
- [Records many agents edit](#records-many-agents-edit)
- [Work that starts from a change](#work-that-starts-from-a-change)

## An agent's context

Five kinds of data under five rules: what the organisation knows how to do, reference data from a system of record, the agent's own memory, notes a team shares, and a record of what was done.

```python
platform = archil.context({"skills": archil.disk("org-skills", "owned", create=True)}, backend=backend)
platform.sync(archil.Static({"triage.md": "# Triage\nReproduce first. Then bisect.\n"},
                            name="skills", layout="One Markdown file per skill."), into="skills")
platform.checkpoint("2026-11-01")                    # a release: what agents pin to

ctx = archil.context(
    {
        "skills":  archil.disk("org-skills", "frozen", at="2026-11-01", description="how we work, pinned to a release"),
        "tracker": archil.disk("tracker-mirror", "read", create=True, description="issues, mirrored from the tracker"),
        "memory":  archil.disk("agent-7-memory", "owned", create=True, description="this agent's own notes"),
        "team":    archil.disk("team-notes", "shared", create=True, description="notes the whole team writes"),
        "audit":   archil.disk("audit-log", "append", create=True, description="what was done, and by whom"),
    },
    backend=backend, name="agent-7", journal="audit/agent-7",
)
print(ctx.describe())

with ctx.transaction(writes=["team", "memory"]) as turn:      # a note and the memory of it, together
    turn.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=turn.out("team/standup.md")).run(check=True)
    turn.write("memory/eng-1.md", "Closed after the coupon fix.\n")
```

| Disk | Mode | Layout |
|---|---|---|
| `org-skills` | `frozen` here; `owned` by the team that publishes it | one Markdown file per skill; a checkpoint per release |
| `tracker-mirror` | `read` here; `owned` by the job that syncs it | see [a mirror](#a-mirror-of-a-system-of-record) |
| `agent-7-memory` | `owned` | one file per thing remembered; `state.db` if it needs keyed state |
| `team-notes` | `shared` | a file per topic, and per writer where writers would collide |
| `audit-log` | `append` | the journal: `agent-7/<date>/<session>.ndjson` |

- A new release of the skills changes nothing for this agent until it is opened `at` the new checkpoint. That is the point of pinning.
- The journal is on the append-only disk on purpose: it records at once, cannot be rewritten, and keeps the lines of a turn that later failed.
- Writers to `team` that may touch the same file use a turn and retry on `Conflict`.
- The SDK's `examples/agent_context` is this at full length.

## Observability on a disk

Services append JSON lines to a disk. Everything else is a statement against it. There is no collector, no ingest service and no index, and nothing runs between questions.

```python
obs = archil.context(
    {
        "logs": archil.disk("app-logs", "append", create=True, description="<date>/<hour>/<service>-<host>.ndjson"),
        "obs":  archil.disk("obs-agent", "owned", create=True, description="reports, cursors, journal"),
    },
    backend=backend, name="observability", journal="obs/journal",
)
obs.log("logs", writer="checkout-a").append([                 # ingest: each host appends to its own file
    {"level": "ERROR", "service": "checkout", "path": "/pay", "ms": 5000, "msg": "payments-gateway pool exhausted"},
    {"level": "INFO", "service": "checkout", "path": "/cart", "ms": 120, "msg": "ok"},
])
log = obs.log("logs")

triage = obs.sql("select service, count(*)::int as errors from {recent} where level = 'ERROR' group by 1 order by 2 desc",
                 recent=log.last("15m"))                      # one call, one hour's directory, read-only
search = obs.grep("pool exhausted", "logs", globs=["checkout-*.ndjson"])       # one call, however many files
report = obs.view("obs/reports/errors-by-service.json",       # rebuilt only when the logs changed
                  lambda: obs.sql("select service, count(*)::int as errors from {e} where level = 'ERROR' group by 1", e=log.all()))
alerts = obs.feed("logs", cursor="obs/cursors/alerts.json")   # a poll is a listing

print(triage.explain())
print(triage.run(check=True).rows, len(search.run().rows), report.refresh().meta.calls, bool(alerts.poll()))
```

| Disk | Mode | Layout |
|---|---|---|
| `app-logs` | `append` | `<date>/<hour>/<service>-<host>.ndjson`; one writer per file |
| `obs-agent` | `owned` | `reports/` (views), `cursors/` (feeds), `journal/`, `bin/duckdb` on Archil |

- The hour directory is what keeps the recurring cost down: a triage that reads the last fifteen minutes every five keeps between one and a quarter and two and a quarter hours of logs active, not the whole archive.
- On Archil, `ctx.sql` needs DuckDB on a disk: put it at `obs/bin/duckdb` with `archil.duckdb(obs, "obs/bin")` and open the context with `tools={"duckdb": "obs/bin/duckdb"}`.
- A question nobody planned for is a mapped `sh` over a glob with a reducer.
- Thirty days of logs at 5 GiB a day comes to about $4.60 a month by the price sheet, nearly all of it archive. This is a back end, not a product: there is no UI, no alert routing, and no metrics or traces.
- The SDK's `examples/datadog_afternoon` is this at full length.

## A mirror of a system of record

A job syncs a recipe into a disk it owns. Everyone else mounts that disk `read`.

```python
ISSUES = [
    {"id": "ENG-1", "title": "Checkout fails with an expired coupon", "status": "open", "updated": "2026-11-08T09:00:00Z", "description": "Steps: …"},
    {"id": "ENG-2", "title": "Add dark mode", "status": "open", "updated": "2026-11-07T15:30:00Z", "description": ""},
]
issues = archil.Records(
    "issues", lambda: ISSUES,                                 # stands in for a call to the tracker's API
    key="id", version="updated", body="description",
    layout="One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.",
)

mirror = archil.context({"tracker": archil.disk("tracker-mirror", "owned", create=True)}, backend=backend)
print(mirror.sync(issues, into="tracker/issues"))             # written: 2
ISSUES[0].update(status="done", updated="2026-11-09T10:00:00Z")
print(mirror.sync(issues, into="tracker/issues"))             # written: 1, unchanged: 1

reader = archil.context({"tracker": archil.disk("tracker-mirror")}, backend=backend)        # read is the default mode
open_issues = reader.sh("grep -l 'status: open' {issues} | wc -l", issues=reader.glob("tracker/issues/*.md"))
print(open_issues.run(check=True).text.strip())               # 1
```

- The layout note becomes `issues/README.md`. Write it for an agent that has never seen this tracker.
- `version` is what makes the sync incremental: an entry whose version has not changed is not fetched again. Use the system's own updated-at or ETag.
- One file per record suits a tracker. For a source that is scanned (orders, events), write a file per day instead, with a recipe of your own.
- Run the sync from wherever a schedule lives. It is direct writes: no compute, and nothing to keep warm.
- Readers that must not see a half-finished sync can pin: checkpoint after each sync and mount `frozen` at it.

## Several attempts, and adopting one

Each attempt gets a fork: private branches of the writable disks, from the same starting state. None sees another's writes. The one that wins is copied to the main line in a turn.

```python
ctx = archil.context({"work": archil.disk("workspace", "owned", create=True)}, backend=backend)
ctx.write("work/task.md", "Summarise the incident.\n")

attempts = [ctx.fork(f"attempt-{i}") for i in range(3)]       # a checkpoint and a branch each
for i, attempt in enumerate(attempts):                        # in real use: one agent per fork, in parallel
    attempt.sh("echo {text} > {answer} && echo {i} > {score}", text=f"summary {i}", i=i,
               answer=attempt.out("work/out/answer.md"), score=attempt.out("work/out/score")).run(check=True)

scores = [int(a.read_text("work/out/score")) for a in attempts]
best = attempts[scores.index(max(scores))]

both = ctx.mount("winner", archil.disk(best.mounts["work"].source.disk))     # the winning branch, read-only, beside the main line
with both.transaction(writes=["work"]) as turn:
    turn.sh("mkdir -p {dst} && cp -R {src}/. {dst}/", src=turn.path("winner/out"), dst=turn.out("work/out")).run(check=True)
print(ctx.read_text("work/out/answer.md").strip())            # summary 2
```

- A fork's source names its branch, which is why the branch can be mounted like any disk: `best.mounts["work"].source.disk`.
- For a small result, skip the copy statement: read through the fork and write in a turn, `turn.write(path, best.read(path))`.
- The turn is what makes adopting safe: if the main line moved meanwhile, it conflicts and nothing is applied.
- A fork covers `owned` and `shared` mounts. An attempt still appends to the real log, and still reads `read` mounts live.
- Each fork leaves a checkpoint and a branch on every disk it covers, for good. On Archil, do not fork in a tight loop.
- To let attempts work on different slices instead, give each a `narrow` of the context rather than a fork.

## A helper that is handed less

A model's commands are not trusted. What they can reach is the context their tools are built from.

```python
publisher = archil.context({"docs": archil.disk("team-handbook", "owned", create=True)}, backend=backend)
publisher.write("docs/security/keys.md", "# Keys\nRotate API keys every 90 days.\n")

ctx = archil.context(
    {
        "docs":   archil.disk("team-handbook"),       # read: nobody holding this context can change it
        "memory": archil.disk("lead-memory", "owned", create=True),
        "audit":  archil.disk("helper-audit", "append", create=True),
    },
    backend=backend, journal="audit/helpers",
)

helper = (
    ctx.narrow("docs/security", "memory/helper-1", "audit/helpers")   # these sub-trees only
       .with_egress("deny")                           # its commands cannot reach the network
       .with_budget(max_usd=0.02)                     # counted from here on
)
tools = helper.tools()                                # read_file, write_file, …; read_file's description names the helper's mounts
print(helper.describe())
print([tool.name for tool in tools])
```

- Give a writer its own directory (`memory/helper-1`) rather than the mount's root, and read what it produced afterwards.
- A reviewer gets `narrow(..., read_only=True)`: the write tools are then left out altogether. Nothing such a context runs is journalled, because the journal is a write.
- The journal is written through the context that runs the statement, which is why the narrowing keeps `audit/helpers`. On an `append` mount the helper's statements are recorded there with what they read, wrote and cost, and its commands can read that directory but not change it. Leave the directory out and nothing the helper runs is recorded. Whatever else is journalled there the helper can read too.
- Paths keep their names under narrowing, so a prompt written for the full context still reads correctly.

## A run that can be replayed

A lock is a manifest in which every mount is frozen at a checkpoint. Opening it gives the same bytes every time, which is what an eval, a replay or a bisection needs.

```python
import json

live = archil.context(
    {"cases": archil.disk("eval-cases", "owned", create=True), "skills": archil.disk("org-skills-eval", "owned", create=True)},
    backend=backend,
)
live.write("cases/001.json", json.dumps({"input": "refund policy?", "expect": "30 days"}))
live.write("skills/refunds.md", "Refunds within 30 days.\n")

lock = live.lock("eval-2026-11-10")                   # save this JSON beside the results
live.write("skills/refunds.md", "Refunds within 14 days.\n")           # the live disks move on

def run(lock, name):
    fixed = archil.from_manifest(lock, backend=backend)                # every mount frozen
    scratch = archil.context({"out": archil.disk(f"eval-out-{name}", "owned", create=True)}, backend=backend)
    scratch.log("out/results", writer=name).append({"case": "001", "skills_say": fixed.read_text("skills/refunds.md").strip()})
    return scratch

for scratch in (run(lock, "run-a"), run(lock, "run-b")):
    for f in scratch.ls("out/results", recursive=True):
        print(scratch.read_text(f.path).strip())      # both runs read "Refunds within 30 days."
```

- Results go on a disk of their own, as a log: one record per case, one writer per run. Comparing runs is then one `sql` over two selections or two globs.
- A lock checkpoints every mount that is not already frozen. On Archil that is one call per mount, and a checkpoint that stays.
- A locked context can write nothing, so a harness needs its scratch disk from outside the lock.

## Records many agents edit

A tracker, a wiki, a CRM: records that are read and changed one at a time by several writers.

```python
ctx = archil.context({"wiki": archil.disk("team-wiki", "shared", create=True)}, backend=backend)
ctx.write("wiki/pages/README.md", "One Markdown file per page, named <slug>.md. Front matter: title, owner, updated.\n")

def edit(ctx, slug, change, attempts=3):
    """Read a page, change it, and write it back, unless someone else changed it first."""
    for _ in range(attempts):
        try:
            with ctx.transaction(writes=["wiki/pages"]) as turn:
                path = f"wiki/pages/{slug}.md"
                before = turn.read_text(path) if turn.exists(path) else ""
                turn.write(path, change(before))
            return True
        except archil.Conflict:
            continue                                   # start again from what is there now
    return False

edit(ctx, "oncall", lambda text: text + "- Rotate the pager on Mondays.\n")
edit(ctx, "oncall", lambda text: text + "- Escalate after 15 minutes.\n")
print(ctx.read_text("wiki/pages/oncall.md"))

index = ctx.view("wiki/index.txt", lambda: ctx.sh("ls {pages} | grep -v README | sort", pages=ctx.path("wiki/pages")))
print(index.read_text())
```

- A file per record means two writers conflict only when they edit the same record. One big file would make every edit a conflict.
- The edit reads inside the turn, so it starts from the turn's snapshot, and the commit refuses it if the page changed meanwhile.
- Search is `ctx.grep`. A listing by field is a view built with `sh` or `sql` over the front matter.
- If edits are rare and each writer has its own pages, plain `ctx.write` on a `shared` mount is enough.

## Work that starts from a change

A feed turns "poll every minute" into something that costs nothing when nothing happened. A scheduler runs a script like this one as often as it likes.

```python
ctx = archil.context(
    {"inbox": archil.disk("uploads", "shared", create=True), "work": archil.disk("pipeline", "owned", create=True)},
    backend=backend,
)

def tick(ctx):
    """One pass: handle what is new, and say how much there was."""
    changes = ctx.feed("inbox", cursor="work/cursors/inbox.json").poll()         # a listing: no call
    if not changes:
        return 0
    counted = ctx.sh("wc -c {new} | tail -n 1", new=changes.refs()).into("work/sizes/latest.txt").run(check=True)
    changes.ack()                                      # only after the work is done: delivery is at least once
    return len(changes.files)

print(tick(ctx))                                       # 0: nothing has arrived
ctx.write("inbox/a.csv", "id,amount\n1,10\n")
print(tick(ctx), tick(ctx))                            # 1 0
```

- Acknowledge after the work, never before. If the script dies in between, the next pass sees the same changes, so the work has to be safe to repeat.
- A file that grew is handed over whole, with its earlier size in `changes.previous`, so a reader of an append-only file can skip what it has seen.
- Derived output that others read belongs in a view, so that it rebuilds only when its inputs changed.
- Nothing here is running between passes. The schedule lives wherever a schedule already lives.
