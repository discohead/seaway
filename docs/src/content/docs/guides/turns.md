---
title: Turns
description: A turn is a transaction over files. Its changes land together or not at all, and when another writer got there first, it conflicts instead of overwriting.
---

The unit of atomicity for an agent is a turn. A transaction makes a turn's changes land together or not at all. For the disks it may write, the semantics are snapshot isolation over files, with the first committer winning, path by path.

::example-context

## Use one

```python
with ctx.transaction(writes=["team", "memory"]) as turn:
    note = turn.out("team/standup.md")
    turn.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=note).run(check=True)
    turn.write("memory/notes/eng-2.md", "Closed after the coupon fix.\n")
# here both changes are on the main line, or neither is

print(ctx.read_text("team/standup.md"))
```

```ts
const commit = await ctx.transaction(
  async (turn) => {
    const note = turn.out("team/standup.md");
    await turn.sh`echo '- agent-7: ENG-1 is done' >> ${note}`.run({ check: true });
    await turn.write("memory/notes/eng-2.md", "Closed after the coupon fix.\n");
  },
  { writes: ["team", "memory"] },
);
// here both changes are on the main line, or neither is

console.log(commit.applied);      // [ 'team/standup.md', 'memory/notes/eng-2.md' ]
console.log(await ctx.readText("team/standup.md"));
```

```text output
- nothing yet
- agent-7: ENG-1 is done
```

| | Python | TypeScript |
|---|---|---|
| Shape | a context manager | a callback |
| Commits | when the block ends | when the callback returns |
| Rolls back | if the block raises | if the callback throws |
| `turn` is | the `Transaction`, which passes a context's verbs on | the turn's own `Context` |

`turn` has every verb a context has: `sh`, `sql`, `grep`, `batch`, `read`, `write`, `append`, `rm`, `ls`, `path`, `glob`, `out`, `log`, `feed`, and the rest. They act on the turn's own workspace.

:::caution[Inside a turn, do everything through `turn`]
A write through the outer `ctx` goes to the main line at once. It is not part of the turn, it is not undone if the turn fails, and it can make the turn conflict with itself. Reading through the outer `ctx` is fine, and is how to see what the main line holds meanwhile.
:::

## What it guarantees

1. **Begin.** Each disk the turn may write is checkpointed and branched. The branch is the turn's private workspace. Reads of those disks inside the turn see the state at the start plus the turn's own writes.
2. **Work.** Every verb acts on the branch. Nothing the turn does is visible to anyone else.
3. **Commit.** The SDK finds what the turn changed by comparing the branch's listing with its starting listing. If none of those paths changed on the main line in the meantime, it copies them across, in one call per disk. If any did, it raises `Conflict` naming the paths, and applies nothing, on any disk.

