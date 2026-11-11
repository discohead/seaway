---
name: sdk
description: Write, review and debug code that uses seaway, the framework for Archil, in Python (`import seaway`) or TypeScript (`from "seaway"`). Covers contexts and mount modes, statements (sh, sql, grep, batch) that declare what they touch, plans and explain(), prices and budgets, turns as transactions, logs, views and feeds, recipes, tools for a model, and the local and Archil backends.
when_to_use: Use whenever code imports seaway, or a task mentions seaway, an Archil context or context manifest ("archilContext"), statements and plans, ctx.sh / ctx.sql / ctx.grep, explain(), turns, or .archil-local. Use it before answering how anything in seaway behaves. seaway is new and is not in training data.
---

# seaway

seaway is a framework for [Archil](https://archil.com). You define the context an agent needs: disks composed under mount names, each with a mode that says who may change it. Then you run statements against it. A statement says what it touches, can explain itself before it runs, and is priced from Archil's public price sheet.

There are two SDKs with one API: Python, which is the reference, and TypeScript. Both sit on Archil's official clients (`archil` on PyPI, `disk` on npm). A local backend runs the same plans on plain directories with real bash, so everything can be tried with no account.

Nothing about seaway is in your training data, and it does not work like the libraries it resembles. Read the reference for the task before writing code (the table is at the end), and read the SDK's source when a detail is not there. Do not fill a gap with a guess.

## The shape of a program

```python
import seaway as archil

ctx = archil.context({
    "docs":   archil.disk("handbook"),                # read: live, read-only (the default mode)
    "logs":   archil.disk("app-logs", "append"),      # append: records are only ever added
    "memory": archil.disk("agent-memory", "owned"),   # owned: this context is the only writer
    "team":   archil.disk("team-notes", "shared"),    # shared: many writers
}, backend=backend)

errors = ctx.sql(
    "select service, count(*)::int as errors from {recent} where level = {level} group by 1 order by 2 desc",
    recent=ctx.log("logs").last("15m"),               # a path parameter: says what the call may see
    level="ERROR",                                    # a value: always quoted
)
print(errors.explain())                               # the plan: what it mounts, how many calls, what it costs
rows = errors.run(check=True).rows                    # runs next to the data; only the rows come back
```

```ts
const ctx = await archil.context({
  docs: archil.disk("handbook"),
  logs: archil.disk("app-logs", "append"),
  memory: archil.disk("agent-memory", "owned"),
  team: archil.disk("team-notes", "shared"),
}, { backend });

const errors = ctx.sql`
  select service, count(*)::int as errors from ${ctx.log("logs").last("15m")}
  where level = ${"ERROR"} group by 1 order by 2 desc`;
console.log(String(await errors.explain()));
const { rows } = await errors.run({ check: true });
```

```text
plan 9af6b2227225  sql · 3 file(s), 1.9 KiB · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   logs/2026-11-10/14 → app-logs:/2026-11-10/14 (read-only)
          not mounted: docs, memory, team
  reads   logs[last 15m]
  writes  —
  price   1 call unit $0.00005 + 1.9 KiB active for an hour <$0.00001 ≈ $0.00005
```

Nobody chose that mount map or that price. The statement said which records it wanted, and the rest followed.

The examples in this skill use that context. `archil` is the import (`import seaway as archil`, `import * as archil from "seaway"`), and `backend` is whichever backend the program runs on.

## What to get right

1. **A path starts with a mount name.** `docs/security/keys.md` is `security/keys.md` on the disk mounted as `docs`. No leading slash and no `..`.

2. **A path a statement touches is a parameter.** `ctx.path(p)` reads a file or a directory, `ctx.glob(p)` reads many files, `ctx.out(p)` writes, and a log selection reads a time range. From these the SDK works out the mount map (only the disks named, read-only unless written, narrowed to the smallest directory that covers the reads), the price, what can be split, and what the journal records. A statement with no path parameters still runs, but it mounts every disk in its own mode and its plan says so.

3. **A value is a parameter too.** Anything that is not a path is quoted: one shell word in `sh`, a literal in `sql`, whatever it contains. So never build the command's text from values. In Python that means no f-string, `.format`, `%` or `+`. In TypeScript, ``ctx.sh`cat ${x}` `` is a tagged template and is right; ``ctx.sh(`cat ${x}`)`` is a call, JavaScript has pasted the value before seaway sees it, and nothing is quoted or declared. `archil.raw(text)` puts text in as written and is for constants.

4. **Nothing runs until you ask.** Building a statement contacts nothing. In Python `.run()` runs it. In TypeScript `await statement` runs it, as does `.run()`. `.explain()` returns the plan and runs nothing. `map`, `into`, `sized`, `egress` and `within` each return a new statement.

5. **Read the plan when reach or cost matters.** `scope` is what the call can see and change. `price` is the estimate. Each `note` is something a careful author would act on: nothing declared, a search that `ctx.grep` would do in one call, a VM size that bills as several calls. To hold a statement to a ceiling, give it one: `statement.within(max_usd=0.01)`, or `ctx.with_budget(max_usd=0.05)` for everything a context runs. `run()` then raises `BudgetExceeded` if the plan would pass it, before anything is sent.

6. **A command that fails is a result, not an exception.** Look at `result.ok` or `result.exit_code` (`exitCode`), or pass `check=True` (`{ check: true }`) to raise `ExecFailed`. Exit 1 can be a mount that could not be made, 30 a checkout that was not granted, 124 a command that ran past five minutes.

7. **Take the cheapest route.** `read`, `write`, `append`, `ls`, `exists` and `rm` go straight to the disk and use no compute. `ctx.grep` is one call per disk however many files. `ctx.batch([...])` runs several small statements in one call. `.map(reduce=...)` splits one input across calls, and only because you said how to put the outputs back together. A view rebuilds only when its inputs changed. A feed's poll is a listing.

8. **Choose a mode by who writes.**

   | Mode | Use it for | Direct verbs | A statement sees it |
   |---|---|---|---|
   | `read` | live data someone else maintains | read | read-only |
   | `frozen` | the same bytes on every run; needs `at=<checkpoint>` | read | read-only, at the checkpoint |
   | `owned` | this context is the only writer | read, write, append | read-write under a checkout: a second writer waits up to five seconds |
   | `shared` | many writers, each keeping to its own paths | read, write, append | read-write, no checkout, last write wins |
   | `append` | logs, journals, histories | read, append | read-only |

9. **Changes that belong together go in a turn.** A transaction lands all of a turn's changes or none. If another writer changed one of the same paths first, the commit raises `Conflict`, applies nothing, and the right response is to run the turn again. Inside a turn, do everything through the turn's own context; a write through the outer one goes to the main line at once. If you pass `writes=`, name every disk the turn writes: only those are in the turn, and a write to any other writable mount lands at once and is not undone.

10. **Know where it will run.** With no `backend` argument a context uses Archil when `ARCHIL_API_KEY` is set and the local backend otherwise. `ARCHIL_BACKEND=local` forces local. On Archil every statement, checkpoint and commit is a billed call against real disks; `ctx.sql` needs DuckDB on a disk; and commands have the whole internet unless the context or the statement has an egress policy.

11. **Hand a model less than you have.** `ctx.narrow(...)` keeps the path names and shrinks the reach. `with_egress("deny")` cuts the network, `with_budget(...)` caps the spend, and `ctx.tools()` gives tools with JSON schemas for what is left.

## Python and TypeScript

The names are the same, in snake case and camel case. Where Python takes keyword arguments, TypeScript takes an options object.

| | Python | TypeScript |
|---|---|---|
| Opening a context | `archil.context({...}, backend=b)` | `await archil.context({...}, { backend: b })` |
| Anything that reaches a backend | synchronous | `async`: `await` it |
| A statement with parameters | `ctx.sh("wc -w {f}", f=ctx.glob("docs/**/*.md"))` | ``ctx.sh`wc -w ${ctx.glob("docs/**/*.md")}` `` or `ctx.sh("wc -w {f}", { f })` |
| Running one | `stmt.run(check=True)` | `await stmt` or `await stmt.run({ check: true })` |
| Narrowing | `ctx.narrow("docs/security", read_only=True)` | `ctx.narrow(["docs/security"], { readOnly: true })` |
| A turn | `with ctx.transaction(writes=[...]) as turn:` | `await ctx.transaction(async (turn) => {...}, { writes: [...] })` |
| A feed with nothing new | `if not changes:` | `if (changes.empty)` |
| Is a view fresh | `view.fresh` | `await view.fresh()` |
| The base error | `archil.Error` | `archil.ArchilError` |
| Calling a model's tool | `tool(**args)` | `await tool.call(args)` |
| A mapped `sum_by_key` | a `dict`, largest first | a `Map`, largest first |

In TypeScript a statement is thenable. An `async` function that returns one hands its caller the result, because the `await` runs it. Return a statement from a plain function, or inside an object. A tagged template names its parameters `p0`, `p1`, …, so its plan hash differs from the named form's; use named parameters when a plan has to match the Python SDK's.

## Where it runs

| | Local backend | Archil |
|---|---|---|
| Chosen when | no `ARCHIL_API_KEY`, or `ARCHIL_BACKEND=local`, or `backend=archil.LocalBackend(root)` | `ARCHIL_API_KEY` set (with `ARCHIL_REGION`), or `backend=archil.ArchilBackend()` |
| A disk is | a directory under the root (`.archil-local`, or `ARCHIL_LOCAL_ROOT`) | a disk in the account, by name or `dsk-` id |
| A statement is | bash on this machine, in a fresh directory with the mounts beneath it | bash in a fresh VM with the disks at `/mnt/archil` |
| `ctx.sql` runs | the `duckdb` on the PATH | a DuckDB binary on a disk: `tools={"duckdb": "<mount>/bin/duckdb"}` |
| Read-only and egress | enforced in a mount namespace on Linux; reported after the fact, and the network left open, where it falls back to symlinks (macOS) | enforced |
| Checkpoints and branches | full copies | copy-on-write, and permanent until the disk is deleted |
| Costs | nothing; prices shown are what Archil would charge | per call, per active byte, per byte of egress |

Before running anything, check which one a script will get. If `ARCHIL_API_KEY` is in the environment and the script passes no backend, it acts on the live account.

## References

Read the one that covers what you are about to write.

| When you are… | Read |
|---|---|
| composing a context, choosing modes, narrowing, setting egress or a budget, saving a manifest, forking or locking | [contexts.md](references/contexts.md) |
| writing `sh`, `sql`, `grep` or `batch`; using parameters, `map`, `into`, `sized`; hitting a limit | [statements.md](references/statements.md) |
| reading a plan, estimating or capping cost, designing for the price sheet | [plans-and-prices.md](references/plans-and-prices.md) |
| making changes atomic, handling `Conflict`, choosing isolation | [turns.md](references/turns.md) |
| appending logs, querying a time range, building a report that rebuilds itself, reacting to new data | [logs-views-feeds.md](references/logs-views-feeds.md) |
| mirroring a system of record into files, installing DuckDB on a disk, cloning a repository | [recipes.md](references/recipes.md) |
| giving a context to a model as tools, or to the official `disk` tool layer | [model-tools.md](references/model-tools.md) |
| deciding or debugging where code runs; what Archil does differently from local; known limits | [backends.md](references/backends.md) |
| keeping keyed state in a SQLite file | [sqlite.md](references/sqlite.md) |
| handling an error, an exit code, or cut output | [errors.md](references/errors.md) |
| reading or writing the framework's files without the SDK (manifest, log, journal, cursor, view state) | [files-on-disk.md](references/files-on-disk.md) |
| looking up a signature | [python-api.md](references/python-api.md), [typescript-api.md](references/typescript-api.md) |

## Check your work

- Print `statement.explain()` for anything that is not trivial, and read `scope`, `price` and every `note`.
- Run it on a local backend with a root of its own before it goes near an account: `archil.LocalBackend(tempfile.mkdtemp())`, `new archil.LocalBackend({ root: mkdtempSync(...) })`. Create the disks it names with `create=True`.
- Run `seaway-lint <files>` (on the PATH while this plugin is enabled). It finds pasted values, calls that should be tagged templates, statements that are never run, writes that bypass a turn, an `out` parameter in `sql`, and a glob inside a list.
- `seaway-doctor` says where a context would act, and which of Python, Node, DuckDB and jq are missing.
- The SDK's own examples are the best long-form reference: `examples/quickstart`, `examples/agent_context` and `examples/datadog_afternoon`, in each language.
