---
title: Core concepts
description: The whole model on one page. A context, its mounts and modes, the verbs, statements and their parameters, plans, turns, and where it all runs.
---

seaway has few ideas, and each one compiles to something Archil already does. This page has all of them. Each links to the guide that goes further.

## The model

1. A **context** composes disks into one tree. Each **mount** names a disk and a **mode** that says who may change it.
2. Simple reads and writes are **direct**: they go straight to the disk and use no compute.
3. Everything else is a **statement**: work that runs next to the data. A statement's **parameters** say which paths it reads and writes.
4. From those parameters the SDK compiles a **plan**: what the call can see, how many calls there are, and what they cost. You can read the plan before anything runs.
5. Changes that belong together go in a **turn**, which lands them all or none.

## Contexts, mounts and modes

A context is a plain value. Every method that changes one returns a new context and leaves the original alone.

```python
import tempfile
import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())
ctx = archil.context({
    # read: live, read-only (the default)
    "skills": archil.disk("org-skills", create=True),
    # this context is the only writer
    "memory": archil.disk("agent-memory", "owned", create=True),
    # many writers
    "team":   archil.disk("team-notes", "shared", create=True),
    # records are only ever added
    "audit":  archil.disk("audit-log", "append", create=True),
}, backend=backend)
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});
const ctx = await archil.context({
  // read: live, read-only (the default)
  skills: archil.disk("org-skills", "read", { create: true }),
  // this context is the only writer
  memory: archil.disk("agent-memory", "owned", { create: true }),
  // many writers
  team: archil.disk("team-notes", "shared", { create: true }),
  // records are only ever added
  audit: archil.disk("audit-log", "append", { create: true }),
}, { backend });
```

The mode is the mutation strategy for that part of the tree.

| Mode | Use it for | A statement sees it |
|---|---|---|
| `read` | live data someone else maintains | read-only |
| `frozen` | the same bytes on every run, pinned to a checkpoint | read-only, at the checkpoint |
| `owned` | data this context alone writes | read-write under a checkout: a second writer waits |
| `shared` | data many writers change, each keeping to its own paths | read-write, no checkout, last write wins |
| `append` | logs, journals, histories | read-only; records go in through `append` |

A **path** starts with a mount name: `memory/notes/eng-1.md` is `notes/eng-1.md` on the disk mounted as `memory`. No leading slash, and no `..`.

Guides: [Compose a context](/guides/contexts/) · [Mount modes](/guides/modes/) · [Limit reach, network and spend](/guides/narrowing/)

## Two kinds of verb

| | Direct | Statement |
|---|---|---|
| Verbs | `read`, `write`, `append`, `ls`, `exists`, `rm` | `sh`, `sql`, `grep`, `batch` |
| Runs | through the object API | in a call, next to the data |
| Compute | none | billed per call |
| When | at once | when you ask: `run()` |

Take the cheapest route that answers the question. A file's contents is a `read`. A regex over a million files is one `grep` call per disk. An aggregate over many files is one `sql` call.

## Statements and parameters

A statement is a template with parameters. A parameter is one of two things.

- **A path in the context.** `ctx.path(p)` reads a file or a directory, `ctx.glob(p)` reads many files, `ctx.out(p)` writes, and a log selection reads a time range. A path parameter tells the planner what the command touches.
- **A value.** Anything else is quoted, so the shell or the SQL engine can never interpret it.

So you never build a command by pasting text into it. In Python that means no f-string, `.format`, `%` or `+`. In TypeScript, write a tagged template: ``ctx.sh`cat ${x}` `` is right, and ``ctx.sh(`cat ${x}`)`` is a call that JavaScript has already pasted together.

Building a statement runs nothing. `explain()` returns its plan. `run()` runs it. A statement is an immutable value: `map`, `into`, `sized`, `egress` and `within` each return a new one.

Guides: [Statements and parameters](/guides/statements/) · [SQL over files](/guides/sql/) · [Search](/guides/grep/) · [Batch and map](/guides/batch-and-map/)

## Plans

