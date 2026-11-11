---
title: Quickstart
description: Compose a context, ask a question, read the plan, run it, make a change that lands whole, and hand a helper less than you have. Ten minutes, no account.
---

This builds one program, a step at a time. It runs on the local backend: disks are directories, and a statement is bash on your machine. You need seaway [installed](/start/installation/) and nothing else.

Put each step in one file, `app.py` or `app.ts`, and run it with `python app.py` or `node app.ts`.

## 1. Open a backend and seed a disk

A backend is where disks live and where statements run. Start with a local one, and write a small handbook to it.

```python
import seaway as archil

# Disks are directories under this root.
backend = archil.LocalBackend(".archil-local")

# The publisher's view of the handbook: it is the one writer.
publisher = archil.context(
    {"docs": archil.disk("handbook", "owned", create=True)},
    backend=backend,
)
for path, text in {
    "docs/onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
    "docs/expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
    "docs/security/keys.md":
        "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
}.items():
    publisher.write(path, text)
```

```ts
import * as archil from "seaway";

// Disks are directories under this root.
const backend = new archil.LocalBackend({ root: ".archil-local" });

// The publisher's view of the handbook: it is the one writer.
const publisher = await archil.context(
  { docs: archil.disk("handbook", "owned", { create: true }) },
  { backend },
);
const handbook = {
  "docs/onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
  "docs/expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
  "docs/security/keys.md":
    "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
};
for (const [path, text] of Object.entries(handbook)) await publisher.write(path, text);
```

A path starts with a mount name. `docs/security/keys.md` is `security/keys.md` on the disk mounted as `docs`.

## 2. Compose a context

A context says which disks an agent has, and under what rules. The second argument to `disk` is the [mode](/guides/modes/): who may change that part of the tree.

```python continues
ctx = archil.context(
    {
        # read is the default mode
        "docs": archil.disk("handbook", description="company policies, one file each"),
        "notes": archil.disk(
            "my-notes", "owned", create=True, description="this agent's working notes",
        ),
    },
    backend=backend,
    name="quickstart",
)
print(ctx.describe())
```

```ts continues
const ctx = await archil.context(
  {
    docs: archil.disk("handbook", "read", {
      description: "company policies, one file each",
    }),
    notes: archil.disk("my-notes", "owned", {
      create: true,
      description: "this agent's working notes",
    }),
  },
  { backend, name: "quickstart" },
);
console.log(ctx.describe());
```

```text output
context "quickstart" on local
  docs/   read    handbook  company policies, one file each
  notes/  owned   my-notes  this agent's working notes
Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to the data and bill per call (≈ $0.00005). explain() prices a statement first.
```

The same handbook is `owned` in the publisher's context and `read` in this one. `describe()` is written for a model: it is a good start for a system prompt.

## 3. Build a statement and read its plan

A statement is work that runs next to the data. Building one runs nothing. The paths it is given are the only paths the call will be able to see.

```python continues
words = ctx.sh("wc -w {files} | sort -n", files=ctx.glob("docs/**/*.md"))
print(words.explain())
```

```ts continues
const words = ctx.sh`wc -w ${ctx.glob("docs/**/*.md")} | sort -n`;
console.log(String(await words.explain()));
```

```plan output
plan d368c5108ff0  sh · 3 file(s), 174 B · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   docs → handbook (read-only)
          not mounted: notes
  reads   docs/**/*.md
  writes  —
  price   1 call unit $0.00005 + 174 B active for an hour <$0.00001 ≈ $0.00005
```

Read `scope` for safety: the call can see `docs`, read-only, and `notes` is not mounted at all. Read `price` for cost: one call. [Read a plan](/guides/plans/) explains every line.

## 4. Run it

```python continues
print(words.run().text)
```

```ts continues
console.log((await words.run()).text);
```

```text output
 8 docs/onboarding.md
 9 docs/expenses.md
15 docs/security/keys.md
32 total
```

A command starts in the directory the disks are mounted under, so it addresses files the way the context does.

:::tip[In TypeScript, awaiting a statement runs it]
`await words` is the same as `await words.run()`. That is why an `async` function must not return a statement unless it means to run it.
:::

## 5. Search

A search is one call per disk, however many files there are. It does not go through `exec`.

```python continues
for hit in ctx.grep("rotate", "docs", ignore_case=True).run().rows:
    print(f"{hit['file']}:{hit['line']}: {hit['text']}")
```

