---
title: Local and Archil backends
description: Two backends provide the same small set of operations, and code written against one runs on the other unchanged. How a context chooses one, and what the local backend does and does not enforce.
sidebar:
  label: Local and Archil
---

Everything the framework does compiles down to a small set of operations: object reads and writes, `exec` with a mount map, parallel `grep`, checkpoints and branches. Two backends provide them.

| | Local backend | Archil |
|---|---|---|
| A disk is | a directory under the root | a disk in the account, by name or `dsk-` id |
| A statement is | bash on this machine, in a fresh directory with the mounts beneath it | bash in a fresh VM with the disks at `/mnt/archil` |
| `ctx.sql` runs | the `duckdb` on the PATH | a DuckDB binary on a disk |
| Read-only and egress | enforced in a mount namespace on Linux; reported after the fact, and the network left open, with symlinks | enforced |
| Checkpoints and branches | full copies | copy-on-write, and permanent until the disk is deleted |
| Costs | nothing. Prices shown are what Archil would charge | per call, per active byte, per byte of egress |

## Which one a context gets

1. The `backend` argument, when there is one.
2. Otherwise Archil, when `ARCHIL_API_KEY` is set and `ARCHIL_BACKEND` is not `local`.
3. Otherwise the local backend, rooted at `ARCHIL_LOCAL_ROOT`, or `.archil-local` in the current directory.

| Variable | Effect |
|---|---|
| `ARCHIL_API_KEY`, `ARCHIL_REGION` | with a key set, a context opened without a backend uses Archil |
| `ARCHIL_BACKEND=local` | use the local backend even though a key is set |
| `ARCHIL_LOCAL_ROOT` | where the local backend keeps its disks. `.archil-local` when unset |
| `ARCHIL_LOCAL_ISOLATION` | `namespace` or `symlink`, to force how the local backend mounts |

:::danger[A script that passes no backend acts wherever the environment points it]
With `ARCHIL_API_KEY` exported in a shell, that is the live account: real disks, billed calls, and checkpoints and branches that cannot be deleted. When trying something out, pass a `LocalBackend` or set `ARCHIL_BACKEND=local`.
:::

## Pass a backend

```python
import tempfile

import seaway as archil

# a root of its own: nothing shared, nothing left behind
local = archil.LocalBackend(tempfile.mkdtemp())
scratch = archil.context(
    {"notes": archil.disk("my-notes", "owned", create=True)},
    backend=local,
)

print(scratch.describe().splitlines()[0])
print(local.name, sorted(local.capabilities))
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

// a root of its own
const local = new archil.LocalBackend({ root: mkdtempSync(join(tmpdir(), "seaway-")) });
const scratch = await archil.context(
  { notes: archil.disk("my-notes", "owned", { create: true }) },
  { backend: local },
);

console.log(scratch.describe().split("\n")[0]);
console.log(local.name, [...local.capabilities].sort());
```

```text output
context "context" on local
local ['branch', 'checkpoint', 'grep', 'share']
```

For Archil, name the backend and it reads the key and the region from the environment:

```py
# ARCHIL_API_KEY and ARCHIL_REGION from the environment
live = archil.ArchilBackend()
# or given
live = archil.ArchilBackend(api_key="…", region="aws-us-west-2")
ctx = archil.context({"logs": archil.disk("app-logs", "append")}, backend=live)
```

```typescript
// ARCHIL_API_KEY and ARCHIL_REGION from the environment
const live = new archil.ArchilBackend();
const ctx = await archil.context(
  { logs: archil.disk("app-logs", "append") },
  { backend: live },
);
```

