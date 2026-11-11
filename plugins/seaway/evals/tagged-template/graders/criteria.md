---
type: llm
weight: 3
---

            PASS only if all of these hold:
            - the files are named with `ctx.glob(...)` (or `ctx.path(...)`) built from `dir`, and passed to the statement as a parameter;
            - the statement is written either as a tagged template, ``ctx.sh`… ${…} …` ``, or with named parameters, `ctx.sh("… {files} …", { files })`;
            - the statement is run, by `await`ing it or calling `.run(...)`, and a number is derived from its output;
            - the function returns a number, not a statement.

            FAIL if the code calls `ctx.sh(` or `ctx.sql(` with a template literal that interpolates a value, as in ``ctx.sh(`wc -w docs/${dir}/**/*.md`)``: that is a function call, JavaScript pastes the value into the text, and nothing is quoted or declared. FAIL if the path is concatenated into the command's text. FAIL if the statement is never awaited or run.
