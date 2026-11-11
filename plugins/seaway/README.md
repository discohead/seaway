# seaway for Claude Code

A plugin that teaches Claude Code to work with [seaway](../../README.md), and gives it a seaway context to work on.

seaway is new, so nothing about it is in a model's training data. Without help, Claude writes plausible code against an API that does not exist. With this plugin it reads the real one first, checks what it wrote, and can open a context and run priced statements against it from inside a session.

## Install

From a checkout of this repository:

```bash
claude plugin marketplace add /path/to/seaway
claude plugin install seaway@seaway
```

Or load it for one session, without installing:

```bash
claude --plugin-dir /path/to/seaway/plugins/seaway
```

The skills and agents need nothing else. The scripts, the hooks and the MCP server need Node on the PATH, and the MCP server needs Node 22.19 or later, the same as the TypeScript SDK. Without Node the hooks do nothing and say nothing.

## What is in it

### Skills Claude uses by itself

| Skill | When it is used | What it holds |
|---|---|---|
| `seaway:sdk` | code imports seaway, or a question is about how it behaves | the API in both languages, and a reference for each part: contexts, statements, plans and prices, turns, logs, views and feeds, recipes, tools for a model, backends, SQLite, errors, files on disk |
| `seaway:design` | someone wants to build something on seaway or Archil | a method for choosing disks, modes and layout and pricing the result, and eight worked blueprints |
| `seaway:contributing` | work on this repository's own SDKs | Python is the reference; the order of a change; the fixture; porting; the interop check |

Every example in the skills is run by the plugin's tests against both SDKs.

### Skills you call

| Command | What it does |
|---|---|
| `/seaway:new [name] [python\|typescript]` | scaffolds a project: a context, a first script, a README. Runs it on a local backend |
| `/seaway:design [what to build]` | designs the context and the layout for it |
| `/seaway:explain [file:line or statement]` | shows a statement's plan and price without running it, and what each note means |
| `/seaway:review [paths]` | lints, then has the reviewer agent read the code |
| `/seaway:port <file> [to python\|typescript]` | ports code that uses seaway between the SDKs |
| `/seaway:cost [workload or journal]` | estimates a workload from the price sheet, or accounts for a journal |
| `/seaway:open [manifest or mounts]` | opens a context in the MCP server and shows what is on it |
| `/seaway:doctor` | says where a context would act and what is missing |
| `/seaway:parity [check\|port]` | in a checkout: both test suites, the fixture, the interop check |

### Agents

| Agent | Use it for | Changes files |
|---|---|---|
| `seaway:reviewer` | what a linter cannot see: modes, scope, turns, cost, what a model is handed, local against Archil | no |
| `seaway:sdk-porter` | porting a change from the Python SDK to the TypeScript one | `typescript/` only |
| `seaway:cost-analyst` | where a context's money goes, from its journal, and how to spend less | no |
| `seaway:context-explorer` | answering a question about the data on an open context, through the MCP server | no |

### Commands on the PATH

While the plugin is enabled, Claude's shell has two more commands.

- **`seaway-doctor [--json] [directory]`** reports where a context would act (the local backend, or the live account), the Python and Node versions, whether the SDKs import, whether `duckdb`, `jq`, `sqlite3` and `rg` are there, and what the local backend enforces on this machine. It reads, and runs `--version`. It contacts nothing and always exits 0.
- **`seaway-lint [--json] [--all] <paths>`** reads Python and TypeScript that imports seaway and reports the mistakes that are cheap to find. It exits 1 on a `warn`.

  | Rule | Level | What it finds |
  |---|---|---|
  | `interpolated-command` | warn | Python: a value pasted into a command's text with an f-string, `.format`, `%` or `+` |
  | `untagged-template` | warn | TypeScript: ``ctx.sh(`…${x}…`)``, a call with a template literal where a tagged template was meant |
  | `never-run` | warn | a statement built and dropped: no `.run()`, no `await` |
  | `turn-bypass` | warn | a write through the outer context inside a turn |
  | `turn-undeclared-mount` | warn | a write inside a turn to a mount its `writes` does not name; that write is not part of the turn |
  | `sql-out-parameter` | warn | `ctx.out(…)` as a parameter of a `sql` statement, which cannot be compiled: a query writes with `.into()` |
  | `glob-in-list` | warn | a glob inside a list parameter, where it is passed as its own text and not expanded |
  | `sql-literal-path` | note | a path written into SQL text, which declares nothing |
  | `raw-fragment` | note | `raw()` given something other than a constant |
  | `returned-statement` | note | TypeScript: a statement returned from an `async` function |
  | `tools-without-egress` | note | tools turned into a model's schema with no network policy in sight |
  | `sqlite-unlocked-read` | note | a `sqlite3 -readonly` read that takes no checkout |
  | `absolute-mount-path` | note | `/mnt/archil` written into a command |

  A line that says `seaway-lint: ignore`, or `seaway-lint: ignore <rule>`, is passed over. The linter reads source without parsing it, and prefers saying nothing to saying something wrong.

