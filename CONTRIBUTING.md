# Contributing to seaway

This is for people changing seaway itself. To use it, start with the [README](README.md).

seaway is two SDKs with one API, and two checks that keep them one. Most of what follows is about not letting them drift.

```
python/        the Python SDK (the reference), its tests and examples
typescript/    the TypeScript SDK (a port), its tests and examples
conformance/   33 statements with the plans both SDKs must compile them to, and tables for the small things
interop/       a check that the two SDKs can work on the same disk, each way round
plugins/       a Claude Code plugin for working with seaway
```

## The rule

**Python is the reference. TypeScript is a port of it.** A change in behaviour is made in the Python first. The fixture is then regenerated from the Python, and the TypeScript is changed until it reproduces the fixture. Never the other way round, and never by editing the fixture.

## Setting up

Each block starts from the repository's root. Nothing here needs an Archil account.

```bash
# Python 3.10+; the package has no runtime dependencies
cd python
pip install -e '.[dev]'                 # pytest, the official archil SDK, the duckdb CLI
python -m pytest -q                     # the whole suite: 134 tests
python -m pytest -q tests/test_statements.py -k map
python examples/quickstart.py           # also agent_context.py and datadog_afternoon.py
```

```bash
# Node 22.19+, which runs .ts directly; there is no build step
cd typescript
npm install                             # typescript, @types/node, and the official disk SDK
npm test                                # node --test test/*.test.ts: 168 tests, plus one that needs zod
node --test test/statements.test.ts     # one file
npm run typecheck                       # tsc --noEmit
node examples/quickstart.ts             # also agent-context.ts and datadog-afternoon.ts
```

```bash
python conformance/generate.py          # rewrites conformance/conformance.json from the Python SDK
./interop/run.sh                        # both SDKs on one local root, each way round; prints PROBLEMS: 0
node --test plugins/seaway/tests/       # the plugin: linter, hooks, MCP server, and every example in its skills
```

Things that catch people out:

- **Check which Python `python3` is.** `interop/run.sh` and the generator run whatever is first on the PATH, and the SDK needs 3.10 or later. The `python3` that ships with macOS is older.
- **The SQL tests and examples need the `duckdb` CLI and `jq`** on the PATH. The Python `dev` extra installs `duckdb`. A test that cannot run is skipped and says why.
- **Without `pip install`,** the Python SDK still imports with `PYTHONPATH=python/src`. Without `npm install`, the TypeScript SDK still runs, and the tests that need the official SDK are skipped.
- **On macOS the local backend mounts by symlink,** and the two tests that need a mount namespace are skipped. `ARCHIL_LOCAL_ISOLATION=symlink` forces the fallback on Linux.
- **Search uses `rg` when it is installed** and the SDK's own implementation when it is not. The two give the same answers.

## The order of a change

1. **Change the Python** in `python/src/seaway/`, with a test in `python/tests/`.
2. **Run the Python tests.**
3. **Regenerate the fixture** if anything a plan, a table or `describe()` shows could have changed: `python conformance/generate.py`. Read the diff of `conformance/conformance.json`. It should show what you meant to change and nothing else.
4. **Port the change** to the twin file in `typescript/src/`, with its test in `typescript/test/`.
5. **Run the TypeScript tests and the typecheck.** The conformance test says, case by case, what does not match yet.
6. **Run the interop check.** It prints `PROBLEMS: 0` when the two agree.
7. **Update the prose** that states a number or a behaviour: the [README](README.md) gives test counts and lists known limits, this file gives the on-disk formats, and the plugin's skills document the API. The plugin's tests run every example in the skills, so they say which ones no longer hold.

A change that only moves code around, in either SDK, needs its own SDK's tests and nothing else. A change to an on-disk format, an error code or a plan's shape is a change to both SDKs and to every disk already written: say so, and prefer adding to changing.

## What has to be identical

To the byte, unless noted:

