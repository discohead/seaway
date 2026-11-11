---
title: Transaction
description: Reference for ctx.transaction, Transaction and Commit. The options of a turn, how each language shapes one, the explicit begin, commit and rollback, and a turn's states.
---

A turn is a transaction over files. Its changes land together or not at all. The guide is [Turns](/guides/turns/), and the mechanism is in [How turns work](/architecture/transactions/).

## ctx.transaction

```py
ctx.transaction(*, writes=None, reads=None,
                isolation="snapshot", name=None) -> Transaction

# begins; commits at the end of the block; rolls back if it raises
with ctx.transaction(writes=[...]) as turn:
    ...
```

```typescript
ctx.transaction(
  fn: (turn: Context) => unknown,
  options?: { writes?, reads?, isolation?, name? },
): Promise<Commit>
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `writes` | list of paths | every `owned` and `shared` mount | the paths the turn may write. Only the disks they name are in the turn |
| `reads` | list of paths | none | the paths the turn's decisions depend on. Checked at commit under `serializable` |
| `isolation` | `"snapshot"` or `"serializable"` | `"snapshot"` | whether a change under `reads` also fails the commit |
| `name` | string | `tx-` and ten hex characters | names the turn, its branch, and its checkpoint (`<name>-base`). Has to be new on those disks |

| | Python | TypeScript |
|---|---|---|
| Shape | a context manager | a callback |
| `turn` is | the `Transaction`, which passes a context's verbs on | the turn's own `Context` |
| The turn's context | `turn.view` | `turn` itself |
| Returns | the `Transaction` | the `Commit` |

Making a transaction raises:

- `ValidationError` with `bad_isolation` for an unknown isolation, or `serializable` with no `reads`;
- `ValidationError` with `read_only` when the context has nothing a turn could write;
- `NotSupported` when the backend cannot checkpoint and branch.

## Transaction

For driving a turn by hand.

```py
tx = ctx.transaction(writes=["team"])
```

```typescript
const tx = new archil.Transaction(ctx, { writes: ["team"] });
```

| Python | TypeScript | Returns | Does |
|---|---|---|---|
| `tx.begin()` | `await tx.begin()` | the transaction | checkpoints and branches each disk the turn may write |
| `tx.changes()` | `await tx.changes()` | what changed, by mount | compares the branch with where it started. Metadata only |
| `tx.commit()` | `await tx.commit()` | a `Commit` | validates, then copies the changes to the main line |
| `tx.rollback()` | `await tx.rollback()` | nothing | abandons the turn. Nothing was written to the main line |

`changes()` returns `{mount: (written, deleted)}` in Python, and a `Map` of mount to `{ written, deleted }` in TypeScript. Paths are relative to the mount.

`commit()` raises:

- `Conflict` when a path the turn changed was changed on the main line. `conflict.paths` lists them. Nothing is applied;
- `ValidationError` with `undeclared_write` when the turn changed a path outside its `writes`. Nothing is applied;
- the base error with `commit_failed` when the copy failed part-way. Some paths may have been applied;
- the base error with `bad_state` when the turn is not open.

| Python | TypeScript | Is |
|---|---|---|
| `tx.id` | `tx.id` | the turn's name |
| `tx.state` | `tx.state` | where the turn is. See below |
| `tx.isolation` | `tx.isolation` | `snapshot` or `serializable` |
| `tx.base` | `tx.base` | the context the turn was made from |
| `tx.view` | `tx.ctx` | the context the turn works in, once begun |
| `tx.write_roots` | `tx.writeRoots` | the declared writes, by mount |
| `tx.read_roots` | `tx.readRoots` | the declared reads, by mount |

In Python a `Transaction` passes a context's verbs through to `tx.view`, so `tx.write(...)` and `tx.sh(...)` work on it directly. One name collides: a view inside a turn is `tx.view.view(path, build)`.

## States

| State | Means |
|---|---|
| `new` | made, and not begun |
| `open` | begun: working on its branch |
| `committed` | its changes are on the main line |
| `aborted` | the commit found a conflict, or an undeclared write. Nothing was applied |
| `rolled_back` | abandoned |
| `failed` | the copy failed part-way |

On a turn that is not `open`, `changes()` and `commit()` raise `bad_state`. Its verbs still run, but on the branch the turn has left behind, so nothing they write reaches the main line. Begin a new one.

## Commit

| Python | TypeScript | Is |
|---|---|---|
| `commit.id` | `commit.id` | the turn's name |
| `commit.applied` | `commit.applied` | the context paths written to the main line |
| `commit.deleted` | `commit.deleted` | the context paths removed from it |
| `commit.calls` | `commit.calls` | how many calls the commit made: one per disk that changed |
| `commit.empty` | `commit.empty` | whether the turn changed nothing |

## Conflict

| Python | TypeScript | Is |
|---|---|---|
| `conflict.paths` | `conflict.paths` | every path that changed under the turn |
| `conflict.code` | `conflict.code` | `conflict` |

See [Errors](/reference/errors/) for the fields every error has.