### Hooks

| When | What it does |
|---|---|
| a session starts | in a project that uses seaway, tells Claude where a context would act and which tools are missing; in a checkout, which SDK is the reference. In any other project it says nothing |
| before a shell command | if the command runs a program with `--archil`, and an API key is set, asks you first: that run creates disks in the account and bills per call |
| before the MCP server opens a context | if the call asks for the live account, asks you first, and says which disks it would create |
| after an edit | lints the file if it imports seaway and tells Claude what is new; in a checkout, says once per file what has to stay in step with it |

A hook never blocks and never fails the work: whatever goes wrong, it exits 0 and says nothing.

### The MCP server

`context` is a stdio MCP server that holds one seaway context per session and offers it as tools. It is what `ctx.tools()` gives any model, with one difference: statements keep their parameters, so a call can declare what it touches, be explained before it runs, and be priced.

| Tool | What it does |
|---|---|
| `describe_context` | the mounts and their modes, the backend, what is writable, the budget and what has been spent |
| `open_context` | opens a context from a manifest or a map of mounts |
| `list_files`, `read_file` | direct: no compute |
| `write_file`, `delete_file` | direct, on `owned` and `shared` mounts |
| `explain_statement` | a statement's plan: scope, calls, price, notes. Runs nothing |
| `run_statement` | runs `sh`, `sql`, `grep` or `batch`, with `map`, `into`, `sized`, `egress`, `within` |
| `begin_turn`, `turn_changes`, `commit_turn`, `rollback_turn` | a transaction over files: until it ends, every tool acts on the turn's branch. When the journal is on a disk the turn writes, its directory is added to the turn's `writes`, since the commit would be refused without it |
| `append_log` | appends records to a log |
| `poll_feed`, `ack_feed` | what changed under a path since a cursor last looked |
| `refresh_view` | rebuilds a derived file if its inputs or its statement changed |

A statement is described the way the conformance fixture describes one:

```json
{
  "kind": "sql",
  "template": "select service, count(*)::int as errors from {recent} where level = {level} group by 1",
  "params": { "recent": { "log": "logs", "last": "15m" }, "level": "ERROR" }
}
```

A parameter that is a path is marked as one: `{"path"}`, `{"glob"}`, `{"out"}`, or `{"log"}` with `last`, `between` or neither. Anything else is a value, and seaway quotes it.

**How it is kept safe.**

- **Local unless told otherwise.** `open_context` uses the local backend, under `.archil-local` in the project, unless a call says `backend: "archil"` or the plugin's Backend option is changed. An exported `ARCHIL_API_KEY` alone does not send it to an account. When a call does ask for the live account, a hook asks you before it runs.
- **No network.** A context opened here denies egress to its commands, unless its manifest carries a policy of its own or the call sets one.
- **A budget.** Each session is held to 25 cents by the plans' estimates unless changed. A statement that would pass it is refused before it runs.
- **`read_only`** opens every mount read-only. A journal is then not written, and the report says so.

Two things to know. On the local backend a statement is bash on your machine, run as you; on macOS the mounts are symlinks, so nothing confines a command to them and a network policy is not enforced. And Claude Code's permission prompt is per tool, not per command: allowing `run_statement` always allows whatever it is asked to run.

**How it finds the SDK.** The server has no dependencies and loads the TypeScript SDK from disk, in this order: the plugin's "seaway checkout" option; a checkout at or above the project (`typescript/src/index.ts`); a project that installed seaway as a link (`node_modules/seaway`); the checkout the plugin itself sits in. If it finds none, the server still starts, and each tool says how to point it at one.

