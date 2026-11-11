---
name: design
description: Design the context and file layout for an agent or an app on seaway and Archil. Decides which disks there are and which mode each is mounted in, how the data is laid out, which statements, views and feeds answer the questions, what a helper may reach, and what it will cost. Produces a context, a layout note and a first script.
when_to_use: Use when someone wants to build something on seaway or Archil (agent memory, observability on a disk, a mirror of a tracker or CRM, a swarm of agents, an eval harness, a knowledge base, keyed state), asks which disks or mount modes to use, how to lay data out, or what it would cost to run. Use it before writing the code; the seaway:sdk skill covers writing it.
argument-hint: "[what to build]"
---

# Designing on seaway

On seaway, software is folders on disks: a context that says which disks and under what rules, and statements that ask questions of them. Nothing runs between questions. A design is therefore mostly three decisions: where the disk boundaries are, how the files are laid out, and which statements run when.

Work through the steps in order and write the decisions down as you go. If what is wanted is not clear enough to answer step 1, ask. Ask about the data and who writes it, not about seaway.

## 1. Name the data and who writes it

List every kind of data the thing needs. For each: who writes it, how often, and whether it is ever changed in place or only added to. That is what chooses the mode.

| The data is… | Mode | Why |
|---|---|---|
| written by this agent or app alone | `owned` | writes take a checkout: fast, and a second writer waits its turn |
| written by several agents or people | `shared` | no checkout; last write wins, so give each writer its own paths, or use turns |
| only ever added to: logs, audit trails, events | `append` | nothing can rewrite it; many writers can append at once |
| maintained by someone else and wanted live | `read` | this context cannot change it |
| wanted exactly as it was at a known point | `frozen`, at a checkpoint | every run sees the same bytes |

## 2. Draw the disk boundaries

A disk is the unit of mode, of checkpoint and fork, and of an `owned` mount's checkout. A directory is the unit of narrowing. So:

- **One disk per owner and mutation strategy.** What one agent owns, what many write and what is only appended are three disks, not three directories of one.
- **Split what has different readers.** A helper is given a narrowed context, and narrowing is by directory. If two things should never be handed over together, different directories at least, different disks if their modes differ.
- **Split what is pinned from what is live.** Skills, prompts and reference data that an eval should hold still go on a disk that can be frozen at a release.
- **Keep the journal where a failed turn should leave it.** A journal on an `append` disk records at once and survives a rollback. One on a disk the turn writes lands with the commit, and vanishes with a rollback, and a turn that names its `writes` then has to name the journal's directory too.
- **Do not split what one statement always reads together** without a reason: each disk a statement names is one more mount.

Mount names are the paths everyone will type. Make them short nouns: `logs`, `memory`, `team`, `skills`, `audit`.

## 3. Lay the files out for the questions

Storage is cheap and listings are free. What costs money is calls and the bytes a call makes active. So lay files out so that a question touches little.

- **Logs: a directory per hour, a file per writer.** `ctx.log(...)` does this. A question about the last fifteen minutes then touches one hour, and no two writers contend for a file.
- **Records edited one at a time: a file each.** Markdown with front matter, or JSON. Two writers then conflict only when they change the same record, because a turn's unit of conflict is the path.
- **Records scanned together: fewer, larger files,** by day or by batch, in JSON lines or Parquet.
- **State looked up by key and updated in place:** a SQLite file on an `owned` disk. It is one unit of conflict, so it has one owner.
- **Derived things in their own directory** (`reports/`, `index/`), so they can be handed out read-only and rebuilt freely.
- **A README in every directory that has a layout.** It is the schema, for a reader that has only `ls` and `cat`. One or two sentences: what one file is, how files are named, where the fields are.

## 4. Write the questions as statements

For each question the thing has to answer, choose the cheapest route that answers it.

