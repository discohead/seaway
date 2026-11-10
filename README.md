# seaway

A prototype of Archil as a framework: define the context an agent needs, then run statements against it that say what they touch, can explain themselves before they run, and are priced from Archil's public price sheet. There are two SDKs, Python and TypeScript, with the same API. They sit on top of Archil's official clients (`archil` on PyPI, `disk` on npm) and use them for every call.

The reasoning is in [The Programmable Archil](the-programmable-archil.md). This file is the practical part.

This is an unofficial proposal. It is packaged under its own name so it installs beside the official SDKs.

## Layout

```
python/        the Python SDK (the reference), its tests and examples
typescript/    the TypeScript SDK, its tests and examples
conformance/   33 statements with the plans both SDKs must compile them to
interop/       a check that the two SDKs can work on the same disk
```

## Run it

Everything runs on a local backend, with no account. The SQL examples need the `duckdb` CLI and `jq` on your PATH. Each block starts from this folder.

```bash
# Python 3.10+, no runtime dependencies
cd python
pip install -e '.[dev]'
python examples/quickstart.py           # context, statement, plan, turn, narrowing
python examples/agent_context.py        # five disks under five rules; recipes, turns, forks, locks
python examples/datadog_afternoon.py    # observability on a disk
python -m pytest -q                     # 134 tests
```

```bash
# TypeScript on Node 22.19+, which runs .ts directly; there is no build step
cd typescript
npm install
node examples/quickstart.ts
node examples/agent-context.ts
node examples/datadog-afternoon.ts
npm test && npm run typecheck           # 168 tests, plus one that needs zod
```

```bash
# both SDKs on one disk, each way round; prints PROBLEMS: 0
./interop/run.sh
```

All of this passes on Linux and on macOS. On Linux the local backend runs each call in its own mount namespace (`unshare`), so a read-only mount really is read-only and a denied network really is cut. Where that isn't available, macOS included, it falls back to symlinks: it reports a write to a read-only mount after the fact and leaves the network open, and the two tests that need a namespace are skipped. `ARCHIL_LOCAL_ISOLATION=symlink` forces the fallback. Search uses `rg` when it is installed and its own implementation when it is not; the two give the same answers.

### On Archil

Set `ARCHIL_API_KEY` and `ARCHIL_REGION`, then run any example with `--archil`:

```bash
python examples/datadog_afternoon.py --archil --cleanup
node examples/datadog-afternoon.ts --archil --cleanup
```

Every disk an example names gets a prefix that is new for the run, so an example never opens a disk that is already in your account. It prints the disks it created; `--cleanup` deletes them when it ends. A run costs a fraction of a cent.

In your own code, leave out the `backend` argument and a context uses Archil when `ARCHIL_API_KEY` is set. Two things to know first:

- **SQL needs DuckDB, and Archil's exec image does not have it.** Put the CLI on a disk once and tell the context where it is:

  ```python
  ctx = archil.context({...}, tools={"duckdb": "obs/bin/duckdb"})
  archil.duckdb(ctx, "obs/bin").run(check=True)     # one call; the binary stays on the disk
  ```

  The recipe downloads DuckDB's release archive from GitHub and checks it against a pinned SHA-256 before it unpacks anything. Another `version`, or a `url` of your own, has to come with its `sha256`.

- **Commands have the whole internet unless you say otherwise.** A mount map limits what a command can read, not where it can send it. `ctx.with_egress("deny")` (or a list of hosts) sets a policy for everything a context runs, its tools included; `statement.egress(...)` sets one for a single call. Archil takes a policy on the Developer plan and above.

## The idea in one example

```python
import seaway as archil

ctx = archil.context({
    "logs": archil.disk("app-logs", "append"),   # services append here; nothing rewrites it
    "obs":  archil.disk("obs-agent", "owned"),   # this agent's own disk
})

errors = ctx.sql(
    "select service, count(*) as errors from {recent} where level = 'ERROR' group by 1 order by 2 desc",
    recent=ctx.log("logs").last("15m"),
)
print(errors.explain())    # what it mounts, how many calls, what it costs
rows = errors.run().rows   # runs next to the data; only the rows come back
```

