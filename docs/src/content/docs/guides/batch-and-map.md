---
title: Batch and map
description: batch runs several small statements in one call. map splits one input across many calls and puts the outputs back together, and only because you said how.
---

Two ways to change the number of calls. A **batch** makes it smaller: many small questions, one call. A **map** makes it larger: one pipeline over a great many files, spread across calls that run at once.

::example-context

## batch: many statements, one call

```python
both = ctx.batch([
    ctx.sh("wc -l < {f}", f=ctx.path("docs/onboarding.md")),
    ctx.sh("ls {d} | wc -l", d=ctx.path("docs")),
    ctx.sql("select count(*)::int as leads from {t}", t=ctx.glob("team/leads/*.csv")),
]).run()

print(both.meta.calls, [r.text.strip() for r in both.results[:2]], both.results[2].rows)
```

```ts
const both = await ctx.batch([
  ctx.sh`wc -l < ${ctx.path("docs/onboarding.md")}`,
  ctx.sh`ls ${ctx.path("docs")} | wc -l`,
  ctx.sql`select count(*)::int as leads from ${ctx.glob("team/leads/*.csv")}`,
]).run();

const texts = both.results.slice(0, 2).map((r) => r.text.trim());
console.log(both.meta.calls, texts, both.results[2]?.rows);
```

```text output
1 ['2', '3'] [{'leads': 4}]
```

Three statements, one call. Each still has its own result in `results`, with its own exit code, output and `rows`.

- **It takes plain `sh` and `sql` statements.** A mapped statement or a `grep` is refused with `bad_batch`: run those on their own.
- **The mount map is the union** of what the statements declare. If any of them declares nothing, the batch sees the whole context.
- **One VM means one network policy.** Set egress on the batch or on the context, not on one of its statements.
- **The batch's exit code** is the first one that is not zero.

## map: one input across many calls

The planner never guesses how to split a command. It splits only when you say which input to split and how to put the outputs back together.

```python
by_service = ctx.sh(
    "cat {files} | jq -r 'select(.level == \"ERROR\") | .service' | sort | uniq -c",
    files=ctx.glob("logs/**/*.ndjson"),
).map(reduce="sum_by_key", shards=4)

print(by_service.explain())
print(by_service.run(check=True).value)
```

```ts
const files = ctx.glob("logs/**/*.ndjson");
const byService =
  ctx.sh`cat ${files} | jq -r 'select(.level == "ERROR") | .service' | sort | uniq -c`
    .map({ reduce: "sum_by_key", shards: 4 });

console.log(String(await byService.explain()));
console.log((await byService.run({ check: true })).value);
```

```plan output
plan …  sh · … file(s), … KiB · 4 calls, combined by sum_by_key
  route   exec · 2 vCPU / 4 GiB · up to 4 at once
  scope   logs → app-logs (read-only)
          not mounted: docs, memory, team
  reads   logs/**/*.ndjson
  writes  —
{'checkout': 3}
```

Each call ran `sort | uniq -c` over its share of the files. The reducer added the counts up by key. In TypeScript a `sum_by_key` value is a `Map`, largest first.

- **Only `sh` statements can be mapped.** `grep` already fans out, and `sql` is one query.
- **`on` names the parameter to split.** It can be left out when exactly one parameter is a glob or a log selection.
- **`shards` is how many calls.** Left out, it is one per 256 MiB or per 2,000 files, whichever asks for more. It is never more than the number of files.
- **Files are spread so the shards are of similar size.** Up to 64 calls run at once.

The result's `value` is what the reducer produced, `text` is that as text, and `shards` holds each call's own output.

## Reducers

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

```python
lines = ctx.sh("cat {files} | wc -l", files=ctx.glob("docs/**/*.md"))
print(lines.map(reduce="sum", shards=3).run(check=True).value)

per_file = lines.map(reduce=lambda outputs: sorted(int(o) for o in outputs), shards=3)
print(per_file.run(check=True).value)
```

```ts
const lines = ctx.sh`cat ${ctx.glob("docs/**/*.md")} | wc -l`;
console.log((await lines.map({ reduce: "sum", shards: 3 }).run({ check: true })).value);

const perFile = lines.map({
  reduce: (outputs) => outputs.map(Number).sort((a, b) => a - b),
  shards: 3,
});
console.log((await perFile.run({ check: true })).value);
```

```text output
7.0
[2, 2, 3]
```

In Python the total of `sum` is a float. In TypeScript it is a number, printed as `7`.

`sum_by_key` reads three line forms:

- `   12 key`: what `uniq -c` writes;
- `key:12` or `key<TAB>12`: what `rg -c --with-filename` and `awk` write;
- `12 key`.

With `rg -c`, add `--with-filename` so that a shard of one file still names it.

### Choose a reducer that is right for the command

A reducer combines the outputs. It does not know what the command meant.

- `sort | uniq -c` per shard and `sum_by_key` gives the true counts.
- `sort | head -5` per shard and `concat` does **not** give the top five. It gives five from each shard.

Reducers are strict. `sum` and `sum_by_key` raise `bad_reduce_input` on a line they cannot read, because a reducer that quietly dropped one shard's output would be worse than no parallelism. When the output is not in a shape a reducer reads, reduce with `lines` and combine it yourself.

## map and into

A mapped statement with `into(path)` writes one file per shard: `<path>/part-00000`, `part-00001`, and so on. `paths` lists only the parts whose call succeeded.

On Archil, parallel calls that write into an `owned` mount queue for its checkout. Map into a `shared` mount when the shards should write at once. The plan carries a note when this applies.

## When to use which

| The work is | Use | Calls |
|---|---|---|
| several small things at once | `batch` | one for all of them |
| one pipeline over a few files | a plain `sh` | one |
| one pipeline over more than 256 MiB or 2,000 files | `map` with a reducer | one per shard |
| a regex over everything | [`ctx.grep`](/guides/grep/) | one per disk |
| an aggregate over many files | [`ctx.sql`](/guides/sql/) | one |

A plan tells you when a map would help. An `sh` statement whose glob or log selection covers more than 256 MiB or 2,000 files in one call carries the note `N files in one call; .map() would spread this over about M calls`.

## Next

:::cards
- [Results and limits](/guides/results/) What comes back, and what happens at each limit.
- [Read a plan](/guides/plans/) The split line, and the notes about it.
:::
