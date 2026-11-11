---
title: The Claude Code plugin
description: seaway is new, so a model knows nothing about it. The repository carries a Claude Code plugin that gives it the real API to read first, checks what it wrote, and opens a context it can work on.
sidebar:
  label: Claude Code plugin
---

seaway is not in any model's training data. Without help, Claude writes plausible code against an API that does not exist. The plugin gives it the real one to read first: skills for both SDKs, a linter for the mistakes that are easy to make, agents that review and port, and an MCP server that opens a context as tools, with plans and prices.

## Install

```bash
claude plugin marketplace add discohead/seaway
claude plugin install seaway@seaway
```

Then, in a session:

```text
/seaway:setup
```

Setup finds a checkout of the repository or clones one where you say, points the plugin's MCP server at it, and offers to install what else is missing, such as DuckDB. It asks before it installs or clones anything.

| Part | Needs |
|---|---|
| The skills and the agents | nothing |
| The linter, the doctor and the hooks | Node on the PATH. Without it the hooks do nothing and say nothing |
| The MCP server | Node 22.19 or later, and the TypeScript SDK on disk, which `/seaway:setup` arranges |

To load the plugin for one session without installing it:

```bash
claude --plugin-dir /path/to/seaway/plugins/seaway
```

## Skills Claude uses by itself

| Skill | When it is used | What it holds |
|---|---|---|
| `seaway:sdk` | code imports seaway, or a question is about how it behaves | the API in both languages, with a reference for each part |
| `seaway:design` | someone wants to build something on seaway or Archil | a method for choosing disks, modes and layout and pricing the result, and eight worked [blueprints](/blueprints/) |
| `seaway:contributing` | work on the repository's own SDKs | Python is the reference; the order of a change; the fixture; porting; the interop check |

Every example in the skills is run by the plugin's tests against both SDKs, as every example on this site is.

## Commands you call

| Command | What it does |
|---|---|
| `/seaway:setup [checkout]` | after installing: finds or clones a checkout, points the MCP server at it, and offers to install what is missing |
| `/seaway:new [name] [python\|typescript]` | scaffolds a project: a context, a first script, a README. Runs it on a local backend |
| `/seaway:design [what to build]` | designs the context and the layout for it |
| `/seaway:explain [file:line or statement]` | shows a statement's plan and price without running it, and what each note means |
| `/seaway:review [paths]` | lints, then has the reviewer agent read the code |
| `/seaway:port <file> [to python\|typescript]` | ports code that uses seaway between the SDKs |
| `/seaway:cost [workload or journal]` | estimates a workload from the price sheet, or accounts for a journal |
| `/seaway:open [manifest or mounts]` | opens a context in the MCP server and shows what is on it |
| `/seaway:doctor` | says where a context would act, and what is missing |
| `/seaway:parity [check\|port]` | in a checkout: both test suites, the fixture, the interop check |

## Agents

| Agent | Use it for | Changes files |
|---|---|---|
| `seaway:reviewer` | what a linter cannot see: modes, scope, turns, cost, what a model is handed, local against Archil | no |
| `seaway:sdk-porter` | porting a change from the Python SDK to the TypeScript one | `typescript/` only |
| `seaway:cost-analyst` | where a context's money goes, from its journal, and how to spend less | no |
| `seaway:context-explorer` | answering a question about the data on an open context, through the MCP server | no |

## Hooks

| When | What it does |
|---|---|
| a session starts | in a project that uses seaway, tells Claude where a context would act and which tools are missing. In any other project it says nothing |
| before a shell command | if the command runs a program with `--archil`, and an API key is set, asks you first: that run creates disks in the account and bills per call |
| before the MCP server opens a context | if the call asks for the live account, asks you first, and says which disks it would create |
| after an edit | lints the file if it imports seaway, and tells Claude what is new |

A hook never blocks and never fails the work. Whatever goes wrong, it exits 0 and says nothing.

## Options

Set when the plugin is enabled, or later with `claude plugin configure seaway`.

| Option | Default | Meaning |
|---|---|---|
| seaway checkout | empty | where the MCP server loads the SDK from, when it is not in or above the project |
| Context manifest | empty | a [manifest](/guides/manifests/) for the MCP server to open on first use |
| Backend | `local` | where the MCP server opens contexts when a call does not say |
| Session budget (USD) | `0.25` | the most each context the MCP server opens may spend. `none` lifts it; `0` lets plans be read and nothing run |
| Ask before live runs | on | the hooks that ask before a command with `--archil`, and before the MCP server opens a context on the live account |
| Lint on edit | on | the hook that lints after an edit |

## What it does not do

- **It does not install anything by itself.** `seaway-doctor` says what is missing, and `/seaway:setup` offers to get it. It asks first, and leaves Python, Node and the official Archil SDKs to you.
- **The MCP server runs on the TypeScript SDK only.** A project that uses only the Python SDK still gets the skills, the agents, the linter and the hooks.
- **The linter does not parse.** It misses what is spread across variables. That is what the reviewer agent is for.
- **The MCP server does not sync recipes, fork or lock a context.** Those need code, or are permanent on Archil, and are left to a program.

## Other coding agents

The plugin is for Claude Code. Any other agent can be pointed at the same material, because these docs are published as Markdown. See [Docs for LLMs](/agents/llms/) for `llms.txt`, the Markdown twin of every page, and a short instruction block to paste into an agent's rules file.

## Next

:::cards
- [The MCP server](/agents/mcp-server/) A context as tools that keep their parameters.
- [Lint and doctor](/agents/lint/) Thirteen rules, and a report on where a context would act.
- [Docs for LLMs](/agents/llms/) What this site publishes for models to read.
:::
