---
title: Views
description: A view is a statement with a name. It writes a derived file, remembers what it was built from, and rebuilds only when its inputs or its statement changed.
---

A view is a derived file: a report, an index, a summary. It knows how to rebuild itself and whether it needs to. Refreshing it when nothing has changed makes no call, because checking is a listing and a listing reads no data.

::example-context

## Define one and refresh it

```python
log = ctx.log("logs")
report = ctx.view(
    "memory/reports/errors-by-service.json",
    lambda: ctx.sql(
        "select service, count(*)::int as errors from {events} "
        "where level = 'ERROR' group by 1 order by 2 desc",
        events=log.all(),
    ),
)

built = report.refresh()            # builds it: one call
again = report.refresh()            # nothing changed, so nothing runs
print(built.meta.calls, again, report.fresh)
print(report.read_text().strip())   # refreshes if stale, then reads it
```

```ts
const log = ctx.log("logs");
const report = ctx.view("memory/reports/errors-by-service.json", () =>
  ctx.sql(
    "select service, count(*)::int as errors from {events} " +
      "where level = 'ERROR' group by 1 order by 2 desc",
    { events: log.all() },
  ),
);

const built = await report.refresh();     // builds it: one call
const again = await report.refresh();     // nothing changed, so nothing runs
console.log(built?.meta.calls, again, await report.fresh());
console.log((await report.readText()).trim());   // refreshes if stale, then reads it
```

```text output
1 None True
{"service":"checkout","errors":3}
```

`refresh()` returns the build's `Result`, or `None` (`null` in TypeScript) when nothing ran.

## It rebuilds when its inputs change

```python
log = ctx.log("logs")
report = ctx.view(
    "memory/reports/errors.json",
    lambda: ctx.sql(
        "select count(*)::int as errors from {events} where level = 'ERROR'",
        events=log.all(),
    ),
)
report.refresh()

ctx.log("logs", writer="checkout-b").append(
    {"level": "ERROR", "service": "checkout", "msg": "again"},
)
print(report.fresh)                 # the log changed
print(report.read_text().strip())   # so reading it rebuilds it first
```

```ts
const log = ctx.log("logs");
const report = ctx.view(
  "memory/reports/errors.json",
  () => ctx.sql`select count(*)::int as errors from ${log.all()} where level = 'ERROR'`,
);
await report.refresh();

await ctx.log("logs", { writer: "checkout-b" }).append(
  { level: "ERROR", service: "checkout", msg: "again" },
);
console.log(await report.fresh());                 // the log changed
console.log((await report.readText()).trim());     // so reading it rebuilds it first
```

```text output
False
{"errors":4}
```

## How it works

- **The path** is where the derived file lives. It has to be on a mount the context can write.
- **The build** is a statement, or a function that returns one. A function is the better habit: it is called afresh each time, so a selection such as `last("1h")` is taken at the time of the refresh.
- **Output.** If the statement neither has `into()` nor writes through an `out` parameter, the view sends its output into the view's path. For `sql` the format follows the path's extension: JSON lines, `.csv` or `.parquet`.
- **Freshness.** A view fingerprints its statement and its inputs: each input file's path, size and version, from a listing. `refresh()` compares that with the fingerprint recorded at the last build, and skips the build when they match. `refresh(force=True)` builds regardless.
- **A changed statement is a stale view.** The template and the parameters are in the fingerprint.
- **A failed build records nothing,** so the next `refresh()` tries again.

:::caution[The build must be a plain function in TypeScript]
An `async` function that returns a statement runs it, because a statement is thenable. Write ``() => ctx.sql`…` ``, not ``async () => ctx.sql`…` ``.
:::

## Inputs

A view's inputs are the statement's own read parameters: its paths, globs and selections. That is usually all it needs. A list parameter is not looked into: paths passed in a list, such as `changes.refs()`, are not inputs until you name them in `inputs`.

When the output depends on files the statement does not name, list them with `inputs`. Here the statement names a script, and the script reads data the statement never mentions:

```python
ctx.write("memory/bin/count.sh", "cat memory/data/*.csv | wc -l\n")
ctx.write("memory/data/a.csv", "1\n2\n")

total = ctx.view(
    "memory/reports/total.txt",
    lambda: ctx.sh("sh {script}", script=ctx.path("memory/bin/count.sh")),
    # what the output really depends on
    inputs=["memory/bin/count.sh", "memory/data/*.csv"],
)
print(total.read_text().strip())

ctx.write("memory/data/b.csv", "3\n")
print(total.fresh, total.read_text().strip())
```

```ts
await ctx.write("memory/bin/count.sh", "cat memory/data/*.csv | wc -l\n");
await ctx.write("memory/data/a.csv", "1\n2\n");

const total = ctx.view(
  "memory/reports/total.txt",
  () => ctx.sh`sh ${ctx.path("memory/bin/count.sh")}`,
  // what the output really depends on
  { inputs: ["memory/bin/count.sh", "memory/data/*.csv"] },
);
console.log((await total.readText()).trim());

await ctx.write("memory/data/b.csv", "3\n");
console.log(await total.fresh(), (await total.readText()).trim());
```

```text output
2
False 3
```

`inputs` replaces the statement's own inputs. It does not add to them, so list everything.

:::caution[A view's statement still has to declare what it reads]
The view sends the statement's output into the view's path, and that is a declared write. So the call mounts the output's disk, plus whatever the statement reads by parameter. A path the command names only in its text, on another disk, is not mounted. `inputs` changes when the view rebuilds, not what the call can see.
:::

## Read it and share it

| | Python | TypeScript |
|---|---|---|
| Is it up to date? | `view.fresh` | `await view.fresh()` |
| Rebuild if stale | `view.refresh()` | `await view.refresh()` |
| Rebuild regardless | `view.refresh(force=True)` | `await view.refresh({ force: true })` |
| Refresh, then read | `view.read()`, `view.read_text()` | `await view.read()`, `await view.readText()` |
| A link for a person | `view.share(expires_in=3600)` | `await view.share({ expiresIn: 3600 })` |

A view is a plain file. Anything can read it without the SDK: `cat memory/reports/errors.json`.

## What a view does not store

A view's definition is not stored on the disk. Only its output and a small state file are, so rebuilding a view needs the code that defined it.

That state file is under `.px/`, which a [turn](/guides/turns/)'s commit does not carry over. A view refreshed inside a turn lands its output, and then builds once more the first time it is refreshed on the main line.

On Archil, a view built from a file written under about a second and a half ago also builds once more on its next refresh. See [Versions and clocks](/architecture/versions/).

## Next

:::cards
- [Feeds](/guides/feeds/) React to what changed, not to a clock.
- [Records many agents edit](/blueprints/shared-records/) An index of pages, kept as a view.
- [What the framework writes](/architecture/files-on-disk/) The view's state file.
:::
