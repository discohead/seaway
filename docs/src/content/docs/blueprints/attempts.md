---
title: Several attempts, and adopting one
description: Each attempt gets a fork, with private branches of the writable disks from the same starting state. None sees another's writes, and the one that wins is copied to the main line in a turn.
sidebar:
  label: Several attempts
---

When several agents try the same task, give each a fork. A fork has private branches of the writable disks, from the same starting state. None sees another's writes. The one that wins is copied to the main line in a turn.

| Disk | Mode | Layout |
|---|---|---|
| `workspace` | `owned` | `task.md`, and `out/` for what an attempt produces |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

ctx = archil.context(
    {"work": archil.disk("workspace", "owned", create=True)},
    backend=backend,
)
ctx.write("work/task.md", "Summarise the incident.\n")

# A checkpoint and a branch each. In real use: one agent per fork, in parallel.
attempts = [ctx.fork(f"attempt-{i}") for i in range(3)]
for i, attempt in enumerate(attempts):
    attempt.sh(
        "echo {text} > {answer} && echo {i} > {score}",
        text=f"summary {i}", i=i,
        answer=attempt.out("work/out/answer.md"), score=attempt.out("work/out/score"),
    ).run(check=True)

scores = [int(attempt.read_text("work/out/score")) for attempt in attempts]
best = attempts[scores.index(max(scores))]

# The winning branch, read-only, beside the main line. Then copy it across in a turn.
both = ctx.mount("winner", archil.disk(best.mounts["work"].source.disk))
with both.transaction(writes=["work"]) as turn:
    turn.sh(
        "mkdir -p {dst} && cp -R {src}/. {dst}/",
        src=turn.path("winner/out"), dst=turn.out("work/out"),
    ).run(check=True)

print(scores, ctx.read_text("work/out/answer.md").strip())
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const ctx = await archil.context(
  { work: archil.disk("workspace", "owned", { create: true }) },
  { backend },
);
await ctx.write("work/task.md", "Summarise the incident.\n");

// A checkpoint and a branch each. In real use: one agent per fork, in parallel.
const attempts: archil.Context[] = [];
for (let i = 0; i < 3; i++) attempts.push(await ctx.fork(`attempt-${i}`));
for (const [i, attempt] of attempts.entries()) {
  await attempt.sh("echo {text} > {answer} && echo {i} > {score}", {
    text: `summary ${i}`, i,
    answer: attempt.out("work/out/answer.md"), score: attempt.out("work/out/score"),
  }).run({ check: true });
}

const scores = await Promise.all(
  attempts.map(async (attempt) => Number(await attempt.readText("work/out/score"))),
);
const best = attempts[scores.indexOf(Math.max(...scores))]!;

// The winning branch, read-only, beside the main line. Then copy it across in a turn.
const both = await ctx.mount(
  "winner",
  archil.disk(best.mounts.get("work")!.source.disk),
);
await both.transaction(async (turn) => {
  await turn.sh("mkdir -p {dst} && cp -R {src}/. {dst}/", {
    src: turn.path("winner/out"), dst: turn.out("work/out"),
  }).run({ check: true });
}, { writes: ["work"] });

console.log(scores, (await ctx.readText("work/out/answer.md")).trim());
```

```text output
[0, 1, 2] summary 2
```

## What to watch

- **A fork's source names its branch.** That is why the branch can be mounted like any disk: `best.mounts["work"].source.disk`.
- **For a small result, skip the copy statement.** Read through the fork and write in a turn: `turn.write(path, best.read(path))`.
- **The turn is what makes adopting safe.** If the main line moved meanwhile, it conflicts, and nothing is applied.
- **A fork covers `owned` and `shared` mounts.** An attempt still appends to the real log, and still reads `read` mounts live.
- **Each fork leaves a checkpoint and a branch on every disk it covers, for good.** On Archil, do not fork in a tight loop.

To let attempts work on different slices of the data instead, give each a [`narrow`](/guides/narrowing/) of the context rather than a fork.

## Next

:::cards
- [Checkpoint, lock and fork](/guides/checkpoints/) What a fork covers, and what it costs.
- [Turns](/guides/turns/) Why the adoption is a transaction.
:::
