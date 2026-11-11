---
type: llm
weight: 3
---

            PASS only if the search is `ctx.grep("pool exhausted", "logs", globs=["checkout-*.ndjson"])` or an equivalent `ctx.grep(...)` call that is then run, the matches are read from `.rows` (each with `file`, `line`, `text`) or from the result's text, and the answer says this is one call (one call per disk, however many files).

            A good answer also mentions that a search stops at a result limit by default and that `value` says whether it was exhaustive, or sets `max_results`.

            FAIL if the search is `rg` or `grep` run through `ctx.sh(...)`, with or without `.map(...)`. FAIL if the answer says the number of calls grows with the number of files. FAIL if the files are read back to the caller and searched there.
