---
name: contributing
description: Work on the seaway repository itself, where the Python SDK is the reference and the TypeScript SDK is a port of it. Covers the order a change in behaviour has to go in, regenerating the conformance fixture, porting to TypeScript, the interop check, the test commands, and what must stay identical between the two SDKs.
when_to_use: Use when editing files under python/src/seaway, typescript/src, conformance/ or interop/ in a seaway checkout, when adding or changing SDK behaviour, a plan's shape, an error, a price or an on-disk format, when a conformance or interop test fails, or when asked to keep the two SDKs in step. Not for code that merely uses seaway; that is the seaway:sdk skill.
---

# Working on seaway

The repository holds two SDKs with one API, and two checks that keep them one.

```text
python/        the Python SDK (the reference), its tests and examples
typescript/    the TypeScript SDK (a port), its tests and examples
conformance/   33 statements with the plans both SDKs must compile them to, and tables for the small things
interop/       a check that the two SDKs can work on the same disk, each way round
```

## The rule

**Python is the reference. TypeScript is a port of it.** A change in behaviour is made in the Python first. The fixture is then regenerated from the Python, and the TypeScript is changed until it reproduces the fixture. Never the other way round, and never by editing the fixture.

What has to be identical in both, to the byte unless noted:

- a statement's plan: `plan.to_dict()` and `JSON.stringify(plan)`, the printed plan, and the hash (numbers named `usd*` may differ by 1e-9);
- `ctx.manifest()` and `ctx.describe()`;
- how a value is quoted for the shell, written as a SQL literal, and rendered into a template; how a glob matches; what each reducer returns;
- error codes, and the text of messages and suggestions that reach a plan, a tool or a file;
- every file the framework writes to a disk: log records, the journal, view and recipe state, feed cursors, a turn's change list;
- a file's version on the local backend, so that both SDKs can work on one root.

## The order of a change

1. **Change the Python** in `python/src/seaway/`, with a test in `python/tests/`.
2. **Run the Python tests.**
3. **Regenerate the fixture** if anything a plan, a table or `describe()` shows could have changed: `python conformance/generate.py`. Read the diff of `conformance/conformance.json`. It should show what you meant to change and nothing else.
4. **Port the change** to the twin file in `typescript/src/`, with its test in `typescript/test/`. See [references/porting.md](references/porting.md).
5. **Run the TypeScript tests and the typecheck.** The conformance test says, case by case, what does not match yet.
6. **Run the interop check.** It prints `PROBLEMS: 0` when the two agree.
7. **Update the prose** that states a number or a behaviour: the README gives test counts and lists known limits, and CONTRIBUTING.md gives test counts and the table of files the framework writes.

A change that only moves code around, in either SDK, needs its own SDK's tests and nothing else. A change to an on-disk format, an error code or a plan's shape is a change to both SDKs and to every disk already written: say so, and prefer adding to changing.

## Commands

Each block starts from the repository's root. The SQL tests and examples need the `duckdb` CLI and `jq` on the PATH; the Python `dev` extra installs `duckdb`.

```bash
# Python 3.10+; the package has no runtime dependencies
cd python
pip install -e '.[dev]'                 # pytest, the official archil SDK, the duckdb CLI
python -m pytest -q                     # the whole suite
python -m pytest -q tests/test_statements.py -k map
python examples/quickstart.py           # also agent_context.py and datadog_afternoon.py
```

```bash
# Node 22.19+, which runs .ts directly; there is no build step
cd typescript
npm install                             # typescript, @types/node, and the official disk SDK
npm test                                # node --test test/*.test.ts
node --test test/statements.test.ts     # one file
npm run typecheck                       # tsc --noEmit
node examples/quickstart.ts             # also agent-context.ts and datadog-afternoon.ts
```

```bash
python conformance/generate.py          # rewrites conformance/conformance.json from the Python SDK
./interop/run.sh                        # both SDKs on one local root, each way round; needs python3, node and duckdb
```

- **Check which Python `python3` is.** `interop/run.sh` and the generator run whatever is first on the PATH, and the SDK needs 3.10 or later. `seaway-doctor` says what is there.
- **Without `pip install`,** the Python SDK still imports with `PYTHONPATH=python/src`. Without `npm install`, the TypeScript SDK still runs, and the tests that need the official SDK are skipped.
- **The tests never need an account.** They run on local backends in temporary directories, and the Archil backend is tested against a fake client that behaves the way the live service did.
- **Keep an API key out of the way.** With `ARCHIL_API_KEY` exported, anything that opens a context without a backend reaches the live account. The suites pass backends explicitly; a script of your own may not. `ARCHIL_BACKEND=local` forces the local one.
- On macOS the local backend mounts by symlink, and the two tests that need a mount namespace are skipped.

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

## The fixture

`conformance/conformance.json` is generated. Its `about` field says so: do not edit it by hand. It holds:

- `cases`: 33 statements, each with the plan the Python SDK compiled it to and the plan's printed text;
- `manifest`, `describe`, `narrowed`: the fixture context as both SDKs must describe it;
- tables: `quote`, `sqlLiteral`, `render`, `globs`, `reducers`, `describeParam`, `canonical`, `pricing`.

To cover something new, add to the lists at the top of `conformance/generate.py` (`CASES`, `QUOTE`, `SQL`, `RENDER`, `GLOBS`, `REDUCE`, `DESCRIBE`) and regenerate. A case describes a statement in language-neutral JSON, which `conformance/harness.py` and `typescript/test/harness.ts` both turn into a statement:

```json
{"name": "into a file on an owned mount takes a checkout", "kind": "sh",
 "template": "sort -n {d}/n1.txt {d}/n2.txt", "params": {"d": {"path": "ref/data"}}, "into": "work/out/sorted.txt"}
```

A parameter is `{"path"}`, `{"out"}`, `{"glob"}`, `{"raw"}`, `{"value"}`, `{"log", "between" | "last" + "now"}` or a list of those. A case can also carry `map`, `into`, `sized`, `egress`, `narrow`, and for `grep`, `pattern`, `over`, `options`; a `batch` has `children`. A new kind of key needs both harnesses taught to read it.

The fixture's disks and context are in `harness.py` (`DISKS`, `CONTEXT`). Pin every clock: a case with `last` gives `now`.

## The interop check

`interop/run.sh` has one SDK seed a local root (logs, a view, a feed cursor, two recipes, a transaction), has the other open the same root and check that everything is as it would have left it, make changes of its own, and hand back for verification. Then it swaps them. `interop/compare.py` compares what each side reported and exits non-zero on any difference. Output is left in `interop/out/`.

When it fails, the line names what differed: a listing, a plan, a fingerprint, a sync result. A view that one SDK built and the other finds stale means the two compute a fingerprint or a version differently. That is usually a difference in how something is written as text: see `compat.ts`.

## What not to do

- Do not edit `conformance/conformance.json`, or change the TypeScript to behave differently from the Python and leave it there.
- Do not add a runtime dependency to either SDK. Both have none; the official SDKs are optional and loaded only when the Archil backend is used.
- Do not change a file format, a `.px/` path, an error code or a plan field in one SDK only.
- Do not write to `.archil/` on a disk. It is Archil's. The framework's own files go under `.px/`.
- Do not let a test reach an account, or depend on the clock, the locale or the order of a directory listing.
- Do not return a statement from an `async` function in the TypeScript: awaiting it runs it.
