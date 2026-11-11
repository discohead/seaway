---
title: Statement
description: Reference for sh, sql, grep and batch, the builders that shape a statement, the Result and Meta that run() returns, and the reducers, in Python and TypeScript.
---

A statement is work that runs next to the data. It is an immutable value: every builder returns a new one. The guides are [Statements and parameters](/guides/statements/), [SQL over files](/guides/sql/), [Search](/guides/grep/) and [Batch and map](/guides/batch-and-map/).

## Making one

| Python | TypeScript | Is |
|---|---|---|
| `ctx.sh(command, **params)` | ``ctx.sh`…` `` or `ctx.sh(command, params)` | a bash command |
| `ctx.sql(query, **params)` | ``ctx.sql`…` `` or `ctx.sql(query, params)` | a DuckDB query over files |
| `ctx.grep(pattern, over=None, **options)` | `ctx.grep(pattern, over?, options?)` | a regex search |
| `ctx.batch(statements)` | `ctx.batch(statements)` | several `sh` and `sql` statements in one call |

### Parameters

| Parameter | Declares | In `sh` | In `sql` |
|---|---|---|---|
| `ctx.path(p)` | a read | the path, quoted | a table |
| `ctx.glob(p)` | a read of the files that match now | each path, quoted, in path order | a table over the glob |
| `ctx.out(p)` | a write | the path, quoted | not allowed: use `.into(path)` |
| a log selection | a read of a time range | the partition files | a table of the records in range |
| a list | each item | the words, separated by spaces | not for tables |
| `archil.raw(text)` | nothing | the text as written | the text as written |
| anything else | nothing | one shell word | a SQL literal |

In a TypeScript tagged template, each `${...}` is a parameter named `p0`, `p1`, and so on.

Compiling a statement raises `ValidationError` with `unused_parameter` for a parameter that never appears in the template, `unknown_mount` or `out_of_scope` for a path the context cannot reach, `read_only` for an `out` on a mount that cannot be written, and `command_too_large` for a command over 100 KiB.

### grep options

| Python | TypeScript | Default | Meaning |
|---|---|---|---|
| `ignore_case=True` | `ignoreCase: true` | false | match without regard to case |
| `globs=[...]` | `globs: [...]` | none | ripgrep globs. With no `/`, a glob matches a file name at any depth. A leading `!` excludes |
| `max_results=200` | `maxResults: 200` | 1,000 | stop each call after this many matches. A search of several mounts is a call each |
| `recursive=False` | `recursive: false` | true | search the directory and not below it |

`over` is a path in the context, or a `Ref`. Left out, every mount is searched, one call each.

## Builders

Each returns a new statement.

| Python | TypeScript | Does |
|---|---|---|
| `stmt.map(on=None, *, reduce="concat", shards=None)` | `stmt.map({ on, reduce, shards })` | runs once per shard of one input, and combines the outputs. `sh` only |
| `stmt.into(path)` | `stmt.into(path)` | sends output to a file in the context. `sh` and `sql` only: a `grep` or a `batch` ignores it |
| `stmt.sized(*, vcpu=None, mem_mib=None, image=None)` | `stmt.sized({ vcpu, memMib, image })` | chooses the VM for each call. A `grep` runs on no VM, and ignores it |
| `stmt.egress(policy)` | `stmt.egress(policy)` | says what this call may reach: `"deny"`, `"allow"`, or a list of hosts. A `grep` ignores it |
| `stmt.within(budget=None, **limits)` | `stmt.within(budget)` | refuses to run if the plan would pass a budget. Takes a `Budget`, or its limits |

`map` raises `ValidationError` with `bad_map` on a statement that is not `sh`, for an unknown reducer, or when it cannot tell which input to split.

| `map` option | Meaning |
|---|---|
| `on` | the parameter to split. Left out when exactly one parameter is a glob or a log selection |
| `reduce` | how to combine the outputs: a reducer's name, or a function of the list of outputs |
| `shards` | how many calls. Left out: one per 256 MiB or per 2,000 files, whichever asks for more |

