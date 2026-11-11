# The TypeScript API

The whole surface of `import * as archil from "seaway"`, as signatures. It is a port of the Python reference with the same semantics and the same files on disk. Node 22.19 or later, which runs `.ts` directly: there is no build step and the package has no runtime dependencies. The source is the authority: `typescript/src/`.

## Contents

- [What differs from Python](#what-differs-from-python)
- [Composing](#composing)
- [Context](#context)
- [Statement, Result, Plan](#statement-result-plan)
- [Transaction](#transaction)
- [Log, View, Feed](#log-view-feed)
- [Recipes](#recipes)
- [Prices](#prices)
- [Tools](#tools)
- [Backends](#backends)
- [Errors](#errors)
- [Types](#types)

## What differs from Python

- **Everything that reaches a backend is async.** `archil.context(...)` returns a promise, and so do `read`, `write`, `ls`, `explain`, `run`, `refresh`, `poll`, `ack`, `sync`, `fork`, `lock` and `checkpoint`. `path`, `glob`, `out`, `narrow`, `withEgress`, `withBudget`, `manifest`, `describe` and `tools` are not.
- **Keyword arguments become an options object,** and names are camel case: `read_only=True` is `{ readOnly: true }`, `mem_mib` is `memMib`, `result.exit_code` is `result.exitCode`.
- **A statement can be a tagged template.** Each interpolation becomes a parameter named `p0`, `p1`, …, so the plan's `statement` reads `wc -w {p0} | sort -n`. The named form, `ctx.sh("wc -w {files}", { files })`, also works and compiles to the same plan as the Python SDK's.
- **A call with a template literal is not a tagged template.** ``ctx.sh(`cat ${x}`)`` hands seaway text that JavaScript already assembled: nothing is quoted and nothing is declared.
- **A statement is thenable:** `await statement` is `await statement.run()`. So an `async` function must not return a statement unless it means to run it. Return one from a plain function, or inside an object.
- **A turn is a callback:** `ctx.transaction(fn, options)` passes the turn's own `Context`. `new archil.Transaction(ctx, options)` gives the explicit `begin()`, `commit()` and `rollback()`, and its context is `tx.ctx`.
- `changes.empty` replaces Python's truthiness on a feed's changes. `view.fresh()` is a method to await.
- `narrow` takes the paths as an array: `ctx.narrow(["docs/security"], { readOnly: true })`.
- The base error is `archil.ArchilError`. `error.message` is the message alone and `String(error)` adds the code, the path and the suggestion.
- `ctx.mounts`, `checkpoint()`'s result, `tx.changes()`, `tx.writeRoots`, `tx.readRoots` and a mapped `sum_by_key` are `Map`s. A `Map` keeps its order, which a plain object would not for keys that look like integers.
- Bytes are `Uint8Array`. A span can be a number of milliseconds as well as `"15m"`. A time you pass is a `Date`. A file's `modified` is a number, seconds since the epoch, as in Python.
- Python's `.to_dict()` is `toJSON()`, so `JSON.stringify(plan)` writes the same document as `plan.to_dict()`. `a + b` on two estimates is `a.plus(b)`, and `ref / "sub"` is `ref.join("sub")`.
- The `budget` option of `archil.context` takes plain limits, `{ maxUsd: 0.05 }`, as well as a `Budget`. Python takes a `Budget`.
- Exported here and not from the Python package: `fmtUsd`, `fmtBytes`, `estimate`, `egressPolicy`, `issueText`, `TRUNCATED_MARK`, `DUCKDB_VERSION`, `DUCKDB_SHA256` and `VERSION` (Python has `__version__`).
- `archil.asFileSystem(ctx)` exists only here; see [model-tools.md](model-tools.md#the-official-tool-layer-asfilesystem).
- `disk`, the official SDK, is an optional peer dependency, loaded only when a context uses `ArchilBackend`. Its client can ask for a checkout on the mount itself, which is why an `owned` mount can be written from a custom image here and not from Python.

## Composing

```typescript
archil.disk(ref, mode = "read", { subdirectory, at, create, description }): Source
archil.context(mounts, { backend, name, prices, budget, journal, tools, egress }): Promise<Context>
archil.fromManifest(manifest, { backend, prices, budget }): Promise<Context>     // an object, a JSON string, or a path
archil.MODES            // ["read", "frozen", "owned", "shared", "append"]
archil.VERSION
```

`mounts` maps a mount name to a `Source` from `archil.disk(...)`, or to a disk's name as a string, which is a `read` mount.

## Context

```typescript
// what it is
ctx.name            ctx.backend         ctx.mounts          // Map<string, Mount>
ctx.prices          ctx.budget          ctx.egress          // null: open. []: nothing leaves. [hosts…]: only these
ctx.journal         ctx.session         ctx.spend           // the Ledger
ctx.toolsMap                                  // what was given as tools; ctx.tools is the method below
ctx.describe(): string
ctx.manifest(): Manifest
ctx.journalPending: number
ctx.spentUnderBudget(): Estimate              // what has been spent since the budget was set

// contexts made from it
ctx.narrow(paths?: string[], { readOnly }): Context
ctx.withEgress(egress): Context               // "deny", "allow", or a list of hosts
ctx.withBudget(budget): Context               // a Budget, { maxUsd, maxCalls, maxBytesTouched }, or null to remove it
ctx.mount(name, source): Promise<Context>
ctx.fork(name): Promise<Context>

// paths, as statement parameters
ctx.path(path): Ref     ctx.glob(pattern): Glob     ctx.out(path): Ref
ctx.expand(sel): Promise<FileStat[]>

// the data plane: direct, no compute
ctx.read(path): Promise<Uint8Array>
ctx.readText(path): Promise<string>
ctx.write(path, data, { ifAbsent }): Promise<string>        // a string or bytes; resolves to the path
ctx.append(path, data): Promise<string>
ctx.exists(path): Promise<boolean>
ctx.rm(path): Promise<void>
ctx.ls(path = "", { recursive }): Promise<FileStat[]>
ctx.share(path, { expiresIn }): Promise<string>

// statements: nothing runs until it is awaited or .run() is called
ctx.sh`…`               ctx.sh(command, params): Statement
ctx.sql`…`              ctx.sql(query, params): Statement
ctx.grep(pattern, over?, { ignoreCase, globs, maxResults, recursive }): Statement
ctx.batch(statements): Statement

// time
ctx.checkpoint(name): Promise<Map<string, string>>
ctx.lock(name): Promise<Manifest>
ctx.transaction(async (turn) => { … }, { writes, reads, isolation, name }): Promise<Commit>

// structures
ctx.log(path, { partition, writer }): Log
ctx.view(path, build, { inputs }): View
ctx.feed(path, { cursor }): Feed
ctx.sync(recipe, into): Promise<SyncStats>
ctx.tools(names?): Tool[]
```

```typescript
Mount:      name, source, handle, allow, readOnly;  .mode  .writable  .appendable
Source:     disk, mode, subdirectory, at, create, description
Ref:        mount, rel, write;  .path;  ref.join("sub")
Glob:       mount, pattern;  .path
FileStat:   path, size, modified, version
archil.raw(text): Raw
```

## Statement, Result, Plan

```typescript
stmt.map({ on, reduce = "concat", shards }): Statement      // sh only
stmt.into(path): Statement
stmt.sized({ vcpu, memMib, image }): Statement
stmt.egress(policy): Statement
stmt.within({ maxUsd, maxCalls, maxBytesTouched }): Statement
stmt.explain(): Promise<Plan>
stmt.run({ check }): Promise<Result>
await stmt                                    // the same as await stmt.run()

archil.REDUCERS         // concat, lines, sorted, unique, count, sum, sum_by_key, json
```

```typescript
Result:  kind, exitCode, stdout, stderr, value, rows, paths, truncated, results, shards, plan, meta
         .ok  .text  .lines  .json()  .check()
Meta:    calls, callUnits, usd, wallMs, queueMs, executeMs;  .toJSON()
Plan:    kind, route, statement, tasks, vm, reads, writes, reduce, estimate, notes, files, parallel, unmounted, readPaths
         .hash  String(plan)  JSON.stringify(plan)  .toJSON()
Task:    command, mounts, label;  .toJSON()
```

`plan.reads` holds what the printed plan shows, such as `logs[last 15m]`. `plan.readPaths`, when it is set, holds the same reads as paths, and is what `effects.reads` reports in the JSON.

## Transaction

```typescript
const commit = await ctx.transaction(async (turn) => {      // turn is a Context on the turn's branch
  await turn.write(…); await turn.sh`…`.run({ check: true });
}, { writes: […] });

const tx = new archil.Transaction(ctx, { writes, reads, isolation = "snapshot", name });
await tx.begin(): Promise<Transaction>
tx.ctx: Context                                // the turn's context, once begun
await tx.changes(): Promise<Map<string, { written: string[]; deleted: string[] }>>
await tx.commit(): Promise<Commit>             // throws Conflict
await tx.rollback(): Promise<void>
tx.id   tx.state   tx.isolation   tx.base   tx.writeRoots   tx.readRoots

Commit:  id, applied, deleted, calls;  .empty
```

## Log, View, Feed

```typescript
const log = ctx.log(path, { partition = "hour", writer });  // partition: "hour", "day", "none"
await log.append(records, { at }): Promise<string[]>        // one record or an iterable of them
log.last(span, { now }): Selection             // "30s", "15m", "2h", "7d", or a number of milliseconds
log.between(start, end): Selection             // Dates; start <= ts < end
log.all(): Selection
log.path   log.partition   log.writer

const view = ctx.view(path, build, { inputs }); // build: a Statement, or a plain function that returns one
await view.refresh({ force }): Promise<Result | null>       // null when nothing ran
await view.fresh(): Promise<boolean>
await view.read(): Promise<Uint8Array>          await view.readText(): Promise<string>
await view.share({ expiresIn }): Promise<string>
await view.fingerprint(): Promise<string>       view.statement(): Statement     view.path

const feed = ctx.feed(path, { cursor });
const changes = await feed.poll();
changes.added   changes.modified               // FileStat[]
changes.removed                                // string[]
changes.previous                               // { [path]: size before }, for modified files
changes.files   changes.refs()   await changes.ack()
changes.empty                                  // a Changes
```

## Recipes

```typescript
await ctx.sync(recipe, into): Promise<{ written, unchanged, deleted, into }>     // also archil.sync(ctx, recipe, into)
new archil.Static(files, { name, layout })
new archil.Records(name, fetch, { key = "id", version, body, layout })
// a recipe of your own is any object with: name, layout, list(): entries of { key, version }, get(key): bytes or a string
archil.git(ctx, url, into, { depth = 1 }): Statement
archil.duckdb(ctx, into, { version, url, sha256 }): Statement
archil.DUCKDB_VERSION   archil.DUCKDB_SHA256
```

`list` and `get` may be async, and so may the `fetch` given to `Records`.

## Prices

```typescript
new archil.PriceSheet({ asOf, source, callUsd, callVcpu, callMemMib, activeGibMonthUsd, archiveGbMonthUsd,
                        sandboxVcpuHourUsd, sandboxGibHourUsd, egressGbUsd, activeWindowHours, hoursPerMonth })
prices.callUnits(vcpu = 2, memMib = 4096): number
prices.activeUsd(nbytes): number      prices.egressUsd(nbytes): number
prices.sandboxHourUsd(vcpu, memMib): number
prices.breakevenCallsPerHour(vcpu = 2, memMib = 4096): number

new archil.Budget({ maxUsd, maxCalls, maxBytesTouched })
Estimate:  calls, callUnits, bytesTouched, egressBytes, usdCalls, usdActive, usdEgress, complete
           .usd  .plus(other)  .since(earlier)  .toJSON()
Ledger:    ctx.spend.total  .statements  .snapshot(): Estimate;  String(ctx.spend)
archil.fmtUsd(x)   archil.fmtBytes(n)
```

## Tools

```typescript
const tools = ctx.tools(names?);               // read_file, write_file, delete_file, list_files, grep, run_bash, sql, plan
                                               // with no names, the two write tools are left out when nothing is writable
tool.name   tool.description   tool.parameters
await tool.call(args): Promise<string>         // never throws; an error is "error: …"
tool.toAnthropic(): { name, description, input_schema }
tool.toOpenAI(): { type: "function", function: { name, description, parameters } }
archil.asFileSystem(ctx): ContextFileSystem    // the official disk package's FileSystem, plus diskNames()
```

## Backends

```typescript
new archil.LocalBackend({ root = ".archil-local", isolation = "auto", verifyReadOnly = true, limits,
                          name = "local", insideArchil = true, capabilities })
new archil.ArchilBackend({ client, apiKey, region, insideArchil = false, limits, name = "archil", capabilities })

backend.name   backend.limits   backend.insideArchil
backend.capabilities                           // a set of "checkpoint", "branch", "grep", "share"
backend.checkpointCalls                        // what one checkpoint bills as: 1
backend.versionGranularityS                    // how coarse a file's version is: 0 locally, 1 on Archil
backend.resolveDisk(ref, { create }): Promise<string>
backend.exec(mounts, command, vm): Promise<ExecOutput>
backend.grep(disk, directory, pattern, options): Promise<[GrepHit[], string]>
backend.get(disk, key)   backend.put(disk, key, data, { ifAbsent })   backend.append(disk, key, data)
backend.delete(disk, key)   backend.list(disk, prefix, { recursive })   backend.head(disk, key)
backend.share(disk, key, expiresIn)   backend.checkpoint(disk, name)   backend.branch(disk, name, fromCheckpoint, { existOk })
backend.commitLock(disk): Promise<() => void>

new archil.Limits({ maxCommandBytes, maxOutputBytes, execTimeoutS, maxParallel, appendMaxBytes, grepMaxResults, checkoutQueueMs })
new archil.MountSpec(disk, { subdirectory, readOnly, conditional, checkoutPaths, queueMs })
new archil.Vm({ vcpu = 2, memMib = 4096, image, egress })
ExecOutput:  exitCode, stdout, stderr, queueMs, executeMs, totalMs, truncated
ObjectInfo:  key, size, modified, etag;  .version
GrepHit:     file, line, text
```

A backend of your own is any object that satisfies the `Backend` interface: every member above, `checkpointCalls` and `versionGranularityS` included. Turns, forks and locks need `"checkpoint"` and `"branch"` in its `capabilities`; without them a transaction throws `NotSupported`.

`LocalBackend.execLog` lists every exec the backend ran, which is handy in tests. `await archilBackend.client()` is the official client, for what this SDK does not wrap, such as deleting a disk. It is typed as `ArchilClient`, which declares only what the SDK calls, so typed code casts to reach the rest: the SDK's own example does, to call a disk's `delete()`.

## Errors

```typescript
archil.ArchilError                            // the base: .code  .message  .path  .suggestion  String(e)  JSON.stringify(e)
archil.ValidationError                        // .issues: { code, message, path, suggestion }[]
archil.BudgetExceeded
archil.Conflict                               // .paths
archil.Busy
archil.NotSupported
archil.ExecFailed                             // .exitCode  .stderr  .command
archil.issueText(issue): string
```

Codes and what to do about each are in [errors.md](errors.md).

## Types

Exported as types, for annotating code that uses the SDK:

```typescript
Mode   Manifest   MountManifest   ContextOptions   SourceOptions          // composing
Selectable   Reduce   ReducerName   Row   GrepOptions                     // statements; a Selectable can stand where a glob can
TransactionOptions   TransactionState   LogOptions   ViewInput            // turns and structures
Recipe   Entry   RecordsOptions   SyncStats                               // recipes
Prices   BudgetLimits   ToolSchema   ContextFileSystem                    // prices and tools
Backend   Egress   VmOptions   VmJSON   MountSpecOptions   MountSpecJSON  // backends
LocalBackendOptions   ArchilBackendOptions   ArchilClient   ArchilDisk    // what a client you supply has to provide
ExecOutput   GrepHit   Issue   ErrorDetails
```
