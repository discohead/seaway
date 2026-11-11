---
title: Prices and budgets
description: Every plan carries a price, worked out from Archil's public price sheet. What the three meters are, what an estimate and the ledger count, how to set a budget, and what a workload costs in a month.
---

A statement on Archil can move three meters: calls, active data and egress. seaway prices every plan on the first two before it runs, and keeps a ledger of what a context has sent, egress included. On the local backend nothing is billed, and the same figures show what Archil would charge.

::example-context

## The price sheet

The numbers are Archil's [public price sheet](https://archil.com/pricing) as read in November 2026. They live in `PriceSheet`, and every one can be overridden.

| Meter | Rate | `PriceSheet` field |
|---|---|---|
| A serverless call (exec or grep) at 2 vCPU / 4 GiB | $0.05 per thousand: $0.00005 | `call_usd` |
| Active data: bytes read or written in about the last hour | $0.20 per GiB-month | `active_gib_month_usd`, `active_window_hours` |
| Archive: everything stored | $0.025 per GB-month | `archive_gb_month_usd` |
| Egress: bytes leaving Archil | $0.07 per GB; nothing inside Archil | `egress_gb_usd` |
| A sandbox kept running | $0.055 per vCPU-hour and $0.020 per GiB-hour | `sandbox_vcpu_hour_usd`, `sandbox_gib_hour_usd` |

A statement can move the first, the second and the fourth. Listings move none.

```python
prices = ctx.prices
# a larger VM bills as the larger of its vCPU and memory multiples
print(prices.call_units(8, 16384))
# making 50 GiB active for an hour
print(round(prices.active_usd(50 * 1024**3), 4))
# a 2 vCPU / 4 GiB sandbox for an hour
print(round(prices.sandbox_hour_usd(2, 4096), 2))
# above this, a warm sandbox of that size is cheaper than calls
print(prices.breakeven_calls_per_hour())

custom = archil.context(
    {"docs": "handbook"},
    backend=backend,
    prices=archil.PriceSheet(call_usd=0.00004),
)
print(custom.prices.call_usd)
```

```ts
const prices = ctx.prices;
// a larger VM bills as the larger of its vCPU and memory multiples
console.log(prices.callUnits(8, 16384));
// making 50 GiB active for an hour
console.log(prices.activeUsd(50 * 1024 ** 3).toFixed(4));
// a 2 vCPU / 4 GiB sandbox for an hour
console.log(prices.sandboxHourUsd(2, 4096).toFixed(2));
// above this, a warm sandbox of that size is cheaper than calls
console.log(prices.breakevenCallsPerHour());

const custom = await archil.context(
  { docs: "handbook" },
  { backend, prices: new archil.PriceSheet({ callUsd: 0.00004 }) },
);
console.log(custom.prices.callUsd);
```

```text output
4
0.0137
0.19
3800
4e-05
```

## Three numbers, three meanings

- **A plan's estimate** prices the statement on its own, as if nothing were warm: every call, and every byte it reads as newly active for an hour. Sizes come from a listing. It is `complete: false` when the statement declares nothing.
- **The ledger**, `ctx.spend`, counts what the context actually sent.
- **A result's** `meta.usd` and `meta.call_units` are that statement's share of the ledger.

The ledger counts every call, including the checkpoints and commits of a turn. It counts a file's bytes once for as long as the session keeps them active: a second statement over the same files within the hour adds only the time it extends them. Reads through `ctx.read` count as egress when the caller is outside Archil. Contexts derived from one another share one ledger.

```python
before = ctx.spend.snapshot()
ctx.sh("cat {f} | wc -c", f=ctx.glob("docs/**/*.md")).run()
# the same files: no new active bytes
ctx.sh("cat {f} | wc -l", f=ctx.glob("docs/**/*.md")).run()
spent = ctx.spend.snapshot().since(before)

print(spent.calls, spent.bytes_touched, round(spent.usd, 6))
print(ctx.spend)
```

```ts
const before = ctx.spend.snapshot();
await ctx.sh`cat ${ctx.glob("docs/**/*.md")} | wc -c`.run();
// the same files: no new active bytes
await ctx.sh`cat ${ctx.glob("docs/**/*.md")} | wc -l`.run();
const spent = ctx.spend.snapshot().since(before);

console.log(spent.calls, spent.bytesTouched, spent.usd.toFixed(6));
console.log(String(ctx.spend));
```

```text output
2 174 0.0001
2 statement(s): 2 call unit(s) $0.00010, 174 B kept active <$0.00001, 0 B egress $0; total ≈ $0.00010
```

:::note[These are estimates, not invoices]
They come from listings and public rates, and they have not been compared with a bill. Estimates for `grep` ignore `globs`, so they run high.
:::

## Budgets

Since every plan carries a price, a budget is enforced before anything runs. A budget has three limits, each optional: `max_usd`, `max_calls` (counted in call units) and `max_bytes_touched`.

