---
title: What it asks of the platform
description: seaway is as far as the idea goes from the client. Six things it works around today, each of which the platform could provide, and the path from a client-side planner to a server-side one.
---

seaway is a proposal, and it is written from the outside. Everything it does, it does with what Archil offers today. This page is where that stops: six things the SDK works around, each of which would be better done by the platform.

## 1. Accept a plan

Take the plan document as a request, run its tasks next to each other, and return the results.

Today the SDK makes one HTTP call per task, from wherever the caller happens to be. A mapped statement of forty shards is forty round trips from the client.

A [plan](/guides/plans/#a-plan-as-data) already says what a planner on the server would need: what to mount, what to run, and how to combine the outputs. Each of its tasks is nearly the body of a request to the exec endpoint as it exists now.

## 2. Return what a call did

If an exec result included the paths it wrote and what it metered, two things would change.

- **Estimates would become facts.** Prices in seaway are worked out from listings and public rates. They have not been compared with an invoice.
- **A turn's change list would not need a listing comparison.** Today the SDK finds what a turn changed by listing its branch twice.

## 3. Merge as a conditional apply

For a turn, one side of the merge is small and already known. So the primitive does not have to be a tree merge. It can be:

> Apply this branch's changes to its parent if none of these paths have changed on the parent since this checkpoint. Otherwise say which ones did.

That closes the window between validating and copying, and makes a commit atomic across files. With it go a REST call for checkpoints, which are taken by an exec today, and a way to delete branches, which today stay until the disk is deleted. [How turns work](/architecture/transactions/#what-a-native-merge-would-change) has the detail.

## 4. A change feed

A [feed](/guides/feeds/) is a cheap poll today. It lists the whole path each time. If system events are going to be most of the triggers for agents, they need a push.

## 5. Path-scoped credentials

[Narrowing](/guides/narrowing/#what-enforces-it) is enforced by the mount map inside a call. For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk. So the holder of a narrowed context is trusted.

Credentials scoped to a path would make narrowing hold for direct reads and writes too, and a narrowed context could be handed to code that is not trusted.

## 6. DuckDB in the exec image

`ctx.sql` needs DuckDB, and the exec image does not have it. The SDK has a [recipe](/guides/recipes/#recipes-that-are-statements) that puts the binary on a disk, after checking it against a pinned hash. With DuckDB in the image, SQL over files would need no setup step.

## The path to a server-side planner

Today the SDK is both planner and executor. It does not have to stay that way, and client code would not have to change, because a statement never said *how* to run.

1. **Now.** The client compiles a plan, and sends each task as a call.
2. **Accept a plan.** The client compiles a plan and sends the plan. The server runs it as given.
3. **Rewrite a plan.** The server starts improving the plan with what only the server knows.

At every step, `ctx.sql(...)` and `ctx.sh(...)` read the same. The declaration was always the interface. The mount map, the split and the price were always consequences of it.

## What this would not change

The parts of seaway that are conventions and not mechanisms would stay as they are: the [modes](/guides/modes/), the [log layout](/guides/logs/), the [files the framework writes](/architecture/files-on-disk/), and the rule that a path is a parameter.

## Next

:::cards
- [Status and known limits](/architecture/status/) What each of these costs today.
- [How planning works](/architecture/planning/) What the client-side planner does.
:::
