---
title: API reference
description: Every public name in both SDKs, side by side. How the reference is laid out, how the two languages differ in spelling, and where each object is documented.
sidebar:
  label: Overview
---

The reference lists every public name in both SDKs. Each table has the Python on the left and the TypeScript beside it, so you can read either.

```py
import seaway as archil
```

```typescript
import * as archil from "seaway";
```

Python needs 3.10 or later. TypeScript needs Node 22.19 or later. Neither has runtime dependencies. This reference is for seaway 0.1.0.

## How the two are spelled

The names are the same, in the idiom of each language.

| | Python | TypeScript |
|---|---|---|
| Names | `snake_case` | `camelCase` |
| Options | keyword arguments | one options object, last |
| Anything that reaches a backend | synchronous | `async`: `await` it |
| Classes | `archil.Budget(max_usd=0.05)` | `new archil.Budget({ maxUsd: 0.05 })` |
| Absent | `None` | `null` |
| Bytes | `bytes` | `Uint8Array` |
| Maps the SDK returns | `dict` | `Map`, where the order of keys matters |
| A document as JSON | `.to_dict()` | `.toJSON()`, so `JSON.stringify(x)` works |
| A printed form | `str(x)` | `String(x)` |
| The base error | `archil.Error` | `archil.ArchilError` |

[Python and TypeScript](/reference/python-and-typescript/) has the differences that are more than spelling.

## The pages

| Page | Covers |
|---|---|
| [Context](/reference/context/) | `disk`, `context`, `from_manifest`, and everything on a `Context`: properties, narrowing, paths, direct verbs, statements, time, structures |
| [Statement](/reference/statement/) | `sh`, `sql`, `grep`, `batch`; the builders; `Result` and `Meta`; reducers |
| [Plan](/reference/plan/) | `Plan`, `Task`, the printed form and the JSON form |
| [Transaction](/reference/transaction/) | `transaction`, `Transaction`, `Commit`, and a turn's states |
| [Logs, views and feeds](/reference/structures/) | `Log`, `Selection`, `View`, `Feed`, `Changes` |
| [Recipes](/reference/recipes/) | `Recipe`, `Entry`, `Static`, `Records`, `sync`, `git`, `duckdb` |
| [Pricing](/reference/pricing/) | `PriceSheet`, `Budget`, `Estimate`, `Ledger` |
| [Tools](/reference/tools/) | `Tool`, `ctx.tools`, `asFileSystem` |
| [Backends](/reference/backends/) | `LocalBackend`, `ArchilBackend`, the backend interface, `Limits`, `MountSpec`, `Vm` |
| [Errors](/reference/errors/) | the error classes and their fields |
| [Limits](/reference/limits/) | every platform limit, its setting, and what happens at it |
| [Environment variables](/reference/environment/) | what the SDKs and the plugin read from the environment |
| [Python and TypeScript](/reference/python-and-typescript/) | every difference between the two APIs |

## What is exported

| Group | Names |
|---|---|
| Composing | `disk`, `context`, `from_manifest` / `fromManifest`, `Context`, `Mount`, `Source`, `MODES` |
| Statements | `Statement`, `Result`, `Meta`, `Plan`, `Task`, `REDUCERS`, `raw`, `Ref`, `Glob`, `Raw`, `FileStat` |
| Turns and structures | `Transaction`, `Commit`, `Log`, `Selection`, `View`, `Feed`, `Changes` |
| Recipes | `Recipe`, `Entry`, `Static`, `Records`, `sync`, `git`, `duckdb` |
| Prices | `PriceSheet`, `Budget`, `Estimate`, `Ledger` |
| Tools | `Tool` |
| Backends | `Backend`, `LocalBackend`, `ArchilBackend`, `MountSpec`, `Vm`, `Limits`, `ExecOutput`, `ObjectInfo`, `GrepHit` |
| Errors | `Error` / `ArchilError`, `ValidationError`, `BudgetExceeded`, `Busy`, `Conflict`, `NotSupported`, `ExecFailed`, `Issue` |
| Version | `__version__` / `VERSION` |

TypeScript also exports `asFileSystem`, `fmtUsd`, `fmtBytes`, `estimate`, `egressPolicy`, `issueText`, `TRUNCATED_MARK`, `DUCKDB_VERSION` and `DUCKDB_SHA256`, and the types listed in [Python and TypeScript](/reference/python-and-typescript/#types).

## The source is the authority

Both SDKs are short and are written to be read. When a detail is not here, read the source, in this order: `context`, `statement`, `plan`, `transaction`, `structures`, `recipes`, `tools`, `pricing`, then `backends`, `local`, `archil_backend`. Paths, globs and quoting are in `shell`, and the errors in `errors`.

- Python: [`python/src/seaway/`](https://github.com/discohead/seaway/tree/main/python/src/seaway)
- TypeScript: [`typescript/src/`](https://github.com/discohead/seaway/tree/main/typescript/src)

Every name in these reference pages is checked against both SDKs when the docs are built.
