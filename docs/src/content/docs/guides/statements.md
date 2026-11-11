---
title: Statements and parameters
description: A statement is work that runs next to the data. Its parameters say which paths it reads and writes, and from that the SDK works out what the call can see.
---

A statement is `sh`, `sql`, `grep` or `batch`. Building one runs nothing. `explain()` returns its plan, and `run()` executes it. Statements are immutable values, so every builder returns a new one.

| Kind | Is | One call does |
|---|---|---|
| `ctx.sh(command, ...)` | a bash command | whatever bash can do with the files it names |
| [`ctx.sql(query, ...)`](/guides/sql/) | DuckDB over files | an aggregate, a join, a filter over many files |
| [`ctx.grep(pattern, over)`](/guides/grep/) | a regex search, fanned out next to the data | a whole disk, however many files |
| [`ctx.batch([...])`](/guides/batch-and-map/) | several `sh` and `sql` statements | all of them, with a result each |

::example-context

## Parameters

A command is a template with named parameters. A parameter is a path in the context, which also tells the planner what the command reads and writes. Or it is a value, which is quoted so the shell can never interpret it.

```python
# A path: the command reads one directory.
ctx.sh("rg -c timeout {dir}", dir=ctx.path("docs"))

# A glob it reads, and a file it writes.
ctx.sh(
    "sort -u {src} > {dst}",
    src=ctx.glob("team/leads/*.csv"),
    dst=ctx.out("memory/leads.csv"),
)

# A list of paths, and raw text that is trusted as written.
ctx.sh(
    "cat {files} {tail}",
    files=[ctx.path("docs/onboarding.md"), ctx.path("docs/expenses.md")],
    tail=archil.raw("| wc -l"),
)

# A value: one quoted word.
quoted = ctx.sh("echo {text}", text="it's; rm -rf /")
print(quoted.run().text)
```

```ts
// A path: the command reads one directory.
ctx.sh`rg -c timeout ${ctx.path("docs")}`;

// A glob it reads, and a file it writes.
ctx.sh`sort -u ${ctx.glob("team/leads/*.csv")} > ${ctx.out("memory/leads.csv")}`;

// A list of paths, and raw text that is trusted as written.
// This one is in the named form, as Python writes it.
ctx.sh("cat {files} {tail}", {
  files: [ctx.path("docs/onboarding.md"), ctx.path("docs/expenses.md")],
  tail: archil.raw("| wc -l"),
});

// A value: one quoted word.
const quoted = ctx.sh`echo ${"it's; rm -rf /"}`;
console.log((await quoted.run()).text);
```

```text output
it's; rm -rf /
```

The first three ran nothing: a statement only runs when you ask. The last one echoed its value back untouched. The value was one shell word, whatever it contained.

