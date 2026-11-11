"""Run the Python examples from the docs. The other half of check-examples.mjs.

Reads {"sdk": <path to python/src>, "setup": <the setup.py block>, "scratch": <a directory>,
"blocks": [{"id", "code", "complete"}]} on stdin. Each block runs in a directory of its own, with
nothing shared with the block before it. A block that is a whole program runs as it is. Any other
runs after the setup, in the same namespace, the way the page "The example context" says to.
Writes [{"id", "ok", "error", "stdout"}].
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import traceback


def main() -> None:
    job = json.load(sys.stdin)
    sys.path.insert(0, job["sdk"])
    # an example must never reach an account, whatever the caller's environment holds
    os.environ.pop("ARCHIL_API_KEY", None)
    os.environ["ARCHIL_BACKEND"] = "local"
    home = os.getcwd()

    results = []
    for block in job["blocks"]:
        os.chdir(tempfile.mkdtemp(prefix="cwd-", dir=job["scratch"]))
        scope = {"__name__": "__main__"}
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                if not block["complete"]:
                    exec(compile(job["setup"], "setup.py", "exec"), scope)
                exec(compile(block["code"], block["id"], "exec"), scope)
            results.append({"id": block["id"], "ok": True, "error": "", "stdout": out.getvalue()})
        except BaseException:  # an example that exits or raises has failed either way
            results.append({"id": block["id"], "ok": False, "error": traceback.format_exc(limit=6), "stdout": out.getvalue()})
        finally:
            os.chdir(home)
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