Disks the turn only reads are read live, not from a snapshot. If a decision depends on them, see [serializable](#declare-writes-and-reads).

## Conflicts

Control is optimistic: nothing is locked while the turn works, and the check happens at the end. Here a turn loses to a write that reached the main line first.

```python
mine = ctx.transaction(writes=["team"]).begin()
mine.write("team/standup.md", "- mine\n")

# the main line moves
ctx.write("team/standup.md", "- someone else got here first\n")

try:
    mine.commit()
except archil.Conflict as conflict:
    print(conflict.paths, mine.state)

# nothing of the turn was applied
print(ctx.read_text("team/standup.md").strip())
```

```ts
const mine = await new archil.Transaction(ctx, { writes: ["team"] }).begin();
await mine.ctx.write("team/standup.md", "- mine\n");

// the main line moves
await ctx.write("team/standup.md", "- someone else got here first\n");

try {
  await mine.commit();
} catch (conflict) {
  if (!(conflict instanceof archil.Conflict)) throw conflict;
  console.log(conflict.paths, mine.state);
}

// nothing of the turn was applied
console.log((await ctx.readText("team/standup.md")).trim());
```

```text output
['team/standup.md'] aborted
- someone else got here first
```

That suits an agent, because an agent can run a turn again.

## Run the turn again

```python
def stand_up(ctx, line, attempts=3):
    for _ in range(attempts):
        try:
            with ctx.transaction(writes=["team"]) as turn:
                note = turn.out("team/standup.md")
                turn.sh("echo {line} >> {note}", line=line, note=note).run(check=True)
            return True
        except archil.Conflict as conflict:
            # nothing was applied; go round again
            print("lost to another writer on", conflict.paths)
    return False

print(stand_up(ctx, "- agent-7: ENG-1 is done"))
```

```ts
async function standUp(
  ctx: archil.Context, line: string, attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await ctx.transaction(async (turn) => {
        const note = turn.out("team/standup.md");
        await turn.sh`echo ${line} >> ${note}`.run({ check: true });
      }, { writes: ["team"] });
      return true;
    } catch (conflict) {
      if (!(conflict instanceof archil.Conflict)) throw conflict;
      // nothing was applied; go round again
      console.log("lost to another writer on", conflict.paths);
    }
  }
  return false;
}

console.log(await standUp(ctx, "- agent-7: ENG-1 is done"));
```

```text output
True
```

- **`Conflict.paths` lists every path that changed under the turn.** The turn is over. Begin a new one, which starts from the new state.
- **Redo the work, do not replay the writes.** The turn that lost was computed from data that has since changed.
- **Granularity is the path.** Two turns that change different files both commit. Two that change the same file conflict, even in different places within it. Records that several agents edit side by side are better as a file each.
- **A change made outside any transaction conflicts in the same way.**

## Declare writes and reads

```python
with ctx.transaction(
    writes=["memory/notes"], reads=["docs/security"], isolation="serializable",
) as turn:
    policy = turn.read_text("docs/security/keys.md")
    turn.write("memory/notes/keys-summary.md", policy.splitlines()[1] + "\n")

print(ctx.read_text("memory/notes/keys-summary.md").strip())
```

```ts
await ctx.transaction(
  async (turn) => {
    const policy = await turn.readText("docs/security/keys.md");
    await turn.write("memory/notes/keys-summary.md", policy.split("\n")[1] + "\n");
  },
  { writes: ["memory/notes"], reads: ["docs/security"], isolation: "serializable" },
);

console.log((await ctx.readText("memory/notes/keys-summary.md")).trim());
```

```text output
Rotate API keys every 90 days.
```

| Option | Meaning |
|---|---|
| `writes` | the paths the turn may write. Left out, it is every `owned` and `shared` mount |
| `reads` | the paths the turn's decisions depend on. Checked at commit under `serializable` |
| `isolation` | `"snapshot"` (the default) or `"serializable"` |
| `name` | names the turn, and with it a branch and a checkpoint (`<name>-base`) on each disk. It has to be new on those disks. Left out, it is `tx-` and ten hex characters |

- **`snapshot`:** the commit fails only if a path the turn *changed* was changed by someone else.
- **`serializable`:** the commit also fails if anything under `reads` changed on the main line. It needs `reads`. Use it when the turn decides something from data it does not write.

:::danger[`writes` also decides which disks are in the turn at all]
Only the disks `writes` names are branched. On one of those, a change to a path outside what was declared is refused at commit (`undeclared_write`), and nothing is applied.

But a write inside the turn to a writable mount that `writes` does **not** name is not caught. That mount was never branched, so the write lands on the main line at once and stays there if the turn fails. Name every disk the turn writes, or leave `writes` out.
:::

## Drive one by hand

When a turn does not fit a block, as when two are interleaved, drive it yourself.

```python
mine = ctx.transaction(writes=["team"]).begin()
mine.write("team/standup.md", "- mine\n")
print(mine.changes())                    # written and deleted, by mount

commit = mine.commit()                   # or mine.rollback()
print(commit.applied, commit.deleted, commit.calls, commit.empty, mine.state)
```

```ts
const mine = await new archil.Transaction(ctx, { writes: ["team"] }).begin();
await mine.ctx.write("team/standup.md", "- mine\n");  // mine.ctx is the turn's context
console.log(await mine.changes());                    // written and deleted, by mount

const commit = await mine.commit();                   // or await mine.rollback()
console.log(commit.applied, commit.deleted, commit.calls, commit.empty, mine.state);
```

```text output
{'team': (['standup.md'], [])}
['team/standup.md'] [] 1 False committed
```

`state` is one of `new`, `open`, `committed`, `aborted` (a conflict, or an undeclared write), `rolled_back` and `failed`. A `rollback()` has nothing to undo: nothing was ever written to the main line.

In Python the turn's context is `turn.view`, which is what to hand a function that wants a `Context`. One name collides: to make a view inside a Python turn, write `turn.view.view(path, build)`.

## What is not part of a turn

- **An `append` mount.** A turn branches the disks it may write, and an append-only mount is not one of them. A record appended to one inside a turn is appended at once and stays if the turn fails. That is the right behaviour for an audit log, and the wrong place for anything that has to be undone.
- **A writable mount that `writes` does not name.** A write to it inside the turn goes straight to the main line.
- **Anything written through the outer context.** It reaches the main line at once, and if the turn changed the same path, the turn then conflicts with it.
- **Disks the turn only reads,** unless it is `serializable` and declares them.
- **Anything outside the context:** a request a command made, a row in a system of record. Do those last, or make them safe to repeat.
- **The framework's bookkeeping under `.px/`.** A commit carries over the files a turn changed, not that bookkeeping. A view refreshed or a recipe synced inside a turn does its work once more the first time it is used on the main line.

The [journal](/guides/journal/#where-to-put-it) follows the same rules, because it is a log on a mount.

## Cost and limits

- **Beginning a turn is one checkpoint per disk it may write.** On Archil a checkpoint is an exec: a billed call, and about a fifth of a second. Committing is one call per disk that changed. An empty turn commits without a call.
- **A commit is not atomic across files.** On Archil there is a window between checking for conflicts and copying, and a failure part-way leaves some paths applied. That is `commit_failed`, and the branch still holds the whole turn.
- **Every turn leaves a branch and a checkpoint** on each disk it could write. Archil cannot delete either except by deleting the disk.
- **A database file is one path,** so it is one unit of conflict. See [State in SQLite](/guides/sqlite/).
- **A context with no `owned` or `shared` mount** has nothing a turn could write, and `ctx.transaction()` says so (`read_only`).

[How turns work](/architecture/transactions/) goes through the mechanism, and what a native merge would change.

## Next

:::cards
- [Records many agents edit](/blueprints/shared-records/) A file per record, and an edit that retries on conflict.
- [How turns work](/architecture/transactions/) Checkpoints, branches, and the window that remains.
- [Transaction reference](/reference/transaction/) Every option and state, in both languages.
:::
