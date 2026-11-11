---
title: Read a plan
description: A plan is what a statement will do, written down before it does it. explain() returns one and runs nothing. How to read each line, what each note means, and the plan as data.
---

`explain()` returns a statement's plan and runs nothing. It costs a listing, and listings are free. A plan answers four questions: how the work reaches the data, what each call can see, how many calls there are, and what they cost.

::example-context

## A plan, line by line

```python
words = ctx.sh(
    "cat {files} | wc -w",
    files=ctx.glob("docs/**/*.md"),
).map(reduce="sum", shards=3)
plan = words.explain()
print(plan)
```

```ts
const words = ctx.sh("cat {files} | wc -w", {
  files: ctx.glob("docs/**/*.md"),
}).map({ reduce: "sum", shards: 3 });
const plan = await words.explain();
console.log(String(plan));
```

```plan output
plan a36fbc79cf7f  sh · 3 file(s), 174 B · 3 calls, combined by sum
  route   exec · 2 vCPU / 4 GiB · up to 3 at once
  scope   docs → handbook (read-only)
          not mounted: logs, memory, team
  reads   docs/**/*.md
  writes  —
  price   3 call units $0.00015 + 174 B active for an hour <$0.00001 ≈ $0.00015
```

| Line | What it answers |
|---|---|
| the first | the plan's hash, the statement's kind, how many files and bytes it reads, how many calls, and the reducer when there is more than one call |
| `route` | how the work reaches the data. `exec` is a serverless call, with its VM size, custom image, network policy, and how many run at once. `grep` is the native search: one call per disk |
| `scope` | every disk the call can see, as `path in the VM → disk:/subdirectory (how)`. `not mounted:` lists the context's other mounts |
| `reads`, `writes` | what the statement declared. `— (not declared)` means it declared nothing |
| `price` | call units and their cost, plus the bytes it would make active for an hour and theirs. `(input size unknown)` means nothing was declared, so only the calls are priced |
| `note` | advice. See [the notes](#the-notes-a-plan-can-carry) |

## Read scope for safety

`scope` is the line to read when reach matters. If a disk is not on it, the command cannot see that disk at all. If a mount says `read-only`, the command cannot change it.

| In `scope` | Means |
|---|---|
| `(read-only)` | the call cannot change this mount |
| `(read-write, checkout /)` | an `owned` mount: the call holds its checkout while it runs |
| `(read-write, conditional)` | a `shared` mount: no checkout, last write wins |
| `disk:/sub/dir` | only that directory of the disk is mounted |
| `not mounted: a, b` | these mounts do not exist in the call |

## The notes a plan can carry

Each note is something a careful author would act on.

| Note | What to do |
|---|---|
| `no paths declared, so all N mount(s) are attached; pass paths as parameters to mount only what the command needs` | declare the paths with `ctx.path`, `ctx.glob`, `ctx.out` |
| `N files in one call; .map() would spread this over about M calls` | the input is over 256 MiB or 2,000 files. Add [`.map(reduce=...)`](/guides/batch-and-map/#map-one-input-across-many-calls) if the command can be split |
| `parallel calls writing to an 'owned' mount queue for its checkout; a 'shared' mount lets them write at once` | map `into` a `shared` mount |
| `this VM size bills as N calls each` (for `sql`, `… as N calls`) | check the larger VM is worth it |
| `a plain regex search is one call per disk with ctx.grep(), however many files` | use [`ctx.grep`](/guides/grep/) instead of `rg` or `grep` in `sh` |
| `the caller is outside Archil: only stdout crosses the network, not the files` | nothing: a reminder that large output should go [`into()`](/guides/results/#keep-large-output-on-the-disk) a file |
| `no input files for X: nothing to run, zero rows returned` | the path or selection matched nothing. Check it |
| `N statements in one call instead of N` | nothing: what the batch saved |

## A plan as data

`plan.to_dict()` in Python and `JSON.stringify(plan)` in TypeScript give the same document. Money in it is rounded to eight places.

```python
import json

count = ctx.sh("wc -w {files}", files=ctx.glob("docs/*.md"))
print(json.dumps(count.explain().to_dict(), indent=2))
```

```ts
const count = ctx.sh("wc -w {files}", { files: ctx.glob("docs/*.md") });
console.log(JSON.stringify(await count.explain(), null, 2));
```

```json output
{
  "plan": 0,
  "hash": "ed578d40c885",
  "kind": "sh",
  "route": "exec",
  "statement": "wc -w {files}",
  "vm": {
    "vcpuCount": 2,
    "memSizeMib": 4096
  },
  "parallel": 64,
  "reduce": null,
  "effects": {
    "reads": [
      "docs/*.md"
    ],
    "writes": []
  },
  "tasks": [
    {
      "command": "wc -w docs/expenses.md docs/onboarding.md",
      "disks": {
        "docs": {
          "disk": "handbook",
          "readOnly": true,
          "conditional": false
        }
      }
    }
  ],
  "estimate": {
    "calls": 1,
    "callUnits": 1,
    "bytesTouched": 103,
    "egressBytes": 0,
    "usd": 5e-05,
    "usdCalls": 5e-05,
    "usdActive": 0.0,
    "usdEgress": 0.0,
    "complete": true
  },
  "notes": []
}
```

- **Each task is nearly the body of a request to Archil's exec endpoint:** a command and a `disks` map. `vm` can also carry `baseImage` and `network`.
- **The glob was expanded.** The task's command names the two files that matched when the plan was compiled.
- **`estimate.complete` is `false`** when the statement declares nothing.

### The hash

`hash` is the first 12 hex characters of the SHA-256 of `{kind, statement, vm, reduce, tasks}` as JSON with sorted keys and no spaces.

- It covers what a plan does and not what it costs, so it survives a price change.
- Written with named parameters, a statement gets the same hash from both SDKs.
- A TypeScript tagged template names its parameters `p0`, `p1`, …, so its `statement`, and so its hash, differ from the named form's.
- It is what the [journal](/guides/journal/) and a [view](/guides/views/)'s state record.

### On the object

```python
plan = ctx.sh("wc -w {files}", files=ctx.glob("docs/*.md")).explain()
print(plan.kind, plan.route, plan.files, len(plan.tasks))
print(plan.reads, plan.writes, plan.unmounted)
print(plan.estimate.calls, plan.estimate.bytes_touched, plan.estimate.usd)
```

```ts
const words = ctx.sh("wc -w {files}", { files: ctx.glob("docs/*.md") });
const plan = await words.explain();
console.log(plan.kind, plan.route, plan.files, plan.tasks.length);
console.log(plan.reads, plan.writes, plan.unmounted);
console.log(plan.estimate.calls, plan.estimate.bytesTouched, plan.estimate.usd);
```

```text output
sh exec 2 1
['docs/*.md'] [] ['logs', 'memory', 'team']
```

## A plan reflects the files that exist now

A glob is expanded and sizes are read when `explain()` or `run()` is called. A plan compiled now reflects the files that exist now.

`run()` compiles again, so the plan that ran is `result.plan`. It can differ from an earlier `explain()` when files were added in between.

## Why a plan is a document

Today the SDK is both planner and executor. But a plan is the document a planner on Archil's side would need. That suggests a way there in steps: first accept a plan as a request and run it as given, then start rewriting it with what only the server knows. Client code doesn't change at any step, because it never said how to run the statement. [What it asks of the platform](/architecture/platform/) follows that thread.

## Next

:::cards
- [Prices and budgets](/guides/prices/) Where the price line comes from, and how to cap it.
- [How planning works](/architecture/planning/) From parameters to a mount map, shards and an estimate.
- [Plan reference](/reference/plan/) Every field of a plan and its JSON form.
:::
