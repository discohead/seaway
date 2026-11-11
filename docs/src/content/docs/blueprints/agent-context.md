---
title: An agent's context
description: Five kinds of data under five rules. What the organisation knows how to do, reference data from a system of record, the agent's own memory, notes a team shares, and a record of what was done.
---

An agent needs five kinds of data, and each is written by someone different. So each is a disk of its own, mounted in the mode that says who writes it.

| Disk | Mode | Layout |
|---|---|---|
| `org-skills` | `frozen` here; `owned` by the team that publishes it | one Markdown file per skill; a checkpoint per release |
| `tracker-mirror` | `read` here; `owned` by the job that syncs it | see [a mirror](/blueprints/mirror/) |
| `agent-7-memory` | `owned` | one file per thing remembered; `state.db` if it needs keyed state |
| `team-notes` | `shared` | a file per topic, and per writer where writers would collide |
| `audit-log` | `append` | the journal: `agent-7/<date>/<session>.ndjson` |

## The program

```python
import json
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

# The platform team publishes the skills, and checkpoints a release.
platform = archil.context(
    {"skills": archil.disk("org-skills", "owned", create=True)},
    backend=backend,
)
platform.sync(
    archil.Static(
        {"triage.md": "# Triage\nReproduce first. Then bisect.\n"},
        name="skills", layout="One Markdown file per skill.",
    ),
    into="skills",
)
platform.checkpoint("2026-11-01")                    # a release: what agents pin to

ctx = archil.context(
    {
        "skills": archil.disk(
            "org-skills", "frozen", at="2026-11-01",
            description="how we work, pinned to a release",
        ),
        "tracker": archil.disk(
            "tracker-mirror", "read", create=True,
            description="issues, mirrored from the tracker",
        ),
        "memory": archil.disk(
            "agent-7-memory", "owned", create=True,
            description="this agent's own notes",
        ),
        "team": archil.disk(
            "team-notes", "shared", create=True,
            description="notes the whole team writes",
        ),
        "audit": archil.disk(
            "audit-log", "append", create=True,
            description="what was done, and by whom",
        ),
    },
    backend=backend, name="agent-7", journal="audit/agent-7",
)
print(ctx.describe())

# a note and the memory of it, together
with ctx.transaction(writes=["team", "memory"]) as turn:
    note = turn.out("team/standup.md")
    turn.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=note).run(check=True)
    turn.write("memory/eng-1.md", "Closed after the coupon fix.\n")

print(ctx.read_text("team/standup.md").strip())

journal = [ctx.read_text(f.path) for f in ctx.ls("audit/agent-7", recursive=True)]
lines = [line for text in journal for line in text.splitlines()]
print(sorted(json.loads(line)["kind"] for line in lines))
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

// The platform team publishes the skills, and checkpoints a release.
const platform = await archil.context(
  { skills: archil.disk("org-skills", "owned", { create: true }) },
  { backend },
);
await platform.sync(
  new archil.Static(
    { "triage.md": "# Triage\nReproduce first. Then bisect.\n" },
    { name: "skills", layout: "One Markdown file per skill." },
  ),
  "skills",
);
await platform.checkpoint("2026-11-01");             // a release: what agents pin to

const ctx = await archil.context(
  {
    skills: archil.disk("org-skills", "frozen", {
      at: "2026-11-01",
      description: "how we work, pinned to a release",
    }),
    tracker: archil.disk("tracker-mirror", "read", {
      create: true,
      description: "issues, mirrored from the tracker",
    }),
    memory: archil.disk("agent-7-memory", "owned", {
      create: true,
      description: "this agent's own notes",
    }),
    team: archil.disk("team-notes", "shared", {
      create: true,
      description: "notes the whole team writes",
    }),
    audit: archil.disk("audit-log", "append", {
      create: true,
      description: "what was done, and by whom",
    }),
  },
  { backend, name: "agent-7", journal: "audit/agent-7" },
);
console.log(ctx.describe());

// a note and the memory of it, together
await ctx.transaction(async (turn) => {
  const note = turn.out("team/standup.md");
  await turn.sh`echo '- agent-7: ENG-1 is done' >> ${note}`.run({ check: true });
  await turn.write("memory/eng-1.md", "Closed after the coupon fix.\n");
}, { writes: ["team", "memory"] });

console.log((await ctx.readText("team/standup.md")).trim());

const files = await ctx.ls("audit/agent-7", { recursive: true });
const journal = await Promise.all(files.map((f) => ctx.readText(f.path)));
const lines = journal.flatMap((text) => text.trim().split("\n"));
console.log(lines.map((line) => JSON.parse(line).kind).sort());
```

```text output
context "agent-7" on local
  skills/   frozen  org-skills @2026-11-01  how we work, pinned to a release
  tracker/  read    tracker-mirror  issues, mirrored from the tracker
  memory/   owned   agent-7-memory  this agent's own notes
  team/     shared  team-notes  notes the whole team writes
  audit/    append  audit-log  what was done, and by whom
- agent-7: ENG-1 is done
['commit', 'sh']
```

## What to watch

- **A new release of the skills changes nothing for this agent** until it is opened `at` the new checkpoint. That is the point of pinning.
- **The journal is on the append-only disk on purpose.** It records at once, cannot be rewritten, and keeps the lines of a turn that later failed. Because it is not on a disk the turn writes, the turn's `writes` need not mention it. Here it holds two lines: the statement the turn ran, and the commit.
- **Writers to `team` that may touch the same file** use a turn and retry on `Conflict`. See [Records many agents edit](/blueprints/shared-records/).
- **The context is a value.** `ctx.manifest()` is this agent's `agent.json`. `ctx.narrow(...)` is what a helper gets. `ctx.fork(...)` is what an attempt gets. `ctx.lock(...)` is what a replay opens.

The repository's [`agent_context` example](/start/examples/#an-agents-context) is this at full length: it also syncs the tracker, runs two agents into a conflict, forks, locks and narrows.

## Next

:::cards
- [Mount modes](/guides/modes/) Why each disk has the mode it has.
- [A helper that is handed less](/blueprints/helper/) What to give a sub-agent out of this context.
:::
