---
title: The MCP server
description: The Claude Code plugin's MCP server holds one seaway context per session and offers it as sixteen tools. Statements keep their parameters, so a call can declare what it touches, be explained before it runs, and be priced.
sidebar:
  label: MCP server
---

`context` is a stdio MCP server that comes with [the Claude Code plugin](/agents/claude-code/). It holds one seaway context per session and offers it as tools. It is what [`ctx.tools()`](/guides/model-tools/) gives any model, with one difference: statements keep their parameters. So a call can declare what it touches, be explained before it runs, and be priced.

## The tools

| Tool | What it does |
|---|---|
| `describe_context` | the mounts and their modes, the backend, what is writable, the budget and what has been spent |
| `open_context` | opens a context from a manifest or a map of mounts |
| `list_files`, `read_file` | direct: no compute |
| `write_file`, `delete_file` | direct, on `owned` and `shared` mounts |
| `explain_statement` | a statement's plan: scope, calls, price, notes. Runs nothing |
| `run_statement` | runs `sh`, `sql`, `grep` or `batch`, with `map`, `into`, `sized`, `egress`, `within` |
| `begin_turn`, `turn_changes`, `commit_turn`, `rollback_turn` | a transaction over files. Until it ends, every tool acts on the turn's branch |
| `append_log` | appends records to a log |
| `poll_feed`, `ack_feed` | what changed under a path since a cursor last looked |
| `refresh_view` | rebuilds a derived file if its inputs or its statement changed |

## A statement, as JSON

A statement is described the way the [conformance fixture](/architecture/two-sdks/#the-conformance-fixture) describes one: a kind, a template, and parameters.

```json
{
  "kind": "sql",
  "template": "select service, count(*)::int as errors from {recent} where level = {level} group by 1",
  "params": { "recent": { "log": "logs", "last": "15m" }, "level": "ERROR" }
}
```

A parameter that is a path is marked as one. A plain string, number or boolean is a value, and seaway quotes it.

| Parameter | Is |
|---|---|
| `{"path": "docs/security"}` | a read of a file or a directory |
| `{"glob": "docs/**/*.md"}` | a read of the files that match |
| `{"out": "memory/report.md"}` | a write |
| `{"log": "logs", "last": "15m"}` | a log selection. Also `between`, or neither for the whole log |
| `{"raw": "\| wc -l"}` | text put into the command as written, not quoted |
| a string, a number, a boolean, or `{"value": …}` | a value. Any other object is refused |

## How it is kept safe

- **Local unless told otherwise.** `open_context` uses the local backend, under `.archil-local` in the project, unless a call says `backend: "archil"` or the plugin's Backend option is changed. An exported `ARCHIL_API_KEY` alone does not send it to an account. When a call does ask for the live account, a hook asks you before it runs.
- **No network.** A context opened here denies egress to its commands, unless its manifest carries a policy of its own or the call sets one.
- **A budget.** Each opened context is held to 25 cents by the plans' estimates unless changed. A statement that would pass it is refused before it runs. Opening a context again starts the count again, and `open_context` can set `max_usd` itself.
- **`read_only`** opens every mount read-only. A journal is then not written, and the report says so.

:::caution[Two things to know]
On the local backend a statement is bash on your machine, run as you. On macOS the mounts are symlinks, so nothing confines a command to them, and a network policy is not enforced.

Claude Code's permission prompt is per tool, not per command. Allowing `run_statement` always allows whatever it is asked to run.
:::

## Turns

`begin_turn` starts a transaction. Until `commit_turn` or `rollback_turn`, every tool acts on the turn's branch, and `turn_changes` lists what it has changed so far.

When the journal is on a disk the turn writes, its directory is added to the turn's `writes`, since the commit would be refused without it. See [where to put the journal](/guides/journal/#where-to-put-it).

## How it finds the SDK

The server has no dependencies and loads the TypeScript SDK from disk, in this order:

1. the plugin's "seaway checkout" option, when it is set. Nothing else is tried then;
2. walking up from the project: at each directory, a checkout (`typescript/src/index.ts`), then an install as a link (`node_modules/seaway`);
3. the checkout the plugin itself sits in.

If it finds none, the server still starts, and each tool says how to point it at one. `/seaway:setup` does that for you.

## Settings

The plugin's [options](/agents/claude-code/#options) set the checkout, a manifest to open on first use, the backend, and the session budget. The server also reads these from the environment Claude Code was started in:

| Variable | Effect |
|---|---|
| `SEAWAY_MCP_EGRESS` | `deny`, `allow`, or hosts separated by commas |
| `SEAWAY_MCP_READ_ONLY=1` | open every mount read-only |
| `ARCHIL_LOCAL_ROOT` | where the local backend keeps its disks |
| `SEAWAY_MCP_TRACE=<file>` | append every message the server receives and sends to a file, for debugging. It holds what statements printed, so treat it as you would the data |

It speaks both eras of the protocol: the revision without a handshake (2026-07-28, which Claude Code uses) and the older one that begins with `initialize`.

## What it leaves to a program

The server does not sync recipes, fork a context or lock one. Those need code, or are permanent on Archil. Write a script with the SDK for them.

## Next

:::cards
- [Tools for a model](/guides/model-tools/) The same idea for any model, from `ctx.tools()`.
- [Lint and doctor](/agents/lint/) The two commands the plugin puts on the PATH.
:::
