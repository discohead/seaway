---
title: Context
description: Reference for disk, context and from_manifest, and for everything on a Context. Properties, narrowing, paths, the direct verbs, statements, time and structures, in Python and TypeScript.
---

A context composes disks into one tree. It is a plain value: every method that changes one returns a new context. The guide is [Compose a context](/guides/contexts/).

## disk

Describes a disk to mount. Contacts nothing.

```py
archil.disk(ref, mode="read",
            *, subdirectory="", at=None, create=False, description="") -> Source
```

```typescript
archil.disk(
  ref: string, mode?: Mode,
  options?: { subdirectory?, at?, create?, description? },
): Source
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `ref` | string | | a disk's name, or on Archil its `dsk-` id |
| `mode` | string | `"read"` | `read`, `frozen`, `owned`, `shared` or `append`. See [Mount modes](/guides/modes/) |
| `subdirectory` | string | `""` | mount this directory of the disk as the mount's root |
| `at` | string | none | the checkpoint a `frozen` mount is pinned to. Required for `frozen` |
| `create` | boolean | `false` | create the disk if no disk has that name |
| `description` | string | `""` | a note for whoever reads `describe()` or the manifest |

Raises `ValidationError` with `bad_mode` for an unknown mode, or for `frozen` without `at`.

`archil.MODES` is the five modes, in that order.

## context

Composes disks into a context. Resolves each disk on the backend.

```py
archil.context(mounts, *, backend=None, name="context", prices=None, budget=None,
               journal=None, tools=None, egress=None) -> Context