| The question | Route | Cost |
|---|---|---|
| "what is in this file?", "what files are here?" | `read`, `ls` | no compute |
| "where does this pattern occur?" | `ctx.grep` | one call per disk, whatever the file count |
| "how many, grouped by, joined with": aggregates over many files | `ctx.sql` over paths, globs or log selections | one call |
| anything bash can do with a few files | `ctx.sh` with declared paths | one call |
| several small things at once | `ctx.batch` | one call for all of them |
| one pipeline over a great many files | `ctx.sh(...).map(reduce=...)` | one call per shard |
| "has anything changed since I last looked?" | a feed's `poll()` | a listing: no call |
| a report or an index someone will read again | a view | a call only when its inputs changed |

Every statement names what it touches as parameters. A design in which statements mount everything has not finished step 3.

## 5. Decide what lands together

Group writes into turns where a half-applied change would be wrong: a record and its index entry, a note and the memory of having written it. Name the disks each turn writes. Expect conflicts to be rare and handle them by running the turn again. Keep external side effects (a request, a message sent) to the end of a turn, or make them safe to repeat.

## 6. Decide what each actor may reach

For every model, sub-agent or tool call that will be handed part of this:

- the sub-trees it needs, and no more: `ctx.narrow(...)`, read-only unless it must write;
- the network: `with_egress("deny")` unless its commands need it, then a list of hosts;
- a ceiling: `with_budget(max_usd=...)`;
- a record: its statements are journalled only if the context it is given can still append to the journal, so keep the journal's directory in the narrowing, on an `append` disk. A read-only narrowing keeps no journal;
- for attempts that should not see each other, a `fork` each; for a run that must be repeatable, a `lock`.

## 7. Price it

Three terms, from the public price sheet (the `PriceSheet` in the SDK has the current numbers):

- **Calls.** Count the statements per day. A call is $0.00005 at the default VM size. A check every five minutes is 8,640 calls a month, about $0.43.
- **Active data.** The bytes read or written in the last hour, at $0.20 per GiB-month. What matters is how much the recurring statements keep warm, which is what step 3 controls.
- **Archive.** Everything stored, at $0.025 per GB-month. For most designs this is nearly the whole bill.

If a statement needs a larger VM, it bills as a multiple. If the design wants more than about 3,800 calls an hour sustained, a warm sandbox would be cheaper, and seaway does not make those.

Then check the estimate against real plans: build the statements on a local backend and read `explain()`.

## 8. Write it down

Produce three things.

1. **The context**, as code, and as a manifest where one will be saved. One line of description per mount.
2. **The layout**: for each disk, the directories, what one file is, and the README text for each.
3. **A first script** that opens the context on a local backend, seeds a little data, runs the main statements and prints their plans. `/seaway:new` scaffolds one, in Python or TypeScript.

Finish with what the design does not do, and what would change it: the size at which a scan stops being the right answer, the write rate at which `shared` needs turns, anything that depends on a limit in [the SDK's known limits](../sdk/references/backends.md#known-limits).

## Blueprints

[references/blueprints.md](references/blueprints.md) has worked designs to start from, each with its context, its layout and the statements that matter:

- an agent with skills, reference data, its own memory, shared notes and an audit log;
- observability on a disk: ingest, triage, search, a report, an alert;
- a mirror of a system of record;
- several attempts at one task, and adopting the one that won;
- a helper that is handed less;
- a run that can be replayed: evals;
- records many agents edit: a tracker or a wiki;
- work that starts from a change, with nothing running in between.

## Checks before calling it done

- Does every disk have exactly one answer to "who writes this"?
- Could two writers ever change the same path? If so, is that a turn, or a layout mistake?
- Does every recurring statement declare its paths, and does its plan mount only what it needs?
- What is kept warm by the recurring statements, in GiB? Is that the smallest it could be?
- What can each model or helper read, write, reach on the network, and spend?
- If a turn fails half-way, what is left behind, and does anything outside the context need undoing?
- Can someone with only `ls` and `cat` find their way around each disk?
- What is left behind on Archil? Every turn, fork and lock leaves a branch or a checkpoint that cannot be deleted without deleting the disk.
