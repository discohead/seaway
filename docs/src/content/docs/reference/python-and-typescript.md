---
title: Python and TypeScript
description: The two SDKs have one API. Every place where the TypeScript differs from the Python by more than spelling, and what each language has that the other does not.
---

The two SDKs have the same names, in snake case and in camel case, and the same semantics. They write the same files on disk. This page lists where they differ by more than spelling.

## At a glance

| | Python | TypeScript |
|---|---|---|
| Opening a context | `archil.context({...}, backend=b)` | `await archil.context({...}, { backend: b })` |
| Anything that reaches a backend | synchronous | `async`: `await` it |
| A statement with parameters | `ctx.sh("wc -w {f}", f=ctx.glob("docs/**/*.md"))` | ``ctx.sh`wc -w ${ctx.glob("docs/**/*.md")}` `` or `ctx.sh("wc -w {f}", { f })` |
| Running one | `stmt.run(check=True)` | `await stmt`, or `await stmt.run({ check: true })` |
| Narrowing | `ctx.narrow("docs/security", read_only=True)` | `ctx.narrow(["docs/security"], { readOnly: true })` |
| A turn | `with ctx.transaction(writes=[...]) as turn:` | `await ctx.transaction(async (turn) => {...}, { writes: [...] })` |
| A feed with nothing new | `if not changes:` | `if (changes.empty)` |
| Is a view fresh | `view.fresh` | `await view.fresh()` |
| The base error | `archil.Error` | `archil.ArchilError` |
| Calling a model's tool | `tool(**args)` | `await tool.call(args)` |
| A mapped `sum_by_key` | a `dict`, largest first | a `Map`, largest first |
| The version | `archil.__version__` | `archil.VERSION` |

## What is async

In TypeScript, everything that reaches a backend returns a promise: `archil.context`, `fromManifest`, `read`, `write`, `append`, `exists`, `rm`, `ls`, `share`, `expand`, `explain`, `run`, `refresh`, `fresh`, `fingerprint`, `poll`, `ack`, `sync`, `mount`, `fork`, `lock`, `checkpoint` and `transaction`. So do `readText`, a tool's `call`, and the `begin`, `changes`, `commit` and `rollback` of a turn made by hand.

These do not, because they only build a value: `disk`, `path`, `glob`, `out`, `sh`, `sql`, `grep`, `batch`, `map`, `into`, `sized`, `egress`, `within`, `narrow`, `withEgress`, `withBudget`, `manifest`, `describe`, `log`, `view`, `feed` and `tools`.

## Statements

**A statement can be a tagged template.** Each interpolation becomes a parameter named `p0`, `p1`, …, so the plan's `statement` reads `wc -w {p0} | sort -n`. The named form, `ctx.sh("wc -w {files}", { files })`, also works, and compiles to the same plan as the Python SDK's.

**A call with a template literal is not a tagged template.** ``ctx.sh(`cat ${x}`)`` hands seaway text that JavaScript has already assembled. Nothing is quoted, and nothing is declared.

**A statement is thenable.** `await statement` is `await statement.run()`. So an `async` function must not return a statement unless it means to run it. Return one from a plain function, or inside an object. The same goes for a view's build function.

**The hash of a tagged template differs** from the named form's, because the parameter names are in the statement. Use named parameters when a plan has to match the Python SDK's.

## Turns

**A TypeScript turn is a callback.** `ctx.transaction(fn, options)` passes the turn's own `Context`, commits when the callback returns, rolls back if it throws, and resolves to the `Commit`.

**A Python turn is a context manager.** `turn` is the `Transaction`, which passes a context's verbs on. The turn's context is `turn.view`, and a view made inside a turn is `turn.view.view(path, build)`.

**By hand,** Python calls `ctx.transaction(...)` and then `begin()`. TypeScript makes one with `new archil.Transaction(ctx, options)`, and its context is `tx.ctx`.

## Values

| | Python | TypeScript |
|---|---|---|
| Bytes | `bytes` | `Uint8Array` |
| A time you pass | a `datetime` | a `Date` |
| A span | `"15m"`, or a `timedelta` | `"15m"`, or a number of milliseconds |
| A file's `modified` | seconds since the epoch | the same |
| `ctx.mounts` | a `dict` | a `Map` |
| `checkpoint()`'s result | a `dict` | a `Map` |
| `tx.changes()` | `{mount: (written, deleted)}` | a `Map` of mount to `{ written, deleted }` |
| `tx.write_roots`, `tx.read_roots` | a `dict` | a `Map` |
| The `budget` option of `context` | a `Budget` | a `Budget`, or plain limits: `{ maxUsd: 0.05 }` |
| `ctx.egress` when nothing may leave | an empty tuple | an empty array |

