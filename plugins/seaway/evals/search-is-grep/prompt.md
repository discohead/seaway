---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: A regex search over many files is ctx.grep, one call per disk
tags: [python, cost]
---

seaway, Python. The mount `logs` holds about forty thousand NDJSON files from our services. I need every line that says `pool exhausted`, from the files named `checkout-*.ndjson` only, with the file and line number of each.

Write the code, and tell me how many billed calls it makes. Do not run anything.
