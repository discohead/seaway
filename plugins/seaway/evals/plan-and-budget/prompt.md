---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: A statement is explained before it runs, and a budget refuses it before anything is sent
tags: [python, plans]
---

seaway, Python, on Archil. I am about to run a `jq` pipeline over every file matching `logs/**/*.ndjson` and I do not know how much data that is.

Show me how to (1) see what the call would mount and what it would cost before anything runs, and (2) make it refuse to run at all if it would cost more than one cent. Use `ctx.sh` with whatever `jq` filter you like. Explain which lines of the plan I should read. Do not run anything.