| Parameter | Declares | In `sh` it becomes | In `sql` it becomes |
|---|---|---|---|
| `ctx.path(p)` | a read of a file or a directory | the path, quoted | a table: the file, or the files under the directory |
| `ctx.glob(p)` | a read of the files that match now | each matching path, quoted, sorted by path | a table over the glob |
| `ctx.out(p)` | a write | the path, quoted. Its directory is created first | not usable: a query writes with `.into(path)` |
| a [log selection](/guides/logs/#selections) | a read of a time range | the partition files that cover the range | a table of exactly the records in the range |
| a list of paths, outs or values | each of them | the words, separated by spaces | use one table per parameter |
| `archil.raw(text)` | nothing | the text as written | the text as written |
| anything else | nothing: it is a value | one shell word, whatever it contains | a SQL literal |

From one declaration the SDK gets five things: the mount map, sizes and so a price, what can be split, what to write in the journal, and what a view depends on. And the declaration is how you would have written the command anyway.

### Globs

`*` and `?` stay inside one path segment. `**` crosses directories. A glob is expanded when the statement is compiled, from a listing.

That happens only when the glob is a parameter of its own, and the same goes for a log selection. Inside a list, either one is passed as its own text in one quoted word, and the command is handed a name that matches no file.

### Values

| Value | In `sh` | In `sql` |
|---|---|---|
| a string | one quoted word | a literal, with its quotes doubled |
| a number | the number | written bare |
| `True`, `False` | `true`, `false` | `TRUE`, `FALSE` |
| `None`, `null` | the empty word `''` | `NULL` |

### Placeholders

- Only `{name}` where `name` was passed as a parameter is substituted. Ordinary shell braces pass through untouched: `awk '{print $1}'`, `${HOME}`, `{a,b}`.
- A parameter that never appears in the template is the error `unused_parameter`, raised before anything runs. It is almost always a typo.
- In TypeScript, a tagged template names its parameters `p0`, `p1`, … and takes the text between them as written, so a backslash reaches bash as a backslash. A value cannot be interpolated straight after `$` or a backslash (`bad_template`). Use the named form there.

## What not to write

Never build a command's text from values. Pasted text is not quoted, and the plan cannot see the path.

```py
ctx.sh(f"cat docs/{name}")                      # pasted: not quoted, not declared
ctx.sh("cat docs/" + name)                      # the same
ctx.sh("cat {f}", f="docs/" + name)             # quoted, but a value: declares nothing
ctx.sh("cat {f}", f=ctx.path("docs/" + name))   # right
```

```typescript
ctx.sh(`cat docs/${name}`);               // a call, not a tag: pasted, not quoted
ctx.sh`cat docs/${name}`;                 // quoted, but a value: declares nothing
ctx.sh`cat ${ctx.path("docs/" + name)}`;  // right
```

The difference between the first two TypeScript lines is two parentheses. ``ctx.sh`…` `` is a tagged template: seaway receives the text and the values separately. ``ctx.sh(`…`)`` is a call with a string that JavaScript has already assembled. The [linter](/agents/lint/) catches a pasted value in either language.

## What a call can see

The rule is short.

- **No path parameters:** the call sees the whole context, each mount in its own mode. `owned` mounts are read-write under a checkout, `shared` mounts read-write and conditional, the rest read-only. The price is marked `(input size unknown)`, and an `sh` plan carries a note.
- **Path parameters:** the call sees only the disks they name.
  - A disk it only reads is mounted read-only, at the smallest directory that covers the paths read on it. A single file is mounted as its directory.
  - A disk it writes is mounted whole, in its own mode. Only reads are narrowed to a directory.
  - A disk it does not name is not mounted.

`into(path)` is a declaration too. A command that declares no reads and is sent `into()` a file sees only the disk that file is on.

```python
merge = ctx.sh(
    "sort -u {src} > {dst}",
    src=ctx.glob("team/leads/*.csv"),
    dst=ctx.out("memory/leads.csv"),
)
print(merge.explain())
```

```ts
const merge = ctx.sh("sort -u {src} > {dst}", {
  src: ctx.glob("team/leads/*.csv"),
  dst: ctx.out("memory/leads.csv"),
});
console.log(String(await merge.explain()));
```

```plan output
plan f381e1d9ce0c  sh · 2 file(s), 58 B · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   team/leads → team-notes:/leads (read-only)
          memory → agent-memory (read-write, checkout /)
          not mounted: docs, logs
  reads   team/leads/*.csv
  writes  memory/leads.csv
  price   1 call unit $0.00005 + 58 B active for an hour <$0.00001 ≈ $0.00005
```

`team` is a `shared` mount, but this statement only reads it, so the call gets one directory of it, read-only. `memory` is written, so it is mounted whole, under a checkout.

This is gradual on purpose. A free-form command still works, and its plan says what it cost to be vague:

```plan
  note    no paths declared, so all 4 mount(s) are attached; pass paths as parameters to mount only what the command needs
```

## sh

`ctx.sh(command, ...)` is bash, on both backends. Archil runs a command with `/bin/sh`, so the SDK hands the text to bash itself: `set -o pipefail`, `[[ ]]` and process substitution mean what they say.

```python
by_words = ctx.sh("wc -w {files} | sort -n", files=ctx.glob("docs/**/*.md"))
print(by_words.run(check=True).text)
```

```ts
const byWords = ctx.sh`wc -w ${ctx.glob("docs/**/*.md")} | sort -n`;
console.log((await byWords.run({ check: true })).text);
```

```text output
 8 docs/onboarding.md
 9 docs/expenses.md
15 docs/security/keys.md
32 total
```

- **A command starts in the directory the disks are mounted under,** and addresses files as the context does: `cat docs/onboarding.md`. That holds on both backends. Do not write `/mnt/archil/...`.
- **Each call is a fresh VM.** Nothing survives it but files on the mounts.
- **There is no stdin.** A command that reads it sees the end of input at once.

## Run one

| | Python | TypeScript |
|---|---|---|
| Read the plan | `stmt.explain()` | `await stmt.explain()` |
| Run it | `stmt.run()` | `await stmt.run()`, or `await stmt` |
| Raise if the command fails | `stmt.run(check=True)` | `await stmt.run({ check: true })` |

A command that fails is a result, not an exception. See [Results and limits](/guides/results/).

:::caution[In TypeScript a statement is thenable]
`await statement` runs it. So an `async` function that returns a statement hands its caller the result, because the `await` runs it. Return a statement from a plain function, or inside an object.
:::

## Shape one

Each of these returns a new statement.

| Builder | Does | Guide |
|---|---|---|
| `.map(reduce=...)` | splits one input across calls and combines the outputs | [Batch and map](/guides/batch-and-map/#map-one-input-across-many-calls) |
| `.into(path)` | sends the output to a file in the context | [Results and limits](/guides/results/#keep-large-output-on-the-disk) |
| `.sized(vcpu=, mem_mib=)` | chooses the VM for each call | [Results and limits](/guides/results/#a-larger-vm) |
| `.egress(policy)` | says what this one call may reach on the network | [Limit reach, network and spend](/guides/narrowing/#the-network) |
| `.within(max_usd=...)` | refuses to run if the plan would pass a budget | [Prices and budgets](/guides/prices/#budgets) |

## Next

:::cards
- [SQL over files](/guides/sql/) Any path parameter is a table.
- [Search](/guides/grep/) One call per disk, however many files.
- [Read a plan](/guides/plans/) Every line, and every note.
- [Statement reference](/reference/statement/) Every method and field, in both languages.
:::
