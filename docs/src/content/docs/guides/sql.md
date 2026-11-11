---
title: SQL over files
description: ctx.sql is DuckDB over files, run next to the data. Any path parameter is a table, a value is a literal, and only the rows come back.
---

`ctx.sql(query, ...)` runs a DuckDB query over files in the context: JSON lines, CSV or Parquet. It is one call. The query runs next to the data, and only the rows cross the network.

::example-context

## A path is a table

```python
by_level = ctx.sql(
    "select level, count(*)::int as n from {events} "
    "where service <> {skip} group by 1 order by 1",
    events=ctx.log("logs").last("2h"),      # a table: the records of the last two hours
    skip="search",                          # a value: a SQL literal
)
print(by_level.run(check=True).rows)
```

```ts
const byLevel = ctx.sql`
  select level, count(*)::int as n from ${ctx.log("logs").last("2h")}
  where service <> ${"search"} group by 1 order by 1`;
console.log((await byLevel.run({ check: true })).rows);
```

```text output
[{'level': 'ERROR', 'n': 3}, {'level': 'INFO', 'n': 14}]
```

The result's `rows` is a list of objects, parsed from DuckDB's JSON output.

| Parameter | Is the table |
|---|---|
| `ctx.path("team/leads/emea.csv")` | that file |
| `ctx.path("team/leads")` | the files under that directory that have its first file's extension |
| `ctx.glob("team/leads/*.csv")` | the files that match |
| a [log selection](/guides/logs/#selections) | exactly the records in its time range |

```python
leads = ctx.sql(
    "select region, count(*)::int as leads from {leads} group by 1 order by 1",
    leads=ctx.glob("team/leads/*.csv"),
)
print(leads.run(check=True).rows)
```

```ts
const csv = ctx.glob("team/leads/*.csv");
const leads = ctx.sql`
  select region, count(*)::int as leads from ${csv} group by 1 order by 1`;
console.log((await leads.run({ check: true })).rows);
```

```text output
[{'region': 'amer', 'leads': 1}, {'region': 'emea', 'leads': 3}]
```

## How files are read

The reader follows the extension of the files. Tables are read with `union_by_name=true`, so files with different columns combine.

| Extension | Reader |
|---|---|
| `.parquet` | `read_parquet` |
| `.csv`, `.tsv` | `read_csv_auto` |
| `.json`, `.ndjson`, `.jsonl`, and anything else | `read_json_auto` |

A directory given with `ctx.path` is read as `<dir>/**/*.<ext>`, where the extension is that of its first file in path order. Files with another extension are left out. Keep one format in a directory, or name the files with a glob.

## Values are literals

Anything that is not a path is written as a SQL literal: a string with its quotes doubled, a number bare, a boolean as `TRUE` or `FALSE`, and `None` or `null` as `NULL`. A value can never change the shape of the query.

```python
name = "O'Brien'; drop table leads; --"
found = ctx.sql("select count(*)::int as n from {leads} where name = {name}",
                leads=ctx.glob("team/leads/*.csv"), name=name)
print(found.run(check=True).rows)       # the value matched nothing, and did nothing
```

```ts
const name = "O'Brien'; drop table leads; --";
const leads = ctx.glob("team/leads/*.csv");
const found = ctx.sql`select count(*)::int as n from ${leads} where name = ${name}`;
// the value matched nothing, and did nothing
console.log((await found.run({ check: true })).rows);
```

```text output
[{'n': 0}]
```

## Keep the result on the disk

`into(path)` writes the result with `COPY … TO`, in the format the extension names: `.parquet`, `.csv`, or JSON lines for `.json`, `.ndjson`, `.jsonl` and anything else. The result then has `paths`, not `rows`.

```python
saved = ctx.sql(
    "select ts, service, msg from {events} where level = 'ERROR'",
    events=ctx.log("logs").all(),
)
print(saved.into("memory/reports/errors.parquet").run(check=True).paths)

report = ctx.path("memory/reports/errors.parquet")
again = ctx.sql("select count(*)::int as n from {t}", t=report)
print(again.run(check=True).rows)
```

```ts
const events = ctx.log("logs").all();
const saved = ctx.sql`select ts, service, msg from ${events} where level = 'ERROR'`;
console.log(
  (await saved.into("memory/reports/errors.parquet").run({ check: true })).paths,
);

const report = ctx.path("memory/reports/errors.parquet");
const again = ctx.sql`select count(*)::int as n from ${report}`;
console.log((await again.run({ check: true })).rows);
```

```text output
['memory/reports/errors.parquet']
[{'n': 3}]
```

A query cannot take a `ctx.out(...)` parameter. It writes with `.into(path)`.

## Things to know

- **Cast what has to be a number.** DuckDB's JSON output writes a `HUGEINT` as a string, and `sum()` of integers is one: `sum(n)` comes back as `"3"`. Write `sum(n)::bigint` and `count(*)::int`.
- **No input files is not an error.** A parameter whose path or selection matches no files makes the statement a no-op: no call is made, `rows` is `[]`, and the plan says so.
- **Pass the path as a parameter.** A query that names files in its own text, such as `read_json_auto('logs/**/*.ndjson')`, declares nothing. It mounts the whole context and cannot be priced.
- **`sql` is one call.** It cannot be mapped. For a heavy query, give it a larger VM with [`sized()`](/guides/results/#a-larger-vm).
- **`rows` is `None` when the query failed,** or when its output was not JSON. Look at `exit_code` and `stderr`, or pass `check=True`. It is also `None` for a query sent `into()` a file, where the rows are. Inside a batch a failed query's `rows` is an empty list, so look at its exit code.

## Where the engine comes from

| Backend | The engine is |
|---|---|
| Local | the `duckdb` on your PATH |
| Archil | a DuckDB binary on a disk, named in the context's `tools` |

Archil's exec image does not have DuckDB. Put the command-line tool on a disk once, and tell the context where it is:

```py
ctx = archil.context(
    {
        "logs": archil.disk("app-logs", "append"),
        "obs": archil.disk("obs-agent", "owned"),
    },
    tools={"duckdb": "obs/bin/duckdb"},
)
if not ctx.exists("obs/bin/duckdb"):
    # one call; the binary stays on the disk
    archil.duckdb(ctx, "obs/bin").run(check=True)
```

```typescript
const ctx = await archil.context(
  { logs: archil.disk("app-logs", "append"), obs: archil.disk("obs-agent", "owned") },
  { tools: { duckdb: "obs/bin/duckdb" } },
);
if (!(await ctx.exists("obs/bin/duckdb"))) {
  // one call; the binary stays on the disk
  await archil.duckdb(ctx, "obs/bin").run({ check: true });
}
```

[Run on Archil](/guides/archil/#sql-needs-duckdb-on-a-disk) has the details. For state that is looked up by key and updated in place, see [State in SQLite](/guides/sqlite/).

## Next

:::cards
- [Logs](/guides/logs/) Selections: the part of a log a question needs.
- [Views](/guides/views/) A query with a name, rebuilt only when its inputs changed.
- [State in SQLite](/guides/sqlite/) When DuckDB over files is the wrong tool.
:::
