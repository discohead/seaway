---
type: llm
weight: 3
---

            PASS only if all of these hold:
            - the context is narrowed before the tools are made: `ctx.narrow("docs/security", read_only=True)`;
            - the network is denied on that context: `.with_egress("deny")`;
            - a budget is set on it: `.with_budget(max_usd=0.05)`;
            - the tools come from that narrowed context, `.tools()`, and are converted with `tool.to_anthropic()`;
            - the answer says `run_bash` sees only `docs/security`, read-only, because the other disks are not mounted at all.

            It is a plus if the answer notes that the write tools are left out of a context that can write nothing, and that `describe()` gives a system prompt.

            FAIL if the tools are built from the full `ctx`. FAIL if read-only is achieved by filtering tool names alone while `run_bash` can still write. FAIL if egress or the budget is missing. FAIL if the answer invents an API such as `ctx.sandbox(...)`, `permissions=` or `ctx.readonly()`.
