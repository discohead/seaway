---
title: Pricing
description: Reference for PriceSheet, Budget, Estimate and Ledger, in Python and TypeScript. The rates, the fields of an estimate, and what the ledger counts.
---

What a statement costs, worked out before it runs. The guide is [Prices and budgets](/guides/prices/).

## PriceSheet

The rates. The defaults are Archil's public price sheet as read in November 2026.

```py
archil.PriceSheet(call_usd=0.00005, ...)          # pass prices by keyword
```

```typescript
new archil.PriceSheet({ callUsd: 0.00005 })       // any subset of the fields
```

| Python | TypeScript | Default | Is |
|---|---|---|---|
| `prices.as_of` | `prices.asOf` | `"2026-11"` | when the sheet was read |
| `prices.source` | `prices.source` | the address of Archil's [pricing page](https://archil.com/pricing) | where it was read |
| `prices.call_usd` | `prices.callUsd` | `0.00005` | one serverless call at the default VM size |
| `prices.call_vcpu` | `prices.callVcpu` | `2` | the default VM's vCPU |
| `prices.call_mem_mib` | `prices.callMemMib` | `4096` | the default VM's memory |
| `prices.active_gib_month_usd` | `prices.activeGibMonthUsd` | `0.20` | active data, per GiB-month |
| `prices.archive_gb_month_usd` | `prices.archiveGbMonthUsd` | `0.025` | archive, per GB-month |
| `prices.egress_gb_usd` | `prices.egressGbUsd` | `0.07` | egress, per GB |
| `prices.sandbox_vcpu_hour_usd` | `prices.sandboxVcpuHourUsd` | `0.055` | a sandbox, per vCPU-hour |
| `prices.sandbox_gib_hour_usd` | `prices.sandboxGibHourUsd` | `0.020` | a sandbox, per GiB-hour |
| `prices.active_window_hours` | `prices.activeWindowHours` | `1.0` | how long data stays active after a touch |
| `prices.hours_per_month` | `prices.hoursPerMonth` | `730.0` | hours in a month |

| Python | TypeScript | Returns |
|---|---|---|
| `prices.call_units(vcpu=2, mem_mib=4096)` | `prices.callUnits(vcpu?, memMib?)` | what a VM of that size bills as: the larger of its vCPU and memory multiples of the default, rounded up |
| `prices.active_usd(nbytes)` | `prices.activeUsd(nbytes)` | the cost of keeping that many bytes active for one window |
| `prices.egress_usd(nbytes)` | `prices.egressUsd(nbytes)` | the cost of that many bytes leaving Archil |
| `prices.sandbox_hour_usd(vcpu, mem_mib)` | `prices.sandboxHourUsd(vcpu, memMib)` | a sandbox of that size for an hour |
| `prices.breakeven_calls_per_hour(vcpu=2, mem_mib=4096)` | `prices.breakevenCallsPerHour(vcpu?, memMib?)` | calls per hour above which a warm sandbox of that size is cheaper than per-call execution |

## Budget

A ceiling, checked before anything runs.

```py
archil.Budget(max_usd=None, max_calls=None, max_bytes_touched=None)
```

```typescript
new archil.Budget({ maxUsd, maxCalls, maxBytesTouched })
```

| Python | TypeScript | Limits |
|---|---|---|
| `budget.max_usd` | `budget.maxUsd` | the estimated total, in dollars |
| `budget.max_calls` | `budget.maxCalls` | call units |
| `budget.max_bytes_touched` | `budget.maxBytesTouched` | bytes made active |

A limit left out is not checked.

| Where | Python | TypeScript |
|---|---|---|
| on one statement | `stmt.within(max_usd=0.01)` | `stmt.within({ maxUsd: 0.01 })` |
| on a context | `ctx.with_budget(max_usd=0.05)` | `ctx.withBudget({ maxUsd: 0.05 })` |
| when opening one | `archil.context(..., budget=archil.Budget(max_usd=0.05))` | `archil.context(..., { budget: { maxUsd: 0.05 } })` |

Over the ceiling, `run()` raises `BudgetExceeded`. For a context's budget, the check is the plan's estimate plus what was spent under the budget since it was set. For a statement's own, set with `within`, it is that plan's estimate alone.

## Estimate

The predicted cost of a plan, and the shape of a ledger's total.

| Python | TypeScript | Is |
|---|---|---|
| `estimate.calls` | `estimate.calls` | how many calls |
| `estimate.call_units` | `estimate.callUnits` | calls, times the VM's multiple |
| `estimate.bytes_touched` | `estimate.bytesTouched` | bytes made active |
| `estimate.egress_bytes` | `estimate.egressBytes` | bytes leaving Archil |
| `estimate.usd_calls` | `estimate.usdCalls` | the cost of the calls |
| `estimate.usd_active` | `estimate.usdActive` | the cost of the active data |
| `estimate.usd_egress` | `estimate.usdEgress` | the cost of the egress |
| `estimate.usd` | `estimate.usd` | the three added up |
| `estimate.complete` | `estimate.complete` | `false` when sizes were unknown, because the statement declared nothing |
| `a + b` | `a.plus(b)` | two estimates added |
| `estimate.since(earlier)` | `estimate.since(earlier)` | what was added after `earlier` |
| `estimate.to_dict()` | `estimate.toJSON()` | the JSON form, with camel-case keys and money rounded to eight places |

## Ledger

The running total of what a context has sent. It is `ctx.spend`, and contexts made from one another share it.

| Python | TypeScript | Is |
|---|---|---|
| `ctx.spend.total` | `ctx.spend.total` | an `Estimate` |
| `ctx.spend.statements` | `ctx.spend.statements` | how many statements have run |
| `ctx.spend.snapshot()` | `ctx.spend.snapshot()` | a copy of the total, to compare with later |
| `str(ctx.spend)` | `String(ctx.spend)` | one line: statements, call units, active data, egress, total |

What it counts:

- **Every call,** including the checkpoints and the commits of a turn.
- **A file's bytes once,** for as long as the session keeps them active. A first touch pays for the whole window. A later one pays only for the time it adds.
- **Reads through `ctx.read`** as egress, when the caller is outside Archil.

A result's `meta.usd` and `meta.call_units` are that statement's share.

## TypeScript only

| Export | Is |
|---|---|
| `archil.fmtUsd(x)` | an amount as the printed plan writes it: `$0.00005`, `<$0.00001`, `$1.20` |
| `archil.fmtBytes(n)` | a size as the printed plan writes it: `58 B`, `1.9 KiB` |
| `archil.estimate(prices, input)` | an `Estimate` from counts: `calls`, `unitsPerCall`, `bytesTouched`, `egressBytes`, `complete` |
