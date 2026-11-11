---
type: llm
weight: 3
---

            PASS only if all of these hold:
            - the files are a declared parameter: `ctx.glob("logs/**/*.ndjson")` passed to `ctx.sh(...)`;
            - the plan is obtained with `.explain()` and printed, and the answer says that this runs nothing;
            - the ceiling is set with `.within(max_usd=0.01)` on the statement, or `ctx.with_budget(max_usd=0.01)` on the context, and the answer says that a plan over the ceiling is refused before anything runs;
            - the explanation points at the plan's `scope` and `price` lines (and ideally `note`).

            It is a plus, and not required, if the answer names the exception, `BudgetExceeded`. Comparing `plan.estimate.usd` with the ceiling by hand as well is harmless.

FAIL if the only ceiling is a comparison written by hand, with no `within` or `with_budget`. FAIL if the cost is "checked" by running the statement first, by a dry-run flag that does not exist, or by reading sizes back with a second command. FAIL if the answer invents an API such as `ctx.estimate(...)`, `dry_run=True` or `max_cost=`.
