---
title: Work that starts from a change
description: A feed turns "poll every minute" into something that makes no call when nothing happened. A scheduler runs one pass as often as it likes, and nothing is running in between.
---

A feed turns "poll every minute" into something that makes no call when nothing happened. A scheduler runs a script like this one as often as it likes. Nothing is running between passes.

| Disk | Mode | Layout |
|---|---|---|
| `uploads` | `shared` | whatever arrives: here, CSV files at the root |
| `pipeline` | `owned` | `cursors/` for feed cursors, `sizes/` for what a pass produced |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

ctx = archil.context(
    {
        "inbox": archil.disk("uploads", "shared", create=True),
        "work": archil.disk("pipeline", "owned", create=True),
    },
    backend=backend,
)

def tick(ctx):
    """One pass: handle what is new, and say how much there was."""
    # a listing: no call
    changes = ctx.feed("inbox", cursor="work/cursors/inbox.json").poll()
    if not changes:
        return 0
    sizes = ctx.sh("wc -c {new} | tail -n 1", new=changes.refs())
    sizes.into("work/sizes/latest.txt").run(check=True)
    # only after the work is done: delivery is at least once
    changes.ack()
    return len(changes.files)

print(tick(ctx))                                       # nothing has arrived
ctx.write("inbox/a.csv", "id,amount\n1,10\n")
print(tick(ctx), tick(ctx))                            # one new file, then nothing
print(ctx.spend.snapshot().calls, "call(s) in three passes")
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
  {
    inbox: archil.disk("uploads", "shared", { create: true }),
    work: archil.disk("pipeline", "owned", { create: true }),
  },
  { backend },
);

/** One pass: handle what is new, and say how much there was. */
async function tick(ctx: archil.Context): Promise<number> {
  // a listing: no call
  const changes = await ctx.feed("inbox", { cursor: "work/cursors/inbox.json" }).poll();
  if (changes.empty) return 0;
  const sizes = ctx.sh`wc -c ${changes.refs()} | tail -n 1`;
  await sizes.into("work/sizes/latest.txt").run({ check: true });
  // only after the work is done: delivery is at least once
  await changes.ack();
  return changes.files.length;
}

console.log(await tick(ctx));                          // nothing has arrived
await ctx.write("inbox/a.csv", "id,amount\n1,10\n");
console.log(await tick(ctx), await tick(ctx));         // one new file, then nothing
console.log(ctx.spend.snapshot().calls, "call(s) in three passes");
```

```text output
0
1 0
1 call(s) in three passes
```

Three passes, one call. The two passes that found nothing made no call and read no data.

## What to watch

- **Acknowledge after the work, never before.** If the script dies in between, the next pass sees the same changes, so the work has to be safe to repeat.
- **A file that grew is handed over whole,** with its earlier size in `changes.previous`, so a reader of an append-only file can [skip what it has seen](/guides/feeds/#a-file-that-grew).
- **Each reader keeps its own cursor.** Two jobs watching the same inbox do not interfere.
- **Derived output that others read belongs in a [view](/guides/views/),** so that it rebuilds only when its inputs changed.
- **The schedule lives wherever a schedule already lives:** cron, a workflow runner, a queue. Nothing here keeps a machine warm.

A feed is a poll, and each poll lists the whole path. For a path with a very large number of files, watch a narrower directory, such as the current day of a log.

## Next

:::cards
- [Feeds](/guides/feeds/) What a poll returns, and what `ack` does.
- [Observability on a disk](/blueprints/observability/) A feed as an alert, beside a triage and a report.
:::
