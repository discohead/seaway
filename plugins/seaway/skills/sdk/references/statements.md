# Statements

A statement is work that runs next to the data: `sh`, `sql`, `grep` or `batch`. Building one runs nothing. `explain()` returns its plan, and `run()` executes it. Statements are immutable values, so every builder returns a new one.

## Contents

- [Parameters](#parameters)
- [What a call can see](#what-a-call-can-see)
- [sh](#sh)
- [sql](#sql)
- [grep](#grep)
- [batch](#batch)
- [map: one input across many calls](#map-one-input-across-many-calls)
- [into, sized, egress, within](#into-sized-egress-within)
- [Results](#results)
- [Limits](#limits)

## Parameters

A command is a template with named parameters. A parameter is a path in the context, which also tells the planner what the command reads and writes, or it is a value, which is quoted so the shell can never interpret it.

```python
ctx.sh("rg -c timeout {dir}", dir=ctx.path("docs"))                          # reads one directory
ctx.sh("sort -u {src} > {dst}", src=ctx.glob("team/leads/*.csv"), dst=ctx.out("memory/leads.csv"))
ctx.sh("echo {text}", text="it's; rm -rf /")                                 # a value: one quoted word
ctx.sh("cat {files} {tail}", files=[ctx.path("docs/onboarding.md"), ctx.path("docs/expenses.md")],
       tail=archil.raw("| wc -l"))                                           # a list, and trusted raw text
```

```ts
ctx.sh`rg -c timeout ${ctx.path("docs")}`;
ctx.sh`sort -u ${ctx.glob("team/leads/*.csv")} > ${ctx.out("memory/leads.csv")}`;
ctx.sh`echo ${"it's; rm -rf /"}`;
ctx.sh("cat {files} {tail}", {                                // the named form, as Python writes it
  files: [ctx.path("docs/onboarding.md"), ctx.path("docs/expenses.md")],
  tail: archil.raw("| wc -l"),
});
```

| Parameter | Declares | In `sh` it becomes | In `sql` it becomes |
|---|---|---|---|
| `ctx.path(p)` | a read of a file or a directory | the path, quoted | a table: the file, or the files under the directory that have its first file's extension |
| `ctx.glob(p)` | a read of the files that match now | each matching path, quoted, sorted by path | a table over the glob |
| `ctx.out(p)` | a write | the path, quoted; its directory is created first | not usable: a query writes with `.into(path)` |
| a log selection | a read of a time range | the partition files that cover the range | a table of exactly the records in the range |
| a list of paths, outs or values | each of them | the words, separated by spaces | (use one table per parameter) |
| `archil.raw(text)` | nothing | the text as written | the text as written |
| anything else | nothing: it is a value | one shell word, whatever it contains | a SQL literal |

Globs: `*` and `?` stay inside one path segment, `**` crosses directories. A glob is expanded when the statement is compiled, from a listing. That happens only when the glob is a parameter of its own, and the same goes for a log selection: inside a list either one is passed as its own text, in one quoted word, and the command is handed a name that matches no file.

Values: in `sh`, `None`/`null` is the empty word `''` and booleans are `true` and `false`. In `sql`, `None`/`null` is `NULL`, booleans are `TRUE` and `FALSE`, numbers are written bare, and a string has its quotes doubled.

Placeholders:

- Only `{name}` where `name` was passed as a parameter is substituted. Ordinary shell braces pass through untouched: `awk '{print $1}'`, `${HOME}`, `{a,b}`.
- A parameter that never appears in the template is a `ValidationError` (`unused_parameter`) before anything runs. It is almost always a typo.
- In TypeScript a tagged template names its parameters `p0`, `p1`, … and takes the text between them as written, so a backslash reaches bash as a backslash. A value cannot be interpolated straight after `$` or a backslash (`bad_template`); use the named form there.

What not to write, and why:

```py
ctx.sh(f"cat docs/{name}")                 # pasted: not quoted, and the plan cannot see the path
ctx.sh("cat docs/" + name)                 # the same
ctx.sh("cat {f}", f="docs/" + name)        # quoted, but a value: the statement declares nothing
ctx.sh("cat {f}", f=ctx.path("docs/" + name))   # right
```

```typescript
ctx.sh(`cat docs/${name}`);                // a call, not a tag: JavaScript pasted the value first
ctx.sh`cat docs/${name}`;                  // quoted, but a value: the statement declares nothing
ctx.sh`cat ${ctx.path("docs/" + name)}`;   // right
```

## What a call can see

The rule is short.

- **No path parameters:** the call sees the whole context, each mount in its own mode. `owned` mounts are read-write under a checkout, `shared` mounts read-write and conditional, the rest read-only. The plan carries a note, and its price is marked `(input size unknown)`.
- **Path parameters:** the call sees only the disks they name.
  - A disk it only reads is mounted read-only, at the smallest directory that covers the paths read on it. A single file is mounted as its directory.
  - A disk it writes is mounted whole, in its own mode. Only reads are narrowed to a directory.
  - A disk it does not name is not mounted.

A command starts in the directory the disks are mounted under and addresses files as the context does: `cat docs/onboarding.md`. That holds on both backends. Do not write `/mnt/archil/...`: it exists only inside an Archil call.

```python
plan = ctx.sh("sort -u {src} > {dst}", src=ctx.glob("team/leads/*.csv"), dst=ctx.out("memory/leads.csv")).explain()
print(plan)
```

```text
plan f381e1d9ce0c  sh · 2 file(s), 58 B · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   team/leads → team-notes:/leads (read-only)
          memory → agent-memory (read-write, checkout /)
          not mounted: docs, logs
  reads   team/leads/*.csv
  writes  memory/leads.csv
  price   1 call unit $0.00005 + 58 B active for an hour <$0.00001 ≈ $0.00005
```

`team` is a `shared` mount, but this statement only reads it, so the call gets one directory of it, read-only. `memory` is written, so it is mounted whole, under a checkout.

This is gradual on purpose. A free-form command still works, and its plan says what it cost to be vague.

## sh

`ctx.sh(command, **params)` is bash on both backends. Archil runs a command with `/bin/sh`, so the SDK hands the text to bash itself: `set -o pipefail`, `[[ ]]` and process substitution mean what they say.

```python
by_words = ctx.sh("wc -w {files} | sort -n", files=ctx.glob("docs/**/*.md"))
result = by_words.run(check=True)
print(result.text)
```

```ts
const byWords = ctx.sh`wc -w ${ctx.glob("docs/**/*.md")} | sort -n`;
const result = await byWords.run({ check: true });
console.log(result.text);
```

Each call is a fresh VM. Nothing survives it but files on the mounts. There is no stdin: a command that reads it sees the end of input at once.

## sql

`ctx.sql(query, **params)` is DuckDB over files, run next to the data. Any path parameter is a table.

```python
by_level = ctx.sql(
    "select level, count(*)::int as n from {events} where service <> {skip} group by 1 order by 1",
    events=ctx.log("logs").last("2h"),
    skip="search",
)
print(by_level.run(check=True).rows)        # [{'level': 'ERROR', 'n': 3}, {'level': 'INFO', 'n': 14}]
```

```ts
const byLevel = ctx.sql`
  select level, count(*)::int as n from ${ctx.log("logs").last("2h")}
  where service <> ${"search"} group by 1 order by 1`;
console.log((await byLevel.run({ check: true })).rows);
```

- The reader follows the extension of the files: `.parquet` is `read_parquet`, `.csv` and `.tsv` are `read_csv_auto`, and `.json`, `.ndjson`, `.jsonl` and anything else are `read_json_auto`. Tables are read with `union_by_name=true`.
- A directory given with `ctx.path` is read as `<dir>/**/*.<ext>`, where the extension is that of its first file in path order. Files with another extension are left out, so keep one format in a directory, or name the files with a glob.
- A log selection is a table of exactly the records in its range: the files are the partitions that cover it, and the SDK adds the filter on `ts`.
- The result's `rows` is a list of objects, parsed from DuckDB's JSON output. That output writes a `HUGEINT` as a string, and `sum()` of integers is one: `sum(n)` comes back as `"3"`. Cast what has to be a number: `sum(n)::bigint`, `count(*)::int`.
- A parameter whose path or selection matches no files makes the statement a no-op: no call is made, `rows` is `[]`, and the plan says so.
- A query that names files in its own text (`read_json_auto('logs/**/*.ndjson')`) declares nothing, so it mounts the whole context and cannot be priced. Pass the path as a parameter.
- `sql` is one call and cannot be mapped. For a heavy query, give it a larger VM with `sized()`.
- On the local backend the engine is the `duckdb` on the PATH. On Archil the exec image has none: see [backends.md](backends.md).
- `into("memory/out.parquet")` writes the result with `COPY … TO`, in the format the extension names: `.parquet`, `.csv`, or JSON lines for `.json`, `.ndjson`, `.jsonl` and anything else.

## grep

`ctx.grep(pattern, over, ...)` is a regex search fanned out next to the data: one call per disk, however many files. It does not go through exec.

```python
hits = ctx.grep("rotate", "docs", ignore_case=True, globs=["*.md"]).run()
for hit in hits.rows:
    print(f"{hit['file']}:{hit['line']}: {hit['text']}")
print(hits.value)                           # {'exhaustive': True, 'stopped_reason': 'completed'}
```

```ts
const hits = await ctx.grep("rotate", "docs", { ignoreCase: true, globs: ["*.md"] });
for (const hit of hits.rows) console.log(`${hit.file}:${hit.line}: ${hit.text}`);
console.log(hits.value);                    // { exhaustive: true, stoppedReason: 'completed' }
```

| Option | Python | TypeScript | Meaning |
|---|---|---|---|
| case | `ignore_case=True` | `ignoreCase: true` | match without regard to case |
| files | `globs=["checkout-*.ndjson"]` | `globs: [...]` | ripgrep globs: with no `/` a glob matches a file name at any depth; a leading `!` excludes |
| cap | `max_results=200` | `maxResults: 200` | stop after this many matches; the default is 1,000 |
| depth | `recursive=False` | `recursive: false` | search the directory and not below it |

- `over` is a path in the context. Left out, every mount is searched, one call each.
- Search takes a directory. Given a file, the SDK searches that file's directory for that one name.
- It looks in hidden files, does not read `.gitignore`, and passes over binary files, on both backends.
- `rows` is a list of `{file, line, text}`, and `text` is `file:line:text` lines. When a search stops early, `value` says why and the rows are a sample.
- A plain `rg` or `grep` written as an `sh` statement works, but costs a call that scans from one VM. When it declares its paths and has no pipe and no `into()`, its plan carries a note pointing here.

## batch

`ctx.batch([...])` runs several small statements in one call. Each still gets its own result.

```python
both = ctx.batch([
    ctx.sh("wc -l < {f}", f=ctx.path("docs/onboarding.md")),
    ctx.sh("ls {d} | wc -l", d=ctx.path("docs")),
]).run()
print(both.meta.calls, [r.text.strip() for r in both.results])     # 1 ['2', '3']
```

```ts
const both = await ctx.batch([
  ctx.sh`wc -l < ${ctx.path("docs/onboarding.md")}`,
  ctx.sh`ls ${ctx.path("docs")} | wc -l`,
]);
console.log(both.meta.calls, both.results.map((r) => r.text.trim()));
```

- It takes plain `sh` and `sql` statements. A mapped statement or a `grep` is refused (`bad_batch`): run those on their own.
- The mount map is the union of what the statements declare. If any of them declares nothing, the batch sees the whole context.
- One VM means one network policy. Set egress on the batch or on the context, not on one of its statements.
- The batch's `exit_code` is the first one that is not zero, and `results[i]` has each statement's own exit code, output and `rows`.

## map: one input across many calls

The planner never guesses how to split a command. It splits only when the caller says which input to split and how to put the outputs back together.

```python
by_service = ctx.sh(
    "cat {files} | jq -r 'select(.level == \"ERROR\") | .service' | sort | uniq -c",
    files=ctx.glob("logs/**/*.ndjson"),
).map(reduce="sum_by_key", shards=4)
print(by_service.explain())
print(by_service.run(check=True).value)     # {'checkout': 3}
```

```ts
const byService = ctx.sh`cat ${ctx.glob("logs/**/*.ndjson")} | jq -r 'select(.level == "ERROR") | .service' | sort | uniq -c`
  .map({ reduce: "sum_by_key", shards: 4 });
console.log(String(await byService.explain()));
console.log((await byService.run({ check: true })).value);   // Map(1) { 'checkout' => 3 }
```

- Only `sh` statements can be mapped. `grep` already fans out, and `sql` is one query.
- `on` names the parameter to split. It can be left out when exactly one parameter is a glob or a log selection.
- `shards` is how many calls. Left out, it is one per 256 MiB or per 2,000 files, whichever asks for more. It is never more than the number of files, and a shard whose file list would not fit in one command is split again.
- Files are spread so the shards are of similar size. Up to 64 calls run at once.
- The result's `value` is what the reducer produced, `text` is that as text, and `shards` holds each call's own output. `exit_code` is the first that is not zero.

| Reducer | Each call's output is | `value` |
|---|---|---|
| `concat` (the default) | anything | the outputs joined, in shard order |
| `lines` | lines | a list of all the lines |
| `sorted` | lines | all the lines, sorted |
| `unique` | lines | the distinct lines, sorted |
| `count` | lines | how many lines there were in all |
| `sum` | one number per line, such as `wc -l < file` | the total |
| `sum_by_key` | a count and a key per line | totals by key, largest first |
| `json` | a JSON value | one list: arrays are concatenated, other values appended |
| a function | anything | whatever the function returns, given the list of outputs |

`sum_by_key` reads three line forms: `   12 key` (what `uniq -c` writes), `key:12` or `key<TAB>12` (what `rg -c --with-filename` and `awk` write), and `12 key`. With `rg -c`, add `--with-filename` so that a shard of one file still names it.

Reducers are strict. `sum` and `sum_by_key` raise (`bad_reduce_input`) on a line they cannot read, because a reducer that quietly dropped one shard's output would be worse than no parallelism. When the output is not in a shape a reducer reads, reduce with `lines` and combine it yourself.

Choose a reducer that is right for the command. `sort | uniq -c` per shard and `sum_by_key` gives the true counts. `sort | head -5` per shard and `concat` does not give the top five.

## into, sized, egress, within

```python
ctx.sh("cat {files}", files=ctx.glob("docs/**/*.md")).into("memory/all-docs.md").run(check=True)   # result.paths, not stdout
ctx.sql("select * from {events} where level = 'ERROR'", events=ctx.log("logs").all()).into("memory/errors.parquet")
ctx.sql("select count(*) from {events}", events=ctx.log("logs").all()).sized(vcpu=8, mem_mib=16384)  # bills as 4 calls
ctx.sh("pip download requests -d {out}", out=ctx.out("memory/wheels")).egress(["pypi.org", "files.pythonhosted.org"])
ctx.sh("ls").within(max_usd=0.001, max_calls=1)       # refused before it runs if the plan would pass either
```

```ts
await ctx.sh`cat ${ctx.glob("docs/**/*.md")}`.into("memory/all-docs.md").run({ check: true });
ctx.sql`select * from ${ctx.log("logs").all()} where level = 'ERROR'`.into("memory/errors.parquet");
ctx.sql`select count(*) from ${ctx.log("logs").all()}`.sized({ vcpu: 8, memMib: 16384 });
ctx.sh`pip download requests -d ${ctx.out("memory/wheels")}`.egress(["pypi.org", "files.pythonhosted.org"]);
ctx.sh`ls`.within({ maxUsd: 0.001, maxCalls: 1 });
```

- **`into(path)`** sends output to a file in the context and returns its path in `result.paths`. Use it when the output is large, or is wanted on the disk anyway: only stdout crosses the network, so a large result is cheaper left where it is. A mapped statement writes one file per shard, `<path>/part-00000`, `part-00001`, …, and `paths` lists only the parts whose call succeeded.
- **`sized(vcpu=, mem_mib=, image=)`** chooses the VM for each call. The default is 2 vCPU and 4 GiB. Anything larger bills as a multiple of a call: the larger of the vCPU and the memory multiple, rounded up. `image` names a custom base image.
- **`egress(policy)`** says what this one call may reach: `"deny"`, `"allow"`, or a list of hosts. See [contexts.md](contexts.md#the-network-egress).
- **`within(...)`** refuses to run if the plan would exceed a budget: `max_usd`, `max_calls`, `max_bytes_touched`. `run()` raises `BudgetExceeded` and nothing is sent. `explain()` is not affected: a plan can always be read.

On Archil, parallel calls that write into an `owned` mount queue for its checkout. Map into a `shared` mount when the shards should write at once; the plan carries a note when this applies.

## Results

`run()` returns a `Result`. In TypeScript the field names are camel case (`exitCode`, `callUnits`, `wallMs`).

| Field | Meaning |
|---|---|
| `ok`, `exit_code` | whether the command exited 0, and what it exited with |
| `stdout`, `text`, `lines` | the output; `text` is `stdout`, `lines` is it split into lines |
| `stderr` | what the command wrote to stderr, and the backend's own notes |
| `json()` | `stdout` parsed as JSON |
| `rows` | `sql` and `grep`: a list of objects; `None`/`null` otherwise, and for a `sql` that failed |
| `value` | what a reducer produced; the rows for `sql`; `{exhaustive, stopped_reason}` for `grep` |
| `paths` | files written by `into()` |
| `truncated` | the output was cut at the limit |
| `results` | `batch`: one result per statement |
| `shards` | a mapped statement: one raw output per call |
| `plan` | the plan that ran |
| `meta` | `calls`, `call_units`, `usd`, `wall_ms`, `queue_ms`, `execute_ms` |
| `check()` | raise `ExecFailed` unless the exit code is 0; returns the result |

## Limits

These follow Archil's documented limits. The local backend imposes the same ones, except the wait for a checkout: it has no checkouts.

| Limit | Value | What happens |
|---|---|---|
| A compiled command | 100 KiB | `ValidationError` (`command_too_large`) before anything is sent: spread the inputs with `.map()` |
| Output | 4 MiB per stream | the first bytes are kept and the stream ends in `[output truncated]`; `result.truncated` is true. Use `into()` |
| Time | 5 minutes per call | exit 124 and `Exec timed out` in stderr |
| An `owned` mount's checkout, on Archil | waited for up to 5 seconds | exit 30 |
| A mount that cannot be made | | exit 1 and `mount failed: …` in stderr |
| One append | 1 MiB | a log splits its appends to fit, and one record larger than that is `record_too_large`. A direct `ctx.append` over the limit is a `ValidationError` with code `invalid` |
| Search results | 1,000 unless `max_results` says otherwise | `value` says the search stopped early |
| Calls at once | 64 | a mapped statement with more shards keeps 64 running until all are done |