- a statement's plan: `plan.to_dict()` and `JSON.stringify(plan)`, the printed plan, and the hash (numbers named `usd*` may differ by 1e-9);
- `ctx.manifest()` and `ctx.describe()`;
- how a value is quoted for the shell, written as a SQL literal, and rendered into a template; how a glob matches; what each reducer returns;
- error codes, and the text of messages and suggestions that reach a plan, a tool or a file;
- every file the framework writes to a disk;
- a file's version on the local backend, so that both SDKs can work on one root.

### What the framework writes

All of it is plain files on the disk it concerns, so either SDK, or an agent with only bash, can read it. This table is the contract. The long form, with examples, is in [files-on-disk.md](plugins/seaway/skills/sdk/references/files-on-disk.md).

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

The framework's own files go under `.px/`. `.archil/` on a disk is Archil's, and is left alone.

## Where things are

| Python | TypeScript | What |
|---|---|---|
| `context.py` | `context.ts` | mounts, modes, narrowing, the data plane, manifests, checkpoint, lock, fork |
| `statement.py` | `statement.ts` | compiling `sh`, `sql`, `grep`, `batch` into plans; reducers; shards; results |
| `plan.py` | `plan.ts` | the plan document, its hash and its printed form |
| `shell.py` | `shell.ts` | paths, globs, quoting, templates; tagged templates are TypeScript only |
| `transaction.py` | `transaction.ts` | turns: begin, changes, commit, rollback |
| `structures.py` | `structures.ts` | logs and selections, views, feeds |
| `recipes.py` | `recipes.ts` | `Static`, `Records`, `sync`, `git`, `duckdb` |
| `tools.py` | `tools.ts` | tools for a model; `asFileSystem` is TypeScript only |
| `pricing.py` | `pricing.ts` | the price sheet, estimates, budgets, the ledger |
| `errors.py` | `errors.ts` | the error classes; the base is `Error` in Python and `ArchilError` in TypeScript |
| `backends.py` | `backends.ts` | the backend interface, `MountSpec`, `Vm`, `Limits` |
| `local.py` | `local.ts` | the local backend |
| `archil_backend.py` | `archil-backend.ts` | the Archil backend, over the official SDK |
| `__init__.py` | `index.ts` | what is exported |
| | `compat.ts` | what Python's built-ins do without being asked, written out |

Tests mirror the modules: `python/tests/test_*.py` and `typescript/test/*.test.ts`, with `test_conformance.py` and `conformance.test.ts` replaying the fixture.

## The conformance fixture

`conformance/conformance.json` is generated from the Python SDK. Do not edit it by hand. It holds:

- `cases`: 33 statements, each with the plan the Python SDK compiled it to and the plan's printed text;
- `manifest`, `describe`, `narrowed`: the fixture context as both SDKs must describe it;
- tables: `quote`, `sqlLiteral`, `render`, `globs`, `reducers`, `describeParam`, `canonical`, `pricing`.

Both test suites replay it. To cover something new, add to the lists at the top of `conformance/generate.py` (`CASES`, `QUOTE`, `SQL`, `RENDER`, `GLOBS`, `REDUCE`, `DESCRIBE`) and regenerate. A case describes a statement in language-neutral JSON, which `conformance/harness.py` and `typescript/test/harness.ts` both turn into a statement:

```json
{"name": "into a file on an owned mount takes a checkout", "kind": "sh",
 "template": "sort -n {d}/n1.txt {d}/n2.txt", "params": {"d": {"path": "ref/data"}}, "into": "work/out/sorted.txt"}
```

A parameter is `{"path"}`, `{"out"}`, `{"glob"}`, `{"raw"}`, `{"value"}`, `{"log", "between" | "last" + "now"}` or a list of those. A case can also carry `map`, `into`, `sized`, `egress`, `narrow`, and for `grep`, `pattern`, `over`, `options`; a `batch` has `children`. A new kind of key needs both harnesses taught to read it.

The fixture's disks and context are in `harness.py` (`DISKS`, `CONTEXT`). Pin every clock: a case with `last` gives `now`.

## The interop check

`interop/run.sh` has one SDK seed a local root (logs, a view, a feed cursor, two recipes, a transaction), has the other open the same root and check that everything is as it would have left it, make changes of its own, and hand back for verification. Then it swaps them. `interop/compare.py` compares what each side reported and exits non-zero on any difference. Output is left in `interop/out/`.

