"""Run the Python examples from the skills' reference files. The other half of docs.test.mjs.

Reads {"sdk": <path to python/src>, "blocks": [{"id", "root", "code"}]} on stdin. Each block gets a
context of its own on a local root that docs.test.mjs has seeded, and runs with `archil`, `ctx` and
`backend` defined, as the skill says its examples do. Writes [{"id", "ok", "error", "stdout"}].
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback


def main() -> None:
    job = json.load(sys.stdin)
    sys.path.insert(0, job["sdk"])
    # an example must never reach an account, whatever the caller's environment holds
    os.environ.pop("ARCHIL_API_KEY", None)
    os.environ["ARCHIL_BACKEND"] = "local"
    import seaway as archil

    results = []
    for block in job["blocks"]:
        backend = archil.LocalBackend(block["root"])
        ctx = archil.context(
            {
                "docs": archil.disk("handbook"),
                "logs": archil.disk("app-logs", "append"),
                "memory": archil.disk("agent-memory", "owned"),
                "team": archil.disk("team-notes", "shared"),
            },
            backend=backend,
        )
        scope = {"archil": archil, "ctx": ctx, "backend": backend, "__name__": "__example__"}
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                exec(compile(block["code"], block["id"], "exec"), scope)
            results.append({"id": block["id"], "ok": True, "error": "", "stdout": out.getvalue()})
        except BaseException:  # an example that exits or raises has failed either way
            results.append({"id": block["id"], "ok": False, "error": traceback.format_exc(limit=4), "stdout": out.getvalue()})
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