```python
# a ceiling for one statement
one = ctx.sh("ls").within(max_usd=0.001, max_calls=1)
# a ceiling for everything a context runs
capped = ctx.with_budget(max_usd=0.05)

try:
    ctx.sh("ls").within(max_calls=0).run()
except archil.BudgetExceeded as e:
    # nothing was sent
    print(e.code)
```

```ts
// a ceiling for one statement
const one = ctx.sh`ls`.within({ maxUsd: 0.001, maxCalls: 1 });
// a ceiling for everything a context runs
const capped = ctx.withBudget({ maxUsd: 0.05 });

try {
  await ctx.sh`ls`.within({ maxCalls: 0 }).run();
} catch (e) {
  if (!(e instanceof archil.BudgetExceeded)) throw e;
  // nothing was sent
  console.log(e.code);
}
```

```text output
budget_exceeded
```

A statement's own ceiling is checked against its plan's estimate. A context's is checked against the estimate plus what was spent under the budget. `explain()` is not affected: a plan can always be read. [Limit reach, network and spend](/guides/narrowing/#spend) has the rest, including how a budget counts from the moment it is set.

## Designing for the meters

A statement should move the meters as little as it can. Because the meters are simple, the rules are few.

| Rule | Meter it saves | How |
|---|---|---|
| Don't use compute to move bytes | calls | `read`, `write`, `append`, `ls`, `exists` and `rm` go straight to the object API |
| Send the question to the data | egress | a statement returns its result; `into()` keeps a large output on the disk and returns its path |
| One search is one call | calls | `ctx.grep` is one call per disk, whatever the fan-out |
| Touch only what the question needs | active data | declare paths; partition logs by hour, so a selection reads only the partitions in range |
| Many small questions, one call | calls | `ctx.batch([...])` |
| Don't rebuild what hasn't changed | calls, active data | a view fingerprints its inputs from a listing and skips the build |
| Don't poll with compute | calls | a feed compares listings; an idle poll makes no call and reads none of the data it watches |
| Don't copy to isolate | active data, archive | forks, locks and turns are branches |
| Don't keep a machine warm | sandbox hours | nothing in seaway creates a sandbox; per-call execution is cheaper below about 3,800 calls an hour |
| Don't buy a bigger VM by reflex | calls | `sized()` multiplies the price of every call it applies to |

There is a second reason to design this hard for these meters. Software built this way, with nothing running between questions, questions sent to the data, and layouts chosen so that a question touches little, is cheap on Archil. On a platform that bills for idle compute or for reads, it is expensive or doesn't work at all.

## What a workload costs in a month

For a rough monthly figure, add three terms. All of it follows from the sheet. None of it is measured.

- **Archive:** GiB retained × 1.0737 (GiB to GB) × $0.025.
- **Active:** GiB kept warm at any moment × $0.20. A job that reads the last hour of a log every five minutes keeps about two to three hours of it warm.
- **Calls:** call units in the month × $0.00005. Every five minutes is 8,640 calls, which is $0.43.

```python
p = archil.PriceSheet()
gib_per_day, days, warm_hours, calls = 5, 30, 2.75, 30 * 24 * 12

archive = gib_per_day * days * (1024**3 / 1000**3) * p.archive_gb_month_usd
active = gib_per_day / 24 * warm_hours * p.active_gib_month_usd
print(round(archive, 2), round(active, 2), round(calls * p.call_usd, 2))
```

```ts
const p = new archil.PriceSheet();
const [gibPerDay, days, warmHours, calls] = [5, 30, 2.75, 30 * 24 * 12];

const archive = gibPerDay * days * (1024 ** 3 / 1000 ** 3) * p.archiveGbMonthUsd;
const active = (gibPerDay / 24) * warmHours * p.activeGibMonthUsd;
console.log(archive.toFixed(2), active.toFixed(2), (calls * p.callUsd).toFixed(2));
```

```text output
4.03 0.11 0.43
```

Here is that arithmetic at two sizes: thirty days of logs retained on a managed disk, with a triage every five minutes.

| Per month | 5 GiB of logs a day | 50 GiB a day |
|---|---|---|
| Archive, 30 days retained | $4.03 | $40.27 |
| Active data (the triage keeps two to three hours of logs warm) | $0.11 | $1.15 |
| Triage, 8,640 calls | $0.43 | $0.43 |
| Total | about $4.60 | about $42 |

Most of the bill is the archive rate. An investigation that greps a whole 50 GiB day makes it active for an hour, which is a little over a cent.

## Next

:::cards
- [Read a plan](/guides/plans/) Where the price line sits, and what each note costs.
- [Observability on a disk](/blueprints/observability/) The workload priced above, as a design.
- [Pricing reference](/reference/pricing/) `PriceSheet`, `Budget`, `Estimate` and `Ledger`.
:::