It catches what a plan does not show: files written by one SDK and read by the other. When it fails, the line names what differed: a listing, a plan, a fingerprint, a sync result. A view that one SDK built and the other finds stale means the two compute a fingerprint or a version differently. That is usually a difference in how something is written as text.

## Porting to TypeScript

Most of a port is mechanical: keyword arguments become an options object, `snake_case` becomes `camelCase`, and whatever touches the backend becomes `async`. The part that is not is everything Python does without being asked: how strings sort, how a float prints, where a line ends, what `json.dumps` looks like. JavaScript's defaults differ in each, and a difference shows up as a hash that does not match.

- **Everything of that kind lives in `typescript/src/compat.ts`**, and nowhere else. If a port needs one more Python behaviour, add it there with a comment saying what Python does.
- **Sort with `sorted()` from `compat.ts`**, not `Array.prototype.sort()`. Every listing is sorted by path before it is used, so plans are reproducible on any backend.
- **Port the words, not the gist.** A message or a suggestion that reaches a plan's notes, a tool's output or a test is part of the behaviour.
- **Never return a statement from an `async` function.** A statement is thenable, so awaiting it runs it.
- **Keep to syntax that can be erased.** The package runs from its `.ts` sources under Node's type stripping: no enums, no namespaces, no parameter properties, `import type` for types, and import paths that end in `.ts`.

When a plan's hash differs and the printed plan looks the same, compare `JSON.stringify(plan)` with the fixture's `plan` field by field. It is almost always a number written differently, a key order, or a sort. The full guide, with the table of what `compat.ts` covers and why, is [porting.md](plugins/seaway/skills/contributing/references/porting.md).

## Keeping tests off an account

- **The tests never need an account.** They run on local backends in temporary directories, and the Archil backend is tested against a fake client that behaves the way the live service did.
- **Keep an API key out of the way.** With `ARCHIL_API_KEY` exported, anything that opens a context without a backend reaches the live account: real disks, billed calls, and checkpoints and branches that cannot be deleted. The suites pass backends explicitly; a script of your own may not. `ARCHIL_BACKEND=local` forces the local one.
- **A run against Archil is deliberate.** The examples take `--archil`, work on disks under a prefix that is new for the run, and delete them with `--cleanup`. When a live run shows the service behaving differently from the fake client, change the fake client and add a test that behaves the way the live service did.

## The plugin

`plugins/seaway` has its own tests and its own notes for contributors, in [its README](plugins/seaway/README.md#working-on-the-plugin).

```bash
node --test plugins/seaway/tests/
claude plugin validate plugins/seaway --strict
claude plugin validate . --strict                 # the marketplace manifest
```

A fenced block marked `python` or `ts` in a skill is run as written, against both SDKs. A block marked `py` or `typescript` is there to be read. So when the SDK changes, the skills' examples fail until they are true again.

The plugin also does this work with you. With it installed, Claude Code loads `seaway:contributing` when you edit either SDK, `/seaway:parity` runs both suites, the fixture and the interop check, and the `seaway:sdk-porter` agent ports a change from the Python to the TypeScript.

## What not to do

- Do not edit `conformance/conformance.json`, or change the TypeScript to behave differently from the Python and leave it there.
- Do not add a runtime dependency to either SDK. Both have none; the official SDKs are optional and loaded only when the Archil backend is used.
- Do not change a file format, a `.px/` path, an error code or a plan field in one SDK only.
- Do not write to `.archil/` on a disk.
- Do not let a test reach an account, or depend on the clock, the locale or the order of a directory listing.

## Sending a change

Open an issue or a pull request at [github.com/discohead/seaway](https://github.com/discohead/seaway). Say what changed in behaviour, and whether it touches a plan, an error code or a file on disk. A pull request is ready when the Python tests, the TypeScript tests and typecheck, the interop check and the plugin's tests all pass, and the fixture's diff shows only what you meant.

The repository does not carry a licence yet.
