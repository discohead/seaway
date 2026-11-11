---
title: Compose a context
description: A context composes disks into one tree. Each mount names a disk and a mode. Open one, read what it holds, and read and write files directly.
---

A context is the answer to "what data does this agent have, and under what rules?" It is a plain value: every method that changes one returns a new context and leaves the original alone.

::example-context

## Open one

```python
ctx = archil.context(
    {
        "docs": archil.disk("handbook", description="company policies, one file each"),
        "logs": archil.disk("app-logs", "append"),
        "memory": archil.disk("agent-memory", "owned", create=True),
        "team": archil.disk("team-notes", "shared"),
    },
    backend=backend,
    name="agent-7",              # shown in describe() and written to the manifest
    journal="memory/journal",    # every statement is logged here
)
print(ctx.describe())
```

```ts
const ctx = await archil.context(
  {
    docs: archil.disk("handbook", "read", {
      description: "company policies, one file each",
    }),
    logs: archil.disk("app-logs", "append"),
    memory: archil.disk("agent-memory", "owned", { create: true }),
    team: archil.disk("team-notes", "shared"),
  },
  { backend, name: "agent-7", journal: "memory/journal" },
);
console.log(ctx.describe());
```

```text output
context "agent-7" on local
  docs/    read    handbook  company policies, one file each
  logs/    append  app-logs
  memory/  owned   agent-memory
  team/    shared  team-notes
Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to the data and bill per call (≈ $0.00005). explain() prices a statement first.
```

`describe()` is a few lines a model can read. It is a good start for a system prompt.

## Describe a disk

`archil.disk(ref, mode, ...)` describes a disk to mount and contacts nothing. `ref` is a disk's name, or on Archil its `dsk-` id. A bare string in the mount map is a `read` mount of the disk with that name: `{"docs": "handbook"}`.

| Option | Meaning |
|---|---|
| `mode` | `read` (the default), `frozen`, `owned`, `shared` or `append`. See [Mount modes](/guides/modes/) |
| `at` | the checkpoint a `frozen` mount is pinned to. Required for `frozen` |
| `subdirectory` | mount this directory of the disk as the mount's root |
| `create` | create the disk if no disk has that name. Without it, an unknown name is the error `unknown_disk` |
| `description` | a note for whoever reads `describe()` or the manifest |

## Options for a context

`archil.context(mounts, ...)` resolves each disk on the backend, which is why it is `async` in TypeScript.

| Option | Meaning |
|---|---|
| `backend` | where it runs. Left out: Archil when `ARCHIL_API_KEY` is set, else local. See [Local and Archil backends](/guides/backends/) |
| `name` | the context's name. `"context"` when left out |
| `journal` | a path in the context where every statement is recorded. See [The journal](/guides/journal/) |
| `tools` | where DuckDB is when it is not on the VM's PATH: `{"duckdb": "memory/bin/duckdb"}`. `duckdb` is the one name it reads |
| `egress` | what commands may reach on the network: `"deny"`, `"allow"`, or a list of hosts |
| `budget` | a ceiling for everything the context runs |
| `prices` | a `PriceSheet` of your own, to override the public rates |

A mount name is one path segment. `.px` is not allowed: it is where the framework keeps its own files on a disk.

## Paths

A path starts with a mount name. `docs/security/keys.md` is `security/keys.md` on the disk mounted as `docs`.

- No leading slash, and no `..`. A path with `..` is the error `bad_path`.
- A first segment that is not a mount is the error `unknown_mount`, and the error lists the mounts.
- Never write `/mnt/archil/...`. That directory exists only inside a call on Archil.

## Read and write directly

Six verbs go straight to the disk through the object API. They use no compute, so on Archil they are not billed as calls.

```python
ctx.write("memory/notes/todo.md", "- rotate the keys\n")
ctx.append("memory/notes/todo.md", "- file expenses\n")
print(ctx.read_text("memory/notes/todo.md"))
print(ctx.exists("docs/onboarding.md"), [f.path for f in ctx.ls("docs")])
ctx.rm("memory/notes/todo.md")
```

```ts
await ctx.write("memory/notes/todo.md", "- rotate the keys\n");
await ctx.append("memory/notes/todo.md", "- file expenses\n");
console.log(await ctx.readText("memory/notes/todo.md"));
const exists = await ctx.exists("docs/onboarding.md");
console.log(exists, (await ctx.ls("docs")).map((f) => f.path));
await ctx.rm("memory/notes/todo.md");
```

```text output
- rotate the keys
- file expenses

True ['docs/security/', 'docs/expenses.md', 'docs/onboarding.md']
```

| Verb | Does | Needs a mount in |
|---|---|---|
| `read`, `read_text` | returns a file's bytes, or its text | any mode |
| `write` | creates or replaces a file. `if_absent=True` refuses if it exists | `owned`, `shared` |
| `append` | adds to the end of a file, at most 1 MiB at a time | `owned`, `shared`, `append` |
| `exists` | whether a file is there | any mode |
| `ls` | lists a directory. Directories end in `/`. `recursive=True` lists everything below. An empty path lists the mounts | any mode |
| `rm` | removes a file, or a directory and everything under it | `owned`, `shared` |
| `share` | returns a link to a file that expires, to hand to a person | any mode |

A write the mode does not allow is refused before anything is sent. The error says what to do:

```python
try:
    ctx.write("logs/note.txt", "x")
except archil.ValidationError as e:
    print(e.code, "|", e.suggestion)
```

```ts
try {
  await ctx.write("logs/note.txt", "x");
} catch (e) {
  if (!(e instanceof archil.ValidationError)) throw e;
  console.log(e.code, "|", e.suggestion);
}
```

```text output
read_only | use append() or log() for an append-only mount
```

A listing reads no data. On Archil it does not make data active, so it moves no meter.

## Contexts made from a context

Each of these returns a new context. The original is unchanged.

| Method | Returns a context that | Guide |
|---|---|---|
| `narrow` | reaches only the given sub-trees, under the same path names | [Limit reach, network and spend](/guides/narrowing/) |
| `with_egress` | runs its commands under a network policy | [Limit reach, network and spend](/guides/narrowing/#the-network) |
| `with_budget` | refuses a statement that would pass a ceiling | [Limit reach, network and spend](/guides/narrowing/#spend) |
| `mount` | has one more mount, or one replaced | |
| `fork` | writes to private branches of the writable disks | [Checkpoint, lock and fork](/guides/checkpoints/) |

Contexts made from one another share one ledger, so `ctx.spend` counts what all of them sent.

## Next

:::cards
- [Mount modes](/guides/modes/) The five modes, and how to choose one.
- [Statements and parameters](/guides/statements/) Work that runs next to the data.
- [Manifests](/guides/manifests/) A context as a small JSON document.
- [Context reference](/reference/context/) Every method and option, in both languages.
:::
