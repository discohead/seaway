---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: Each mount gets the mode that fits who writes it
tags: [design, contexts]
---

I am setting up storage for an agent on Archil with seaway. It needs:

1. our company handbook, which the people team maintains and the agent must never change;
2. the agent's own working memory, which nothing else writes;
3. a notes area that this agent and three other agents all write to;
4. an audit trail of what the agent did, which must never be rewritten.

The disks are called `handbook`, `agent-7-memory`, `team-notes` and `audit-log`. Write the Python that opens this context, and say in a sentence per mount why you chose its mode.
