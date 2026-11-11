# Backends: local and Archil

Everything the framework does compiles down to a small set of operations: object reads and writes, `exec` with a mount map, parallel `grep`, checkpoints and branches. Two backends provide them. Code written against one runs on the other unchanged.

## Contents

- [Which one a context gets](#which-one-a-context-gets)
- [The local backend](#the-local-backend)
- [The Archil backend](#the-archil-backend)
- [SQL on Archil: DuckDB on a disk](#sql-on-archil-duckdb-on-a-disk)
- [What Archil's exec image has](#what-archils-exec-image-has)
- [Versions rest on a clock](#versions-rest-on-a-clock)
- [Known limits](#known-limits)
- [Running the SDK's examples](#running-the-sdks-examples)

## Which one a context gets

1. The `backend` argument, when there is one.
2. Otherwise Archil, when `ARCHIL_API_KEY` is set and `ARCHIL_BACKEND` is not `local`.
3. Otherwise the local backend, rooted at `ARCHIL_LOCAL_ROOT`, or `.archil-local` in the current directory.

```python
import tempfile

local = archil.LocalBackend(tempfile.mkdtemp())                  # a root of its own: nothing shared, nothing left behind
scratch = archil.context({"notes": archil.disk("my-notes", "owned", create=True)}, backend=local)
print(scratch.describe().splitlines()[0])                        # context "context" on local
```

```ts
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const local = new archil.LocalBackend({ root: mkdtempSync(join(tmpdir(), "seaway-")) });
const scratch = await archil.context({ notes: archil.disk("my-notes", "owned", { create: true }) }, { backend: local });
console.log(scratch.describe().split("\n")[0]);
```

```py
live = archil.ArchilBackend()                       # ARCHIL_API_KEY and ARCHIL_REGION from the environment
live = archil.ArchilBackend(api_key="…", region="aws-us-west-2")
ctx = archil.context({"logs": archil.disk("app-logs", "append")}, backend=live)
```

| Variable | Effect |
|---|---|
| `ARCHIL_API_KEY`, `ARCHIL_REGION` | with a key set, a context opened without a backend uses Archil |
| `ARCHIL_BACKEND=local` | use the local backend even though a key is set |
| `ARCHIL_LOCAL_ROOT` | where the local backend keeps its disks; `.archil-local` when unset |
| `ARCHIL_LOCAL_ISOLATION` | `namespace` or `symlink`, to force how the local backend mounts |

**A script that passes no backend acts wherever the environment points it.** With `ARCHIL_API_KEY` exported in a shell, that is the live account: real disks, billed calls, and checkpoints and branches that cannot be deleted. When trying something out, pass a `LocalBackend` or set `ARCHIL_BACKEND=local`.

## The local backend

Disks are directories and exec is local bash. It needs no account, and exists so that an app can be developed and tested anywhere and then pointed at Archil.

- **Layout.** A disk named `my-notes` is `<root>/disks/my-notes/`. Seeding a disk for a test is writing files there. Both SDKs use the same layout and the same file versions, so both can work on one root.
- **A call** gets a fresh working directory with the mounted disks beneath it, at the same relative paths an Archil call sees. Nothing but the disks survives it. There is no stdin. Output is cut and commands time out exactly as on Archil.
- **Isolation.** Where unprivileged user namespaces are available (most Linux hosts), each call runs in its own mount namespace with the disks bind-mounted: a read-only mount really is read-only, and a call with an egress policy gets no network at all. Elsewhere, macOS included, mounts are symlinks:
  - a write to a read-only mount is *detected* after the command, which then reports exit 30;
  - an egress policy is not enforced, and the network stays open;
  - `find` and `du` do not cross a symlink by default: use `find -L`, or start from a path inside the mount.
- **Checkpoints and branches** are full copies of the directory. On Archil they are copy-on-write and take milliseconds at any size.
- **Search** uses `rg` when it is installed and the SDK's own implementation when it is not. The two give the same answers.
- **SQL** runs the `duckdb` on the PATH. `jq`, `sqlite3` and anything else a statement names are the ones on this machine, and their versions may differ from Archil's.
- **Prices** are still worked out. A plan on the local backend shows what the same plan would cost on Archil.
- A statement on the local backend runs with your own permissions. The mount map says what it is given, but with symlink mounts nothing stops a command from reaching outside it.

## The Archil backend

It sends the same plans to Archil through the official SDK: `pip install archil` for Python, `npm install disk` for TypeScript. Each is needed only when this backend is used.

| In the framework | On Archil |
|---|---|
| a task of a plan | one `exec` call, with a mount per disk |
| `grep` | the disk's native parallel grep |
| `read`, `write`, `rm` | object get, put and delete through the S3-compatible API |
| `append` | the server-side append, at most 1 MiB, never retried |
| `ls`, and every listing behind a plan, a view or a feed | object listings: metadata only |
| a branch | the disk's `create_branch` from a checkpoint |
| a checkpoint | `archil checkpoints create`, run inside an exec |

Things to know when code that worked locally goes live:

- **Disks.** `archil.disk("name")` finds a disk by name in the region, or takes a `dsk-` id. `create=True` creates one that does not exist.
- **Every statement is a billed call,** and so is each checkpoint, which is how a turn, a fork and a lock begin. See [plans-and-prices.md](plans-and-prices.md).
- **Commands have the whole internet** unless the context or the statement has an egress policy. Archil takes a policy on the Developer plan and above.
- **`owned` means a checkout.** A statement that writes an `owned` mount takes a checkout of the mount root and waits up to five seconds for it. If it cannot, the result is exit 30. While it holds the checkout, a direct `write`, `append` or `rm` on that disk raises `Busy`.
- **`shared` is last-write-wins.** Nothing queues. Keep writers to their own paths, or use a turn.
- **Reads leave Archil.** `ctx.read` from outside Archil is egress, and the ledger counts it. A statement's output is the only part of its work that crosses the network, which is why a large result belongs in a file (`into()`). A caller that itself runs inside Archil can say so: `ArchilBackend(inside_archil=True)`.
- **Failures that are not the command's own** come back as results, as they do locally: a mount that cannot be made is exit 1, a checkout not taken in time is exit 30, and a command that ran past five minutes is exit 124.
- **`write(..., if_absent=True)`** is a check followed by a write on Archil, not one atomic step.
- **In Python, an `owned` mount cannot be written from a custom image** (`sized(image=...)`). The Python client cannot ask for a checkout on the mount, so the command takes it with the `archil` CLI, and only Archil's own exec image has that. Use `shared`, or the TypeScript SDK, whose client can.

## SQL on Archil: DuckDB on a disk

`ctx.sql` needs DuckDB, and Archil's exec image does not have it. Put the CLI on a disk once and tell the context where it is.

```py
ctx = archil.context(
    {"logs": archil.disk("app-logs", "append"), "obs": archil.disk("obs-agent", "owned")},
    tools={"duckdb": "obs/bin/duckdb"},
)
if not ctx.exists("obs/bin/duckdb"):
    archil.duckdb(ctx, "obs/bin").run(check=True)     # one call; the binary stays on the disk
```

```typescript
const ctx = await archil.context(
  { logs: archil.disk("app-logs", "append"), obs: archil.disk("obs-agent", "owned") },
  { tools: { duckdb: "obs/bin/duckdb" } },
);
if (!(await ctx.exists("obs/bin/duckdb"))) {
  await archil.duckdb(ctx, "obs/bin").run({ check: true });
}
```

A `sql` plan that declares its paths then also mounts the tool's directory, read-only. One that writes to the tool's own disk with `into()` has that whole disk read-write, as any written disk is, and one that declares nothing has the whole context. The install downloads DuckDB's release archive and checks it against a pinned SHA-256 before it unpacks anything; see [recipes.md](recipes.md#recipes-that-are-statements-git-and-duckdb). To write one script for both backends, set `tools` only when the backend is Archil: locally the `duckdb` on the PATH is used.

## What Archil's exec image has

Seen by running commands on a live account on 10 November 2026. Archil's own documentation is the authority on what the image holds, and it can change:

- `bash`, `jq`, `git`, `curl`, `rg`, `sqlite3`, `python3` and Node are there. DuckDB is not.
- The `archil` CLI is there, which is how checkpoints and Python's checkouts are taken.
- A command runs under `/bin/sh`, which is dash. seaway hands every statement to bash, so `set -o pipefail`, `[[ ]]` and process substitution work. An image without bash runs the statement with its own `sh`.
- `sqlite3` is 3.37.2, from 2022: it has `json_extract` and not `->>`, and no `percentile`. The Node in the same image carries a current SQLite as `node:sqlite`.
- Disks are mounted under `/mnt/archil`, and that is where a command starts. Write paths as the context has them.

## Versions rest on a clock

A file's **version** is what views, feeds and turns compare to tell whether it changed.

- On the local backend it is the modification time in nanoseconds and the size: every write changes it.
- On Archil it is the ETag and the modification time in whole seconds. An ETag alone is not enough there, because a file rewritten in place through a mount keeps the ETag it was created with.

So on Archil, a file rewritten in place, at the same size, twice within one second looks unchanged. The SDKs close that gap by not trusting a version that is under about a second and a half old:

- a **view** built from such a file records a provisional fingerprint, and builds once more on its next refresh;
- a **feed** remembers such a file provisionally, and hands it over again on the next poll;
- a **turn** that begins that soon after a write waits out the difference before it takes its snapshot.

This rests on the caller's clock being within half a second of Archil's.

## Known limits

- A commit is not atomic across files, and on Archil there is a window between checking for conflicts and copying.
- Every turn and fork leaves a checkpoint and a branch behind on each disk it could write. A lock leaves a checkpoint on every mount that was not already frozen, read-only ones included, and opening a `frozen` mount makes a branch at its checkpoint the first time. Archil cannot delete either except by deleting the disk.
- A statement that writes gets its whole disk mounted in the disk's mode, not just the directory it writes. Only reads are narrowed to a directory.
- Narrowing is enforced by the mount map inside a call. For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk.
- A view's definition is not stored on the disk, only its output and a fingerprint.
- Prices are estimates from listings and public rates, not invoices. Estimates for `grep` ignore `globs`, so they run high.
- An egress policy is enforced by Archil. The local backend can only cut the network entirely, and only in a namespace.
- A feed is a poll. A view's freshness check and a feed's poll list the whole path each time.
- There are no services or sandboxes, no server-side planner, no caching by plan hash, no inferred reducers and no command-line tool.

## Running the SDK's examples

In a seaway checkout, each example runs on the local backend with no account, and on Archil with `--archil`:

```bash
cd python && pip install -e '.[dev]'            # Python 3.10+; the dev extra brings pytest, archil and the duckdb CLI
python examples/quickstart.py
python examples/datadog_afternoon.py --archil --cleanup
```

```bash
cd typescript && npm install                    # Node 22.19+, which runs .ts directly; there is no build step
node examples/quickstart.ts
node examples/datadog-afternoon.ts --archil --cleanup
```

With `--archil`, every disk an example names gets a prefix that is new for the run (`px-` and six hex characters), so an example never opens a disk that is already in the account. It prints the disks it created. `--cleanup` deletes them when it ends, and with them the branches and checkpoints the run left. A run costs a fraction of a cent. The same pattern suits your own tests against Archil: a fresh prefix per run, and delete the disks afterwards.
