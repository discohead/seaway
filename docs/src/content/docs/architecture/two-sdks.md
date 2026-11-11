---
title: Two SDKs, one framework
description: Python is the reference and TypeScript is a port of it. A shared fixture of 33 statements has to compile to identical plans in both, and a second check has each SDK open a disk the other wrote.
---

seaway is two SDKs with one API. Python is the reference. TypeScript is a port of it. Two checks keep them one framework, and most of the work on seaway itself is about not letting them drift.

## The rule

**A change in behaviour is made in the Python first.** The fixture is then regenerated from the Python, and the TypeScript is changed until it reproduces the fixture. Never the other way round, and never by editing the fixture.

## What has to be identical

To the byte, unless noted:

- a statement's plan: `plan.to_dict()` and `JSON.stringify(plan)`, the printed plan, and the hash (numbers named `usd*` may differ by 1e-9);
- `ctx.manifest()` and `ctx.describe()`;
- how a value is quoted for the shell, written as a SQL literal, and rendered into a template; how a glob matches; what each reducer returns;
- error codes, and the text of messages and suggestions that reach a plan, a tool or a file;
- [every file the framework writes](/architecture/files-on-disk/) to a disk;
- a file's version on the local backend, so that both SDKs can work on one root.

## The conformance fixture

`conformance/conformance.json` is generated from the Python SDK. It holds:

- **33 statements,** each with the plan the Python SDK compiled it to and the plan's printed text;
- the fixture's context as both SDKs must describe it: its manifest, its `describe()`, and a narrowing of it;
- tables for the small things: quoting, SQL literals, rendering, globs, reducers, parameters, canonical JSON and prices.

Both test suites replay it. A case describes a statement in language-neutral JSON, which each SDK's harness turns into a statement:

```json
{"name": "into a file on an owned mount takes a checkout", "kind": "sh",
 "template": "sort -n {d}/n1.txt {d}/n2.txt", "params": {"d": {"path": "ref/data"}}, "into": "work/out/sorted.txt"}
```

A parameter is `{"path"}`, `{"out"}`, `{"glob"}`, `{"raw"}`, `{"value"}`, a log selection, or a list of those. The [MCP server](/agents/mcp-server/#a-statement-as-json) describes statements the same way.

Every clock in the fixture is pinned. A case with `last` gives `now`.

## The interop check

`interop/run.sh` catches what a plan does not show: files written by one SDK and read by the other.

1. One SDK seeds a local root: logs, a view, a feed cursor, two recipes, a transaction.
2. The other opens the same root, checks that everything is as it would have left it, and makes changes of its own.
3. The first verifies.

Then it swaps them, and compares what each side reported. It prints `PROBLEMS: 0` when the two agree.

When it fails, the line names what differed: a listing, a plan, a fingerprint, a sync result. A view that one SDK built and the other finds stale means the two compute a fingerprint or a version differently. That is usually a difference in how something is written as text.

## Why a port is not mechanical

Most of a port is mechanical: keyword arguments become an options object, `snake_case` becomes `camelCase`, and whatever touches the backend becomes `async`.

The part that is not is everything Python does without being asked: how strings sort, how a float prints, where a line ends, what `json.dumps` looks like. JavaScript's defaults differ in each, and a difference shows up as a hash that does not match.

- **Everything of that kind lives in `typescript/src/compat.ts`,** and nowhere else.
- **Sorting uses `sorted()` from `compat.ts`,** not `Array.prototype.sort()`. Every listing is sorted by path before it is used, so plans are reproducible on any backend.
- **The words are ported, not the gist.** A message or a suggestion that reaches a plan's notes, a tool's output or a test is part of the behaviour.
- **The TypeScript keeps to syntax that can be erased.** The package runs from its `.ts` sources under Node's type stripping: no enums, no namespaces, no parameter properties, `import type` for types, and import paths that end in `.ts`.

## What differs on purpose

The API is the same, in the idiom of each language. [Python and TypeScript](/reference/python-and-typescript/) lists every difference. The ones that are more than spelling:

- A TypeScript statement can be a tagged template, and is thenable.
- A TypeScript turn is a callback that receives the turn's own context.
- `asFileSystem` exists only in TypeScript, because the official tool layer it adapts to does.
- The TypeScript client can ask for a checkout on a mount. The Python client cannot, so in Python an `owned` mount cannot be written from a custom image.

## The tests

| Suite | Count | Needs |
|---|---|---|
| Python | 134 tests | Python 3.10+; `duckdb` and `jq` for the SQL tests |
| TypeScript | 168 tests, plus one that needs `zod` | Node 22.19+ |
| Conformance | 33 statements and eight tables, replayed by both suites | nothing more |
| Interop | both SDKs on one root, each way round | both of the above |
| The plugin | its linter, hooks, MCP server, and every example in its skills | Node; both SDKs |
| These docs | every example on this site, in both languages | both SDKs, `duckdb`, `jq` |

None of them needs an account. The Archil backend is tested against a fake client that behaves the way the live service did.

[Contributing](/project/contributing/) has the commands, and the order of a change.

## Next

:::cards
- [What the framework writes](/architecture/files-on-disk/) The formats the interop check holds both SDKs to.
- [Python and TypeScript](/reference/python-and-typescript/) Every difference between the two APIs.
- [Contributing](/project/contributing/) Setting up, and sending a change.
:::