```ts
import * as archil from "seaway";

const ctx = await archil.context({
  logs: archil.disk("app-logs", "append"),
  obs: archil.disk("obs-agent", "owned"),
});

const errors = ctx.sql`
  select service, count(*) as errors
  from ${ctx.log("logs").last("15m")}
  where level = 'ERROR'
  group by 1 order by 2 desc`;
console.log(String(await errors.explain()));
const { rows } = await errors;   // awaiting a statement runs it
```

```
plan 158e748ceaa6  sql · 6 file(s), 140.4 KiB · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   logs/2026-11-09/14 → app-logs:/2026-11-09/14 (read-only)
          not mounted: obs
  reads   logs[last 15m]
  writes  —
  price   1 call unit $0.00005 + 140.4 KiB active for an hour <$0.00001 ≈ $0.00005
```

## The pieces

A **context** composes disks. Each mount has a mode, which is its mutation strategy.

| Mode | Meaning | On Archil |
|---|---|---|
| `read` | Live data, read-only | Mounted `readOnly` |
| `frozen` | Read-only, pinned to a checkpoint | A branch of the checkpoint, mounted `readOnly` |
| `owned` | This context is the only writer | A mount with `queueMs`: a checkout of the mount root, waited for up to five seconds |
| `shared` | Many writers | A `conditional` mount |
| `append` | Records are only added | `AppendObject`; commands see it read-only |

`shared` is Archil's *conditional* mode. It is not `archil mount --shared`, which is the mode an exec mount is in by default and needs a checkout before most writes.

A context is a value: `manifest()` and `from_manifest()` turn it into JSON and back, `narrow()` returns one that reaches less, `with_egress()` returns one whose commands reach less of the network, `lock()` returns a manifest with every mount frozen at a checkpoint, and `fork()` gives every writable disk a private branch.

A **statement** is `sh`, `sql`, `grep` or `batch`. Parameters that are paths (`ctx.path`, `ctx.glob`, `ctx.out`, a log selection) declare what it reads and writes. A statement with no path parameters sees the whole context. One with path parameters sees, on each disk it names, the smallest directory that covers those paths (read-only where it only reads, the mount in its own mode where it writes), and no other disk. Other parameters are values and are always quoted. `explain()` returns the plan and `run()` executes it. `map()` splits one input across calls and combines the outputs with a reducer you name. `into()` sends output to a file. `within()` sets a budget. `egress()` says what the call may reach on the network. A `sh` statement is bash on both backends.

A **plan** says how the work reaches the data (route), what each call can see (scope), how many calls and how they combine (split), and what it costs (price). `plan.to_dict()` in Python and `JSON.stringify(plan)` in TypeScript give the same document.

A **transaction** makes a turn's changes land together or not at all: for the disks it may write, snapshot isolation over files, first committer wins by path. It uses a checkpoint and a branch per written disk. Disks a turn only reads are read live, unless it asks for `serializable` and declares them.

A **log** is append-only records at `<path>/<date>/<hour>/<writer>.ndjson`. A selection (`last("15m")`, `between(a, b)`) reads only the partitions in range, and in SQL it is exactly the records in range. A **view** is a derived file that rebuilds only when its inputs changed. A **feed** reports what was added, changed or removed under a path since a cursor last looked; a changed file is handed over whole, with its earlier size so a reader can skip what it has seen. A **recipe** is an adapter shaped like an object store (`list`, `get`) plus a note on the layout it writes; `sync()` materialises it incrementally.

`ctx.tools()` returns tools for a model (`read_file`, `list_files`, `grep`, `run_bash`, `sql`, `plan`, and the two write tools when something is writable), with JSON schemas in OpenAI and Anthropic shapes.

## State in SQLite

`ctx.sql` is DuckDB over files, which suits logs and exports. (Over 2.7 GiB of raw logs on Archil, DuckDB answered a triage in 11 seconds and `sqlite3` in 29, because SQLite has to load the lines before it can query them.) State that is looked up by key and updated in place suits SQLite better, and it needs no verb of its own. `sqlite3` is in Archil's exec image, so a database is a file that a `sh` statement reads or writes. Locally it is the `sqlite3` on your PATH.

```python
db = "memory/state.db"
ctx.sh("sqlite3 {db} {q}", db=ctx.out(db),
       q="create table if not exists seen(id text primary key, note text); "
         "insert or replace into seen values ('ENG-1', 'closed after the coupon fix')").run(check=True)
rows = ctx.sh("sqlite3 -readonly -json {db} {q}", db=ctx.path(db), q="select * from seen").run(check=True).json()
```