## Plan and run

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `stmt.explain()` | `await stmt.explain()` | a [`Plan`](/reference/plan/) | compiles the statement. Runs nothing |
| `stmt.run(*, check=False)` | `await stmt.run({ check })` | a `Result` | compiles, checks any budget, and runs. With `check`, raises `ExecFailed` on a non-zero exit |
| | `await stmt` | a `Result` | the same as `await stmt.run()` |

`run` raises `BudgetExceeded` when the plan would pass the statement's budget or the context's. Nothing is sent.

A statement's own fields are readable: `kind`, `template`, `params`, `vm`, `budget`.

## Result

| Python | TypeScript | Is |
|---|---|---|
| `result.kind` | `result.kind` | `sh`, `sql`, `grep` or `batch` |
| `result.ok` | `result.ok` | whether the exit code is 0 |
| `result.exit_code` | `result.exitCode` | the exit code. For several calls, the first that is not zero |
| `result.stdout` | `result.stdout` | the output |
| `result.text` | `result.text` | the same as `stdout` |
| `result.lines` | `result.lines` | `stdout`, split into lines |
| `result.stderr` | `result.stderr` | what the command wrote to stderr, and the backend's own notes |
| `result.json()` | `result.json()` | `stdout` parsed as JSON |
| `result.rows` | `result.rows` | `sql` and `grep`: a list of objects. None otherwise, for a `sql` that failed, and for a `sql` sent `into()` a file |
| `result.value` | `result.value` | what a reducer produced; the rows for `sql`; `{exhaustive, stopped_reason}` for `grep` |
| `result.paths` | `result.paths` | files written by `into()` |
| `result.truncated` | `result.truncated` | the output was cut at the limit |
| `result.results` | `result.results` | `batch`: one result per statement |
| `result.shards` | `result.shards` | a mapped statement: one raw output per call |
| `result.plan` | `result.plan` | the plan that ran |
| `result.meta` | `result.meta` | what it cost |
| `result.check()` | `result.check()` | raises `ExecFailed` unless the exit code is 0. Returns the result |

A `grep` result's `value` has the keys `exhaustive` and `stopped_reason` in Python, and `exhaustive` and `stoppedReason` in TypeScript.

### Meta

| Python | TypeScript | Is |
|---|---|---|
| `result.meta.calls` | `result.meta.calls` | how many calls were made |
| `result.meta.call_units` | `result.meta.callUnits` | calls, times the VM's multiple |
| `result.meta.usd` | `result.meta.usd` | this statement's share of the ledger |
| `result.meta.wall_ms` | `result.meta.wallMs` | the time the calls took, from the first sent to the last back. Compiling the plan is not in it |
| `result.meta.queue_ms` | `result.meta.queueMs` | time spent waiting, summed over calls |
| `result.meta.execute_ms` | `result.meta.executeMs` | time spent running, summed over calls |

## Reducers

`archil.REDUCERS` holds the named ones.

| Name | Each call's output is | `value` |
|---|---|---|
| `concat` | anything | the outputs joined, in shard order |
| `lines` | lines | a list of all the lines |
| `sorted` | lines | all the lines, sorted |
| `unique` | lines | the distinct lines, sorted |
| `count` | lines | how many lines there were in all |
| `sum` | one number per line | the total |
| `sum_by_key` | a count and a key per line | totals by key, largest first: a `dict` in Python, a `Map` in TypeScript |
| `json` | a JSON value | one list: arrays are concatenated, other values appended |

A reducer can also be a function that takes the list of outputs and returns the value.

`sum` and `sum_by_key` raise the base error with `bad_reduce_input` on a line they cannot read.

## TypeScript only

- **A statement is thenable.** `await stmt` runs it. An `async` function must not return a statement unless it means to run it.
- **A tagged template** takes the text between its values as written, so a backslash reaches bash as a backslash. A value straight after `$` or a backslash is `bad_template`: use the named form there.
- **A call with a template literal is not a tagged template.** ``ctx.sh(`cat ${x}`)`` hands seaway text that JavaScript has already assembled.
