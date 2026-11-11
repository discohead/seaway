---
title: A run that can be replayed
description: A lock is a manifest in which every mount is frozen at a checkpoint. Opening it gives the same bytes every time, which is what an eval, a replay or a bisection needs.
---

An eval has to hold its inputs still while the live disks move on. A lock does that: it is a manifest in which every mount is frozen at a checkpoint. Save it beside the results, and any later run reads the same bytes.

| Disk | Mode | Layout |
|---|---|---|
| `eval-cases` | `owned`, then `frozen` by the lock | one JSON file per case |
| `org-skills-eval` | `owned`, then `frozen` by the lock | one Markdown file per skill |
| `eval-out-<run>` | `owned` | `results/`: a log, one record per case, one writer per run |

## The program

```python
import json
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

live = archil.context(
    {
        "cases": archil.disk("eval-cases", "owned", create=True),
        "skills": archil.disk("org-skills-eval", "owned", create=True),
    },
    backend=backend,
)
live.write(
    "cases/001.json",
    json.dumps({"input": "refund policy?", "expect": "30 days"}),
)
live.write("skills/refunds.md", "Refunds within 30 days.\n")

lock = live.lock("eval-2026-11-10")  # save this JSON beside the results
live.write("skills/refunds.md", "Refunds within 14 days.\n")  # the live disks move on

def run(lock, name):
    fixed = archil.from_manifest(lock, backend=backend)  # every mount frozen
    scratch = archil.context(
        {"out": archil.disk(f"eval-out-{name}", "owned", create=True)},
        backend=backend,
    )
    scratch.log("out/results", writer=name).append(
        {"case": "001", "skills_say": fixed.read_text("skills/refunds.md").strip()})
    return scratch

for scratch in (run(lock, "run-a"), run(lock, "run-b")):
    for f in scratch.ls("out/results", recursive=True):
        print(json.loads(scratch.read_text(f.path))["skills_say"])

print(live.read_text("skills/refunds.md").strip())
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const live = await archil.context(
  {
    cases: archil.disk("eval-cases", "owned", { create: true }),
    skills: archil.disk("org-skills-eval", "owned", { create: true }),
  },
  { backend },
);
await live.write(
  "cases/001.json",
  JSON.stringify({ input: "refund policy?", expect: "30 days" }),
);
await live.write("skills/refunds.md", "Refunds within 30 days.\n");

const lock = await live.lock("eval-2026-11-10");  // save this JSON beside the results
await live.write("skills/refunds.md", "Refunds within 14 days.\n");  // live moves on

async function run(lock: archil.Manifest, name: string): Promise<archil.Context> {
  const fixed = await archil.fromManifest(lock, { backend });  // every mount frozen
  const scratch = await archil.context(
    { out: archil.disk(`eval-out-${name}`, "owned", { create: true }) },
    { backend },
  );
  await scratch.log("out/results", { writer: name }).append(
    { case: "001", skills_say: (await fixed.readText("skills/refunds.md")).trim() });
  return scratch;
}

for (const scratch of [await run(lock, "run-a"), await run(lock, "run-b")]) {
  for (const f of await scratch.ls("out/results", { recursive: true })) {
    console.log(JSON.parse(await scratch.readText(f.path)).skills_say);
  }
}

console.log((await live.readText("skills/refunds.md")).trim());
```

```text output
Refunds within 30 days.
Refunds within 30 days.
Refunds within 14 days.
```

Both runs read the skills as they were when the lock was taken. The live disk has moved on.

## What to watch

- **Results go on a disk of their own, as a log:** one record per case, one writer per run. Comparing runs is then one `sql` over two selections or two globs.
- **A lock checkpoints every mount that is not already frozen.** On Archil that is one call per mount, and a checkpoint that stays.
- **A locked context can write nothing,** so a harness needs its scratch disk from outside the lock.
- **Lock names have to be new on their disks.** Put a date or a run id in the name.

To bisect, take a lock per candidate and run the same cases against each.

## Next

:::cards
- [Checkpoint, lock and fork](/guides/checkpoints/) What a lock covers, and what it leaves behind.
- [Manifests](/guides/manifests/) The document a lock returns.
:::