A `Map` keeps its order, which a plain object would not for keys that look like integers.

## Spelling that is not just case

| Python | TypeScript |
|---|---|
| `x.to_dict()` | `x.toJSON()`, so `JSON.stringify(x)` writes the same document. `result.meta` is the exception: its keys are snake case from `to_dict()` and camel case from `toJSON()` |
| `str(x)` | `String(x)` |
| `a + b` on two estimates | `a.plus(b)` |
| `ref / "sub"` | `ref.join("sub")` |
| `bool(changes)` | `!changes.empty` |
| `error.message` is the message; `str(error)` adds the rest | the same: `error.message`, and `String(error)` |
| `archil.Budget(max_usd=0.05)` | `new archil.Budget({ maxUsd: 0.05 })` |
| `archil.Recipe`, a class to subclass | `Recipe`, an interface: any object with `name`, `list` and `get` |
| `archil.Entry(key, version)` | a plain object: `{ key, version }` |
| `backend.client`, on the Archil backend | `await backend.client()` |
| `with backend.commit_lock(disk):` | `const release = await backend.commitLock(disk)`, then `release()` |

## Only in TypeScript

- **`archil.asFileSystem(ctx)`**, which gives a context the shape of the official `disk` package's `FileSystem`. See [Tools](/reference/tools/#asfilesystem).
- **A checkout on the mount itself.** The official TypeScript client can ask for one, which is why an `owned` mount can be written from a custom image in TypeScript and not in Python.
- **Async callbacks.** A recipe's `list` and `get`, the `fetch` given to `Records`, and a reducer function may be `async`.
- **These exports:** `fmtUsd`, `fmtBytes`, `estimate`, `egressPolicy`, `issueText`, `TRUNCATED_MARK`, `DUCKDB_VERSION`, `DUCKDB_SHA256` and `VERSION`.
- **The error code `bad_template`,** for a tagged template that cannot be compiled.
- **Two errors that Python leaves plain.** A time that cannot be read is `bad_time`, where Python raises a `ValueError`. A `Static` or `Records` recipe asked for a key it does not have raises `not_found`, where Python raises a `KeyError`.
- **A mount cannot be named `__proto__`.** It is refused with `bad_mount`, because it cannot be a key of the mount map a call takes.

## Only in Python

- **`exec_timeout_s` on `ArchilBackend`:** the official client's request timeout. The TypeScript client's own is already the five minutes a call may run.
- **`ctx.grep` passes over an option it does not know.** A misspelt option is ignored, not refused. TypeScript's types catch the same mistake.

## Types

TypeScript exports these as types, for annotating code that uses the SDK.

| Area | Types |
|---|---|
| Composing | `Mode`, `Manifest`, `MountManifest`, `ContextOptions`, `SourceOptions` |
| Statements | `Selectable`, `Reduce`, `ReducerName`, `Row`, `GrepOptions` |
| Turns and structures | `TransactionOptions`, `TransactionState`, `LogOptions`, `ViewInput` |
| Recipes | `Recipe`, `Entry`, `RecordsOptions`, `SyncStats` |
| Prices and tools | `Prices`, `BudgetLimits`, `ToolSchema`, `ContextFileSystem` |
| Backends | `Backend`, `Egress`, `VmOptions`, `VmJSON`, `MountSpecOptions`, `MountSpecJSON`, `LocalBackendOptions`, `ArchilBackendOptions`, `ArchilClient`, `ArchilDisk`, `ExecOutput`, `GrepHit` |
| Errors | `Issue`, `ErrorDetails` |

A `Selectable` is anything that can stand where a glob can. A log selection is one.

## Running the TypeScript

The package runs from its `.ts` sources under Node's type stripping. There is no build step. That has two consequences for your project:

- **Install it as a link:** `npm install <checkout>/typescript`. Node will not run TypeScript from a copy under `node_modules`.
- **To type-check,** use the compiler options the SDK is checked with. [Installation](/start/installation/#typescript) has them.

## Port a program

To move a program from one SDK to the other:

1. Keyword arguments become an options object, and the reverse.
2. `snake_case` becomes `camelCase`.
3. Whatever reaches a backend gains or loses an `await`.
4. A `with ctx.transaction(...) as turn:` block becomes a callback, and the reverse.
5. `if not changes:` becomes `if (changes.empty)`, and `view.fresh` becomes `await view.fresh()`.

With the [Claude Code plugin](/agents/claude-code/), `/seaway:port <file>` does it.