It speaks both eras of the protocol: the revision without a handshake (2026-07-28, which Claude Code uses) and the older one that begins with `initialize`.

## Options

Set when the plugin is enabled, or later with `claude plugin configure seaway`.

| Option | Default | Meaning |
|---|---|---|
| seaway checkout | empty | where the MCP server loads the SDK from, when it is not in or above the project |
| Context manifest | empty | a manifest for the MCP server to open on first use |
| Backend | `local` | where the MCP server opens contexts when a call does not say |
| Session budget (USD) | `0.25` | the most one MCP session may spend; `none` lifts it; `0` lets plans be read and nothing run |
| Ask before live runs | on | the hooks that ask before a command with `--archil`, and before the MCP server opens a context on the live account |
| Lint on edit | on | the hook that lints after an edit |

The server also reads `SEAWAY_MCP_EGRESS` (`deny`, `allow`, or hosts separated by commas), `SEAWAY_MCP_READ_ONLY=1` and `ARCHIL_LOCAL_ROOT` from the environment Claude Code was started in. `SEAWAY_MCP_TRACE=<file>` and `SEAWAY_HOOK_TRACE=<file>` append what the server and the hooks receive to a file, for debugging. An API key is never written to either.

## Working on the plugin

```text
.claude-plugin/plugin.json    the manifest, and the options above
skills/                       eleven skills; sdk/references and design/references hold the long form
agents/                       four agents
hooks/hooks.json, run.sh      four hooks, all through one wrapper that does nothing without Node
scripts/                      hook.mjs, lint.mjs, doctor.mjs, and lib/ they share
servers/context-server.mjs    the MCP server
bin/                          seaway-lint and seaway-doctor
templates/                    what /seaway:new starts from
evals/                        eight cases for `claude plugin eval`
tests/                        node:test suites for all of the above
```

```bash
node --test plugins/seaway/tests/                 # from the repository's root
claude plugin validate plugins/seaway --strict
claude plugin validate . --strict                 # the marketplace manifest
claude --plugin-dir plugins/seaway plugin details seaway
```

The tests need nothing but Node for the linter and the hooks. The MCP server's tests need the TypeScript SDK beside the plugin, which a checkout has. The examples in the skills and the templates are run in both languages, which also needs `duckdb` and `jq` on the PATH and a Python 3.10 or later: the first `python3` that qualifies, or the one named by `SEAWAY_PYTHON`. What cannot run is skipped and says why. Nothing in the tests can reach an account: each runs on a temporary local root with the API key removed from its environment.

**Examples in the skills are executable.** A fenced block marked `python` or `ts` is run as written, given `archil`, `ctx` and `backend`, on a seeded local root. A block marked `py` or `typescript` is there to be read: a signature, a fragment, something not to do. When the SDK changes, `tests/docs.test.mjs` says which examples no longer hold.

**Evals.** `evals/` holds eight cases that ask for seaway code and grade the answer: values as parameters, tagged templates, modes, turns and conflicts, search, plans and budgets, handing a model less, and keeping a test off the live account. Each has a rubric, a pattern or two, and a check that the skill was used.

```bash
claude plugin eval plugins/seaway --no-publish                          # with and without the plugin, three runs a case
claude plugin eval plugins/seaway --no-publish --case search-is-grep --runs 1 --ablation none
```

Every run is a real model call on your account. `--no-publish` keeps the report on this machine.

**Releasing.** The version is in `plugin.json` alone. `claude plugin tag plugins/seaway --dry-run` checks that the manifest and the marketplace entry agree and shows the tag it would make.

## What it does not do

- It does not install seaway, Python, Node, DuckDB or the official Archil SDKs. `seaway-doctor` says what is missing and how to get it.
- The MCP server runs on the TypeScript SDK only. A project that uses only the Python SDK still gets the skills, the agents, the linter and the hooks.
- The linter does not parse. It misses what is spread across variables, and it cannot tell that a path given as a plain string should have been `ctx.path`. That is what the reviewer agent is for.
- The MCP server does not sync recipes, fork or lock a context. Those need code, or are permanent on Archil, and are left to a program.
- Nothing here has a licence of its own. The repository does not carry one yet, so the plugin cannot be listed in a plugin directory as it stands.
