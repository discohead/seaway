---
title: A helper that is handed less
description: A model's commands are not trusted. What they can reach is the context their tools are built from, so narrow it, cut the network, cap the spend, and keep a journal the helper cannot rewrite.
---

A model's commands are not trusted. What they can reach is the context their tools are built from. So the lead agent keeps the full context, and hands a helper a smaller one.

| Disk | Mode | Layout |
|---|---|---|
| `team-handbook` | `read` | policies in Markdown, by topic |
| `lead-memory` | `owned` | a directory per helper: `helper-1/` |
| `helper-audit` | `append` | the journal: `helpers/<date>/<session>.ndjson` |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

publisher = archil.context(
    {"docs": archil.disk("team-handbook", "owned", create=True)},
    backend=backend,
)
publisher.write("docs/security/keys.md", "# Keys\nRotate API keys every 90 days.\n")
publisher.write("docs/hr/leave.md", "# Leave\nAsk two weeks ahead.\n")

ctx = archil.context(
    {
        # read: nobody holding this context can change it
        "docs":   archil.disk("team-handbook"),
        "memory": archil.disk("lead-memory", "owned", create=True),
        "audit":  archil.disk("helper-audit", "append", create=True),
    },
    backend=backend, journal="audit/helpers",
)
# the lead's own work is journalled, which creates audit/helpers
ctx.sh("ls {d}", d=ctx.path("docs")).run(check=True)

helper = (
    # these sub-trees only
    ctx.narrow("docs/security", "memory/helper-1", "audit/helpers")
       .with_egress("deny")        # its commands cannot reach the network
       .with_budget(max_usd=0.02)  # counted from here on
)
tools = {tool.name: tool for tool in helper.tools()}
print(helper.describe())

# What the helper's model can and cannot do.
print(tools["run_bash"](command="cat docs/security/keys.md | tail -n 1").strip())
print(tools["read_file"](path="docs/hr/leave.md"))
print(tools["write_file"](
    path="memory/helper-1/summary.md",
    content="Keys rotate every 90 days.\n",
))

# What it ran is on record, on a disk it cannot rewrite.
files = ctx.ls("audit/helpers", recursive=True)
spent = round(helper.spent_under_budget().usd, 5)
print(len(files), "journal file(s);", spent, "spent")
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const publisher = await archil.context(
  { docs: archil.disk("team-handbook", "owned", { create: true }) },
  { backend },
);
await publisher.write(
  "docs/security/keys.md",
  "# Keys\nRotate API keys every 90 days.\n",
);
await publisher.write("docs/hr/leave.md", "# Leave\nAsk two weeks ahead.\n");

const ctx = await archil.context(
  {
    // read: nobody holding this context can change it
    docs: archil.disk("team-handbook"),
    memory: archil.disk("lead-memory", "owned", { create: true }),
    audit: archil.disk("helper-audit", "append", { create: true }),
  },
  { backend, journal: "audit/helpers" },
);
// the lead's own work is journalled, which creates audit/helpers
await ctx.sh`ls ${ctx.path("docs")}`.run({ check: true });

const helper = ctx
  // these sub-trees only
  .narrow(["docs/security", "memory/helper-1", "audit/helpers"])
  .withEgress("deny")             // its commands cannot reach the network
  .withBudget({ maxUsd: 0.02 });  // counted from here on
const tools = new Map(helper.tools().map((tool) => [tool.name, tool]));
console.log(helper.describe());

// What the helper's model can and cannot do.
console.log((await tools.get("run_bash")!.call({
  command: "cat docs/security/keys.md | tail -n 1",
})).trim());
console.log(await tools.get("read_file")!.call({ path: "docs/hr/leave.md" }));
console.log(await tools.get("write_file")!.call({
  path: "memory/helper-1/summary.md",
  content: "Keys rotate every 90 days.\n",
}));

// What it ran is on record, on a disk it cannot rewrite.
const files = await ctx.ls("audit/helpers", { recursive: true });
const spent = helper.spentUnderBudget().usd.toFixed(5);
console.log(files.length, "journal file(s);", spent, "spent");
```

```text output
context "context" on local
  docs/security/    read    team-handbook
  memory/helper-1/  owned   lead-memory
  audit/helpers/    append  helper-audit
Commands run with egress denied.
exit 0
Rotate API keys every 90 days.
error: out_of_scope [docs/hr/leave.md]: outside this context: it is narrowed to docs/security — ask the owner of the wider context for this path
wrote memory/helper-1/summary.md (27 bytes)
2 journal file(s); 5e-05 spent
```

The helper read what it was given. Its attempt to read another part of the handbook came back as text it can act on, not as an exception. Its one statement is in the journal, in a file of its own beside the lead's.

## What to watch

- **Give a writer its own directory** (`memory/helper-1`) rather than the mount's root, and read what it produced afterwards.
- **A reviewer gets `narrow(..., read_only=True)`.** The write tools are then left out altogether. Nothing such a context runs is journalled, because the journal is a write.
- **The journal is written through the context that runs the statement,** which is why the narrowing keeps `audit/helpers`. On an `append` mount the helper's statements are recorded there, and its commands can read that directory but not change it. Leave the directory out and nothing the helper runs is recorded.
- **Whatever else is journalled there, the helper can read too.** Give helpers a journal directory of their own.
- **The journal's directory has to exist before the helper runs a command.** A narrowed mount is a subdirectory mount, and a read-only one cannot be made of a directory that is not there: the call comes back with exit 1 and `mount failed`. The lead's first journalled statement creates it.
- **Paths keep their names under narrowing,** so a prompt written for the full context still reads correctly.

## Next

:::cards
- [Limit reach, network and spend](/guides/narrowing/) The three limits, in detail.
- [Tools for a model](/guides/model-tools/) What each tool returns, and a loop to run them in.
- [The journal](/guides/journal/) What a line holds, and where to put it.
:::