```ts
const db = "memory/state.db";
const insert = "create table if not exists seen(id text primary key, note text); " +
  "insert or replace into seen values ('ENG-1', 'closed after the coupon fix')";
await ctx.sh`sqlite3 ${ctx.out(db)} ${insert}`.run({ check: true });
const rows = (await ctx.sh`sqlite3 -readonly -json ${ctx.path(db)} ${"select * from seen"}`.run({ check: true })).json();
```

Naming the database with `ctx.out` is what makes the write take the checkout on an `owned` disk, so a second writer waits. Each statement is one call, and its plan says so before it runs. Four things to know, all seen on Archil on 9 November 2026:

- **A database is one file, so it is one unit of conflict.** Two turns that change different rows of one database conflict, and the second is refused. Records that several agents edit side by side are better as a file each. SQLite is for state with one owner.
- **A read is not isolated from a write made by another call.** SQLite keeps readers and writers apart with file locks, and a lock taken in one call is invisible to another. A read that starts during a write finds the writer's journal and fails with `attempt to write a readonly database`: with a writer busy on a large table, 49 of 81 reads failed, nearly all that way. A read that is still open when a write commits can see both sides of it: one read transaction, held open across an update of every row, got back a minimum from before the update and a maximum from after. Where a read has to be right, name the database with `ctx.out` in the read as well, so that it takes the checkout as a writer would. All 23 reads made that way succeeded, and a transaction held open that way saw one state throughout. The write that arrived in the middle of it waited five seconds, came back with exit 30, and went through when it was run again. If a write is ever killed midway, reads fail the same way until the next write, which repairs the database as it opens it.
- **The image's `sqlite3` is 3.37.2, from 2022.** It has `json_extract` and not `->>`, and no `percentile`. The Node in the same image carries a current SQLite as `node:sqlite`.
- **From TypeScript there is also Archil's own [`@archildata/sqlite`](https://docs.archil.com/compute/sqlite).** It works the same way underneath: each query is one exec call, with a read-only mount for a read and a checkout for a write. Its reads take no checkout, so the second point applies to them as well.

## What the framework writes

All of it is plain files on the disk it concerns, so either SDK, or an agent with only bash, can read it.

| What | Where | Format |
|---|---|---|
| Context manifest | wherever you save it | `{"archilContext": 0, "name", "mounts": {name: {"disk", "mode", "at"?, "subdirectory"?, "description"?, "allow"?, "readOnly"?}}, "journal"?, "tools"?, "egress"?}`. `egress` is `"deny"` or a list of hosts |
| Log record | `<log>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`, UTC | One JSON object per line with `ts` (ISO, milliseconds, `Z`) and `id` (12 hex) added |
| Journal | the path given as `journal`, as a log by day | One record per statement: `kind`, `plan`, `statement`, `reads`, `writes`, `calls`, `callUnits`, `usd`, `ms`, `exit`. Commits, rollbacks and syncs are recorded too. `ts` is when it happened, which can be before it was written |
| View state | `<mount>/.px/views/<sha1 of the view's path, 16 hex>.json` | `{"path", "fingerprint", "plan", "builtAt", "usd"}`. A fingerprint ending in `~` is provisional: the view builds once more |
| Recipe state | `<mount>/.px/recipes/<sha1 of the target directory, 16 hex>.json` | `{key: version}` |
| Feed cursor | the path given as `cursor` | `{"feed": 0, "path", "seen": {path: [size, version]}}`. A version ending in `~` is provisional: the file is handed over again |
| A turn's changes | `<mount>/.px/tx/<id>.changes` on the turn's branch | Lines of `W<TAB>path` or `D<TAB>path` |
| Plan | `plan.to_dict()` | `{"plan": 0, "hash", "kind", "route", "statement", "vm", "parallel", "reduce", "effects": {"reads", "writes"}, "tasks": [{"command", "disks"}], "estimate", "notes"}`. `vm` is `{"vcpuCount", "memSizeMib", "baseImage"?, "network"?}` |

A plan's hash is the first 12 hex characters of the SHA-256 of `{kind, statement, vm, reduce, tasks}` as JSON with sorted keys and no spaces. It covers what a plan does and not what it costs.

A file's **version** is what views, feeds and turns compare. On the local backend it is the modification time in nanoseconds and the size. On Archil it is the ETag and the modification time in whole seconds: an ETag alone is not enough there, because a file rewritten in place through a mount keeps the ETag it was created with.

