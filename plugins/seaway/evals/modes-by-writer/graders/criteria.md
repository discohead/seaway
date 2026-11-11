---
type: llm
weight: 3
---

            PASS only if the context is opened with `archil.context({...})` and `archil.disk(...)`, and the modes are:
            - the handbook: `read` (the default, so no mode given is also right), or `frozen` with an `at=` checkpoint;
            - the agent's memory: `owned`;
            - the shared notes: `shared`;
            - the audit trail: `append`.

            The explanation should connect each mode to who writes: `owned` because this context is the only writer, `shared` because several agents write, `append` because records are only added.

            Judge the modes and the reasons. Other things in the answer do not count against it: extra helper functions, a backend argument, a journal, descriptions, or a mount name or disk name that differs slightly from the request.

FAIL if any mount has a different mode, for example the shared notes as `owned`, or the audit trail as `owned` or `shared`. FAIL if the answer uses a mode that does not exist (such as `write`, `rw`, `readonly`, `readwrite`). FAIL if the context is composed with functions seaway does not have (such as `archil.mount(...)`, `archil.Disk(...)`, `ctx.add_disk(...)` or a `Workspace` class) instead of `archil.context` and `archil.disk`.
