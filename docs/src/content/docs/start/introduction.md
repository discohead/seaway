---
title: Introduction
description: seaway is a framework for Archil. You define the context an agent needs, then run statements against it that say what they touch, explain themselves before they run, and carry a price.
---

[Archil](https://archil.com) gives an agent a file system and `exec`, a call that runs a command next to the data. seaway is the layer in front of that call. It is two SDKs, Python and TypeScript, with one API. Both are built on Archil's official clients and use them for every call, and both run today: on a local backend with no account, and on Archil.

seaway is an unofficial prototype, packaged under its own name so it installs beside the official SDKs.

## The idea

Archil's post [Bash is the SQL for file systems](https://archil.com/post/serverless-execution) ends: "The SQL analogy gets a little closer to literal with every step." seaway takes it literally.

If bash is the SQL, then `exec` is the executor: the part of a database that runs a query. Archil's is very good. The compute sits next to the data, starts in tens of milliseconds, and costs five cents per thousand calls. But a database gives you more than a place to run a query. It gives you everything in front of the executor, and that is what makes it something you build on.

| A database gives you | seaway gives you | Which on Archil is |
|---|---|---|
| A catalog | A **context**: disks composed under path names, each with a mutation strategy | A mount map: `readOnly`, `conditional`, checkouts, branches |
| Bound parameters | A **statement**: a path parameter declares what the command reads or writes, and a value is always quoted | The `disks` of an exec call, worked out for you |
| `EXPLAIN` | A **plan**: route, scope, split and price, before anything runs | A listing and the price sheet |
| Transactions | A **turn**: snapshot isolation over files, first committer wins | A checkpoint and a branch per written disk |
| Materialised views | A **view**: a derived file that rebuilds only when its inputs changed | A listing compared with a fingerprint |
| A cost model | A price on every plan, and budgets enforced before a call is made | Three meters: calls, active data, egress |

## One example

A context with four mounts, and one question asked of it.

::example-context

```python
errors = ctx.sql(
    "select service, count(*)::int as errors from {recent} "
    "where level = {level} group by 1 order by 2 desc",
    recent=ctx.log("logs").last("15m"),  # a path parameter: says what the call may see
    level="ERROR",                       # a value: always quoted
)
# the plan: what it mounts, how many calls, what it costs
print(errors.explain())
# runs next to the data; only the rows come back
rows = errors.run(check=True).rows
print(rows)  # [{'service': 'checkout', 'errors': 3}]
```

```ts
const errors = ctx.sql`
  select service, count(*)::int as errors from ${ctx.log("logs").last("15m")}
  where level = ${"ERROR"} group by 1 order by 2 desc`;

// the plan: what it mounts, how many calls, what it costs
console.log(String(await errors.explain()));
// runs next to the data; only the rows come back
const { rows } = await errors.run({ check: true });
console.log(rows);  // [ { service: 'checkout', errors: 3 } ]
```

```plan
plan 9af6b2227225  sql · 3 file(s), 1.9 KiB · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   logs/2026-11-10/14 → app-logs:/2026-11-10/14 (read-only)
          not mounted: docs, memory, team
  reads   logs[last 15m]
  writes  —
  price   1 call unit $0.00005 + 1.9 KiB active for an hour <$0.00001 ≈ $0.00005
```

Nothing ran until `run`. The plan says what will: one call, with one hour's directory of one disk mounted read-only, the other three disks not mounted at all, and a price. The code chose none of that. It said which records it wanted, and the mount map, the route and the price followed.

## Where the decisions live

Here is the same question asked with the official SDK.

```typescript
import { Archil } from "disk";
const archil = new Archil();

const { stdout } = await archil.exec({
  disks: {
    logs:
      { disk: "dsk-0123456789abcdef", subdirectory: "2026-11-10/14", readOnly: true },
    // DuckDB is not in the exec image
    tools: { disk: "dsk-fedcba9876543210", subdirectory: "bin", readOnly: true },
  },
  command: `/mnt/archil/tools/duckdb -json -c "select service, count(*) as errors
            from read_json_auto('/mnt/archil/logs/*.ndjson')
            where level = 'ERROR' and ts >= '${since}'
            group by 1 order by 2 desc"`,
});
const rows = JSON.parse(stdout);
```

That does the job, and it isn't much longer. What differs is where the decisions live. Here the caller decided:

- which disk the call may see, at which subdirectory, and whether it may write;
- that the image has no DuckDB, and where to find one;
- that this is an exec, and not a search or a plain read;
- that one call is enough;
- to paste a value into SQL inside a shell string;
- and it did all that with no idea what the call would cost.

A harness makes those decisions for every tool call an agent issues. In practice they get made once, in the helper behind the bash tool, and the safe choice there is to mount everything on every call. And because they are made in the caller's code, all Archil receives is a string and a mount map. A planner on the server has nothing to work with.

A seaway statement carries that information, and is no more work to write.

## What is in it

:::cards
- [Contexts](/guides/contexts/) Disks composed into one tree. Each mount has a mode: `read`, `frozen`, `owned`, `shared` or `append`.
- [Statements](/guides/statements/) `sh`, `sql`, `grep` and `batch`. A path is a parameter, and so is every value.
- [Plans and prices](/guides/plans/) `explain()` before `run()`. Budgets are checked against the plan, before a call is made.
- [Turns](/guides/turns/) A transaction over files. A turn's changes land together or not at all.
- [Logs, views and feeds](/guides/logs/) Append-only records, derived files that rebuild themselves, and a cursor over what changed.
- [Tools for a model](/guides/model-tools/) A context as tools with JSON schemas, narrowed and budgeted first.
:::

Everything the framework keeps is a plain file on the disk it concerns, so either SDK, or an agent with only bash, can read it. The journal is JSON lines it can `jq`. A manifest is JSON it can write. A view is a file it can `cat`.

## What it is not

- **Not an Archil product.** It is an unofficial proposal, written against Archil's public API.
- **Not on a package registry.** You install it from a checkout or from GitHub. See [Installation](/start/installation/).
- **Not licensed yet.** The repository does not carry a licence.
- **Not finished.** There are no services or sandboxes, no server-side planner, no caching by plan hash and no command-line tool. [Status and known limits](/architecture/status/) is the full list.

## Next

:::cards
- [Installation](/start/installation/) Both SDKs, and the two command-line tools the examples call.
- [Quickstart](/start/quickstart/) A context, a statement, its plan, a turn and a narrowed helper.
- [Core concepts](/start/concepts/) The whole model on one page.
:::
