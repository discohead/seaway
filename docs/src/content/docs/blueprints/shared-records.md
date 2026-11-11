---
title: Records many agents edit
description: A tracker, a wiki or a CRM, where records are read and changed one at a time by several writers. A file per record, an edit inside a turn that retries on conflict, and an index kept as a view.
sidebar:
  label: Records many agents edit
---

A tracker, a wiki, a CRM: records that are read and changed one at a time by several writers. Give each record a file, make each edit a turn, and two writers conflict only when they change the same record.

| Disk | Mode | Layout |
|---|---|---|
| `team-wiki` | `shared` | `pages/<slug>.md`, one per page; `pages/README.md`; `index.txt`, a view |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

ctx = archil.context(
    {"wiki": archil.disk("team-wiki", "shared", create=True)},
    backend=backend,
)
ctx.write("wiki/pages/README.md", "One Markdown file per page, named <slug>.md.\n")

def edit(ctx, slug, change, attempts=3):
    """Read a page, change it, and write it back,
    unless someone else changed it first."""
    for _ in range(attempts):
        try:
            with ctx.transaction(writes=["wiki/pages"]) as turn:
                path = f"wiki/pages/{slug}.md"
                before = turn.read_text(path) if turn.exists(path) else ""
                turn.write(path, change(before))
            return True
        except archil.Conflict:
            continue  # start again from what is there now
    return False

edit(ctx, "oncall", lambda text: text + "- Rotate the pager on Mondays.\n")
edit(ctx, "oncall", lambda text: text + "- Escalate after 15 minutes.\n")
edit(ctx, "deploys", lambda text: text + "- Deploy before 3pm.\n")
print(ctx.read_text("wiki/pages/oncall.md"))

index = ctx.view(
    "wiki/index.txt",
    lambda: ctx.sh("ls {pages} | grep -v README | sort", pages=ctx.path("wiki/pages")),
)
print(index.read_text())
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const ctx = await archil.context(
  { wiki: archil.disk("team-wiki", "shared", { create: true }) },
  { backend },
);
await ctx.write(
  "wiki/pages/README.md",
  "One Markdown file per page, named <slug>.md.\n",
);

/** Read a page, change it, and write it back, unless someone else changed it first. */
async function edit(
  ctx: archil.Context, slug: string, change: (text: string) => string, attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await ctx.transaction(async (turn) => {
        const path = `wiki/pages/${slug}.md`;
        const before = (await turn.exists(path)) ? await turn.readText(path) : "";
        await turn.write(path, change(before));
      }, { writes: ["wiki/pages"] });
      return true;
    } catch (e) {
      if (!(e instanceof archil.Conflict)) throw e;
      // otherwise: start again from what is there now
    }
  }
  return false;
}

await edit(ctx, "oncall", (text) => text + "- Rotate the pager on Mondays.\n");
await edit(ctx, "oncall", (text) => text + "- Escalate after 15 minutes.\n");
await edit(ctx, "deploys", (text) => text + "- Deploy before 3pm.\n");
console.log(await ctx.readText("wiki/pages/oncall.md"));

const index = ctx.view(
  "wiki/index.txt",
  () => ctx.sh`ls ${ctx.path("wiki/pages")} | grep -v README | sort`,
);
console.log(await index.readText());
```

```text output
- Rotate the pager on Mondays.
- Escalate after 15 minutes.

deploys.md
oncall.md
```

## What to watch

- **A file per record means two writers conflict only when they edit the same record.** One big file would make every edit a conflict.
- **The edit reads inside the turn,** so it starts from the turn's snapshot, and the commit refuses it if the page changed meanwhile.
- **Redo the change, do not replay the write.** `change` is a function of the page as it is now, so a retry applies it to the newer text.
- **Search is `ctx.grep`.** A listing by field is a view built with `sh` or `sql` over the front matter.
- **If edits are rare and each writer has its own pages,** plain `ctx.write` on a `shared` mount is enough.
- **Every turn leaves a checkpoint and a branch.** For a wiki with a high edit rate on Archil, that adds up: batch several edits into one turn where they belong together.

## Next

:::cards
- [Turns](/guides/turns/) Conflicts, isolation, and what is not part of a turn.
- [Views](/guides/views/) How the index knows when to rebuild.
:::