```

```typescript
archil.context(
  mounts: Record<string, Source | string>,
  options?: { backend?, name?, prices?, budget?, journal?, tools?, egress? },
): Promise<Context>
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `mounts` | map | | mount name to a `Source` from `archil.disk(...)`, or to a disk's name as a string, which is a `read` mount |
| `backend` | `Backend` | from the environment | where it runs. See [which one a context gets](/guides/backends/#which-one-a-context-gets) |
| `name` | string | `"context"` | shown in `describe()` and written to the manifest |
| `prices` | `PriceSheet` | the public rates | to override them |
| `budget` | `Budget` | none | a ceiling for everything the context runs. TypeScript also takes plain limits: `{ maxUsd: 0.05 }` |
| `journal` | string | none | a path in the context where every statement is recorded |
| `tools` | map | none | where DuckDB is when it is not on the VM's PATH: `{"duckdb": "memory/bin/duckdb"}`. `duckdb` is the one name it reads |
| `egress` | `"deny"`, `"allow"`, or a list of hosts | open | what commands may reach on the network |

Raises `ValidationError`: `empty_context`, `bad_mount`, `unknown_disk`, `bad_egress`. An unknown mode is refused earlier, by `archil.disk`.

## from_manifest

Opens a context from a [manifest](/guides/manifests/).

```py
archil.from_manifest(manifest, *, backend=None, prices=None, budget=None) -> Context
```

```typescript
archil.fromManifest(
  manifest: object | string,
  options?: { backend?, prices?, budget? },
): Promise<Context>
```

`manifest` is the document itself, a JSON string, or a path to a file. Raises `ValidationError` with `bad_manifest` when it does not carry `"archilContext": 0`.

## What a context is

| Python | TypeScript | Is |
|---|---|---|
| `ctx.name` | `ctx.name` | the context's name |
| `ctx.backend` | `ctx.backend` | the backend it runs on |
| `ctx.mounts` | `ctx.mounts` | the mounts, by name: a `dict` in Python, a `Map` in TypeScript |
| `ctx.prices` | `ctx.prices` | the `PriceSheet` |
| `ctx.budget` | `ctx.budget` | the `Budget`, or none |
| `ctx.egress` | `ctx.egress` | the network policy. `None`/`null`: open. Empty: nothing leaves. Hosts: only these |
| `ctx.journal` | `ctx.journal` | the journal's path, or none |
| `ctx.session` | `ctx.session` | eight hex characters, new for every context object |
| `ctx.spend` | `ctx.spend` | the `Ledger`. Contexts made from one another share it |
| `ctx.tools_map` | `ctx.toolsMap` | what was given as `tools` |
| `ctx.journal_pending` | `ctx.journalPending` | journal entries not yet on the disk |
| `ctx.describe()` | `ctx.describe()` | a few lines a model can read |
| `ctx.manifest()` | `ctx.manifest()` | the context as a JSON document |
| `ctx.spent_under_budget()` | `ctx.spentUnderBudget()` | an `Estimate` of what was spent since the budget was set |

## Contexts made from it

Each returns a new context. The original is unchanged.

| Python | TypeScript | Returns a context that |
|---|---|---|
| `ctx.narrow(*paths, read_only=False)` | `ctx.narrow(paths?, { readOnly })` | reaches only the given sub-trees. Several paths on one mount narrow it to the deepest directory that holds them all. TypeScript takes the paths as an array |
| `ctx.with_egress(egress)` | `ctx.withEgress(egress)` | runs its commands under a network policy: `"deny"`, `"allow"`, or a list of hosts |
| `ctx.with_budget(budget=None, **limits)` | `ctx.withBudget(budget)` | refuses a statement that would pass the ceiling. Takes a `Budget`, or its limits. `None`/`null` removes it |
| `ctx.mount(name, source)` | `await ctx.mount(name, source)` | has one more mount, or one replaced |
| `ctx.fork(name)` | `await ctx.fork(name)` | writes to private branches of the `owned` and `shared` disks |

`narrow` raises `unknown_mount` or `out_of_scope` for a path it cannot reach. See [Limit reach, network and spend](/guides/narrowing/).

## Paths, as statement parameters

| Python | TypeScript | Returns | Declares |
|---|---|---|---|
| `ctx.path(path)` | `ctx.path(path)` | `Ref` | a read of a file or a directory |
| `ctx.glob(pattern)` | `ctx.glob(pattern)` | `Glob` | a read of the files that match. `**` crosses directories; `*` does not |
| `ctx.out(path)` | `ctx.out(path)` | `Ref` | a write. The mount has to be `owned` or `shared` |
| `ctx.expand(sel)` | `await ctx.expand(sel)` | a list of `FileStat` | nothing: the files a path, glob or selection covers now, from a listing |
| `archil.raw(text)` | `archil.raw(text)` | `Raw` | nothing: text put into a command as written |

## The direct verbs

They go straight to the disk. No compute.

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `ctx.read(path)` | `await ctx.read(path)` | bytes | reads a file |
| `ctx.read_text(path)` | `await ctx.readText(path)` | string | reads a file as UTF-8 |
| `ctx.write(path, data, *, if_absent=False)` | `await ctx.write(path, data, { ifAbsent })` | the path | creates or replaces a file. `data` is a string or bytes |
| `ctx.append(path, data)` | `await ctx.append(path, data)` | the path | adds to the end of a file. At most 1 MiB |
| `ctx.exists(path)` | `await ctx.exists(path)` | boolean | whether a file is there |
| `ctx.rm(path)` | `await ctx.rm(path)` | nothing | removes a file, or a directory and everything under it |
| `ctx.ls(path="", *, recursive=False)` | `await ctx.ls(path?, { recursive })` | a list of `FileStat` | lists a directory. Directories end in `/`. An empty path lists the mounts |
| `ctx.share(path, *, expires_in=86400)` | `await ctx.share(path, { expiresIn })` | a URL | a link to a file that expires, in seconds |

`write` and `rm` raise `read_only` on a mount that is not `owned` or `shared`. `append` raises it on a `read` or `frozen` mount. `write(..., if_absent=True)` raises `exists` when the file is there.

## Statements

Nothing runs until `run()`. See [Statement](/reference/statement/).

| Python | TypeScript | Is |
|---|---|---|
| `ctx.sh(command, **params)` | ``ctx.sh`…` `` or `ctx.sh(command, params)` | a bash command |
| `ctx.sql(query, **params)` | ``ctx.sql`…` `` or `ctx.sql(query, params)` | a DuckDB query over files |
| `ctx.grep(pattern, over=None, **options)` | `ctx.grep(pattern, over?, options?)` | a regex search: one call per disk |
| `ctx.batch(statements)` | `ctx.batch(statements)` | several `sh` and `sql` statements in one call |

## Time

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `ctx.checkpoint(name)` | `await ctx.checkpoint(name)` | the checkpoint, by mount name | checkpoints each `owned`, `shared` and `append` mount |
| `ctx.lock(name)` | `await ctx.lock(name)` | a manifest | checkpoints every mount that is not `frozen`, and returns a manifest in which all of them are |
| `ctx.fork(name)` | `await ctx.fork(name)` | a `Context` | checkpoints and branches each `owned` and `shared` mount |
| `ctx.transaction(*, writes=None, reads=None, isolation="snapshot", name=None)` | `await ctx.transaction(fn, { writes, reads, isolation, name })` | a `Transaction` in Python; the `Commit` in TypeScript | a [turn](/reference/transaction/) |

## Structures

| Python | TypeScript | Returns |
|---|---|---|
| `ctx.log(path, *, partition="hour", writer=None)` | `ctx.log(path, { partition, writer })` | a [`Log`](/reference/structures/#log) |
| `ctx.view(path, build, *, inputs=None)` | `ctx.view(path, build, { inputs })` | a [`View`](/reference/structures/#view) |
| `ctx.feed(path, *, cursor)` | `ctx.feed(path, { cursor })` | a [`Feed`](/reference/structures/#feed) |
| `ctx.sync(recipe, into)` | `await ctx.sync(recipe, into)` | what changed: [`sync`](/reference/recipes/#sync) |
| `ctx.tools(names=None)` | `ctx.tools(names?)` | a list of [`Tool`](/reference/tools/) |

## The small types

### Mount

One mount of a context, as `ctx.mounts` holds it.

| Python | TypeScript | Is |
|---|---|---|
| `mount.name` | `mount.name` | the mount's name |
| `mount.source` | `mount.source` | the `Source` it was made from |
| `mount.handle` | `mount.handle` | the backend's handle for the disk. A branch's handle when frozen or forked |
| `mount.allow` | `mount.allow` | the sub-tree it was narrowed to. Empty for the whole mount |
| `mount.read_only` | `mount.readOnly` | forced read-only by `narrow` |
| `mount.mode` | `mount.mode` | the mode in effect. `read` when forced read-only, unless the mount is `frozen` |
| `mount.writable` | `mount.writable` | `owned` or `shared` |
| `mount.appendable` | `mount.appendable` | `owned`, `shared` or `append` |

### Source

What `archil.disk(...)` returns: `disk`, `mode`, `subdirectory`, `at`, `create`, `description`.

### Ref and Glob

| Python | TypeScript | Is |
|---|---|---|
| `ref.mount` | `ref.mount` | the mount's name |
| `ref.rel` | `ref.rel` | the path within the mount |
| `ref.write` | `ref.write` | whether it declares a write |
| `ref.path` | `ref.path` | `<mount>/<rel>` |
| `ref / "sub"` | `ref.join("sub")` | a path below this one |
| `glob.mount` | `glob.mount` | the mount's name |
| `glob.pattern` | `glob.pattern` | the pattern within the mount |
| `glob.path` | `glob.path` | `<mount>/<pattern>` |

### FileStat

What `ls`, `expand` and a feed return for each file.

| Python | TypeScript | Is |
|---|---|---|
| `file.path` | `file.path` | the context path: `<mount>/<rel>` |
| `file.size` | `file.size` | bytes |
| `file.modified` | `file.modified` | seconds since the epoch |
| `file.version` | `file.version` | a string that changes when the content does. See [Versions and clocks](/architecture/versions/) |
