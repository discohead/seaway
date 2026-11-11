---
title: Installation
description: Install the Python or TypeScript SDK from GitHub, add the two command-line tools the examples call, and check that it runs.
---

seaway is not on PyPI or npm. You install it from GitHub or from a checkout. Neither SDK has runtime dependencies.

| | Python | TypeScript |
|---|---|---|
| Runtime | Python 3.10 or later | Node 22.19 or later, which runs `.ts` files as they are |
| Import | `import seaway as archil` | `import * as archil from "seaway"` |
| Build step | none | none |
| To reach Archil | the official `archil` package | the official `disk` package |

## Python

```bash
pip install "seaway @ git+https://github.com/discohead/seaway#subdirectory=python"
```

To reach Archil as well as the local backend, add the `archil` extra. It brings Archil's official client:

```bash
pip install \
  "seaway[archil] @ git+https://github.com/discohead/seaway#subdirectory=python"
```

To work from a checkout, install it in place. The `dev` extra adds pytest, the official client and the `duckdb` command:

```bash
git clone https://github.com/discohead/seaway
pip install -e './seaway/python[dev]'
```

## TypeScript

The TypeScript SDK runs from its `.ts` sources, so it is installed from a checkout, as a link:

```bash
git clone https://github.com/discohead/seaway
npm install ./seaway/typescript
```

Give your project's `package.json` `"type": "module"`, so Node reads `app.ts` as an ES module without having to guess. Then run a file with `node app.ts`.

:::note[Why a link]
Node runs TypeScript by stripping the types, and it refuses to do that for a file under `node_modules`. `npm install <directory>` makes a link to the checkout, which Node follows to the real files. A copy would not run.
:::

To reach Archil, add the official client: `npm install disk`. It is loaded only when a context uses the Archil backend.

To type-check a project that imports seaway, install `disk` as well, even if you only run locally: `tsc` reads the SDK's sources, and they import its types. Then give `tsc` the options the SDK itself is checked with:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

## The tools statements call

A statement is bash. On the local backend it runs on your machine, so the programs it names have to be there.

| Tool | Needed for | Install |
|---|---|---|
| `duckdb` | `ctx.sql`, which is DuckDB over files | `brew install duckdb`, or `pip install duckdb-cli` |
| `jq` | the examples' pipelines over JSON lines | `brew install jq`, or your system's package manager |
| `rg` | nothing: search uses it when it is there, and its own implementation when it is not | optional |

On Archil the exec image has `jq`, `git`, `curl`, `rg`, `sqlite3`, `python3` and Node. It does not have DuckDB: see [Run on Archil](/guides/archil/#sql-needs-duckdb-on-a-disk).

## Check that it runs

This writes a file to a disk on the local backend and reads it back through a statement.

```python
import seaway as archil

ctx = archil.context(
    {"notes": archil.disk("notes", "owned", create=True)},
    backend=archil.LocalBackend(".archil-local"),
)
ctx.write("notes/hello.md", "hello\n")
text = ctx.sh("cat {f}", f=ctx.path("notes/hello.md")).run(check=True).text
print(archil.__version__, text)
```

```ts
import * as archil from "seaway";

const ctx = await archil.context(
  { notes: archil.disk("notes", "owned", { create: true }) },
  { backend: new archil.LocalBackend({ root: ".archil-local" }) },
);
await ctx.write("notes/hello.md", "hello\n");
const { text } = await ctx.sh`cat ${ctx.path("notes/hello.md")}`.run({ check: true });
console.log(archil.VERSION, text);
```

```text output
0.1.0 hello
```

The local backend keeps its disks under the root you give it: here `.archil-local/disks/notes/`. Delete the directory to start again, and add it to `.gitignore`.

## Know where it will run

A context opened without a `backend` chooses one from the environment:

1. Archil, when `ARCHIL_API_KEY` is set and `ARCHIL_BACKEND` is not `local`.
2. Otherwise the local backend, rooted at `ARCHIL_LOCAL_ROOT`, or `.archil-local` in the current directory.

:::caution[An exported API key sends a script to the live account]
With `ARCHIL_API_KEY` in your shell, a script that passes no backend acts on real disks. Every statement, checkpoint and commit is a billed call, and checkpoints and branches cannot be deleted. When you are trying something out, pass a `LocalBackend` as the examples here do, or set `ARCHIL_BACKEND=local`.
:::

[Local and Archil backends](/guides/backends/) covers both, and [Run on Archil](/guides/archil/) is the checklist for going live.

## With Claude Code

seaway is new, so a model knows nothing about it. The repository carries a Claude Code plugin with the real API as skills, a linter, and an MCP server:

```bash
claude plugin marketplace add discohead/seaway
claude plugin install seaway@seaway
```

Then run `/seaway:setup` in a session. [The Claude Code plugin](/agents/claude-code/) has the details.

## Next

:::cards
- [Quickstart](/start/quickstart/) A context, a statement, its plan, a turn and a narrowed helper.
- [Example programs](/start/examples/) Three longer programs in the repository, in both languages.
:::
