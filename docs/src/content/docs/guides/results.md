---
title: Results and limits
description: What run() returns, why a command that fails is a result and not an exception, how to keep large output on the disk, and what happens at each platform limit.
---

`run()` returns a `Result`. It has the output, what the statement cost, and the plan that ran.

::example-context

## What comes back

```python
# lines in each file
result = ctx.sh("grep -c '' {files}", files=ctx.glob("docs/*.md")).run()
print(result.ok, result.exit_code)
print(result.lines)
print(result.meta.calls, result.meta.call_units, f"${result.meta.usd:.5f}")
```

```ts
// lines in each file
const result = await ctx.sh`grep -c '' ${ctx.glob("docs/*.md")}`.run();
console.log(result.ok, result.exitCode);
console.log(result.lines);
console.log(result.meta.calls, result.meta.callUnits, `$${result.meta.usd.toFixed(5)}`);
```

```text output
True 0
['docs/expenses.md:2', 'docs/onboarding.md:2']
1 1 $0.00005
```

In TypeScript the names are camel case: `exitCode`, `callUnits`, `wallMs`.

| Field | Meaning |
|---|---|
| `ok`, `exit_code` | whether the command exited 0, and what it exited with |
| `stdout`, `text`, `lines` | the output. `text` is `stdout`, and `lines` is it split into lines |
| `stderr` | what the command wrote to stderr, and the backend's own notes |
| `json()` | `stdout` parsed as JSON |
| `rows` | `sql` and `grep`: a list of objects. `None`/`null` otherwise, for a `sql` that failed, and for one sent `into()` a file |
| `value` | what a reducer produced; the rows for `sql`; `{exhaustive, stopped_reason}` for `grep` |
| `paths` | files written by `into()` |
| `truncated` | the output was cut at the limit |
| `results` | `batch`: one result per statement |
| `shards` | a mapped statement: one raw output per call |
| `plan` | the plan that ran |
| `meta` | `calls`, `call_units`, `usd`, `wall_ms`, `queue_ms`, `execute_ms` |
| `check()` | raise `ExecFailed` unless the exit code is 0. Returns the result |

## A command that fails is a result

A non-zero exit is not an exception. Look at `ok` or the exit code, or ask for an exception with `check`.

```python
f = ctx.path("docs/onboarding.md")
result = ctx.sh("grep -c nothing-matches-this {f}", f=f).run()
print(result.ok, result.exit_code)

try:
    result.check()                      # or run(check=True)
except archil.ExecFailed as e:
    print(e.exit_code, "|", e)
```

```ts
const f = ctx.path("docs/onboarding.md");
const result = await ctx.sh`grep -c nothing-matches-this ${f}`.run();
console.log(result.ok, result.exitCode);

try {
  result.check();                       // or run({ check: true })
} catch (e) {
  if (!(e instanceof archil.ExecFailed)) throw e;
  console.log(e.exitCode, "|", String(e));
}
```

```text output
False 1
1 | exec_failed: exit 1: no stderr — read result.stderr for the full output
```

This is deliberate. `grep` exits 1 when it finds nothing, and `diff` when files differ. Neither is a failure of the call.

A request that is *wrong* is different: it raises `ValidationError` before anything is sent. A budget that would be passed raises `BudgetExceeded`, also before anything is sent. See [Errors and exit codes](/guides/errors/).

Three exit codes are also used for failures that are not the command's own:

| Exit | Meaning |
|---|---|
| 1, with `mount failed: …` in stderr | a mount could not be made, usually a subdirectory that does not exist on the disk |
| 30 | on Archil, the checkout of an `owned` mount was not granted within five seconds: run it again. On the local backend with symlink mounts, the command wrote to a read-only mount: declare the write with `ctx.out` |
| 124 | the command ran past five minutes |

## Keep large output on the disk

`into(path)` sends the output to a file in the context and returns its path. Only stdout crosses the network, so a large result is cheaper left where it is.

```python
files = ctx.glob("docs/**/*.md")
saved = ctx.sh("cat {files}", files=files).into("memory/all-docs.md").run(check=True)
print(saved.paths, repr(saved.text))
print(len(ctx.read_text("memory/all-docs.md").splitlines()))
```

```ts
const saved = await ctx.sh`cat ${ctx.glob("docs/**/*.md")}`
  .into("memory/all-docs.md").run({ check: true });
console.log(saved.paths, JSON.stringify(saved.text));
console.log((await ctx.readText("memory/all-docs.md")).split("\n").length - 1);
```

```text output
['memory/all-docs.md'] ''
7
```

Use it when the output is large, or is wanted on the disk anyway. For `sql`, the file's format follows its extension: see [SQL over files](/guides/sql/#keep-the-result-on-the-disk).

## A larger VM

`sized()` chooses the VM for each call. The default is 2 vCPU and 4 GiB.

```python
heavy = ctx.sql(
    "select count(*)::int as n from {events}",
    events=ctx.log("logs").all(),
).sized(vcpu=8, mem_mib=16384)
plan = heavy.explain()
print(plan.estimate.call_units, plan.notes)
```

```ts
const heavy = ctx.sql`select count(*)::int as n from ${ctx.log("logs").all()}`
  .sized({ vcpu: 8, memMib: 16384 });
const plan = await heavy.explain();
console.log(plan.estimate.callUnits, plan.notes);
```

```text output
4 ['this VM size bills as 4 calls']
```

Anything larger than the default bills as a multiple of a call: the larger of the vCPU and the memory multiple, rounded up. `image=` names a custom base image.

## Limits

These follow Archil's documented limits. The local backend imposes the same ones, except the wait for a checkout: it has no checkouts.

| Limit | Value | What happens |
|---|---|---|
| A compiled command | 100 KiB | `ValidationError` (`command_too_large`) before anything is sent. Spread the inputs with `.map()` |
| Output | 4 MiB per stream | the first bytes are kept, the stream ends in `[output truncated]`, and `result.truncated` is true. Use `into()` |
| Time | 5 minutes per call | exit 124, and `Exec timed out` in stderr |
| An `owned` mount's checkout, on Archil | waited for up to 5 seconds | exit 30 |
| A mount that cannot be made | | exit 1, and `mount failed: …` in stderr |
| One append | 1 MiB | a log splits its appends to fit. One record larger than that is `record_too_large`. A direct `ctx.append` over the limit is a `ValidationError` with code `invalid` |
| Search results | 1,000 unless `max_results` says otherwise | `value` says the search stopped early |
| Calls at once | 64 | a mapped statement with more shards keeps 64 running until all are done |

[Limits](/reference/limits/) has the same table with the names of the settings.

## Next

:::cards
- [Read a plan](/guides/plans/) What a statement will do, before it does it.
- [Errors and exit codes](/guides/errors/) Every error code, and what to do about each.
:::
