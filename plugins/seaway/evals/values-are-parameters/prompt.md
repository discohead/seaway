---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: A value from a user goes into a statement as a parameter, never into its text
tags: [python, statements]
---

I have a seaway context `ctx` (Python, `import seaway as archil`) with an append-only mount `logs` that holds a log at its root, and the SQL examples I have seen use `ctx.sql`.

Write me a function `errors_for(ctx, service)` that returns how many ERROR records the given service logged in the last 15 minutes. `service` comes straight from a web form, so treat it as hostile. Reply with the function and one or two sentences on how it handles the input. Do not run anything.