## Status

**Runs today.** Both SDKs on the local backend, which executes the same plans with real bash and uses directory copies for checkpoints and branches. The Python tests, the TypeScript tests, the conformance fixture and the interop check all pass, on Linux and on macOS.

**Run against Archil.** On 9 November 2026 both SDKs were run against a live account (aws-us-west-2, Developer plan): the three examples in each language, a check that one SDK reads what the other wrote on the same disks, and tests aimed at each mount mode, at contention, and at every failure listed below. Everything in this section comes from that run. The three assumptions the backend was written on turned out like this:

1. `archil checkpoints create` works from inside a serverless exec. It is one call and takes about a fifth of a second; a branch can be made from the checkpoint straight after. It needs a mount that is not read-only.
2. A branch's `filesystem_id` is an ordinary disk id. It mounts in an exec and reads through the object API.
3. DuckDB is **not** in the exec image. `ctx.sql` needs the binary on a disk (`archil.duckdb(ctx, "<mount>/bin")`) and `tools={"duckdb": "<mount>/bin/duckdb"}`, as above.

What else the run found, and what the SDKs now do about it:

- Archil runs a command with `/bin/sh`. Statements are handed to bash, so a `sh` statement means the same thing on both backends.
- An ETag does not change when a file is rewritten in place through a mount. Versions on Archil therefore carry the modification time too, which a listing gives in whole seconds. To cover the second that leaves open, a view or a feed does not trust a version of a file written under about a second and a half ago (the view builds once more; the feed hands the file over again), and a turn that starts that soon after a write waits out the difference before it takes its snapshot.
- While a statement holds an `owned` disk's checkout, a direct `write`, `append` or `rm` on that disk is refused. That is a `Busy` error. A journal on that disk keeps the entries it could not write and writes them with the next one.
- Search takes a directory. Asked for one file, the SDK searches its directory for that name. It looks in hidden files, ignores `.gitignore`, and passes over binary files; the local backend does the same.
- Output is cut at 4 MiB a stream, keeping the first bytes and ending in `[output truncated]`. The local backend cuts the same way.
- A mount that cannot be made, a checkout that could not be taken, and a command that ran past five minutes come back as results with exit codes 1, 30 and 124, as they do locally.

**Known limits.**

- A commit is not atomic across files, and on Archil there is a window between checking for conflicts and copying. Both need a native merge; the essay says what that could be.
- Every turn leaves a branch and a checkpoint behind, on each disk it could write. Archil cannot delete either except by deleting the disk.
- Versions on Archil rest on a clock. If the caller's clock is more than half a second off Archil's, a file rewritten in place, at the same size, within a second of its last change can still go unnoticed.
- In Python an `owned` mount cannot be written from a custom image (`sized(image=...)`). The Python client cannot ask for a checkout on the mount, so the command takes it with the `archil` CLI, and only Archil's own exec image has that. Use `shared`, or the TypeScript SDK.
- Narrowing is enforced by the mount map inside a call. For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk.
- A statement that writes gets its whole disk mounted in the disk's mode, not just the directory it writes. Only reads are narrowed to a directory.
- A view's definition is not stored on the disk, only its output and a fingerprint. To rebuild a view you need the code that defined it.
- Prices are estimates from listings and public rates, not invoices, and they have not been compared with one: the billing API is not available in every region. The ledger counts every call, a checkpoint included, and counts a file's bytes once while this session keeps them warm. Grep estimates ignore `globs`, so they run high.
- An egress policy is enforced by Archil. The local backend can only cut the network entirely, and only in a namespace.
- A feed is a poll. A view's freshness check and a feed's poll list the whole path each time.
- Not built: services and sandboxes, a server-side planner, caching by plan hash, inferred reducers, a CLI.

## Keeping the two SDKs in step

`conformance/conformance.json` is generated from the Python SDK by `python conformance/generate.py`. It holds 33 statements with their compiled plans, hashes and printed text, plus tables for shell quoting, SQL literals, template rendering, glob matching, reducers and pricing. Both test suites replay it. Change the Python, regenerate, and the TypeScript tests say what to port.

`interop/run.sh` has one SDK build logs, a view, a feed cursor, recipes and a transaction on a local root, then has the other open the same root, check that everything is as it would have left it, make its own changes, and hand back for verification. Then it swaps them.
