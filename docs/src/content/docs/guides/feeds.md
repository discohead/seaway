---
title: Feeds
description: A feed is a cursor over a listing. It reports what was added, changed or removed under a path since a reader last looked, and an idle poll makes no call and reads none of the data it watches.
---

A feed is how work starts from a change in the data instead of from a clock. `poll()` lists a path, which reads no data, and compares the listing with what a cursor recorded. When nothing changed, the poll made no call: all it read was its own cursor file.

::example-context

## Poll, handle, acknowledge

```python
feed = ctx.feed("logs", cursor="memory/cursors/alerts.json")
feed.poll().ack()            # the first poll hands over everything; call it seen

ctx.log("logs", writer="checkout-b").append(
    {"level": "ERROR", "service": "checkout", "msg": "payments-gateway unreachable"})

changes = feed.poll()        # a listing: no call
if changes:
    alert = ctx.sh(
        "cat {new} | jq -r 'select(.level == \"ERROR\") | .service + \": \" + .msg' "
        "| sort | uniq -c",
        new=changes.refs(),  # only the files that are new or have changed
    )
    print(alert.run(check=True).text.strip())
    # move the cursor; until then the next poll returns these again
    changes.ack()

print(bool(feed.poll()))     # nothing new
```

```ts
const feed = ctx.feed("logs", { cursor: "memory/cursors/alerts.json" });
// the first poll hands over everything; call it seen
await (await feed.poll()).ack();

await ctx.log("logs", { writer: "checkout-b" }).append(
  { level: "ERROR", service: "checkout", msg: "payments-gateway unreachable" });

const changes = await feed.poll();        // a listing: no call
if (!changes.empty) {
  const alert = ctx.sh(
    "cat {new} | jq -r 'select(.level == \"ERROR\") | .service + \": \" + .msg' " +
      "| sort | uniq -c",
    { new: changes.refs() },              // only the files that are new or have changed
  );
  console.log((await alert.run({ check: true })).text.trim());
  // move the cursor; until then the next poll returns these again
  await changes.ack();
}

console.log(!(await feed.poll()).empty);  // nothing new
```

```text output
1 checkout: payments-gateway unreachable
False
```

In Python, `changes` is falsy when there is nothing to do. In TypeScript, ask `changes.empty`.

## What a poll returns

| On `changes` | Is |
|---|---|
| `added` | files that were not there at the last `ack()` |
| `modified` | files whose size or version changed |
| `removed` | the paths of files that are gone |
| `files` | `added` then `modified` |
| `refs()` | `files` as statement parameters, so a statement mounts and reads only those |
| `previous` | the size each modified file had before |
| `ack()` | moves the cursor |

Each file has `path`, `size`, `modified` and `version`.

## Acknowledge after the work

`ack()` moves the cursor. Until then `poll()` returns the same changes, so a reader that stops half-way sees them again.

- **Delivery is at least once.** Make the handling safe to repeat.
- **Acknowledge after the work, never before.** If the script dies in between, the next pass sees the same changes.
- **Each reader keeps its own cursor.** The cursor is a small file on a mount the context can write. A cursor that lives under the watched path is left out of the changes.

## A file that grew

A changed file is handed over whole, not as a diff. For an append-only file, `changes.previous[path]` is the size it had before, so a reader can skip what it has seen:

```python
feed = ctx.feed("logs", cursor="memory/cursors/tail.json")
feed.poll().ack()

ctx.log("logs", writer="api-a").append(
    {"level": "WARN", "service": "api", "msg": "slow upstream"})

changes = feed.poll()
for f in changes.modified:
    start = changes.previous[f.path] + 1          # tail counts bytes from 1
    file = ctx.path(f.path)
    new = ctx.sh("tail -c +{start} {file} | jq -r .msg", start=start, file=file)
    print(new.run(check=True).text.strip())
changes.ack()
```

```ts
const feed = ctx.feed("logs", { cursor: "memory/cursors/tail.json" });
await (await feed.poll()).ack();

await ctx.log("logs", { writer: "api-a" }).append(
  { level: "WARN", service: "api", msg: "slow upstream" });

const changes = await feed.poll();
for (const f of changes.modified) {
  const start = (changes.previous[f.path] ?? 0) + 1;   // tail counts bytes from 1
  const fresh = ctx.sh`tail -c +${start} ${ctx.path(f.path)} | jq -r .msg`;
  console.log((await fresh.run({ check: true })).text.trim());
}
await changes.ack();
```

```text output
slow upstream
```

## One pass of a scheduled job

A scheduler runs a script like this as often as it likes. Nothing is running between passes.

```python
def tick(ctx):
    """One pass: handle what is new, and say how much there was."""
    feed = ctx.feed("team/leads", cursor="memory/cursors/leads.json")
    changes = feed.poll()    # a listing: no call
    if not changes:
        return 0
    ctx.sh(
        "wc -l {new} | tail -n 1",
        new=changes.refs(),
    ).into("memory/leads-count.txt").run(check=True)
    changes.ack()            # only after the work is done
    return len(changes.files)

print(tick(ctx), tick(ctx))  # the first pass sees both files; the second sees nothing
ctx.write("team/leads/apac.csv", "name,region\nDee,apac\n")
print(tick(ctx), tick(ctx))
```

```ts
async function tick(ctx: archil.Context): Promise<number> {
  // One pass: handle what is new, and say how much there was.
  const feed = ctx.feed("team/leads", { cursor: "memory/cursors/leads.json" });
  const changes = await feed.poll();  // a listing: no call
  if (changes.empty) return 0;
  await ctx.sh`wc -l ${changes.refs()} | tail -n 1`
    .into("memory/leads-count.txt").run({ check: true });
  await changes.ack();                // only after the work is done
  return changes.files.length;
}

// the first pass sees both files; the second sees nothing
console.log(await tick(ctx), await tick(ctx));
await ctx.write("team/leads/apac.csv", "name,region\nDee,apac\n");
console.log(await tick(ctx), await tick(ctx));
```

```text output
2 0
1 0
```

## What a feed is not

- **It is a poll, not a push.** Each poll lists the whole path.
- **It is not a diff.** A changed file is handed over whole.
- **On Archil it can hand a file over twice.** A file written within the last second or two is remembered provisionally, and handed over again on the next poll. See [Versions and clocks](/architecture/versions/).

Derived output that others read belongs in a [view](/guides/views/), so that it rebuilds only when its inputs changed.

## Next

:::cards
- [Work that starts from a change](/blueprints/change-driven/) A feed, a statement and a cursor, as a design.
- [What the framework writes](/architecture/files-on-disk/) The cursor's format.
:::
