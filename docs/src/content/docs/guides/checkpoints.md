---
title: Checkpoint, lock and fork
description: Three ways to use time. A checkpoint names a moment, a lock freezes a whole context at one, and a fork gives an attempt private branches to write to.
---

Archil's checkpoints and branches are copy-on-write and take milliseconds at any size. Three methods of a context are built on them.

| Method | Does | Returns |
|---|---|---|
| `checkpoint(name)` | checkpoints each `owned`, `shared` and `append` mount under one name | the checkpoint, by mount name |
| `lock(name)` | checkpoints every mount that is not already `frozen` | a [manifest](/guides/manifests/) in which all of them are |
| `fork(name)` | checkpoints each `owned` and `shared` mount and branches it | a context that writes to the branches |

::example-context

## Checkpoint: name a moment

```python
print(ctx.checkpoint("release-2026-11-10"))
```

```ts
console.log(await ctx.checkpoint("release-2026-11-10"));
```

```text output
{'logs': 'release-2026-11-10', 'memory': 'release-2026-11-10', 'team': 'release-2026-11-10'}
```

A checkpoint is what a `frozen` mount pins to: `archil.disk("agent-memory", "frozen", at="release-2026-11-10")`. `docs` is not in the result: this context cannot write it, so it is the publisher's to checkpoint.

## Lock: the same bytes every time

A lock is a manifest with every mount frozen at one point. Opening it gives the input to an eval, a replay or a reproducible build.

```python
lock = ctx.lock("eval-2026-11-10")                 # save this JSON with results
ctx.write("memory/notes/eng-1.md", "Reopened.\n")  # the live disk moves on

replay = archil.from_manifest(lock, backend=backend)
print(replay.read_text("memory/notes/eng-1.md").strip())
print(sorted({mount.mode for mount in replay.mounts.values()}), lock["locked"])
```

```ts
// save this JSON with the results
const lock = await ctx.lock("eval-2026-11-10");
// the live disk moves on
await ctx.write("memory/notes/eng-1.md", "Reopened.\n");

const replay = await archil.fromManifest(lock, { backend });
console.log((await replay.readText("memory/notes/eng-1.md")).trim());
const modes = [...new Set([...replay.mounts.values()].map((mount) => mount.mode))];
console.log(modes, lock.locked);
```

```text output
Closed after the coupon fix.
['frozen'] eval-2026-11-10
```

- A mount that was already `frozen` keeps the pin it had.
- A locked context can write nothing. A harness that records results needs a scratch disk from outside the lock.
- A lock checkpoints read-only mounts too, so that they hold still.

The [replay blueprint](/blueprints/replay/) is a small eval harness built on this.

## Fork: one branch per attempt

A fork gives each `owned` and `shared` mount a private branch. Use one per attempt when several agents try the same task: each sees the same starting state, and none sees another's writes.

```python
attempts = [ctx.fork(f"attempt-{i}") for i in range(3)]
for i, attempt in enumerate(attempts):
    attempt.write("memory/plan.md", f"plan {i}\n")

print([attempt.read_text("memory/plan.md").strip() for attempt in attempts])
print(ctx.exists("memory/plan.md"))                   # the main line saw none of it
```

```ts
const attempts: archil.Context[] = [];
for (let i = 0; i < 3; i++) attempts.push(await ctx.fork(`attempt-${i}`));
for (const [i, attempt] of attempts.entries()) {
  await attempt.write("memory/plan.md", `plan ${i}\n`);
}

const plans = await Promise.all(
  attempts.map(async (attempt) => (await attempt.readText("memory/plan.md")).trim()),
);
console.log(plans);
console.log(await ctx.exists("memory/plan.md"));      // the main line saw none of it
```

```text output
['plan 0', 'plan 1', 'plan 2']
False
```

- **A fork covers `owned` and `shared` mounts.** Mounts in the other modes are the same disks as before, so a fork still appends to the real log and still reads `read` mounts live.
- **A fork's manifest opens the fork.** Its mounts name the branches, not the original disks.
- **To keep one attempt,** copy what it wrote to the main line inside a [turn](/guides/turns/). The [attempts blueprint](/blueprints/attempts/) shows how.

To let attempts work on different slices of the data instead, give each a [narrowing](/guides/narrowing/) rather than a fork.

## Names

A checkpoint name has to be new on its disk, and made of letters, digits, `-` and `_`. A fork, a lock or a turn whose name was used before on that disk is refused.

## What these cost and leave behind

On Archil:

- **A checkpoint is taken by an exec.** Each one is a billed call and takes about a fifth of a second. A lock is one per mount, and a fork one per writable mount.
- **Nothing here can be deleted.** Archil cannot delete a branch or a checkpoint except by deleting the disk. Every fork and every turn leaves one of each on each disk it could write. Do not fork in a tight loop.
- **Opening a `frozen` mount** makes a branch at its checkpoint the first time.

On the local backend a checkpoint and a branch are each a full copy of the directory.

## Next

:::cards
- [Turns](/guides/turns/) A checkpoint and a branch per written disk, with a commit at the end.
- [Several attempts, and adopting one](/blueprints/attempts/) Forks, a score, and a turn that copies the winner.
- [A run that can be replayed](/blueprints/replay/) A lock, and a scratch disk for the results.
:::
