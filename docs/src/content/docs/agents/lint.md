---
title: Lint and doctor
description: Two commands the Claude Code plugin puts on the PATH. seaway-lint reads code that uses seaway for the mistakes that are cheap to find, and seaway-doctor says where a context would act and what is missing.
---

While [the Claude Code plugin](/agents/claude-code/) is enabled, Claude's shell has two more commands. Both are plain Node scripts in the repository, so you can run them without the plugin as well:

```bash
node plugins/seaway/scripts/lint.mjs <paths>
node plugins/seaway/scripts/doctor.mjs
```

## seaway-lint

`seaway-lint [--json] [--all] <paths>` reads Python and TypeScript that imports seaway and reports the mistakes that are easy to make. It exits 1 on a `warn`.

Given this file:

```py
import seaway as archil

ctx = archil.context({
    "docs": archil.disk("handbook"),
    "memory": archil.disk("agent-memory", "owned"),
})
name = "onboarding.md"
ctx.sh(f"cat docs/{name}").run()
ctx.sh("ls {d}", d=ctx.path("docs"))
with ctx.transaction(writes=["memory"]) as turn:
    ctx.write("memory/notes/x.md", "x")
```

it reports:

```text
bad.py:8  warn  interpolated-command  the command's text is built from values, so they are not quoted and declare nothing. Write {name} in the template and pass the value as a parameter (a path as ctx.path, ctx.glob or ctx.out).
bad.py:9  warn  never-run  this statement is built and dropped. A statement does nothing until it is run: call .run() or .explain().
bad.py:11  warn  turn-bypass  inside this turn, a write through the outer context goes to the main line at once and is not part of the turn. Use the turn's own context: turn.write(…).

seaway-lint: 1 file(s) read, 3 warn, 0 note
```

### The rules

| Rule | Level | What it finds |
|---|---|---|
| `interpolated-command` | warn | Python: a value pasted into a command's text with an f-string, `.format`, `%` or `+` |
| `untagged-template` | warn | TypeScript: ``ctx.sh(`…${x}…`)``, a call with a template literal where a tagged template was meant |
| `never-run` | warn | a statement built and dropped: no `.run()`, no `await` |
| `turn-bypass` | warn | a write through the outer context inside a turn |
| `turn-undeclared-mount` | warn | a write inside a turn to a mount its `writes` does not name. That write is not part of the turn |
| `sql-out-parameter` | warn | `ctx.out(…)` as a parameter of a `sql` statement, which cannot be compiled. A query writes with `.into()` |
| `glob-in-list` | warn | a glob inside a list parameter, where it is passed as its own text and not expanded |
| `sql-literal-path` | note | a path written into SQL text, which declares nothing |
| `raw-fragment` | note | `raw()` given something other than a constant |
| `returned-statement` | note | TypeScript: a statement returned from an `async` function |
| `tools-without-egress` | note | tools turned into a model's schema with no network policy in sight |
| `sqlite-unlocked-read` | note | a `sqlite3 -readonly` read that takes no checkout |
| `absolute-mount-path` | note | `/mnt/archil` written into a command |

A line that says `seaway-lint: ignore`, or `seaway-lint: ignore <rule>`, is passed over.

### What it is, and is not

The linter reads source without parsing it, and prefers saying nothing to saying something wrong. It misses what is spread across variables, and it cannot tell that a path given as a plain string should have been `ctx.path`. Those are for a reader: the plugin's `seaway:reviewer` agent, or `/seaway:review`, which runs the linter and then the reviewer.

`--json` prints the findings as JSON, each with `file`, `line`, `rule`, `level` and `message`.

## seaway-doctor

`seaway-doctor [--json] [directory]` reports where a context would act, and what this machine has. It reads, and runs `--version`. It contacts nothing and always exits 0.

```text
seaway doctor: /home/you/project
project    a seaway checkout: python/ (the reference), typescript/, conformance/, interop/
backend    local: no ARCHIL_API_KEY is set, so contexts open on directories under the local root. Set ARCHIL_API_KEY and ARCHIL_REGION to reach Archil.
python     3.13.18 at /usr/bin/python3, ok. seaway does NOT import: pip install -e 'python[dev]', or run with PYTHONPATH=python/src. archil (the official SDK) is installed.
node       26.13.0, ok. TypeScript SDK at /home/you/project/typescript/src/index.ts. disk (the official SDK) is installed.
duckdb     v2.0.0 (Cyanoptera) d54cbbe3df, ok
jq         jq-1.7.1, ok
sqlite3    3.54.0, ok (Archil's exec image has 3.37.2: json_extract but no ->>)
rg         not installed: search uses the SDK's own implementation, which gives the same answers
isolation  symlink: on the local backend a write to a read-only mount is reported after the command (exit 30) rather than refused, a network policy is not enforced, and find and du need -L to cross a mount. Archil enforces all three.
local root /home/you/project/.archil-local (not created yet)
```

| Line | Says |
|---|---|
| `backend` | **where a context opened without a backend would act:** the local backend, or the live account |
| `python`, `node` | the versions, and whether each SDK imports |
| `duckdb`, `jq`, `sqlite3`, `rg` | whether the tools statements call are installed |
| `isolation` | what the local backend really enforces on this machine: a mount namespace, or symlinks |
| `local root` | where the local backend would keep its disks |

Run it before you run anything else. If the `backend` line says Archil, a script that passes no backend acts on the live account.

## Next

:::cards
- [The Claude Code plugin](/agents/claude-code/) Where these come from, and the hook that lints after an edit.
- [Troubleshooting](/guides/troubleshooting/) When something looks wrong but nothing was raised.
:::
