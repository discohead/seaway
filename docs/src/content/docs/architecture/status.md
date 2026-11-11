---
title: Status and known limits
description: What runs today, what was found when both SDKs were run against a live Archil account, what is known to be imperfect, and what is not built.
sidebar:
  label: Status and limits
---

seaway is an unofficial prototype of a proposal, at version 0.1.0, released under the [MIT licence](https://github.com/discohead/seaway/blob/main/LICENSE). This page says plainly what is real.

## It runs today

Both SDKs run on a local backend that executes the same plans with real bash, and uses directory copies for checkpoints and branches. The Python tests, the TypeScript tests, the conformance fixture and the interop check all pass, on Linux and on macOS.

## The two SDKs are one framework

A shared fixture of 33 statements has to compile to identical plans, hashes and printed text in both languages. A second check has one SDK build logs, a view, a feed cursor, recipes and a transaction on a disk, then has the other open the same disk and find everything as it would have left it. Then it swaps them. See [Two SDKs, one framework](/architecture/two-sdks/).

## It has been run against Archil

On 9 November 2026 both SDKs were run against a live account (aws-us-west-2, Developer plan): the three examples in each language, the cross-SDK check on live disks, and tests aimed at each mount mode, at contention, and at each failure listed below.

The backend was written on three assumptions. Two held, and one did not.

| Assumption | Held? | What was found |
|---|---|---|
| `archil checkpoints create` works from inside a serverless exec | yes | it is one call and takes about a fifth of a second, and a branch can be made from the checkpoint straight after |
| A branch's `filesystem_id` is an ordinary disk id | yes | it mounts in an exec and reads through the object API |
| DuckDB is in the exec image | **no** | `ctx.sql` needs the binary on a disk, and the SDK has a recipe that puts it there |

### What else the run found

And what the SDKs now do about it:

- **An exec runs its command with `/bin/sh`.** Statements are handed to bash, so an `sh` statement means the same thing on both backends.
- **An ETag does not change when a file is rewritten in place through a mount.** Versions on Archil therefore carry the modification time too, and the SDKs do not trust a version that is under about a second and a half old. See [Versions and clocks](/architecture/versions/).
- **While a statement holds an `owned` disk's checkout, a direct write on that disk is refused.** That is a `Busy` error, and a journal on that disk keeps the entries it could not write.
- **Search takes a directory, not a file.** Output is cut at 4 MiB a stream and keeps the first bytes. The local backend does both the same way.
- **A SQLite read on a read-only mount is not isolated from a write made by another call.** With a writer busy on a large table, 49 of 81 reads failed. A read that names the database as an output takes the checkout as a writer would, and all 23 reads made that way succeeded. See [State in SQLite](/guides/sqlite/).

## Known limits

### Turns

- **A commit is not atomic across files,** and on Archil there is a window between checking for conflicts and copying. Both need a native merge.
- **Every turn leaves a branch and a checkpoint behind,** on each disk it could write. Archil cannot delete either except by deleting the disk. The same goes for a fork. A lock leaves a checkpoint on every mount that was not already frozen, and opening a `frozen` mount makes a branch the first time.

### Versions

- **Versions on Archil rest on a clock.** If the caller's clock is more than half a second off Archil's, a file rewritten in place, at the same size, within a second of its last change can still go unnoticed.

### Scope

- **A statement that writes gets its whole disk mounted** in the disk's mode, not just the directory it writes. Only reads are narrowed to a directory.
- **Narrowing is enforced by the mount map inside a call.** For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk.
- **An egress policy is enforced by Archil.** The local backend can only cut the network entirely, and only in a namespace.

### Python

- **In Python an `owned` mount cannot be written from a custom image.** The Python client cannot ask for a checkout on the mount, so the command takes it with the `archil` CLI, and only Archil's own exec image has that. Use `shared`, or the TypeScript SDK.

### Views and feeds

- **A view's definition is not stored on the disk,** only its output and a fingerprint. To rebuild a view you need the code that defined it.
- **A feed is a poll.** A view's freshness check and a feed's poll list the whole path each time.

### Prices

- **Prices are estimates from listings and public rates, not invoices,** and they have not been compared with one: the billing API is not available in every region.
- The ledger counts every call, a checkpoint included, and counts a file's bytes once while this session keeps them warm.
- Estimates for `grep` ignore `globs`, so they run high.

## Not built

- services and sandboxes;
- a server-side planner;
- caching by plan hash;
- inferred reducers;
- a command-line tool.

## Not there yet

- **Packages on a registry.** seaway is not on PyPI or npm. It installs [from GitHub or from a checkout](/start/installation/).

## Where to report something

Open an issue or a pull request at [github.com/discohead/seaway](https://github.com/discohead/seaway). Say what changed in behaviour, and whether it touches a plan, an error code or a file on disk.

## Next

:::cards
- [What it asks of the platform](/architecture/platform/) What would remove most of these limits.
- [Run on Archil](/guides/archil/) What to know before a live run.
:::
