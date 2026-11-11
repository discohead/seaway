---
title: Search
description: ctx.grep is a regex search fanned out next to the data. It is one call per disk, however many files there are, and it does not go through exec.
sidebar:
  label: Search with grep
---

`ctx.grep(pattern, over, ...)` uses Archil's native parallel search. One call searches a whole disk. A `grep` written inside an `sh` statement works too, but it scans from one VM and costs the same call.

::example-context

## Search a path

```python
hits = ctx.grep("rotate", "docs", ignore_case=True, globs=["*.md"]).run()
for hit in hits.rows:
    print(f"{hit['file']}:{hit['line']}: {hit['text']}")
print(hits.value)
```

```ts
const hits = await ctx.grep("rotate", "docs", {
  ignoreCase: true,
  globs: ["*.md"],
}).run();
for (const hit of hits.rows ?? []) console.log(`${hit.file}:${hit.line}: ${hit.text}`);
console.log(hits.value);
```

```text output
docs/security/keys.md:2: Rotate API keys every 90 days.
{'exhaustive': True, 'stopped_reason': 'completed'}
```

- `rows` is a list of `{file, line, text}`.
- `text` (and `stdout`) is the same matches as `file:line:text` lines.
- `value` says whether the search saw every file. When it stopped early, `value` says why, and the rows are a sample.

In TypeScript the keys of `value` are `exhaustive` and `stoppedReason`.

## Options

| Option | Python | TypeScript | Meaning |
|---|---|---|---|
| case | `ignore_case=True` | `ignoreCase: true` | match without regard to case |
| files | `globs=["checkout-*.ndjson"]` | `globs: [...]` | ripgrep globs. With no `/`, a glob matches a file name at any depth. A leading `!` excludes |
| cap | `max_results=200` | `maxResults: 200` | stop after this many matches. The default is 1,000 |
| depth | `recursive=False` | `recursive: false` | search the directory and not below it |

:::caution[A misspelt option is ignored in Python]
`ctx.grep` takes its options as keywords and passes over one it does not know. `ignorecase=True` searches with case. TypeScript's types catch the same mistake.
:::

## What it searches

- **`over` is a path in the context.** Left out, every mount is searched, one call each.
- **Search takes a directory.** Given a file, the SDK searches that file's directory for that one name.
- **It looks in hidden files, does not read `.gitignore`, and passes over binary files,** on both backends.
- **The framework's own files are passed over.** Nothing under `.px/` is searched.

## Its plan

A search has a route of its own. It runs no command of yours, so it carries no network policy and mounts nothing writable.

```python
print(ctx.grep("pool exhausted", "logs", globs=["checkout-*.ndjson"]).explain())
```

```ts
console.log(String(await ctx.grep("pool exhausted", "logs", {
  globs: ["checkout-*.ndjson"],
}).explain()));
```

```plan output
plan …  grep · … file(s), … KiB · 1 call
  route   grep · one call per disk, fanned out next to the data
  scope   logs → app-logs (read-only)
          not mounted: docs, memory, team
  reads   logs
  writes  —
```

The estimate for a search counts every file under the path. It ignores `globs`, so it runs high.

## grep or sh?

A plain `rg` or `grep` in an `sh` statement costs a call that scans from one VM. When such a statement declares its paths and has no pipe and no `into()`, its plan carries a note:

```python
print(ctx.sh("grep -rn rotate {d}", d=ctx.path("docs")).explain().notes)
```

```ts
console.log((await ctx.sh`grep -rn rotate ${ctx.path("docs")}`.explain()).notes);
```

```text output
['a plain regex search is one call per disk with ctx.grep(), however many files']
```

Use `sh` when the search is one step of a pipeline: `rg -c … | sort | head`. Use `ctx.grep` when the matches are the answer.

## Next

:::cards
- [Batch and map](/guides/batch-and-map/) Many statements in one call, or one input across many.
- [Statement reference](/reference/statement/) Every option of `grep`, in both languages.
:::
