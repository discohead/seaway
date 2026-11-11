# seaway (TypeScript)

The TypeScript SDK. It is a port of the Python reference with the same semantics and the same files on disk. See the [README one level up](../README.md) for what this is and why, and [CONTRIBUTING.md](../CONTRIBUTING.md) to work on it.

```bash
npm install                             # Node 22.19+, which runs .ts directly; there is no build step
node examples/quickstart.ts
node examples/agent-context.ts
node examples/datadog-afternoon.ts      # needs the duckdb CLI and jq
npm test && npm run typecheck

node examples/quickstart.ts --archil --cleanup    # the same example on Archil; see examples/_where.ts
```

```ts
import * as archil from "seaway";

const ctx = await archil.context({
  docs: archil.disk("handbook"),                              // read is the default mode
  notes: archil.disk("my-notes", "owned", { create: true }),
});

const words = ctx.sh`wc -w ${ctx.glob("docs/**/*.md")} | sort -n`;
console.log(String(await words.explain()));   // the plan: route, scope, split, price
console.log((await words).text);              // awaiting a statement runs it

await ctx.transaction(async (turn) => {       // all of the turn's changes, or none
  await turn.write("notes/todo.md", "- read the handbook\n");
});
```

What differs from Python:

- Everything that reaches a backend is async, and keyword arguments become an options object.
- A statement can be written as a tagged template. Each interpolation becomes a parameter named `p0`, `p1` and so on, so the plan's `statement` reads `wc -w {p0} | sort -n`. The named form, `ctx.sh("wc -w {files}", { files })`, also works and compiles to the same plan as the Python SDK's.
- A statement is thenable: `await statement` is `await statement.run()`. Don't return one from an `async` function unless you mean to run it.
- `ctx.transaction(fn, options)` takes a callback that receives the turn's own context. `new archil.Transaction(ctx, options)` gives the explicit `begin()`, `commit()` and `rollback()`.
- `changes.empty` replaces Python's truthiness on a feed's changes.
- `archil.asFileSystem(ctx)` makes a context satisfy the official `disk` package's `FileSystem` interface, so `createDiskTools(...)` and the AI SDK adapters can be pointed at a composed context.

The package has no runtime dependencies. `disk` is an optional peer dependency, loaded only when a context uses `ArchilBackend`, which happens by default when `ARCHIL_API_KEY` is set. The backend sends checkouts through the mount spec's own `queueMs` and `checkoutPaths`, which the Python client doesn't have yet. That is why an `owned` mount can be written from a custom image here and not from Python.

On Archil, `ctx.sql` needs DuckDB on a disk, because the exec image has none: `await archil.duckdb(ctx, "notes/bin").run({ check: true })` puts it there, after checking the download against a pinned SHA-256, and `tools: { duckdb: "notes/bin/duckdb" }` tells the context. The [README one level up](../README.md#on-archil) has the rest.

One test is skipped unless `zod` is installed: it runs the official tool layer over a context, and that layer imports zod.
