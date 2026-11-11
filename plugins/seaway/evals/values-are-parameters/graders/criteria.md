---
type: llm
weight: 3
---

            PASS only if all of these hold in the code given:
            - the query is a `ctx.sql(...)` statement (or `ctx.sh(...)`) whose text is a constant template with `{name}` placeholders;
            - `service` is passed as a keyword parameter to that statement, so that seaway quotes it;
            - the records are a log selection passed as a parameter, such as `ctx.log("logs").last("15m")`, and not a path or a `read_json_auto('…')` call written into the SQL text;
            - the statement is actually run (`.run(...)`) and a count is returned from its rows.

            FAIL if `service` reaches the query through an f-string, `.format`, `%` or `+`; if the code escapes or validates the value by hand instead of passing it as a parameter; if a file path or a glob is written inside the SQL text; or if the statement is built and never run.
