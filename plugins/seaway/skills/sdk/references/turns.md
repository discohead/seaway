# Turns as transactions

The unit of atomicity for an agent is a turn. A transaction makes a turn's changes land together or not at all.

## Contents

- [Using one](#using-one)
- [What it guarantees](#what-it-guarantees)
- [Conflicts, and running the turn again](#conflicts-and-running-the-turn-again)
- [Declaring writes and reads](#declaring-writes-and-reads)
- [Doing it by hand](#doing-it-by-hand)
- [What is not part of a turn](#what-is-not-part-of-a-turn)
- [Cost and limits](#cost-and-limits)

## Using one

```python
with ctx.transaction(writes=["team", "memory"]) as turn:
    turn.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=turn.out("team/standup.md")).run(check=True)
    turn.write("memory/notes/eng-1.md", "Closed after the coupon fix.\n")
# here both changes are on the main line, or neither is
```

```ts
const commit = await ctx.transaction(
  async (turn) => {
    await turn.sh`echo '- agent-7: ENG-1 is done' >> ${turn.out("team/standup.md")}`.run({ check: true });
    await turn.write("memory/notes/eng-1.md", "Closed after the coupon fix.\n");
  },
  { writes: ["team", "memory"] },
);
console.log(commit.applied);      // [ 'team/standup.md', 'memory/notes/eng-1.md' ]
```

In Python the turn is a context manager: it commits when the block ends and rolls back if the block raises. In TypeScript `ctx.transaction` takes a callback, commits when it returns, rolls back if it throws, and resolves to the `Commit`.

`turn` has every verb a context has (`sh`, `sql`, `grep`, `batch`, `read`, `write`, `append`, `rm`, `ls`, `path`, `glob`, `out`, `log`, `feed`, …), acting on the turn's own workspace. In TypeScript `turn` is a `Context`. In Python it is the `Transaction`, which passes those verbs on; the context itself is `turn.view`, which is what to hand a function that wants a `Context`. One name collides: to make a view inside a Python turn, write `turn.view.view(path, build)`.

**Do everything inside a turn through `turn`.** A write through the outer `ctx` goes to the main line at once: it is not part of the turn, it is not undone if the turn fails, and it can make the turn conflict with itself. Reading through the outer `ctx` is fine, and is how to see what the main line holds meanwhile.

## What it guarantees

For the disks a turn may write: snapshot isolation over files, with the first committer winning, path by path.

1. **Begin.** Each disk the turn may write is checkpointed and branched. The branch is the turn's private workspace. Reads of those disks inside the turn see the state at the start plus the turn's own writes.
2. **Work.** Every verb acts on the branch. Nothing the turn does is visible to anyone else.
3. **Commit.** The SDK finds what the turn changed by comparing the branch's listing with its starting listing. If none of those paths changed on the main line in the meantime, it copies them across, in one call per disk. If any did, it raises `Conflict` naming the paths, and applies nothing, on any disk.

Disks the turn only reads are read live, not from a snapshot. If a decision depends on them, see [serializable](#declaring-writes-and-reads).

## Conflicts, and running the turn again

Control is optimistic: nothing is locked while the turn works, and the check happens at the end. That suits an agent, because an agent can run a turn again.

```python
def stand_up(ctx, line, attempts=3):
    for _ in range(attempts):
        try:
            with ctx.transaction(writes=["team"]) as turn:
                turn.sh("echo {line} >> {note}", line=line, note=turn.out("team/standup.md")).run(check=True)
            return True
        except archil.Conflict as conflict:
            print("lost to another writer on", conflict.paths)   # nothing was applied; go round again
    return False

stand_up(ctx, "- agent-7: ENG-1 is done")
```

```ts
async function standUp(ctx, line, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await ctx.transaction(async (turn) => {
        await turn.sh`echo ${line} >> ${turn.out("team/standup.md")}`.run({ check: true });
      }, { writes: ["team"] });
      return true;
    } catch (conflict) {
      if (!(conflict instanceof archil.Conflict)) throw conflict;
      console.log("lost to another writer on", conflict.paths);
    }
  }
  return false;
}

await standUp(ctx, "- agent-7: ENG-1 is done");
```

- `Conflict.paths` lists every path that changed under the turn. The turn is over; begin a new one, which starts from the new state.
- Redo the work, do not replay the writes. The turn that lost was computed from data that has since changed.
- Granularity is the path. Two turns that change different files both commit. Two that change the same file conflict, even in different places within it, so records that several agents edit side by side are better as a file each.
- A change made to the main line outside any transaction conflicts in the same way.

## Declaring writes and reads

```python
with ctx.transaction(writes=["memory/notes"], reads=["docs/security"], isolation="serializable") as turn:
    policy = turn.read_text("docs/security/keys.md")
    turn.write("memory/notes/keys-summary.md", policy.splitlines()[0] + "\n")
```

```ts
await ctx.transaction(
  async (turn) => {
    const policy = await turn.readText("docs/security/keys.md");
    await turn.write("memory/notes/keys-summary.md", policy.split("\n")[0] + "\n");
  },
  { writes: ["memory/notes"], reads: ["docs/security"], isolation: "serializable" },
);
```

- **`writes`** lists the paths the turn may write. Left out, it is every `owned` and `shared` mount, and each of those is checkpointed and branched. Naming them keeps the turn to the disks it needs.
- **`writes` also decides which disks are in the turn at all.** Only the disks it names are branched. On one of those, a change to a path outside what was declared is refused at commit (`undeclared_write`) and nothing is applied. But a write inside the turn to a writable mount that `writes` does not name is not caught: that mount was never branched, so the write lands on the main line at once and stays there if the turn fails. Name every disk the turn writes, or leave `writes` out.
- **`isolation="snapshot"`** is the default: the commit fails only if a path the turn *changed* was changed by someone else.
- **`isolation="serializable"`** also fails the commit if anything under `reads` changed on the main line. It needs `reads`. Use it when the turn decides something from data it does not write.
- **`name`** names the turn, and with it a branch and a checkpoint (`<name>-base`) on each disk, so it has to be new on those disks: a name used before is refused. Left out, it is `tx-` and ten hex characters.

## Doing it by hand

When a turn does not fit a block, as when two are interleaved, drive it yourself.

```python
mine = ctx.transaction(writes=["team"]).begin()
mine.write("team/standup.md", "- mine\n")
print(mine.changes())                    # {'team': (['standup.md'], [])}: written and deleted, by mount
try:
    commit = mine.commit()               # or mine.rollback()
    print(commit.id, commit.applied, commit.deleted, commit.calls, commit.empty)
except archil.Conflict as conflict:
    print(conflict.paths)
print(mine.state)                        # committed
```

```ts
const mine = await new archil.Transaction(ctx, { writes: ["team"] }).begin();
await mine.ctx.write("team/standup.md", "- mine\n");     // mine.ctx is the turn's context
console.log(await mine.changes());                       // Map { 'team' => { written: ['standup.md'], deleted: [] } }
const commit = await mine.commit();                      // or await mine.rollback()
console.log(commit.id, commit.applied, commit.deleted, commit.calls, commit.empty, mine.state);
```

`state` is one of `new`, `open`, `committed`, `aborted` (a conflict, or an undeclared write), `rolled_back` and `failed`. A `rollback()` has nothing to undo: nothing was ever written to the main line.

## What is not part of a turn

- **An `append` mount.** A turn branches the disks it may write, and an append-only mount is not one of them. A record appended to one inside a turn is appended at once and stays if the turn fails. That is the right behaviour for an audit log or a journal, and the wrong place for anything that has to be undone. (An append to an `owned` or `shared` mount that is in the turn is on the branch, and commits with the rest.)
- **A writable mount that `writes` does not name.** See above: a write to it inside the turn goes straight to the main line.
- **Anything written through the outer context.** It reaches the main line at once, and if the turn changed the same path, the turn then conflicts with it.
- **Disks the turn only reads**, unless it is `serializable` and declares them.
- **Anything outside the context:** a request a command made, a row in a system of record. Do those last, or make them safe to repeat.

The journal follows the same rules, because it is a log on a mount. If it lives on a disk the turn writes, the lines for statements run inside the turn are on the branch: they land with the commit, and a rolled-back turn leaves only its `rollback` line. The journal's file is then one of the turn's changes, so a turn that names its `writes` has to name the journal's directory among them, or its commit is refused with `undeclared_write`. If it lives on an `append` mount, every line is written at once and stays whatever becomes of the turn, and `writes` need not mention it. Put the journal on an `append` disk when failed turns should leave a record of what they ran.

The same goes for the framework's bookkeeping under `.px/`. A commit carries over the files a turn changed and not that bookkeeping, so a view refreshed or a recipe synced inside a turn does its work once more the first time it is used on the main line.

## Cost and limits

- Beginning a turn is one checkpoint per disk it may write. On Archil a checkpoint is an exec: a billed call and about a fifth of a second. Committing is one call per disk that changed, and an empty turn commits without a call.
- A commit is not atomic across files. On the local backend a lock makes the check and the copy one step for turns that share one backend object. Two processes on the same root are not serialised against each other. On Archil there is a window between them, and a failure part-way leaves some paths applied. That is `commit_failed`, and the branch still holds the whole turn.
- Every turn leaves a branch and a checkpoint on each disk it could write. Archil cannot delete either except by deleting the disk.
- On Archil a file's version carries its modification time in whole seconds. A turn that begins within about a second and a half of a write waits out the difference before it takes its snapshot.
- A database file is one path, so it is one unit of conflict. See [sqlite.md](sqlite.md).
- Transactions need a backend that can checkpoint and branch. Both shipped backends can. One that cannot raises `NotSupported`.
- A context with no `owned` or `shared` mount has nothing a turn could write, and `ctx.transaction()` says so (`read_only`).
