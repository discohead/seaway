---
title: Logs, views and feeds
description: Reference for Log, Selection, View, Feed and Changes, in Python and TypeScript.
sidebar:
  label: Logs, views and feeds
---

Three structures built from the same verbs. The guides are [Logs](/guides/logs/), [Views](/guides/views/) and [Feeds](/guides/feeds/).

## Log

Append-only records at `<path>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`, in UTC.

```py
ctx.log(path, *, partition="hour", writer=None) -> Log
```

```typescript
ctx.log(path: string, options?: { partition?, writer? }): Log
```

| Option | Default | Meaning |
|---|---|---|
| `partition` | `"hour"` | `"hour"`, `"day"` or `"none"`. Anything else is `bad_partition` |
| `writer` | the context's session id | names the file. Characters other than letters, digits, `_`, `.` and `-` become `-` |

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `log.append(records, *, at=None)` | `await log.append(records, { at })` | the files written | adds one record or several. Each gets `ts` and `id` unless it has them |
| `log.last(span, *, now=None)` | `log.last(span, { now })` | a `Selection` | the records from the last `span` up to now |
| `log.between(start, end)` | `log.between(start, end)` | a `Selection` | the records with `start <= ts < end` |
| `log.all()` | `log.all()` | a `Selection` | the whole log |
| `log.path` | `log.path` | a string | the log's path in the context |
| `log.partition` | `log.partition` | a string | the partition |
| `log.writer` | `log.writer` | a string | the writer's name |

- **`records`** is one record or an iterable of them. A record is a `dict` in Python and a plain object in TypeScript.
- **`at`** is the time for records that carry no `ts`: a `datetime` in Python, a `Date` in TypeScript. The default is now.
- **`span`** is `"30s"`, `"15m"`, `"2h"` or `"7d"`. Python also takes a `timedelta`, and TypeScript a number of milliseconds. Anything else is `bad_duration`.
- **`start`, `end`, `now`** are a `datetime` in Python and a `Date` in TypeScript. A time without a zone is taken as UTC.

`append` raises `ValidationError` with `record_too_large` for one record over 1 MiB, and `read_only` on a mount that cannot be appended to.

## Selection

A time range of a log. Pass it as a statement parameter, where a path or a glob would go.

| In | A selection is |
|---|---|
| `sh` | the partition files that cover the range |
| `sql` | a table of exactly the records in the range: the files, with a filter on `ts` |
| `ctx.expand(selection)` | the files, as a list of `FileStat` |
| `str(selection)` / `String(selection)` | its label: `logs[last 15m]` |

Its fields are `log`, `start`, `end` and `label`.

## View

A derived file that rebuilds only when its inputs or its statement changed.

```py
ctx.view(path, build, *, inputs=None) -> View
```

```typescript
ctx.view(
  path: string,
  build: Statement | (() => Statement),
  options?: { inputs? },
): View
```

| Parameter | Meaning |
|---|---|
| `path` | where the derived file lives. On a mount the context can write |
| `build` | a statement, or a function that returns one. In TypeScript it must be a plain function, not an `async` one |
| `inputs` | what the output depends on, when the statement's own read parameters do not say: paths, globs or selections. It replaces them |

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `view.refresh(*, force=False)` | `await view.refresh({ force })` | the build's `Result`, or none | rebuilds if stale. With `force`, rebuilds regardless |
| `view.fresh` | `await view.fresh()` | a boolean | whether the output exists and its fingerprint matches. A property in Python, a method in TypeScript |
| `view.read()` | `await view.read()` | bytes | refreshes if stale, then reads the file |
| `view.read_text()` | `await view.readText()` | a string | the same, as text |
| `view.share(*, expires_in=86400)` | `await view.share({ expiresIn })` | a URL | a link to the file that expires |
| `view.fingerprint()` | `await view.fingerprint()` | a string | changes when the inputs change, or the statement's template or parameters do. A change to `sized`, `egress` or `map` alone does not move it. From a listing |
| `view.statement()` | `view.statement()` | a `Statement` | the build, with its output sent to the view's path |
| `view.path` | `view.path` | a string | the view's path in the context |

A failed build records nothing, so the next `refresh()` tries again.

## Feed

What changed under a path since a reader last looked.

```py
ctx.feed(path, *, cursor) -> Feed
```

```typescript
ctx.feed(path: string, options: { cursor: string }): Feed
```

| Parameter | Meaning |
|---|---|
| `path` | the path to watch |
| `cursor` | where this reader's cursor is kept. On a mount the context can write |

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `feed.poll()` | `await feed.poll()` | a `Changes` | lists the path and compares it with the cursor. No call, no data read |
| `feed.path` | `feed.path` | a string | the watched path |
| `feed.cursor` | `feed.cursor` | a string | the cursor's path |

## Changes

| Python | TypeScript | Is |
|---|---|---|
| `changes.added` | `changes.added` | files that were not there at the last `ack()`: a list of `FileStat` |
| `changes.modified` | `changes.modified` | files whose size or version changed |
| `changes.removed` | `changes.removed` | the paths of files that are gone |
| `changes.files` | `changes.files` | `added`, then `modified` |
| `changes.previous` | `changes.previous` | the size each modified file had before, by path |
| `changes.refs()` | `changes.refs()` | `files` as statement parameters: a list of `Ref` |
| `changes.ack()` | `await changes.ack()` | moves the cursor. Until then `poll()` returns the same changes |
| `bool(changes)` | `!changes.empty` | whether there is anything to do |

Delivery is at least once.
