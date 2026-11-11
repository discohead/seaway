---
title: The journal
description: Give a context a journal and every statement it runs is recorded with its plan, what it read and wrote, and what it cost. The journal is a log, so it is queried with the same verbs.
---

With `journal=` set, a context records every statement it runs at that path: one JSON line each, with the plan's hash, the reads and writes, the calls and the cost. Commits, rollbacks and syncs are recorded as well.

::example-context

## Turn it on

```python
logged = archil.context(
    {"docs": archil.disk("handbook"), "memory": archil.disk("agent-memory", "owned")},
    backend=backend,
    journal="memory/journal",
)
logged.sh("wc -l {f}", f=logged.glob("docs/*.md")).run()
with logged.transaction() as turn:
    turn.write("memory/notes/todo.md", "- rotate the keys\n")

for f in logged.ls("memory/journal", recursive=True):
    print(logged.read_text(f.path))
```

```ts
const logged = await archil.context(
  { docs: archil.disk("handbook"), memory: archil.disk("agent-memory", "owned") },
  { backend, journal: "memory/journal" },
);
await logged.sh`wc -l ${logged.glob("docs/*.md")}`.run();
await logged.transaction(async (turn) => {
  await turn.write("memory/notes/todo.md", "- rotate the keys\n");
});

for (const f of await logged.ls("memory/journal", { recursive: true })) {
  console.log(await logged.readText(f.path));
}
```

```json output
{"ts":"…","id":"…","kind":"sh","plan":"cefb41f41c31","statement":"wc -l {f}","reads":["docs/*.md"],"writes":[],"calls":1,"callUnits":1,"usd":5e-05,"ms":…,"exit":0}
{"ts":"…","id":"…","kind":"commit","tx":"…","applied":1,"deleted":0,"calls":1}
```

The journal is a [log](/guides/logs/) partitioned by day, with one file per session: `<journal>/<date>/<session>.ndjson`.

## What a line holds

| `kind` | Fields |
|---|---|
| `sh`, `sql`, `grep`, `batch` | `plan` (the hash), `statement` (the template, at most 240 characters; the pattern for `grep`, and `N statements` for `batch`), `reads`, `writes`, `calls`, `callUnits`, `usd`, `ms`, `exit` |
| `sync` | `recipe`, `written`, `unchanged`, `deleted`, `into` |
| `commit` | `tx`, `applied`, `deleted`, `calls` |
| `rollback` | `tx` |

Every line also has `ts` and `id`. `ts` is when the thing happened, which can be before the line was written. Direct reads and writes (`read`, `write`, `append`, `ls`) are not journalled.

The statement is recorded as its template, not with its values filled in. `wc -l {f}` is what is written, and `reads` says what `{f}` was.

## Ask it questions

The journal is a log like any other, so it is a table in `ctx.sql`.

```python
logged = archil.context(
    {"docs": archil.disk("handbook"), "memory": archil.disk("agent-memory", "owned")},
    backend=backend,
    journal="memory/journal",
)
logged.sh("wc -l {f}", f=logged.glob("docs/*.md")).run()
logged.grep("rotate", "docs").run()

spent = logged.sql(
    "select kind, count(*)::int as statements, sum(calls)::int as calls "
    "from {j} group by 1 order by 1",
    j=logged.log("memory/journal", partition="day").all(),
)
print(spent.run(check=True).rows)
```

```ts
const logged = await archil.context(
  { docs: archil.disk("handbook"), memory: archil.disk("agent-memory", "owned") },
  { backend, journal: "memory/journal" },
);
await logged.sh`wc -l ${logged.glob("docs/*.md")}`.run();
await logged.grep("rotate", "docs").run();

const journal = logged.log("memory/journal", { partition: "day" }).all();
const spent = logged.sql`
  select kind, count(*)::int as statements, sum(calls)::int as calls
  from ${journal} group by 1 order by 1`;
console.log((await spent.run({ check: true })).rows);
```

```text output
[{'kind': 'grep', 'statements': 1, 'calls': 1}, {'kind': 'sh', 'statements': 1, 'calls': 1}]
```

An agent with only bash can read it too:

```bash
# what did this agent run today, and what did it cost?
cat memory/journal/$(date -u +%F)/*.ndjson | jq -s '
  map(select(.usd))
  | {statements: length, calls: (map(.calls) | add), usd: (map(.usd) | add)}'

# the statements that failed
cat memory/journal/*/*.ndjson \
  | jq -c 'select(.exit != null and .exit != 0) | {ts, statement, exit}'
```

## Where to put it

Put the journal on a mount the context can append to: `append`, `owned` or `shared`. Which one decides what a failed turn leaves behind.

| The journal is on | Lines for statements inside a turn | A rolled-back turn leaves |
|---|---|---|
| an `append` mount | are written at once, and stay | every line it wrote |
| a disk the turn writes | are on the turn's branch, and land with the commit | only its `rollback` line |

Put the journal on an `append` disk when failed turns should leave a record of what they ran. It records at once, and nothing can rewrite it.

:::caution[A turn that names its writes has to name the journal]
When the journal is on a disk a turn writes, the journal's file is one of the turn's changes. A turn that passes `writes=` has to include the journal's directory, or its commit is refused with `undeclared_write`. A journal on an `append` mount needs no mention.
:::

## A narrowed context writes its own lines

A context made from another (`narrow`, `with_budget`, `with_egress`, `mount`, `fork`) keeps the `journal` setting and writes its own lines, through itself. So a narrowed context that can no longer append to that path records nothing.

That is the case when the narrowing left the journal's directory out, and always when it was made with `read_only=True`. To keep a record of what a helper runs, put the journal on an `append` mount and keep its directory in the narrowing. The helper's commands can then read that directory, and cannot change it.

## A journal never breaks the work it records

If an entry cannot be written, it is kept and written with the next one. On Archil that happens while a statement holds the checkout of the journal's disk. `ctx.journal_pending` (`journalPending` in TypeScript) counts what is waiting.

## Next

:::cards
- [Logs](/guides/logs/) The layout the journal uses, and selections over it.
- [A helper that is handed less](/blueprints/helper/) A journal on an append-only disk that the helper cannot rewrite.
- [What the framework writes](/architecture/files-on-disk/) The journal's format, line by line.
:::
