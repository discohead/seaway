# seaway

**The layer in front of `exec`: a framework for [Archil](https://archil.com).**

Define the context an agent needs. Then run statements against it that say what they touch, explain themselves before they run, and carry a price from Archil's public price sheet.

> "…start thinking very hard about how we start to represent Archil, as a framework, that can be used to programmatically define and interact with the context that agents need."
>
> Hunter Leath, [Who will build Vercel for agents?](https://archil.com/post/who-will-build-vercel-for-agents)

seaway is a working answer to that sentence. It is two SDKs, Python and TypeScript, with one API, built on Archil's official clients (`archil` on PyPI, `disk` on npm) and using them for every call. It runs today: on a local backend with no account, and on Archil.

It is an unofficial prototype, packaged under its own name so it installs beside the official SDKs.

## The idea

Archil's post [Bash is the SQL for file systems](https://archil.com/post/serverless-execution) ends: "The SQL analogy gets a little closer to literal with every step." seaway takes it literally.

If bash is the SQL, then `exec` is the executor, the part of a database that runs a query. Archil's is very good: the compute sits next to the data, it starts in tens of milliseconds, and it costs five cents per thousand calls. But SQL gives you more than a place to run it. It gives you everything in front of the executor, and that is what makes it something you build on. seaway is that layer, and each piece of it compiles to something Archil already does.

| A database gives you | seaway gives you | Which on Archil is |
|---|---|---|
| A catalog | A **context**: disks composed under path names, each with a mutation strategy | A mount map: `readOnly`, `conditional`, checkouts, branches |
| Bound parameters | A **statement**: a path parameter declares what the command reads or writes, and a value is always quoted | The `disks` of an exec call, worked out for you |
| `EXPLAIN` | A **plan**: route, scope, split and price, before anything runs | A listing and the price sheet |
| Transactions | A **turn**: snapshot isolation over files, first committer wins | A checkpoint and a branch per written disk |
| Materialised views | A **view**: a derived file that rebuilds only when its inputs changed | A listing compared with a fingerprint |
| A cost model | A price on every plan, and budgets enforced before a call is made | Three meters: calls, active data, egress |

## One example

```ts
import * as archil from "seaway";

const ctx = await archil.context({
  logs: archil.disk("app-logs", "append"),   // services append here; nothing rewrites it
  obs:  archil.disk("obs-agent", "owned"),   // this agent's own disk
});

const errors = ctx.sql`
  select service, count(*) as errors
  from ${ctx.log("logs").last("15m")}
  where level = 'ERROR'
  group by 1 order by 2 desc`;

console.log(String(await errors.explain()));
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

```ts
const { rows } = await errors;   // runs next to the data; only the rows come back
// [{"service":"checkout","errors":53},{"service":"api","errors":2},{"service":"search","errors":2}]
```

Nothing ran until the last line. The plan says what will: one exec call, with one hour's directory of one disk mounted read-only, the agent's own disk not mounted at all, and a price. The code chose none of that. It said which records it wanted, and the mount map, the route and the price followed.

<details>
<summary>The same in Python</summary>

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

</details>

### Where the decisions live

Here is the same question with the official SDK.

```ts
import { Archil } from "disk";
const archil = new Archil();

const { stdout } = await archil.exec({
  disks: {
    logs:  { disk: "dsk-0123456789abcdef", subdirectory: "2026-11-09/14", readOnly: true },
    tools: { disk: "dsk-fedcba9876543210", subdirectory: "bin", readOnly: true },   // DuckDB is not in the exec image
  },
  command: `/mnt/archil/tools/duckdb -json -c "select service, count(*) as errors
            from read_json_auto('/mnt/archil/logs/*.ndjson')
            where level = 'ERROR' and ts >= '${since}'
            group by 1 order by 2 desc"`,
});
const rows = JSON.parse(stdout);
```

That does the job, and it isn't much longer. What differs is where the decisions live. The caller decided which disk the call may see, at which subdirectory, and whether it may write. The caller knew the image has no DuckDB, chose an exec over a grep or a plain read, decided one call was enough, pasted a value into SQL inside a shell string, and had no idea what it would cost.

A harness makes those decisions for every tool call an agent issues. In practice they get made once, in the helper behind the bash tool, and the safe choice there is to mount everything on every call. And because they are made in the caller's code, all Archil receives is a string and a mount map. A planner on the server has nothing to work with.

A seaway statement carries that information, and is no more work to write.

## Four ideas

### A context is a value

```ts
const ctx = await archil.context({
  skills:  archil.disk("org-skills", "frozen", { at: "2026-11-01" }),
  tracker: archil.disk("tracker-mirror", "read"),
  memory:  archil.disk("agent-7-memory", "owned"),
  team:    archil.disk("team-notes", "shared"),
  audit:   archil.disk("audit-log", "append"),
});
```

The same post says an agent's storage has to be "composable across several different sources, with different access controls, permissions, and mutation strategies." Here that sentence is close to a literal. The second argument is the mutation strategy. There are five, and each is something Archil does today.

| Mode | Meaning | On Archil |
|---|---|---|
| `read` | Live data, read-only | Mounted `readOnly` |
| `frozen` | Read-only, pinned to a checkpoint, so every run sees the same bytes | A branch of the checkpoint, mounted `readOnly` |
| `owned` | This context is the only writer | A mount with `queueMs`: a checkout of the mount root, waited for up to five seconds |
| `shared` | Many writers | A `conditional` mount |
| `append` | Records are only added | `AppendObject`; commands see it read-only |

(`shared` is Archil's *conditional* mode. It is not `archil mount --shared`, which is the mode an exec mount is in by default.)

Because a context is a plain value, the things you want to do with one are short.

- `manifest()` turns it into a small JSON document and `fromManifest()` turns it back: an `agent.json`.
- `narrow()` returns a context with the same path names and a smaller reach, to hand to a sub-agent.
- `withEgress()` returns one whose commands reach less of the network, or none of it.
- `lock()` checkpoints every mount and returns a manifest with all of them frozen: the input to a replay or an eval.
- `fork()` gives each of several attempts its own copy-on-write branch of every writable disk.

### A statement says what it touches

```ts
ctx.sh`rg -c timeout ${ctx.path("tracker/issues")}`                               // reads one directory
ctx.sh`sort -u ${ctx.glob("team/leads/*.csv")} > ${ctx.out("memory/leads.csv")}`  // reads one disk, writes another
ctx.sh`echo ${userInput}`                                                         // a value: always one quoted word
ctx.sh`ls -R`                                                                     // declares nothing
```

This is the idea the rest depends on. From a path parameter the SDK gets the mount map: the first statement mounts `tracker/issues` read-only and nothing else, and the second takes a checkout on `memory` only. It gets sizes from a listing, and so a price. It knows what can be split, because a glob is a list of files. It knows what to write in the journal. And it knows what a view depends on. That is five things from one declaration, and the declaration is how you would have written the command anyway.

It is gradual on purpose. A statement that declares nothing still runs, with the whole context mounted, and its plan says what it cost to be vague:

```
  note    no paths declared, so all 5 mount(s) are attached; pass paths as parameters to mount only what the command needs
```

Values are handled the way you would hope. One of the tests passes `x'; touch work/owned; echo '` as a value and checks that the file never appears.

### A plan you can read

`explain()` returns the plan: how the work reaches the data (route), what each call can see (scope), how many calls there are and how they combine (split), and what it costs (price). Printed, it is the block above. As JSON, each of its tasks is almost the body of a request to `/api/exec` as it exists now: a command and a `disks` map.

The planner knows more than one route. Reads, writes, appends and listings go straight to the S3-compatible API and use no compute. A search goes to Archil's native grep, which is one call however many files there are. Everything else is an exec.

It never guesses at parallelism. A command is split across calls only when the caller says which input to split and how to put the outputs back together:

```ts
const byPath = ctx.sh`cat ${ctx.glob("logs/**/checkout-*.ndjson")} | jq -r 'select(.level == "ERROR") | .path' | sort | uniq -c`
  .map({ reduce: "sum_by_key", shards: 4 });
```

Today the SDK is both planner and executor. But a plan is the document a planner on Archil's side would need, which suggests a way there in steps: first accept a plan as a request and run it as given, then start rewriting it with what only the server knows. Client code doesn't change at any step, because it never said how to run the statement.

### A turn is a transaction

Archil's post on [file system transactions for agents](https://archil.com/post/building-file-system-transactions-for-agents) says: "The unit of atomicity for agents is a task, a goal, or a turn." And then: "What's left? Merging."

```ts
await ctx.transaction(async (turn) => {
  await turn.sh`echo '- agent-7: ENG-1 is done' >> ${turn.out("team/standup.md")}`.run({ check: true });
  await turn.write("memory/eng-1.md", "Closed after the coupon fix.\n");
}, { writes: ["team", "memory"] });
```

A turn's changes land together or not at all. For the disks it may write, the semantics are snapshot isolation over files, with the first committer winning at path granularity. Underneath it is a checkpoint and a branch per written disk. One of the examples runs two agents from the same starting state against a shared note:

```
agent-8 commits: [ 'team/standup.md' ]
agent-7 conflicts on: [ 'team/standup.md' ] and its memory is untouched: true
after the retry: [ '- agent-8: rewrote the file', '- agent-7: ENG-1 is done' ]
```

Agent 7 lost. Its write to its own memory disk was not applied either, because the turn is the unit. It ran the turn again from the new state and committed. Optimistic control fits agents: a turn is cheap to run again, and conflicts should be rare.

### And on top of those

- A **log** is append-only records at `<path>/<date>/<hour>/<writer>.ndjson`. A selection (`last("15m")`, `between(a, b)`) reads only the partitions in range.
- A **view** is a derived file that rebuilds only when its inputs changed.
- A **feed** reports what was added, changed or removed under a path since a cursor last looked. An idle poll makes no call and reads no data.
- A **recipe** turns a system of record into files: an adapter shaped like an object store (`list`, `get`) plus a note on the layout it writes, which becomes the directory's README. `sync()` materialises it incrementally.
- **`ctx.tools()`** returns tools for a model (`read_file`, `list_files`, `grep`, `run_bash`, `sql`, `plan`, and the write tools when something is writable), with JSON schemas in OpenAI and Anthropic shapes. A model can be handed a `plan` tool next to its `run_bash` and see what a command will cost before it runs it.

Everything the framework keeps is a plain file on the disk it concerns, so either SDK, or an agent with only bash, can read it. The journal is NDJSON it can `jq`. A manifest is JSON it can write. A view is a file it can `cat`.

## Shaped like the price sheet

Archil's [pricing](https://archil.com/pricing) has three meters a statement can move: calls at $0.05 per thousand, active data at $0.20 per GiB-month, and egress at $0.07 per GB leaving Archil. A planner's job is to move them as little as it can. Because the meters are simple, the rules are few.

| Rule | Meter it saves | In seaway |
|---|---|---|
| Don't use compute to move bytes | calls | `read`, `write`, `append` and `ls` go straight to the S3-compatible API |
| Send the question to the data | egress | A statement returns its result; `into()` keeps a large output on the disk |
| One search is one call | calls | `grep` uses the native parallel grep: one call per disk |
| Touch only what the question needs | active data | A log is partitioned by hour, and a selection reads only the partitions in range |
| Many small questions, one call | calls | `batch([...])` runs several statements in one exec and returns a result for each |
| Don't rebuild what hasn't changed | calls, active data | A view fingerprints its inputs from a listing and skips the build |
| Don't poll with compute | calls | A feed compares listings |
| Don't copy to isolate | active data, archive | Forks, locks and turns are branches |
| Don't keep a machine warm | sandbox hours | Nothing on the main path creates a sandbox |

Since every plan carries a price, a budget is enforced before anything runs: `statement.within({ maxUsd: 0.01 })` for one statement, `ctx.withBudget(...)` for a session.

There is a second reason to design this hard for these meters. Software built this way, with nothing running between questions, questions sent to the data, and layouts chosen so that a question touches little, is cheap on Archil. On a platform that bills for idle compute or for reads, it is expensive or doesn't work at all. Apps and recipes shaped like the price sheet are an advantage a competitor doesn't get by matching a cold-start time.

## The Datadog afternoon

`examples/datadog_afternoon.py`, with a TypeScript twin, is observability on a disk. It follows Archil's [Agentic observability](https://docs.archil.com/guides/agents/agentic-observability) guide (the same two disks, the same hourly layout), so the two can be read side by side.

| Piece | Is |
|---|---|
| Ingest | Services appending JSON lines. There is no collector, and no compute |
| Triage | One `sql` statement comparing the last fifteen minutes with the hour before |
| Search | `ctx.grep(...)`: one call |
| The question nobody planned for | A `jq` pipeline, mapped across four calls and summed |
| A report | A view. Refresh it twice and the second does nothing |
| An alert | A feed. When nothing has changed, the poll costs nothing |
| The agent's own telemetry | A journal on its own disk: one line per statement, with its plan, its reads and writes, and its cost |

The whole example, six statements over about thirteen thousand log lines, comes to nine calls: $0.00045 by the estimate. At a larger size, 2.7 GiB of raw logs in 23.8 million lines on Archil, DuckDB answered the triage from the raw files in 11 seconds on the default exec size.

Here is the arithmetic at two realistic sizes: thirty days of logs retained on a managed disk, triage every five minutes. The figures are worked out from the public price sheet. They are not measured.

| Per month | 5 GiB of logs a day | 50 GiB a day |
|---|---|---|
| Archive, 30 days retained | $4.03 | $40.27 |
| Active data (triage keeps two to three hours of logs warm) | $0.11 | $1.15 |
| Triage, 8,640 calls | $0.43 | $0.43 |
| Total | about $4.60 | about $42 |

Most of the bill is the archive rate. This is not Datadog: there is no UI, no alert routing, and no metrics or traces. The claim is narrower. The back end reduces to a layout and a handful of statements, and those are things an agent can write.

## Try it

Everything runs on a local backend, with no account.

```bash
git clone https://github.com/discohead/seaway && cd seaway
```

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

The SQL examples and the interop check need the `duckdb` CLI and `jq` on your PATH. The Python `dev` extra installs `duckdb`.

On Linux the local backend runs each call in its own mount namespace, so a read-only mount really is read-only and a denied network really is cut. Where that isn't available, macOS included, it falls back to symlinks: it reports a write to a read-only mount after the fact and leaves the network open.

### On Archil

Set `ARCHIL_API_KEY` and `ARCHIL_REGION`, then run any example with `--archil`:

```bash
python examples/datadog_afternoon.py --archil --cleanup
node examples/datadog-afternoon.ts --archil --cleanup
```

Every disk an example names gets a prefix that is new for the run, so an example never opens a disk that is already in your account. It prints the disks it created, and `--cleanup` deletes them when it ends. A run costs a fraction of a cent.

In your own code, leave out the `backend` argument and a context uses Archil when `ARCHIL_API_KEY` is set. Two things to know first:

- **SQL needs DuckDB, and Archil's exec image does not have it.** Put the CLI on a disk once and tell the context where it is:

  ```python
  ctx = archil.context({...}, tools={"duckdb": "obs/bin/duckdb"})
  archil.duckdb(ctx, "obs/bin").run(check=True)     # one call; the binary stays on the disk
  ```

  The recipe downloads DuckDB's release archive from GitHub and checks it against a pinned SHA-256 before it unpacks anything. Another `version`, or a `url` of your own, has to come with its `sha256`.

- **Commands have the whole internet unless you say otherwise.** A mount map limits what a command can read, not where it can send it. `ctx.with_egress("deny")` (or a list of hosts) sets a policy for everything a context runs, its tools included, and `statement.egress(...)` sets one for a single call. Archil takes a policy on the Developer plan and above.

## What's real

**Runs today.** Both SDKs, on a local backend that executes the same plans with real bash and uses directory copies for checkpoints and branches. The Python tests, the TypeScript tests, the conformance fixture and the interop check all pass, on Linux and on macOS.

**The two SDKs are one framework.** A shared fixture of 33 statements has to compile to identical plans, hashes and printed text in both languages. A second check has one SDK build logs, a view, a feed cursor, recipes and a transaction on a disk, then has the other open the same disk and find everything as it would have left it. Then it swaps them.

**Run against Archil.** On 9 November 2026 both SDKs were run against a live account (aws-us-west-2, Developer plan): the three examples in each language, the cross-SDK check on live disks, and tests aimed at each mount mode, at contention, and at each failure listed below. The backend was written on three assumptions. Two held, and one did not:

1. `archil checkpoints create` works from inside a serverless exec. It is one call and takes about a fifth of a second, and a branch can be made from the checkpoint straight after.
2. A branch's `filesystem_id` is an ordinary disk id. It mounts in an exec and reads through the object API.
3. DuckDB is **not** in the exec image. `ctx.sql` needs the binary on a disk, and the SDK has a recipe that puts it there.

**What else the run found**, and what the SDKs now do about it:

- An exec runs its command with `/bin/sh`. Statements are handed to bash, so a `sh` statement means the same thing on both backends.
- An ETag does not change when a file is rewritten in place through a mount. Versions on Archil therefore carry the modification time too, and the SDKs do not trust a version that is under about a second and a half old.
- While a statement holds an `owned` disk's checkout, a direct write on that disk is refused. That is a `Busy` error, and a journal on that disk keeps the entries it could not write.
- Search takes a directory, not a file. Output is cut at 4 MiB a stream and keeps the first bytes. The local backend now does both the same way.
- A SQLite read on a read-only mount is not isolated from a write made by another call: with a writer busy on a large table, 49 of 81 reads failed. A read that names the database as an output takes the checkout as a writer would, and all 23 reads made that way succeeded. [State in SQLite](plugins/seaway/skills/sdk/references/sqlite.md) has the rest.

**Known limits.**

- A commit is not atomic across files, and on Archil there is a window between checking for conflicts and copying. Both need a native merge.
- Every turn leaves a branch and a checkpoint behind, on each disk it could write. Archil cannot delete either except by deleting the disk.
- Versions on Archil rest on a clock. If the caller's clock is more than half a second off Archil's, a file rewritten in place, at the same size, within a second of its last change can still go unnoticed.
- In Python an `owned` mount cannot be written from a custom image. The Python client cannot ask for a checkout on the mount, so the command takes it with the `archil` CLI, and only Archil's own exec image has that. Use `shared`, or the TypeScript SDK.
- Narrowing is enforced by the mount map inside a call. For direct reads and writes the SDK checks paths itself, because Archil credentials cover a whole disk.
- A statement that writes gets its whole disk mounted in the disk's mode, not just the directory it writes. Only reads are narrowed to a directory.
- A view's definition is not stored on the disk, only its output and a fingerprint. To rebuild a view you need the code that defined it.
- Prices are estimates from listings and public rates, not invoices, and they have not been compared with one: the billing API is not available in every region. The ledger counts every call, a checkpoint included, and counts a file's bytes once while this session keeps them warm. Grep estimates ignore `globs`, so they run high.
- An egress policy is enforced by Archil. The local backend can only cut the network entirely, and only in a namespace.
- A feed is a poll. A view's freshness check and a feed's poll list the whole path each time.
- Not built: services and sandboxes, a server-side planner, caching by plan hash, inferred reducers, a CLI.

## What it would ask of the platform

This is as far as the idea goes from the client. Each of these is something the SDK works around today.

1. **Accept a plan.** Take the plan document as a request, run its tasks next to each other, and return the results. Today the SDK makes one HTTP call per task from wherever the caller happens to be.
2. **Return what a call did.** If an exec result included the paths it wrote and what it metered, estimates would become facts, and a turn's change list would no longer need a listing comparison.
3. **Merge as a conditional apply.** For a turn, one side of the merge is small and already known. So the primitive doesn't have to be a tree merge. It can be: apply this branch's changes to its parent if none of these paths have changed on the parent since this checkpoint, and otherwise say which ones did. With it go a REST call for checkpoints and a way to delete branches.
4. **A change feed.** A feed is a cheap poll today. If system events are going to be most of the triggers, they need a push.
5. **Path-scoped credentials**, so that narrowing holds for direct reads and writes and not only inside a call.
6. **DuckDB in the exec image**, so that SQL over files needs no setup step.

## With Claude Code

seaway is new, so a model knows nothing about it, and without help it writes plausible code against an API that does not exist. `plugins/seaway` is a plugin for Claude Code that gives it the real one to read first: skills for both SDKs, a linter for the mistakes that are easy to make, agents that review and port, and an MCP server that opens a context as tools, with plans and prices.

```bash
claude plugin marketplace add discohead/seaway
claude plugin install seaway@seaway
```

Then run `/seaway:setup` in a session. The MCP server loads the TypeScript SDK from a checkout of this repository, and setup finds one or clones it and points the plugin there. Its [README](plugins/seaway/README.md) says what is in it. Every example in its skills is run against both SDKs by the plugin's tests.

## Where to go next

| For | Read |
|---|---|
| The Python SDK, the reference | [python/](python/README.md) |
| The TypeScript SDK | [typescript/](typescript/README.md) |
| The API in both languages, part by part | [plugins/seaway/skills/sdk/](plugins/seaway/skills/sdk/SKILL.md) and its [references](plugins/seaway/skills/sdk/references/) |
| Designing something on seaway: disks, modes, layout, price | [eight worked blueprints](plugins/seaway/skills/design/references/blueprints.md) |
| Local against Archil, and what the exec image has | [backends](plugins/seaway/skills/sdk/references/backends.md) |
| Every file the framework writes | [files on disk](plugins/seaway/skills/sdk/references/files-on-disk.md) |
| Working on seaway itself | [CONTRIBUTING.md](CONTRIBUTING.md) |

seaway is an unofficial proposal. The repository does not carry a licence yet.
