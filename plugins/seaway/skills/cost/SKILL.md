---
name: cost
description: Estimate what a workload would cost on Archil from the public price sheet, or total up what a seaway journal says a context has spent and where the money went.
argument-hint: "[a workload in words, or the path of a journal]"
disable-model-invocation: true
---

# What does it cost

Two jobs, told apart by the argument. A path that holds a journal (JSON lines with `kind`, `calls`, `usd`) means: account for what was spent. Anything else is a workload to estimate. With no argument, ask which.

Every number here is an estimate from listings and public rates, not an invoice. Say so once, and say what the estimate leaves out.

## Estimating a workload

1. **Get the four quantities,** asking only for what cannot be worked out:
   - how much data arrives per day, and how long it is kept;
   - which statements run on a schedule, how often, and how much data each reads;
   - what runs on demand, roughly how often, and over how much data;
   - any statement that needs a VM above 2 vCPU and 4 GiB.

2. **Take the rates from the SDK,** so that they are the ones the plans use. In a project where seaway imports, print them; otherwise use the figures in the `seaway:sdk` skill's `plans-and-prices.md`, and say they were read in November 2026.

   ```python
   import seaway as archil
   p = archil.PriceSheet()
   print(p.as_of, p.call_usd, p.active_gib_month_usd, p.archive_gb_month_usd, p.egress_gb_usd, p.breakeven_calls_per_hour())
   ```

3. **Work out the three terms,** and show the arithmetic.
   - *Archive:* GiB retained × 1.0737 × the archive rate per GB-month.
   - *Active data:* GiB kept warm at any moment × the active rate per GiB-month. Data is active for about an hour after it is last read or written. A statement that reads the last hour of an hourly log every few minutes keeps two to three hours of it warm. A one-off scan of N GiB costs N × the active rate ÷ 730.
   - *Calls:* call units in a month × the call rate. A larger VM multiplies the units by the larger of vCPU ÷ 2 and memory ÷ 4 GiB, rounded up.
   - *Egress,* only if results leave Archil in bulk: GB × the egress rate. A statement's output is all that crosses, so this is usually nothing.

4. **Present** a small table per month: archive, active, calls, total. Then the assumptions, and what would change the answer most. Usually the archive is nearly all of it.

5. **Say what would make it cheaper,** if anything would: declared paths, hourly partitions, `ctx.grep` for searches, `batch` for small statements run together, a view for a report that is asked for more often than it changes, a feed in place of a scheduled scan. If the workload wants more than about 3,800 calls an hour sustained, say that a warm sandbox would be cheaper and that seaway does not make those.

Where real statements exist, prefer their plans to arithmetic: `explain()` on a local backend, or on Archil for real sizes if the user asks. A plan prices a statement as if nothing were warm, so a recurring statement's true cost is its calls plus its share of what it keeps active.

## Accounting for a journal

A journal has one line per statement, with `kind`, `plan`, `statement`, `reads`, `writes`, `calls`, `callUnits`, `usd`, `ms` and `exit`, and lines for each `commit`, `rollback` and `sync`.

1. For a long journal, hand it to the `seaway:cost-analyst` agent with the path and the period that matters. For a short one, read it yourself:

   ```bash
   cat <journal>/*/*.ndjson | jq -s 'map(select(.usd != null)) | group_by(.kind) | map({kind: .[0].kind, statements: length, calls: (map(.calls) | add), usd: (map(.usd) | add)})'
   cat <journal>/*/*.ndjson | jq -s 'map(select(.usd != null)) | group_by(.statement) | map({statement: .[0].statement, runs: length, usd: (map(.usd) | add)}) | sort_by(-.usd) | .[:10]'
   ```

2. Report the total, the split by kind, the ten statements that cost most, and what failed (`exit` not 0) or was rolled back and paid for anyway.

3. Name what the lines themselves show could be saved: statements with empty `reads` (they declared nothing, so they mounted everything and were priced without sizes), a `grep` or `rg` run through `sh`, the same statement run many times over inputs that did not change, many one-call statements in quick succession.

What a journal does not hold: direct reads and writes, the cost of checkpoints (a turn's begin), and the archive. The context's ledger, `ctx.spend`, has the first two for a live session.
