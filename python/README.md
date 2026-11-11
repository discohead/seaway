# seaway (Python)

The Python SDK, and the reference implementation. See the [README one level up](../README.md) for what this is and why, and [CONTRIBUTING.md](../CONTRIBUTING.md) to work on it.

```bash
pip install -e '.[dev]'                 # Python 3.10+; the package has no runtime dependencies
python examples/quickstart.py
python examples/agent_context.py
python examples/datadog_afternoon.py    # needs the duckdb CLI and jq
python -m pytest -q

python examples/quickstart.py --archil --cleanup    # the same example on Archil; see examples/_where.py
```

```python
import seaway as archil

ctx = archil.context({
    "docs":  archil.disk("handbook"),                         # read is the default mode
    "notes": archil.disk("my-notes", "owned", create=True),
})

words = ctx.sh("wc -w {files} | sort -n", files=ctx.glob("docs/**/*.md"))
print(words.explain())      # the plan: route, scope, split, price
print(words.run().text)

with ctx.transaction() as turn:                               # all of the turn's changes, or none
    turn.write("notes/todo.md", "- read the handbook\n")
```

Without `backend=`, a context uses Archil when `ARCHIL_API_KEY` is set (through the official `archil` package: `pip install archil`) and otherwise a local backend rooted at `.archil-local`. `ARCHIL_BACKEND=local` forces the local one. On Archil, `ctx.sql` needs DuckDB on a disk, because the exec image has none: `archil.duckdb(ctx, "notes/bin").run(check=True)` puts it there, after checking the download against a pinned SHA-256, and `tools={"duckdb": "notes/bin/duckdb"}` tells the context. The [README one level up](../README.md#on-archil) has the rest.

Modules, in reading order: `context.py` (mounts, modes, the data plane), `statement.py` (compiling statements into plans, reducers), `plan.py`, `transaction.py`, `structures.py` (logs, views, feeds), `recipes.py`, `tools.py`, `pricing.py`, then the backends: `backends.py` (the interface), `local.py`, `archil_backend.py`.
