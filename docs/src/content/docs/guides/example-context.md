---
title: The example context
description: The four disks and the one context that the examples in these docs run against, and the setup that creates them.
sidebar:
  label: The example context
---

Most examples in these docs are a few lines that use two names: `archil`, the import, and `ctx`, a context with four mounts. This page is where both come from. Save the setup below, add any example after it, and it runs on a local backend with no account.

| Mount | Disk | Mode | What is on it |
|---|---|---|---|
| `docs` | `handbook` | `read` | three policies in Markdown, one of them under `security/` |
| `logs` | `app-logs` | `append` | three hours of JSON lines from three services |
| `memory` | `agent-memory` | `owned` | one note |
| `team` | `team-notes` | `shared` | a stand-up note and two CSV files of leads |

## Setup

```python title="setup.py"
import tempfile
from datetime import datetime, timedelta, timezone

import seaway as archil

# A root of its own: nothing shared, nothing left behind.
backend = archil.LocalBackend(tempfile.mkdtemp())

# Seed four disks. Whoever owns a disk writes it; here one context owns them all.
seed = archil.context({
    "docs":   archil.disk("handbook", "owned", create=True),
    "logs":   archil.disk("app-logs", "append", create=True),
    "memory": archil.disk("agent-memory", "owned", create=True),
    "team":   archil.disk("team-notes", "owned", create=True),
}, backend=backend)

for path, text in {
    "docs/onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
    "docs/expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
    "docs/security/keys.md":
        "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
    "memory/notes/eng-1.md": "Closed after the coupon fix.\n",
    "team/standup.md": "- nothing yet\n",
    "team/leads/emea.csv": "name,region\nAda,emea\nBo,emea\n",
    "team/leads/amer.csv": "name,region\nCy,amer\nAda,emea\n",
}.items():
    seed.write(path, text)

# Three hours of logs: two steady services, and one whose errors are all in the
# last quarter of an hour.
seeded = datetime.now(timezone.utc)
exhausted = "payments-gateway pool exhausted in_use=64/64"

def emit(service, minutes_ago, level="INFO", path="/", ms=120, msg="ok"):
    seed.log("logs", writer=f"{service}-a").append(
        {"level": level, "service": service, "path": path, "ms": ms, "msg": msg},
        at=seeded - timedelta(minutes=minutes_ago),
    )

for m in (1, 3, 5, 8, 12, 20, 40, 65, 95, 130, 160):
    emit("api", m, path="/item")
for m in (2, 6, 25, 70, 110, 150):
    emit("checkout", m, path="/cart", ms=140)
for m in (4, 9, 13):
    emit("checkout", m, "ERROR", "/pay", 5000, exhausted)
for m in (7, 33):
    emit("search", m, path="/search", ms=90)

# The context every example uses.
ctx = archil.context({
    "docs":   archil.disk("handbook"),               # read, the default: cannot write
    "logs":   archil.disk("app-logs", "append"),     # append: records are only added
    "memory": archil.disk("agent-memory", "owned"),  # owned: one writer, this context
    "team":   archil.disk("team-notes", "shared"),   # shared: many writers
}, backend=backend)
```

```ts title="setup.ts"
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

// A root of its own: nothing shared, nothing left behind.
const backend = new archil.LocalBackend({
  root: mkdtempSync(join(tmpdir(), "seaway-")),
});

// Seed four disks. Whoever owns a disk writes it; here one context owns them all.
const seed = await archil.context({
  docs: archil.disk("handbook", "owned", { create: true }),
  logs: archil.disk("app-logs", "append", { create: true }),
  memory: archil.disk("agent-memory", "owned", { create: true }),
  team: archil.disk("team-notes", "owned", { create: true }),
}, { backend });

const seedFiles: Record<string, string> = {
  "docs/onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
  "docs/expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
  "docs/security/keys.md":
    "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
  "memory/notes/eng-1.md": "Closed after the coupon fix.\n",
  "team/standup.md": "- nothing yet\n",
  "team/leads/emea.csv": "name,region\nAda,emea\nBo,emea\n",
  "team/leads/amer.csv": "name,region\nCy,amer\nAda,emea\n",
};
for (const [path, text] of Object.entries(seedFiles)) await seed.write(path, text);

// Three hours of logs: two steady services, and one whose errors are all in the
// last quarter of an hour.
const seeded = Date.now();
const exhausted = "payments-gateway pool exhausted in_use=64/64";

async function emit(
  service: string, minutesAgo: number, level = "INFO", path = "/", ms = 120, msg = "ok",
) {
  await seed.log("logs", { writer: `${service}-a` }).append(
    { level, service, path, ms, msg },
    { at: new Date(seeded - minutesAgo * 60_000) },
  );
}

for (const m of [1, 3, 5, 8, 12, 20, 40, 65, 95, 130, 160]) {
  await emit("api", m, "INFO", "/item");
}
for (const m of [2, 6, 25, 70, 110, 150]) {
  await emit("checkout", m, "INFO", "/cart", 140);
}
for (const m of [4, 9, 13]) {
  await emit("checkout", m, "ERROR", "/pay", 5000, exhausted);
}
for (const m of [7, 33]) {
  await emit("search", m, "INFO", "/search", 90);
}

// The context every example uses.
const ctx = await archil.context({
  docs: archil.disk("handbook"),                  // read, the default: cannot write
  logs: archil.disk("app-logs", "append"),        // append: records are only added
  memory: archil.disk("agent-memory", "owned"),   // owned: one writer, this context
  team: archil.disk("team-notes", "shared"),      // shared: many writers
}, { backend });
```

The same disk is mounted under two rules here. The `seed` context owns the handbook, because something has to write it. The `ctx` context reads it, and can't change it. A mode belongs to the mount, not to the disk.

## What it creates

```text
handbook/        onboarding.md   expenses.md   security/keys.md
app-logs/        <date>/<hour>/api-a.ndjson   checkout-a.ndjson   search-a.ndjson
agent-memory/    notes/eng-1.md
team-notes/      standup.md   leads/emea.csv   leads/amer.csv
```

Each is a directory under the backend's root, at `<root>/disks/<disk>/`. The logs follow the [log layout](/guides/logs/): a directory per hour in UTC, a file per writer, one JSON object per line.

## Run an example

Add an example to the end of the setup and run the file.

A few examples open a context of their own and call it `ctx`. In TypeScript that declares the name a second time, so put such an example in braces: `{ … }`.

```bash
python setup.py      # Python 3.10 or later
node setup.ts        # Node 22.19 or later, which runs TypeScript as it is
```

The examples that use `ctx.sql` need the `duckdb` command, and a few pipelines use `jq`. [Installation](/start/installation/#the-tools-statements-call) covers both.

An example that begins with its own imports is a whole program. It doesn't need the setup.

## These examples are tested

Every example on this site is run as written, in both languages, whenever the docs or either SDK changes. The TypeScript is type-checked as well. Three kinds of block are shown without being run, because they can't run on a local backend:

- code that reaches Archil or a model provider;
- signatures in the [API reference](/reference/);
- fragments that show what *not* to write.
