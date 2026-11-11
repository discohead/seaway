# Plans and prices

A plan is what a statement will do, written down before it does it. `explain()` returns one and runs nothing: it costs a listing, and listings are free.

## Contents

- [Reading a plan](#reading-a-plan)
- [The notes a plan can carry](#the-notes-a-plan-can-carry)
- [A plan as data](#a-plan-as-data)
- [The price sheet](#the-price-sheet)
- [Estimates, the ledger and budgets](#estimates-the-ledger-and-budgets)
- [Designing for the meters](#designing-for-the-meters)
- [What a workload costs in a month](#what-a-workload-costs-in-a-month)

## Reading a plan

```python
triage = ctx.sh(
    "cat {files} | jq -r 'select(.level == \"ERROR\") | .path' | sort | uniq -c",
    files=ctx.glob("logs/**/*.ndjson"),
).map(reduce="sum_by_key", shards=4)
plan = triage.explain()
print(plan)                                  # the text below
print(plan.estimate.usd, plan.estimate.calls, plan.hash, plan.notes)
```

```ts
const triage = ctx.sh`cat ${ctx.glob("logs/**/*.ndjson")} | jq -r 'select(.level == "ERROR") | .path' | sort | uniq -c`
  .map({ reduce: "sum_by_key", shards: 4 });
const plan = await triage.explain();
console.log(String(plan));
console.log(plan.estimate.usd, plan.estimate.calls, plan.hash, plan.notes);
```

```text
plan b2e6d58c12b9  sh · 10 file(s), 2.8 KiB · 4 calls, combined by sum_by_key
  route   exec · 2 vCPU / 4 GiB · up to 4 at once
  scope   logs → app-logs (read-only)
          not mounted: docs, memory, team
  reads   logs/**/*.ndjson
  writes  —
  price   4 call units $0.00020 + 2.8 KiB active for an hour <$0.00001 ≈ $0.00020
```

The figures are from a small log. The file count and the hash follow the files that exist when the plan is compiled, so they change as a log grows.

| Line | What it answers |
|---|---|
| the first | the plan's hash, the statement's kind, how many files and bytes it reads, how many calls, and the reducer when there is more than one call |
| `route` | how the work reaches the data. `exec` is a serverless call, with its VM size, custom image, network policy and how many run at once. `grep` is the native search: one call per disk |
| `scope` | every disk the call can see, as `path in the VM → disk:/subdirectory (how)`. `how` is `read-only`, `read-write, checkout /` (an `owned` mount) or `read-write, conditional` (a `shared` one). `not mounted:` lists the context's other mounts |
| `reads`, `writes` | what the statement declared. `— (not declared)` means it declared nothing |
| `price` | call units and their cost, plus the bytes it would make active for an hour and theirs. `(input size unknown)` means nothing was declared, so only the calls are priced |
| `note` | advice; see below |

`scope` is the line to read for safety. If a disk is not on it, the command cannot see that disk at all. If a mount says `read-only`, the command cannot change it.

## The notes a plan can carry

| Note | What to do |
|---|---|
| `no paths declared, so all N mount(s) are attached; pass paths as parameters to mount only what the command needs` | declare the paths with `ctx.path`, `ctx.glob`, `ctx.out` |
| `N files in one call; .map() would spread this over about M calls` | the input is over 256 MiB or 2,000 files: add `.map(reduce=...)` if the command can be split |
| `parallel calls writing to an 'owned' mount queue for its checkout; a 'shared' mount lets them write at once` | map `into` a `shared` mount |
| `this VM size bills as N calls each` | check the larger VM is worth it |
| `a plain regex search is one call per disk with ctx.grep(), however many files` | use `ctx.grep` instead of `rg`/`grep` in `sh` |
| `the caller is outside Archil: only stdout crosses the network, not the files` | nothing: a reminder that large output should go `into()` a file |
| `no input files for X: nothing to run, zero rows returned` | the path or selection matched nothing: check it |
| `N statements in one call instead of N` | nothing: what the batch saved |

## A plan as data

`plan.to_dict()` in Python and `JSON.stringify(plan)` in TypeScript give the same document. This is the plan above, with the first of its four tasks shown. Money in it is rounded to eight places.

```json
{
  "plan": 0,
  "hash": "b2e6d58c12b9",
  "kind": "sh",
  "route": "exec",
  "statement": "cat {files} | jq -r 'select(.level == \"ERROR\") | .path' | sort | uniq -c",
  "vm": { "vcpuCount": 2, "memSizeMib": 4096 },
  "parallel": 64,
  "reduce": "sum_by_key",
  "effects": { "reads": ["logs/**/*.ndjson"], "writes": [] },
  "tasks": [
    { "command": "cat logs/2026-11-09/13/search-a.ndjson logs/2026-11-09/14/checkout-a.ndjson | jq -r 'select(.level == \"ERROR\") | .path' | sort | uniq -c",
      "disks": { "logs": { "disk": "app-logs", "readOnly": true, "conditional": false } } }
  ],
  "estimate": { "calls": 4, "callUnits": 4, "bytesTouched": 2822, "egressBytes": 0,
                "usd": 0.0002, "usdCalls": 0.0002, "usdActive": 0, "usdEgress": 0, "complete": true },
  "notes": []
}
```

- Each task is nearly the body of a request to Archil's exec endpoint: a command and a `disks` map. `vm` can also carry `baseImage` and `network`.
- `hash` is the first 12 hex characters of the SHA-256 of `{kind, statement, vm, reduce, tasks}` as JSON with sorted keys and no spaces. It covers what a plan does and not what it costs, so it survives a price change. Written with named parameters, a statement gets the same hash from both SDKs.
- A plan compiled now reflects the files that exist now: a glob is expanded and sizes are read when `explain()` or `run()` is called. `run()` compiles again, so the plan that ran is `result.plan`.
- On the object: `plan.hash`, `plan.kind`, `plan.route`, `plan.tasks`, `plan.reads`, `plan.writes`, `plan.unmounted`, `plan.files`, `plan.notes`, `plan.estimate`.

## The price sheet

The numbers are Archil's public price sheet as read in November 2026. They live in `PriceSheet`, and every one can be overridden.

| Meter | Rate | Field |
|---|---|---|
| A serverless call (exec or grep) at 2 vCPU / 4 GiB | $0.05 per thousand: $0.00005 | `call_usd` |
| Active data: bytes read or written in about the last hour | $0.20 per GiB-month | `active_gib_month_usd`, `active_window_hours` |
| Archive: everything stored | $0.025 per GB-month | `archive_gb_month_usd` |
| Egress: bytes leaving Archil | $0.07 per GB; nothing inside Archil | `egress_gb_usd` |
| A sandbox kept running | $0.055 per vCPU-hour and $0.020 per GiB-hour | `sandbox_vcpu_hour_usd`, `sandbox_gib_hour_usd` |

A statement can move three of them: calls, active data and egress. Listings move none.

```python
prices = ctx.prices
print(prices.call_units(8, 16384))             # 4: a larger VM bills as the larger of its vCPU and memory multiples
print(prices.active_usd(50 * 1024**3))         # 0.0137: making 50 GiB active for an hour
print(prices.sandbox_hour_usd(2, 4096))        # 0.19: a 2 vCPU / 4 GiB sandbox for an hour
print(prices.breakeven_calls_per_hour())       # 3800: above this, a warm sandbox of that size is cheaper than calls

custom = archil.context({"docs": "handbook"}, backend=backend, prices=archil.PriceSheet(call_usd=0.00004))
```

```ts
const prices = ctx.prices;
console.log(prices.callUnits(8, 16384), prices.activeUsd(50 * 1024 ** 3), prices.sandboxHourUsd(2, 4096), prices.breakevenCallsPerHour());

const custom = await archil.context({ docs: "handbook" }, { backend, prices: new archil.PriceSheet({ callUsd: 0.00004 }) });
```

## Estimates, the ledger and budgets

- **A plan's estimate** prices the statement on its own, as if nothing were warm: every call, and every byte it reads as newly active for an hour. Sizes come from a listing. It is `complete: false` when the statement declares nothing.
- **The ledger**, `ctx.spend`, counts what the context actually sent: every call, including the checkpoints and commits of a turn, and a file's bytes once for as long as the session keeps them active. A second statement over the same files within the hour adds only the time it extends them. Reads through `ctx.read` count as egress when the caller is outside Archil. Contexts derived from one another share one ledger.
- **A result's** `meta.usd` and `meta.call_units` are that statement's share.
- **A budget** is checked against the plan's estimate plus what was spent under the budget, before anything runs. See [contexts.md](contexts.md#spend-budgets-and-the-ledger).

```python
before = ctx.spend.snapshot()
ctx.sh("cat {f} | wc -c", f=ctx.glob("docs/**/*.md")).run()
ctx.sh("cat {f} | wc -l", f=ctx.glob("docs/**/*.md")).run()      # the same files: no new active bytes
spent = ctx.spend.snapshot().since(before)
print(spent.calls, spent.bytes_touched, round(spent.usd, 6))
print(ctx.spend)    # 2 statement(s): 2 call unit(s) $0.00010, 174 B kept active <$0.00001, 0 B egress $0; total ≈ $0.00010
```

These are estimates, not invoices. They come from listings and public rates. Estimates for `grep` ignore `globs`, so they run high.

## Designing for the meters

A statement should move the meters as little as it can. Because the meters are simple, the rules are few.

| Rule | Meter it saves | How |
|---|---|---|
| Do not use compute to move bytes | calls | `read`, `write`, `append`, `ls`, `exists`, `rm` go straight to the object API |
| Send the question to the data | egress | a statement returns its result; `into()` keeps a large output on the disk and returns its path |
| One search is one call | calls | `ctx.grep` is one call per disk, whatever the fan-out |
| Touch only what the question needs | active data | declare paths; partition logs by hour so a selection reads only the partitions in range |
| Many small questions, one call | calls | `ctx.batch([...])` |
| Do not rebuild what has not changed | calls, active data | a view fingerprints its inputs from a listing and skips the build |
| Do not poll with compute | calls | a feed compares listings; an idle poll makes no call and reads no data |
| Do not copy to isolate | active data, archive | forks, locks and turns are branches |
| Do not keep a machine warm | sandbox hours | nothing in seaway creates a sandbox; per-call execution is cheaper below about 3,800 calls an hour |
| Do not buy a bigger VM by reflex | calls | `sized()` multiplies the price of every call it applies to |

## What a workload costs in a month

For a rough monthly figure, add three terms. All of it follows from the sheet; none of it is measured.

- **Archive:** GiB retained × 1.0737 (GiB to GB) × $0.025.
- **Active:** GiB kept warm at any moment × $0.20. A job that reads the last hour of a log every five minutes keeps about two to three hours of it warm.
- **Calls:** call units in the month × $0.00005. Every five minutes is 8,640 calls, which is $0.43.

Thirty days of logs at 5 GiB a day is 150 GiB retained, about $4.03 of archive. A triage every five minutes that keeps two and three-quarter hours warm adds about $0.11 of active data and $0.43 of calls: roughly $4.60 a month. At 50 GiB a day the same shape is about $42, nearly all of it archive. An investigation that greps a whole 50 GiB day makes it active for an hour, which is a little over a cent.

```python
p = archil.PriceSheet()
gib_per_day, days, warm_hours, calls = 5, 30, 2.75, 30 * 24 * 12
archive = gib_per_day * days * (1024**3 / 1000**3) * p.archive_gb_month_usd
active = gib_per_day / 24 * warm_hours * p.active_gib_month_usd
print(round(archive, 2), round(active, 2), round(calls * p.call_usd, 2))      # 4.03 0.11 0.43
```