A plan answers four questions that a harness author settles by hand today.

| Question | In the plan | Example |
|---|---|---|
| **Route**: how does the work reach the data? | `route` | `exec`, or the native `grep` |
| **Scope**: which disks can the call see, and can it change them? | `scope` | one directory of one disk, read-only |
| **Split**: how many calls, and how are the outputs combined? | the first line | `4 calls, combined by sum_by_key` |
| **Price**: what does it cost on each meter? | `price` | `1 call unit $0.00005 + …` |

The scope rule is short. A statement that declares paths sees only the disks they name: a disk it reads is mounted read-only, narrowed to the smallest directory that covers the reads, and a disk it writes is mounted whole, in its own mode. A statement that declares nothing sees the whole context, and its plan says so.

Because every plan carries a price, a **budget** is checked before anything runs.

Guides: [Read a plan](/guides/plans/) · [Prices and budgets](/guides/prices/)

## Results

`run()` returns a result: `text`, `rows` for `sql` and `grep`, `value` for a mapped statement, and `meta` with what it cost. A command that fails is a result, not an exception: look at `ok` or the exit code, or ask for an exception with `check=True` (`{ check: true }`).

Guide: [Results and limits](/guides/results/)

## Turns

A turn is a transaction over files. It checkpoints each disk it may write, works on a private branch, and at the end copies its changes to the main line, unless another writer changed one of the same paths first. Then it raises `Conflict`, applies nothing, and the right response is to run the turn again.

The semantics are snapshot isolation, first committer wins, at the granularity of a path.

Guide: [Turns](/guides/turns/)

## Structures built from the same verbs

| Structure | Is | Guide |
|---|---|---|
| **Log** | append-only records at `<path>/<date>/<hour>/<writer>.ndjson`; a selection reads only the partitions in a time range | [Logs](/guides/logs/) |
| **View** | a derived file that rebuilds only when its inputs changed | [Views](/guides/views/) |
| **Feed** | what was added, changed or removed under a path since a cursor last looked | [Feeds](/guides/feeds/) |
| **Recipe** | a system of record as files: an adapter with `list` and `get`, plus a note on the layout | [Recipes](/guides/recipes/) |
| **Journal** | a log of every statement a context ran: what it read, wrote and cost | [The journal](/guides/journal/) |

All of them are plain files on the disk they concern. [What the framework writes](/architecture/files-on-disk/) is the contract.

## Where it runs

Two backends provide the same operations, and code written against one runs on the other unchanged.

| | Local backend | Archil |
|---|---|---|
| A disk is | a directory | a disk in your account |
| A statement is | bash on this machine | bash in a fresh VM, with the disks mounted |
| Costs | nothing; plans show what Archil would charge | per call, per active byte, per byte of egress |

Guides: [Local and Archil backends](/guides/backends/) · [Run on Archil](/guides/archil/)

## What to get right

These are the mistakes that are easy to make, most of them because seaway does not work like the libraries it resembles.

1. **A path starts with a mount name.** No leading slash, no `..`, and never `/mnt/archil/...`.
2. **A path a statement touches is a parameter.** Otherwise the statement mounts every disk, and its plan can't be priced.
3. **A value is a parameter too.** Never build a command's text from values.
4. **Nothing runs until you ask.** In Python, `.run()`. In TypeScript, `await` the statement or call `.run()`.
5. **Read the plan when reach or cost matters.** `scope` is what the call can see. Each `note` is advice worth acting on.
6. **A command that fails is a result.** Check `ok`, or pass `check=True`.
7. **Take the cheapest route.** Direct verbs use no compute. `grep` is one call per disk. `batch` runs several statements in one call.
8. **Choose a mode by who writes.**
9. **Changes that belong together go in a turn,** and inside it everything goes through the turn's own context.
10. **Know where it will run.** With `ARCHIL_API_KEY` set and no backend given, a context acts on the live account.
11. **Hand a model less than you have.** `narrow` shrinks the reach, `with_egress("deny")` cuts the network, `with_budget` caps the spend.
