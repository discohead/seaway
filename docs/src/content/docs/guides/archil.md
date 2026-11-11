---
title: Run on Archil
description: "Code written against the local backend runs on Archil unchanged. This is what changes around it: billed calls, checkouts, DuckDB on a disk, an open network, and branches that stay."
---

The same code runs on both backends. What changes is everything around it: calls are billed, an `owned` mount takes a real checkout, the network is open unless you close it, and a checkpoint is permanent. Read this once before the first live run.

## Before the first run

1. **Install the official client.** `pip install archil` for Python, `npm install disk` for TypeScript. Each is needed only when the Archil backend is used.
2. **Set `ARCHIL_API_KEY` and `ARCHIL_REGION`.**
3. **Decide where the backend comes from.** With the key set, a context opened without a `backend` uses Archil. To keep that deliberate, pass the backend yourself and make live runs opt in. See [pass a backend](/guides/backends/#pass-a-backend).
4. **Check with a plan.** `explain()` costs a listing and runs nothing. Read `scope` and `price` before the first `run()`.

```py
import seaway as archil

live = archil.ArchilBackend()  # the key and the region, from the environment
ctx = archil.context(
    {
        "logs": archil.disk("app-logs", "append"),
        "obs": archil.disk("obs-agent", "owned", create=True),
    },
    backend=live,
    egress="deny",
)
print(ctx.describe())
```

```typescript
import * as archil from "seaway";

// the key and the region, from the environment
const live = new archil.ArchilBackend();
const ctx = await archil.context(
  {
    logs: archil.disk("app-logs", "append"),
    obs: archil.disk("obs-agent", "owned", { create: true }),
  },
  { backend: live, egress: "deny" },
);
console.log(ctx.describe());
```

`archil.disk("name")` finds a disk by name in the region, or takes a `dsk-` id. `create=True` creates one that does not exist.

## What each thing becomes

| In the framework | On Archil |
|---|---|
| a task of a plan | one `exec` call, with a mount per disk |
| `grep` | the disk's native parallel grep |
| `read`, `write`, `rm` | object get, put and delete through the S3-compatible API |
| `append` | the server-side append, at most 1 MiB, never retried |
| `ls`, and every listing behind a plan, a view or a feed | object listings: metadata only |
| a branch | the disk's `create_branch` from a checkpoint |
| a checkpoint | `archil checkpoints create`, run inside an exec |

## What changes

### Every statement is a billed call

So is each checkpoint, which is how a turn, a fork and a lock begin. [Prices and budgets](/guides/prices/) has the rates. Give a context a budget when something else is issuing the statements: `ctx.with_budget(max_usd=0.05)`.

### SQL needs DuckDB on a disk

`ctx.sql` needs DuckDB, and Archil's exec image does not have it. Put the command-line tool on a disk once, and tell the context where it is.

```py
ctx = archil.context(
    {
        "logs": archil.disk("app-logs", "append"),
        "obs": archil.disk("obs-agent", "owned"),
    },
    tools={"duckdb": "obs/bin/duckdb"},
)
if not ctx.exists("obs/bin/duckdb"):
    # one call; the binary stays on the disk
    archil.duckdb(ctx, "obs/bin").run(check=True)
```

```typescript
const ctx = await archil.context(
  { logs: archil.disk("app-logs", "append"), obs: archil.disk("obs-agent", "owned") },
  { tools: { duckdb: "obs/bin/duckdb" } },
);
if (!(await ctx.exists("obs/bin/duckdb"))) {
  // one call; the binary stays on the disk
  await archil.duckdb(ctx, "obs/bin").run({ check: true });
}
```

- The install downloads DuckDB's release archive and checks it against a pinned SHA-256 before it unpacks anything. See [recipes that are statements](/guides/recipes/#recipes-that-are-statements).
- A `sql` plan that declares its paths then also mounts the tool's directory, read-only.
- To write one script for both backends, set `tools` only when the backend is Archil. Locally the `duckdb` on the PATH is used.

### Commands have the whole internet

A mount map limits what a command can read, not where it can send it. Unless the context or the statement has an [egress policy](/guides/narrowing/#the-network), a command can reach anything. Archil takes a policy on the Developer plan and above.

### owned means a checkout

A statement that writes an `owned` mount takes a checkout of the mount root and waits up to five seconds for it.

- If it cannot get it, the result is **exit 30**. Run the statement again.
- While it holds the checkout, a direct `write`, `append` or `rm` on that disk raises **`Busy`**. Retry when the statement has finished.

`shared` is last-write-wins. Nothing queues. Keep writers to their own paths, or use a [turn](/guides/turns/).

### Reads leave Archil

`ctx.read` from outside Archil is egress, and the ledger counts it. A statement's output is the only part of its work that crosses the network, which is why a large result belongs in a file: use [`into()`](/guides/results/#keep-large-output-on-the-disk).

A caller that itself runs inside Archil can say so, and reads are then not counted as egress: `ArchilBackend(inside_archil=True)`.

### Failures that are not the command's own

They come back as results, as they do locally:

| Exit | Meaning |
|---|---|
| 1 | a mount could not be made, usually a subdirectory that does not exist |
| 30 | a checkout was not granted in time |
| 124 | the command ran past five minutes |

### Smaller differences

- **`write(..., if_absent=True)`** is a check followed by a write on Archil, not one atomic step.
- **In Python, an `owned` mount cannot be written from a custom image** (`sized(image=...)`). The Python client cannot ask for a checkout on the mount, so the command takes it with the `archil` CLI, and only Archil's own exec image has that. Use `shared`, or the TypeScript SDK, whose client can.
- **A file's version carries a time in whole seconds.** Views, feeds and turns allow for that. See [Versions and clocks](/architecture/versions/).

## What the exec image has

Seen by running commands on a live account on 10 November 2026. Archil's own documentation is the authority, and the image can change.

- `bash`, `jq`, `git`, `curl`, `rg`, `sqlite3`, `python3` and Node are there. **DuckDB is not.**
- The `archil` CLI is there, which is how checkpoints and Python's checkouts are taken.
- A command runs under `/bin/sh`, which is dash. seaway hands every statement to bash, so `set -o pipefail`, `[[ ]]` and process substitution work.
- `sqlite3` is 3.37.2, from 2022: it has `json_extract` and not `->>`, and no `percentile`. See [State in SQLite](/guides/sqlite/).
- Disks are mounted under `/mnt/archil`, and that is where a command starts. Write paths as the context has them.

## What a run leaves behind

Archil cannot delete a branch or a checkpoint except by deleting the disk.

| This | Leaves |
|---|---|
| a turn | a checkpoint and a branch on each disk it could write |
| a fork | a checkpoint and a branch on each `owned` and `shared` disk |
| a lock | a checkpoint on every mount that was not already frozen, read-only ones included |
| opening a `frozen` mount | a branch at its checkpoint, the first time |

Turns are cheap to take and they stay. Do not fork in a tight loop.

## Test against Archil

Give every run a prefix that is new, so a test never opens a disk that is already in the account, and delete the disks afterwards. The repository's examples do this with `--archil` and `--cleanup`:

```bash
python python/examples/datadog_afternoon.py --archil --cleanup
node typescript/examples/datadog-afternoon.ts --archil --cleanup
```

Deleting a disk also removes the branches and checkpoints a run left on it. The official client is at `backend.client` (Python) or `await backend.client()` (TypeScript), for what seaway does not wrap, such as deleting a disk.

## When it worked locally and fails on Archil

The usual causes:

- `duckdb` is not in the exec image. Put it on a disk and name it in `tools`.
- The image's `sqlite3` is older than yours.
- A path was written as `/mnt/archil/...` or as a local absolute path. Write paths as the context has them.
- The network is denied by an egress policy.
- The disk names differ.
- A tool your command calls is on your machine and not in the image.

## Next

:::cards
- [Status and known limits](/architecture/status/) What was found on a live account, and what is not built.
- [Errors and exit codes](/guides/errors/) `Busy`, exit 30, and the rest.
- [What it asks of the platform](/architecture/platform/) What the SDK works around today.
:::
