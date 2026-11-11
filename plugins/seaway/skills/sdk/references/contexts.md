# Contexts

A context composes disks into one tree. Each mount names a disk and a mode. A context is a plain value: every method that changes one returns a new context and leaves the original alone.

## Contents

- [Composing one](#composing-one)
- [Modes](#modes)
- [Less than you have: narrow](#less-than-you-have-narrow)
- [The network: egress](#the-network-egress)
- [Spend: budgets and the ledger](#spend-budgets-and-the-ledger)
- [Manifests](#manifests)
- [Time: checkpoint, lock, fork](#time-checkpoint-lock-fork)
- [The journal](#the-journal)

## Composing one

```python
ctx = archil.context(
    {
        "docs": archil.disk("handbook", description="company policies, one file each"),
        "logs": archil.disk("app-logs", "append"),
        "memory": archil.disk("agent-memory", "owned", create=True),
        "team": archil.disk("team-notes", "shared", subdirectory="eng"),
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
    docs: archil.disk("handbook", "read", { description: "company policies, one file each" }),
    logs: archil.disk("app-logs", "append"),
    memory: archil.disk("agent-memory", "owned", { create: true }),
    team: archil.disk("team-notes", "shared", { subdirectory: "eng" }),
  },
  { backend, name: "agent-7", journal: "memory/journal" },
);
console.log(ctx.describe());
```

```text
context "agent-7" on local
  docs/    read    handbook  company policies, one file each
  logs/    append  app-logs
  memory/  owned   agent-memory
  team/    shared  team-notes
Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to the data and bill per call (≈ $0.00005). explain() prices a statement first.
```

`archil.disk(ref, mode, ...)` describes a disk and contacts nothing. `ref` is a disk's name, or on Archil its `dsk-` id. A bare string in the mount map is a `read` mount of the disk with that name.

| Option | Meaning |
|---|---|
| `mode` | `read` (the default), `frozen`, `owned`, `shared` or `append` |
| `at` | the checkpoint a `frozen` mount is pinned to; required for `frozen` |
| `subdirectory` | mount this directory of the disk as the mount's root |
| `create` | create the disk if no disk has that name; without it an unknown name is `unknown_disk` |
| `description` | a note for whoever reads `describe()` or the manifest |

`archil.context(mounts, ...)` resolves each disk, which is why it is `async` in TypeScript.

| Option | Meaning |
|---|---|
| `backend` | where it runs. Left out: Archil when `ARCHIL_API_KEY` is set, else local. See [backends.md](backends.md) |
| `name` | the context's name; `"context"` when left out |
| `journal` | a path in the context where every statement is recorded |
| `tools` | where a tool lives when it is not on the VM's PATH: `{"duckdb": "memory/bin/duckdb"}` |
| `egress` | what commands may reach on the network: `"deny"`, `"allow"`, or a list of hosts |
| `budget` | a ceiling for everything the context runs: `archil.Budget(max_usd=0.05)`; in TypeScript `{ maxUsd: 0.05 }` |
| `prices` | a `PriceSheet` of your own, to override the public rates |

A mount name is one path segment. `.px` is not allowed: it is where the framework keeps its own files on a disk.

## Modes

The mode is the mutation strategy for that part of the tree. Each compiles to something Archil already does.

| Mode | Meaning | On Archil | `write`, `rm` | `append`, `log().append` |
|---|---|---|---|---|
| `read` | live data, read-only | mounted `readOnly` | refused | refused |
| `frozen` | read-only, and pinned to a checkpoint so every run sees the same bytes | a branch of the checkpoint named `at`, mounted `readOnly` | refused | refused |
| `owned` | this context is the only writer | a mount that takes a checkout of the mount root, waiting up to five seconds for it | yes | yes |
| `shared` | many writers | a `conditional` mount: no checkout, the last write to reach the disk wins | yes | yes |
| `append` | records are only ever added | appends go through the server-side append; commands see the data read-only | refused | yes |

Choosing:

- One agent's memory, a view's output, a cursor, a SQLite file: `owned`. Writes run at local-disk speed, and a second writer waits its turn and is then refused with exit 30.
- Notes several agents write: `shared`, and give each writer its own paths. Nothing stops two writers overwriting each other except a turn.
- Logs, audit trails, journals: `append`. Nothing can rewrite them, and many writers can append at once when each has its own file.
- Skills, prompts, reference data for an eval: `frozen` at a named checkpoint.
- Anything this context should not change: `read`.

`shared` is Archil's *conditional* mode. It is not `archil mount --shared`, which is the mode an exec mount is in by default and which needs a checkout before most writes.

A refused write is a `ValidationError` with code `read_only`, raised before anything is sent, and it says what to do:

```python
try:
    ctx.write("logs/2026-11-09/note.txt", "x")
except archil.ValidationError as e:
    print(e.code, "|", e.suggestion)    # read_only | use append() or log() for an append-only mount
```

On Archil, while a statement holds an `owned` disk's checkout, a direct `write`, `append` or `rm` on that disk raises `Busy`. Retry when the statement has finished.

## Less than you have: narrow

`narrow` returns a context that reaches only the given sub-trees, under the same path names. It can only take access away.

```python
helper = ctx.narrow("docs/security", "memory/notes", read_only=True)
print(helper.describe())
print(helper.sh("find -L . -type f").run().text)     # only what is under those two directories
```

```ts
const helper = ctx.narrow(["docs/security", "memory/notes"], { readOnly: true });
console.log(helper.describe());
console.log((await helper.sh`find -L . -type f`).text);
```

- Mounts that no path names are dropped. With several paths on one mount, the mount is narrowed to the deepest directory that contains them all.
- `read_only=True` forces every remaining mount read-only, and its mode then reads as `read` (a `frozen` mount stays `frozen`). With no paths, `ctx.narrow(read_only=True)` keeps every mount and only does that.
- A path outside the narrowed tree is a `ValidationError`: `out_of_scope` on a mount that was kept, `unknown_mount` on one that was dropped.
- A narrowed context keeps the `journal` setting and writes its own lines, through itself. If the narrowing dropped the journal's directory, or is read-only, nothing it runs is journalled: see [the journal](#the-journal).
- Inside a call the boundary is the mount map: a disk that is not in it does not exist in the VM, and a narrowed mount is a subdirectory mount. For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk. So the holder of the context is trusted and the commands it runs are not.

Use it before handing a context to a sub-agent, a model's tools, or any call that should see less than you do.

## The network: egress

A mount map limits what a command can read. It does not limit where the command can send it. On Archil a command has the whole internet unless it is given a policy.

```python
offline = ctx.with_egress("deny")                     # nothing leaves, for everything this context runs
pypi = ctx.with_egress(["pypi.org", "files.pythonhosted.org"])
one = ctx.sh("curl -fsS https://example.com").egress(["example.com"])   # for a single statement
print(offline.describe().splitlines()[-1])            # Commands run with egress denied.
```

```ts
const offline = ctx.withEgress("deny");
const pypi = ctx.withEgress(["pypi.org", "files.pythonhosted.org"]);
const one = ctx.sh`curl -fsS https://example.com`.egress(["example.com"]);
console.log(offline.describe().split("\n").at(-1));
```

- `"deny"`: nothing leaves. A list of hosts: only those. `"allow"`: open, which is Archil's default.
- A statement's own `.egress(...)` overrides its context's policy for that call.
- The statements in a `batch` run in one VM and so share one policy: set it on the batch or on the context.
- The policy is written to the manifest and shown in the `route` line of every plan that runs a command. A `grep` runs no command of yours and carries no policy.
- Archil enforces it, and takes a policy on the Developer plan and above. The local backend can only cut the network entirely, and only where it runs calls in a namespace (Linux). With symlink mounts (macOS) the network stays open.

Hand a model the tools of `ctx.with_egress("deny")` unless its commands need the network.

## Spend: budgets and the ledger

Every plan carries a price, so a ceiling can be checked before anything runs.

```python
capped = ctx.with_budget(max_usd=0.01, max_calls=50)
try:
    capped.sh("ls").within(max_usd=0.00001).run()     # one statement can carry a tighter one
except archil.BudgetExceeded as e:
    print(e)                                          # budget_exceeded: plan exceeds budget: $0.00005 > $0.00001 — …
print(ctx.spend)                                      # what this context has sent so far
```

```ts
const capped = ctx.withBudget({ maxUsd: 0.01, maxCalls: 50 });
try {
  await capped.sh`ls`.within({ maxUsd: 0.00001 }).run();
} catch (e) {
  if (!(e instanceof archil.BudgetExceeded)) throw e;
  console.log(String(e));
}
console.log(String(ctx.spend));
```

- A budget has three limits, each optional: `max_usd`, `max_calls` (counted in call units) and `max_bytes_touched`.
- `with_budget` counts what is spent from the moment it is set, so a helper handed a budgeted context is not charged for what its parent already did. `with_budget(None)` removes the ceiling.
- The check is the plan's estimate plus what has been spent under the budget. Over the ceiling, `run()` raises `BudgetExceeded` and nothing is sent.
- `ctx.spend` is the ledger. Contexts derived from one another share it. It counts every call, checkpoints and commits included, and counts a file's bytes once for as long as the session keeps them active. See [plans-and-prices.md](plans-and-prices.md).

## Manifests

A manifest is the context as a small JSON document: the disks, the modes, and what was narrowed.

```python
import json, os, tempfile

manifest = ctx.with_egress("deny").manifest()
path = os.path.join(tempfile.mkdtemp(), "agent.json")
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)

again = archil.from_manifest(path, backend=backend)   # a dict, a JSON string or a path to a file
print(again.describe())
```

```ts
const manifest = ctx.withEgress("deny").manifest();
const again = await archil.fromManifest(manifest, { backend });   // an object, a JSON string or a path to a file
console.log(JSON.stringify(manifest, null, 2));
```

```json
{
  "archilContext": 0,
  "name": "agent-7",
  "mounts": {
    "docs": { "disk": "handbook", "mode": "read", "description": "company policies, one file each" },
    "logs": { "disk": "app-logs", "mode": "append" },
    "memory": { "disk": "agent-memory", "mode": "owned" },
    "team": { "disk": "team-notes", "mode": "shared", "subdirectory": "eng" }
  },
  "journal": "memory/journal",
  "egress": "deny"
}
```

A mount can also carry `at` (the checkpoint, for `frozen`), `allow` (the sub-tree it was narrowed to) and `readOnly`. The top level can carry `tools`, and `egress` as `"deny"` or a list of hosts. A manifest does not carry `create`, a budget, a price sheet or a backend: those belong to whoever opens it.

## Time: checkpoint, lock, fork

```python
ctx.checkpoint("release-2026-11-10")                  # every writable or appendable mount, under one name

lock = ctx.lock("eval-2026-11-10")                    # a manifest with every mount frozen at that point
replay = archil.from_manifest(lock, backend=backend)  # reads the same bytes every time

attempts = [ctx.fork(f"attempt-{i}") for i in range(3)]   # private branches of the writable disks
for i, attempt in enumerate(attempts):
    attempt.write("memory/plan.md", f"plan {i}\n")
print(ctx.exists("memory/plan.md"))                   # False: the main line saw none of it
```

```ts
await ctx.checkpoint("release-2026-11-10");

const lock = await ctx.lock("eval-2026-11-10");
const replay = await archil.fromManifest(lock, { backend });

const attempt = await ctx.fork("attempt-0");
await attempt.write("memory/plan.md", "plan 0\n");
console.log(await ctx.exists("memory/plan.md"));      // false
```

- `checkpoint(name)` checkpoints each `owned`, `shared` and `append` mount and returns the checkpoint by mount name.
- `lock(name)` checkpoints every mount that is not already `frozen` and returns a manifest in which all of them are, with `"locked": name`. Opening it gives the input to an eval, a replay or a reproducible build. A mount that was already frozen keeps the pin it had.
- `fork(name)` checkpoints each `owned` and `shared` mount and gives the new context a branch of it. Mounts in the other modes are the same disks as before, so a fork still appends to the real log. Use one fork per attempt when several agents try the same task.
- To pin one mount, name the checkpoint: `archil.disk("org-skills", "frozen", at="2026-11-01")`.

What these cost and leave behind on Archil:

- A checkpoint is taken by an exec, so each one is a billed call and about a fifth of a second.
- A checkpoint name has to be new on its disk, and made of letters, digits, `-` and `_`. A fork, a lock or a turn whose name was used before on that disk is refused.
- Archil cannot delete a branch or a checkpoint except by deleting the disk. Every fork and every turn leaves one of each on each disk it could write.
- On the local backend a checkpoint and a branch are each a full copy of the directory.

## The journal

With `journal=` set, every statement the context runs is recorded at that path as a log partitioned by day, one file per session. Commits, rollbacks and syncs are recorded as well.

A context made from it (`narrow`, `with_budget`, `with_egress`, `mount`, `fork`) keeps the setting and writes its own lines, through itself. So a narrowed context that can no longer append to that path records nothing: its entries wait in `journal_pending` and are never written. That is the case when the narrowing left the journal's directory out, and always when it was made with `read_only=True`. To keep a record of what a helper runs, put the journal on an `append` mount and keep its directory in the narrowing. The helper's commands can then read that directory and cannot change it.

```python
logged = archil.context({"memory": archil.disk("agent-memory", "owned")}, backend=backend, journal="memory/journal")
logged.sh("ls {d}", d=logged.path("memory/notes")).run()
for f in logged.ls("memory/journal", recursive=True):
    print(f.path, logged.read_text(f.path))
```

One record per statement: `kind`, `plan` (the hash), `statement` (the template, cut at 240 characters), `reads`, `writes`, `calls`, `callUnits`, `usd`, `ms`, `exit`, with `ts` and `id` added. The journal is a log like any other, so it can be queried with the same verbs: `ctx.log("memory/journal", partition="day").all()` is a table in `ctx.sql`.

- Put the journal on a mount the context can append to: `append`, `owned` or `shared`.
- A journal never breaks the work it records. If an entry cannot be written (on Archil, because a statement holds that disk's checkout), it is kept and written with the next one. `ctx.journal_pending` (`journalPending`) counts what is waiting. `ts` is when the statement ran, which can be before the line was written.
