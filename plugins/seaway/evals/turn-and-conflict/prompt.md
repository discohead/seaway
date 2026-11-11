---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: Changes that belong together go in a turn, written through the turn, and a conflict means running it again
tags: [python, turns]
---

seaway, Python. My context `ctx` has a `shared` mount `team` and an `owned` mount `memory`.

When my agent closes an issue it has to do two things that must never be half done: append a line to `team/standup.md`, and write a note at `memory/<issue-id>.md`. Other agents edit `team/standup.md` at the same time.

Write `close_issue(ctx, issue_id, line, note)` so that both changes land or neither does, and so that it copes when another agent got to the standup file first. Reply with the function and a short explanation. Do not run anything.
