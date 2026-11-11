---
title: Mount modes
description: The mode of a mount is its mutation strategy. There are five, each compiles to something Archil already does, and you choose one by asking who writes the data.
---

Every mount has a mode. It says who may change that part of the tree, and it decides how a statement's call sees the disk.

::example-context

## The five modes

| Mode | Meaning | On Archil | `write`, `rm` | `append` |
|---|---|---|---|---|
| `read` | live data, read-only | mounted `readOnly` | refused | refused |
| `frozen` | read-only, and pinned to a checkpoint so every run sees the same bytes | a branch of the checkpoint named `at`, mounted `readOnly` | refused | refused |
| `owned` | this context is the only writer | a mount that takes a checkout of the mount root, waiting up to five seconds for it | yes | yes |
| `shared` | many writers | a `conditional` mount: no checkout, and the last write to reach the disk wins | yes | yes |
| `append` | records are only ever added | appends go through the server-side append; commands see the data read-only | refused | yes |

`read` is the default.

## Choose by who writes

| The data is… | Mode | Why |
|---|---|---|
| written by this agent or app alone | `owned` | writes take a checkout: they run at local-disk speed, and a second writer waits its turn |
| written by several agents or people | `shared` | nothing queues. Give each writer its own paths, or use [turns](/guides/turns/) |
| only ever added to: logs, audit trails, events | `append` | nothing can rewrite it, and many writers can append at once when each has its own file |
| maintained by someone else, and wanted live | `read` | this context cannot change it |
| wanted exactly as it was at a known point | `frozen` | every run sees the same bytes |

In practice:

- One agent's memory, a view's output, a feed's cursor, a SQLite file: `owned`.
- Notes several agents write: `shared`.
- Logs and journals: `append`.
- Skills, prompts and reference data for an eval: `frozen` at a named checkpoint.
- Anything this context should not change: `read`.

## How a statement sees each mode

A statement that declares no paths is given every mount, each in its own mode. Its plan shows what each mode becomes:

```python
print(ctx.sh("ls").explain())
```

```ts
console.log(String(await ctx.sh`ls`.explain()));
```

```plan output
plan da2b48f4f8ef  sh · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   docs → handbook (read-only)
          logs → app-logs (read-only)
          memory → agent-memory (read-write, checkout /)
          team → team-notes (read-write, conditional)
  reads   — (not declared)
  writes  —
  price   1 call unit $0.00005 ≈ $0.00005 (input size unknown)
  note    no paths declared, so all 4 mount(s) are attached; pass paths as parameters to mount only what the command needs
```

- `read`, `frozen` and `append` mounts are **read-only** in a call. A command cannot change them.
- An `owned` mount is **read-write under a checkout**. The call owns the mount root while it runs.
- A `shared` mount is **read-write and conditional**. Nothing is checked out, and nothing waits.

A statement that declares its paths gets less: a disk it only reads is read-only whatever its mode. See [what a call can see](/guides/statements/#what-a-call-can-see).

## A mode belongs to the mount

The same disk can be mounted under different rules in different contexts. The publisher of a handbook owns it. Everyone else reads it.

```python
owned = {"docs": archil.disk("handbook", "owned")}
publisher = archil.context(owned, backend=backend)
reader = archil.context({"docs": archil.disk("handbook")}, backend=backend)

publisher.write("docs/expenses.md", "# Expenses\nFile within 14 days.\n")
print(reader.read_text("docs/expenses.md").splitlines()[1])    # File within 14 days.
```

```ts
const publisher = await archil.context(
  { docs: archil.disk("handbook", "owned") },
  { backend },
);
const reader = await archil.context({ docs: archil.disk("handbook") }, { backend });

await publisher.write("docs/expenses.md", "# Expenses\nFile within 14 days.\n");
const line = (await reader.readText("docs/expenses.md")).split("\n")[1];
console.log(line);   // File within 14 days.
```

## frozen: the same bytes every time

A `frozen` mount is pinned to a checkpoint with `at`. It keeps reading what the disk held at that point, whatever happens to the disk afterwards.

```python
owned = {"docs": archil.disk("handbook", "owned")}
publisher = archil.context(owned, backend=backend)
publisher.checkpoint("2026-11-01")                    # a release: what readers pin to

pinned = archil.context(
    {"docs": archil.disk("handbook", "frozen", at="2026-11-01")},
    backend=backend,
)
publisher.write("docs/onboarding.md", "# Onboarding\nChanged since the release.\n")

line = pinned.read_text("docs/onboarding.md").splitlines()[1]
print(line)    # Read the handbook. Ask questions early.
```

```ts
const publisher = await archil.context(
  { docs: archil.disk("handbook", "owned") },
  { backend },
);
await publisher.checkpoint("2026-11-01");             // a release: what readers pin to

const pinned = await archil.context(
  { docs: archil.disk("handbook", "frozen", { at: "2026-11-01" }) },
  { backend },
);
await publisher.write(
  "docs/onboarding.md",
  "# Onboarding\nChanged since the release.\n",
);

const line = (await pinned.readText("docs/onboarding.md")).split("\n")[1];
console.log(line);   // Read the handbook. Ask questions early.
```

A new release changes nothing for a pinned reader until it is opened `at` the new checkpoint. To freeze every mount of a context at once, use [`lock`](/guides/checkpoints/).

## owned: one writer, under a checkout

A statement that writes an `owned` mount takes a checkout of the mount root and waits up to five seconds for it. Two things follow on Archil:

- A second statement that wants the same checkout waits, and if it is not granted in time, its result is exit code 30. Run it again.
- While a statement holds the checkout, a direct `write`, `append` or `rm` on that disk raises `Busy`. Retry when the statement has finished.

The local backend has no checkouts, so neither happens there.

## shared: many writers, last write wins

`shared` is Archil's *conditional* mode. Nothing queues, and nothing stops two writers overwriting each other except a [turn](/guides/turns/). Keep each writer to its own paths.

:::note[This is not `archil mount --shared`]
`archil mount --shared` is the mode an exec mount is in by default, and it needs a checkout before most writes. seaway's `shared` is the conditional mode, which needs none.
:::

## append: add, never rewrite

An `append` mount accepts `append` and nothing else. Use it through a [log](/guides/logs/), which lays records out so that many writers never contend for a file. Commands see the data read-only, so a statement can query an append-only mount but can't write to it.

## Next

:::cards
- [Limit reach, network and spend](/guides/narrowing/) Hand a helper less than you have.
- [Turns](/guides/turns/) Make several writers safe on a shared mount.
- [Designing on seaway](/blueprints/) Where the disk boundaries go, and why.
:::
