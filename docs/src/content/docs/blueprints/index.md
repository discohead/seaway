---
title: Designing on seaway
description: On seaway, software is folders on disks, and statements that ask questions of them. A method for choosing disks, modes and layout, and eight worked designs to start from.
sidebar:
  label: Designing on seaway
---

On seaway, software is folders on disks: a context that says which disks and under what rules, and statements that ask questions of them. Nothing runs between questions. A design is therefore mostly three decisions: where the disk boundaries are, how the files are laid out, and which statements run when.

## Blueprints

Each is a complete program that runs on an empty local backend, in both languages, with its context, its layout and what to watch.

:::cards
- [An agent's context](/blueprints/agent-context/) Skills, reference data, its own memory, shared notes and an audit log: five disks under five rules.
- [Observability on a disk](/blueprints/observability/) Ingest, triage, search, a report and an alert, with nothing running between questions.
- [A mirror of a system of record](/blueprints/mirror/) A job that syncs a tracker into files, and readers that mount the result.
- [Several attempts, and adopting one](/blueprints/attempts/) A fork per attempt, a score, and a turn that copies the winner.
- [A helper that is handed less](/blueprints/helper/) A narrowed context, no network, a budget, and a journal it cannot rewrite.
- [A run that can be replayed](/blueprints/replay/) A lock, and a scratch disk for the results: an eval harness.
- [Records many agents edit](/blueprints/shared-records/) A file per record, an edit that retries on conflict, and an index kept as a view.
- [Work that starts from a change](/blueprints/change-driven/) A feed, a statement and a cursor, on any schedule.
:::

## The method

Work through these in order, and write the decisions down as you go.

### 1. Name the data and who writes it

List every kind of data the thing needs. For each: who writes it, how often, and whether it is ever changed in place or only added to. That is what chooses the [mode](/guides/modes/).

| The data is… | Mode | Why |
|---|---|---|
| written by this agent or app alone | `owned` | writes take a checkout: fast, and a second writer waits its turn |
| written by several agents or people | `shared` | no checkout; last write wins, so give each writer its own paths, or use turns |
| only ever added to: logs, audit trails, events | `append` | nothing can rewrite it; many writers can append at once |
| maintained by someone else and wanted live | `read` | this context cannot change it |
| wanted exactly as it was at a known point | `frozen`, at a checkpoint | every run sees the same bytes |

### 2. Draw the disk boundaries

A disk is the unit of mode, of checkpoint and fork, and of an `owned` mount's checkout. A directory is the unit of narrowing.

- **One disk per owner and mutation strategy.** What one agent owns, what many write, and what is only appended are three disks, not three directories of one.
- **Split what has different readers.** A helper is given a narrowed context, and narrowing is by directory. If two things should never be handed over together, different directories at least, and different disks if their modes differ.
- **Split what is pinned from what is live.** Skills, prompts and reference data that an eval should hold still go on a disk that can be frozen at a release.
- **Keep the journal where a failed turn should leave it.** A journal on an `append` disk records at once and survives a rollback.
- **Do not split what one statement always reads together** without a reason: each disk a statement names is one more mount.

Mount names are the paths everyone will type. Make them short nouns: `logs`, `memory`, `team`, `skills`, `audit`.

### 3. Lay the files out for the questions

Storage is cheap and listings are free. What costs money is calls, and the bytes a call makes active. So lay files out so that a question touches little.

- **Logs: a directory per hour, a file per writer.** [`ctx.log`](/guides/logs/) does this.
- **Records edited one at a time: a file each.** Markdown with front matter, or JSON. Two writers then conflict only when they change the same record.
- **Records scanned together: fewer, larger files,** by day or by batch, in JSON lines or Parquet.
- **State looked up by key and updated in place:** a [SQLite](/guides/sqlite/) file on an `owned` disk.
- **Derived things in their own directory** (`reports/`, `index/`), so they can be handed out read-only and rebuilt freely.
- **A README in every directory that has a layout.** It is the schema, for a reader that has only `ls` and `cat`.

### 4. Write the questions as statements

For each question the thing has to answer, choose the cheapest route that answers it.

| The question | Route | Cost |
|---|---|---|
| "what is in this file?", "what files are here?" | `read`, `ls` | no compute |
| "where does this pattern occur?" | [`ctx.grep`](/guides/grep/) | one call per disk, whatever the file count |
| "how many, grouped by, joined with" | [`ctx.sql`](/guides/sql/) over paths, globs or log selections | one call |
| anything bash can do with a few files | `ctx.sh` with declared paths | one call |
| several small things at once | [`ctx.batch`](/guides/batch-and-map/) | one call for all of them |
| one pipeline over a great many files | `ctx.sh(...).map(reduce=...)` | one call per shard |
| "has anything changed since I last looked?" | a [feed](/guides/feeds/)'s `poll()` | a listing: no call |
| a report or an index someone will read again | a [view](/guides/views/) | a call only when its inputs changed |

Every statement names what it touches as parameters. A design in which statements mount everything has not finished step 3.

### 5. Decide what lands together

Group writes into [turns](/guides/turns/) where a half-applied change would be wrong: a record and its index entry, a note and the memory of having written it. Name the disks each turn writes. Expect conflicts to be rare, and handle them by running the turn again. Keep external side effects to the end of a turn, or make them safe to repeat.

### 6. Decide what each actor may reach

For every model, sub-agent or tool call that will be handed part of this:

- the sub-trees it needs, and no more: [`narrow`](/guides/narrowing/), read-only unless it must write;
- the network: `with_egress("deny")` unless its commands need it, then a list of hosts;
- a ceiling: `with_budget(max_usd=...)`;
- a record: its statements are journalled only if the context it is given can still append to the journal;
- for attempts that should not see each other, a `fork` each; for a run that must be repeatable, a `lock`.

### 7. Price it

Three terms, from the [public price sheet](/guides/prices/):

- **Calls.** Count the statements per day. A check every five minutes is 8,640 calls a month, about $0.43.
- **Active data.** The bytes read or written in the last hour. What matters is how much the recurring statements keep warm, which is what step 3 controls.
- **Archive.** Everything stored. For most designs this is nearly the whole bill.

Then check the estimate against real plans: build the statements on a local backend and read `explain()`.

### 8. Write it down

Produce three things: the context, as code and as a [manifest](/guides/manifests/); the layout, with the README text for each directory; and a first script that opens the context on a local backend, seeds a little data, runs the main statements and prints their plans.

## Checks before calling it done

- Does every disk have exactly one answer to "who writes this"?
- Could two writers ever change the same path? If so, is that a turn, or a layout mistake?
- Does every recurring statement declare its paths, and does its plan mount only what it needs?
- What do the recurring statements keep warm, in GiB? Is that the smallest it could be?
- What can each model or helper read, write, reach on the network, and spend?
- If a turn fails half-way, what is left behind, and does anything outside the context need undoing?
- Can someone with only `ls` and `cat` find their way around each disk?
- What is left behind on Archil? Every turn, fork and lock leaves a branch or a checkpoint that cannot be deleted without deleting the disk.
