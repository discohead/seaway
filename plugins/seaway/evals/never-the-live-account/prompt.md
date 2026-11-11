---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: A test passes a local backend, so an exported API key cannot send it to an account
tags: [python, backends]
---

seaway, Python. I have `ARCHIL_API_KEY` exported in my shell for other work.

Write a pytest test for this function that cannot touch my Archil account, whatever is in my environment, and that leaves nothing behind:

```python
def count_lines(ctx):
    return int(ctx.sh("cat {files} | wc -l", files=ctx.glob("docs/**/*.md")).run(check=True).text)
```

Tell me why a test that just calls `archil.context({...})` would be a problem.
