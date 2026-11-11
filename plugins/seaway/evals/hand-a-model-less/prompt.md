---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: A model's tools are built from a narrowed context with the network denied and a budget
tags: [python, tools]
---

seaway, Python. My context `ctx` has mounts `docs` (read), `memory` (owned), `team` (shared) and `audit` (append).

I want to give a model tools for a review task. It should be able to read `docs/security` and nothing else, change nothing, be unable to send anything to the network, and be unable to spend more than five cents. Write the code that builds the tool definitions in Anthropic's format, and say what the model's `run_bash` tool would be able to see.
