---
title: A mirror of a system of record
description: A job syncs a tracker into a disk it owns, one Markdown file per record, and fetches only what changed. Everyone else mounts that disk read-only.
---

A tracker, a CRM or a wiki becomes files an agent can `ls`, `cat` and `grep`. One job owns the mirror and syncs it. Everyone else mounts it `read`.

| Disk | Mode | Layout |
|---|---|---|
| `tracker-mirror` | `owned` by the sync job; `read` for everyone else | `issues/<ID>.md`, with the fields as front matter, and `issues/README.md` |

## The program

```python
import tempfile

import seaway as archil

backend = archil.LocalBackend(tempfile.mkdtemp())

ISSUES = [
    {"id": "ENG-1", "title": "Checkout fails with an expired coupon", "status": "open",
     "updated": "2026-11-08T09:00:00Z",
     "description": "Steps: add a coupon that expired yesterday, then pay."},
    {"id": "ENG-2", "title": "Add dark mode", "status": "open",
     "updated": "2026-11-07T15:30:00Z", "description": ""},
]
issues = archil.Records(
    "issues", lambda: ISSUES,  # stands in for a call to the tracker's API
    key="id", version="updated", body="description",
    layout="One Markdown file per issue, named <ID>.md. "
           "The fields are front matter; the description is the body.",
)

# The job that owns the mirror.
mirror = archil.context(
    {"tracker": archil.disk("tracker-mirror", "owned", create=True)},
    backend=backend,
)
print(mirror.sync(issues, into="tracker/issues"))

# the tracker moves on
ISSUES[0].update(status="done", updated="2026-11-09T10:00:00Z")
# only the record that changed is fetched
print(mirror.sync(issues, into="tracker/issues"))

# Everyone else.
reader = archil.context(
    {"tracker": archil.disk("tracker-mirror")},  # read is the default mode
    backend=backend,
)
files = reader.glob("tracker/issues/*.md")
open_issues = reader.sh("grep -l 'status: open' {issues} | wc -l", issues=files)
print(open_issues.run(check=True).text.strip(), "open")
print(reader.read_text("tracker/issues/README.md").strip())
```

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

const ISSUES = [
  { id: "ENG-1", title: "Checkout fails with an expired coupon", status: "open",
    updated: "2026-11-08T09:00:00Z",
    description: "Steps: add a coupon that expired yesterday, then pay." },
  { id: "ENG-2", title: "Add dark mode", status: "open",
    updated: "2026-11-07T15:30:00Z", description: "" },
];
// stands in for a call to the tracker's API
const issues = new archil.Records("issues", () => ISSUES, {
  key: "id", version: "updated", body: "description",
  layout: "One Markdown file per issue, named <ID>.md. " +
    "The fields are front matter; the description is the body.",
});

// The job that owns the mirror.
const mirror = await archil.context(
  { tracker: archil.disk("tracker-mirror", "owned", { create: true }) },
  { backend },
);
console.log(await mirror.sync(issues, "tracker/issues"));

// the tracker moves on
Object.assign(ISSUES[0]!, { status: "done", updated: "2026-11-09T10:00:00Z" });
// only the record that changed is fetched
console.log(await mirror.sync(issues, "tracker/issues"));

// Everyone else.
const reader = await archil.context(
  { tracker: archil.disk("tracker-mirror") },  // read is the default mode
  { backend },
);
const files = reader.glob("tracker/issues/*.md");
const openIssues = reader.sh`grep -l 'status: open' ${files} | wc -l`;
console.log((await openIssues.run({ check: true })).text.trim(), "open");
console.log((await reader.readText("tracker/issues/README.md")).trim());
```

```text output
{'written': 2, 'unchanged': 0, 'deleted': 0, 'into': 'tracker/issues'}
{'written': 1, 'unchanged': 1, 'deleted': 0, 'into': 'tracker/issues'}
1 open
One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.
```

## What to watch

- **The layout note becomes `issues/README.md`.** Write it for an agent that has never seen this tracker. It is the schema, for a reader that has only `ls` and `cat`.
- **`version` is what makes the sync incremental.** An entry whose version has not changed is not fetched again. Use the system's own updated-at time or ETag.
- **One file per record suits a tracker.** For a source that is scanned (orders, events), write a file per day instead, with a [recipe of your own](/guides/recipes/#a-recipe-of-your-own).
- **Run the sync from wherever a schedule lives.** It is direct writes: no compute, and nothing to keep warm.
- **Readers that must not see a half-finished sync can pin.** Checkpoint after each sync, and mount `frozen` at it.

## Next

:::cards
- [Recipes](/guides/recipes/) `Records`, `Static`, and writing your own.
- [Search](/guides/grep/) The open issues that mention a word, in one call.
:::