A good habit for a program is the one the [project template](/agents/claude-code/#commands-you-call) uses: local unless asked otherwise, so that an exported key alone does not send it to an account.

```python
import sys

import seaway as archil

def backend():
    """Local unless asked otherwise."""
    if "--archil" in sys.argv:
        return archil.ArchilBackend()
    return archil.LocalBackend(".archil-local")

print(backend().name)
```

```ts
import * as archil from "seaway";

/** Local unless asked otherwise. */
function backend(): archil.Backend {
  if (process.argv.includes("--archil")) return new archil.ArchilBackend();
  return new archil.LocalBackend({ root: ".archil-local" });
}

console.log(backend().name);
```

```text output
local
```

## The local backend

Disks are directories and exec is local bash. It needs no account, and exists so that an app can be developed and tested anywhere and then pointed at Archil.

- **Layout.** A disk named `my-notes` is `<root>/disks/my-notes/`. Seeding a disk for a test is writing files there. Both SDKs use the same layout and the same file versions, so both can work on one root.
- **A call** gets a fresh working directory with the mounted disks beneath it, at the same relative paths an Archil call sees. Nothing but the disks survives it. There is no stdin. Output is cut and commands time out exactly as on Archil.
- **Checkpoints and branches** are full copies of the directory. On Archil they are copy-on-write and take milliseconds at any size.
- **Search** uses `rg` when it is installed and the SDK's own implementation when it is not. The two give the same answers for a pattern both accept, so keep to ripgrep's syntax: no look-around, no back-references.
- **SQL** runs the `duckdb` on the PATH. `jq`, `sqlite3` and anything else a statement names are the ones on this machine, and their versions may differ from Archil's.
- **Prices** are still worked out. A plan on the local backend shows what the same plan would cost on Archil.

### What it enforces

Where unprivileged user namespaces are available, which is most Linux hosts, each call runs in its own mount namespace with the disks bind-mounted. A read-only mount really is read-only, and a call with an egress policy gets no network at all.

Elsewhere, macOS included, mounts are symlinks:

- a write to a read-only mount is *detected* after the command, which then reports exit 30;
- an egress policy is not enforced, and the network stays open;
- `find` and `du` do not cross a symlink by default: use `find -L`, or start from a path inside the mount.

A statement on the local backend runs with your own permissions. The mount map says what it is given, but with symlink mounts nothing stops a command from reaching outside it. Do not run a model's commands on the local backend of a machine you care about, unless that is in a container.

[`seaway-doctor`](/agents/lint/#seaway-doctor) says which of the two this machine gets.

## Seed a disk for a test

```python
import os
import tempfile

import seaway as archil

root = tempfile.mkdtemp()
os.makedirs(f"{root}/disks/handbook/security")
with open(f"{root}/disks/handbook/security/keys.md", "w") as f:
    f.write("# Keys\nRotate API keys every 90 days.\n")

local = archil.LocalBackend(root)
ctx = archil.context({"docs": "handbook"}, backend=local)
ctx.sh("wc -l {f}", f=ctx.path("docs/security/keys.md")).run(check=True)

print(ctx.read_text("docs/security/keys.md").splitlines()[1])
print(len(local.exec_log))  # every exec the backend ran: handy in a test
```

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const root = mkdtempSync(join(tmpdir(), "seaway-"));
mkdirSync(join(root, "disks/handbook/security"), { recursive: true });
writeFileSync(
  join(root, "disks/handbook/security/keys.md"),
  "# Keys\nRotate API keys every 90 days.\n",
);

const local = new archil.LocalBackend({ root });
const ctx = await archil.context({ docs: "handbook" }, { backend: local });
await ctx.sh`wc -l ${ctx.path("docs/security/keys.md")}`.run({ check: true });

console.log((await ctx.readText("docs/security/keys.md")).split("\n")[1]);
console.log(local.execLog.length);  // every exec the backend ran: handy in a test
```

```text output
Rotate API keys every 90 days.
1
```

A test should give each case a root of its own, pass the backend explicitly, and never depend on the clock or on the order of a directory listing.

## A backend of your own

A backend provides `resolve_disk`, `exec`, `grep`, the object verbs (`get`, `put`, `append`, `delete`, `list`, `head`), and optionally `share`, `checkpoint` and `branch`. A turn needs `"checkpoint"` and `"branch"` in its `capabilities`, and raises `NotSupported` without them. A fork and a lock call `checkpoint` and `branch` directly. [Backends reference](/reference/backends/) has the whole interface.

## Next

:::cards
- [Run on Archil](/guides/archil/) What changes when the same code goes live.
- [Versions and clocks](/architecture/versions/) How each backend tells that a file changed.
- [Backends reference](/reference/backends/) Options, limits and the backend interface.
:::