```ts continues
const found = await ctx.grep("rotate", "docs", { ignoreCase: true }).run();
for (const hit of found.rows ?? []) {
  console.log(`${hit.file}:${hit.line}: ${hit.text}`);
}
```

```text output
docs/security/keys.md:2: Rotate API keys every 90 days.
```

## 6. Write where the context allows

`ctx.out` declares a write. Declaring it is what makes that mount writable for the call.

```python continues
ctx.sh(
    "grep -l key {files} > {out}",
    files=ctx.glob("docs/**/*.md"),
    out=ctx.out("notes/mentions-keys.txt"),
).run(check=True)
print(ctx.read_text("notes/mentions-keys.txt").strip())

try:
    ctx.write("docs/onboarding.md", "rewritten")
except archil.ValidationError as e:
    print(f"refused: {e.code}: {e.suggestion}")
```

```ts continues
const files = ctx.glob("docs/**/*.md");
const out = ctx.out("notes/mentions-keys.txt");
await ctx.sh`grep -l key ${files} > ${out}`.run({ check: true });
console.log((await ctx.readText("notes/mentions-keys.txt")).trim());

try {
  await ctx.write("docs/onboarding.md", "rewritten");
} catch (e) {
  if (!(e instanceof archil.ValidationError)) throw e;
  console.log(`refused: ${e.code}: ${e.suggestion}`);
}
```

```text output
docs/security/keys.md
refused: read_only: mount the disk as 'owned' or 'shared' to write to it
```

The write to `docs` was refused before anything was sent, and the error says what to do. `check=True` turns a command that fails into an exception. Without it, a failed command is a result with a non-zero `exit_code`.

## 7. Make changes that land together

A turn is a transaction over files. Its changes land together, or not at all.

```python continues
with ctx.transaction() as turn:
    turn.write("notes/todo.md", "- read the security policies\n")
    turn.sh("date -u +%F > {f}", f=turn.out("notes/started.txt")).run(check=True)
    print("inside the turn, the main line has:", [f.path for f in ctx.ls("notes")])
print("after the commit:", [f.path for f in ctx.ls("notes")])
```

```ts continues
await ctx.transaction(async (turn) => {
  await turn.write("notes/todo.md", "- read the security policies\n");
  await turn.sh`date -u +%F > ${turn.out("notes/started.txt")}`.run({ check: true });
  const visible = (await ctx.ls("notes")).map((f) => f.path);
  console.log("inside the turn, the main line has:", visible);
});
console.log("after the commit:", (await ctx.ls("notes")).map((f) => f.path));
```

```text output
inside the turn, the main line has: ['notes/mentions-keys.txt']
after the commit: ['notes/mentions-keys.txt', 'notes/started.txt', 'notes/todo.md']
```

Inside a turn, do everything through `turn`. It works on a private branch, and nobody else sees its writes until the commit. If another writer changed one of the same paths first, the commit raises `Conflict` and applies nothing. [Turns](/guides/turns/) covers that.

## 8. Hand a helper less than you have

`narrow` returns a context with the same path names and a smaller reach. It can only take access away.

```python continues
helper = ctx.narrow("docs/security", read_only=True)
print(helper.describe().splitlines()[1])
print(helper.sh("find -L . -type f").run().text)
```

```ts continues
const helper = ctx.narrow(["docs/security"], { readOnly: true });
console.log(helper.describe().split("\n")[1]);
console.log((await helper.sh`find -L . -type f`.run()).text);
```

```text output
  docs/security/  read    handbook  company policies, one file each
./docs/security/keys.md
```

The helper's command declared nothing, so it was given everything its context has. That was one directory.

## 9. See what it cost

```python continues
print(ctx.spend)
```

```ts continues
console.log(String(ctx.spend));
```

```text output
5 statement(s): 7 call unit(s) $0.00035, 174 B kept active <$0.00001, 0 B egress $0; total ≈ $0.00035
```

Nothing was billed: this ran on your machine. The ledger shows what the same run would cost on Archil, by the public price sheet. The two extra call units are the turn: one checkpoint when it began, and one call to apply its commit.

## Next

:::cards
- [Core concepts](/start/concepts/) The whole model on one page.
- [Statements and parameters](/guides/statements/) What a parameter declares, and what a call can see.
- [Run on Archil](/guides/archil/) Point the same code at an account.
- [Blueprints](/blueprints/) Worked designs to start from.
:::
