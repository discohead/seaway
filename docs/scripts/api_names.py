"""Does the Python SDK have these names? The Python half of check-api.mjs.

Reads {"sdk": <path to python/src>, "root": <a scratch directory>, "queries": [{"receiver", "member"}]}
on stdin. Builds one real object for each receiver on a local backend, and reports the members that
are not there, the error codes the source raises, and what the package exports. Writes
{"missing": ["receiver.member"], "codes": [...], "exports": [...]}.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


def main() -> None:
    job = json.load(sys.stdin)
    sys.path.insert(0, job["sdk"])
    os.environ.pop("ARCHIL_API_KEY", None)
    os.environ["ARCHIL_BACKEND"] = "local"
    import seaway as archil

    backend = archil.LocalBackend(os.path.join(job["root"], "py"))
    ctx = archil.context(
        {
            "docs": archil.disk("handbook", "owned", create=True),
            "logs": archil.disk("app-logs", "append", create=True),
            "memory": archil.disk("agent-memory", "owned", create=True),
        },
        backend=backend,
    )
    ctx.write("docs/a.md", "a\n")
    stmt = ctx.sh("cat {f}", f=ctx.path("docs/a.md"))
    result = stmt.run()
    plan = stmt.explain()
    log = ctx.log("logs")
    log.append({"level": "INFO"})
    feed = ctx.feed("docs", cursor="memory/cursor.json")
    tx = ctx.transaction(writes=["memory"]).begin()
    tx.write("memory/x.md", "x\n")
    commit = tx.commit()
    turn = ctx.transaction(writes=["memory"]).begin()

    try:
        ctx.read("nowhere/x")
    except archil.ValidationError as e:
        validation = e
    errors = [validation, archil.Conflict(["docs/a.md"]), archil.ExecFailed(1, "", "cat"), archil.Error("x")]

    objects = {
        "archil": archil,
        "ctx": ctx,
        "stmt": stmt,
        "result": result,
        "meta": result.meta,
        "plan": plan,
        "estimate": plan.estimate,
        "task": plan.tasks[0],
        "tx": tx,
        "turn": turn,
        "commit": commit,
        "conflict": errors[1],
        "log": log,
        "selection": log.all(),
        "view": ctx.view("memory/view.txt", lambda: stmt),
        "feed": feed,
        "changes": feed.poll(),
        "prices": ctx.prices,
        "budget": archil.Budget(max_usd=1),
        "ledger": ctx.spend,
        "tool": ctx.tools()[0],
        "backend": backend,
        "mount": ctx.mounts["docs"],
        "ref": ctx.path("docs/a.md"),
        "glob": ctx.glob("docs/*.md"),
        "file": ctx.ls("docs")[0],
    }

    missing = []
    for query in job["queries"]:
        receiver, member = query["receiver"], query["member"]
        if receiver == "error":
            found = any(hasattr(error, member) for error in errors)
        elif receiver == "archil" and member == "ArchilBackend":
            found = "ArchilBackend" in archil.__all__  # loaded on first use: it needs the official SDK
        elif receiver == "backend":
            found = hasattr(backend, member) or hasattr(_archil_backend(archil), member)
        else:
            found = hasattr(objects[receiver], member)
        if not found:
            missing.append(f"{receiver}.{member}")

    codes = set()
    for source in Path(job["sdk"], "seaway").glob("*.py"):
        text = source.read_text()
        codes.update(re.findall(r'\bcode\s*=\s*"([a-z_0-9]+)"', text))
        codes.update(re.findall(r'\bIssue\(\s*"([a-z_0-9]+)"', text))
    codes.discard("error")  # the base class's placeholder: nothing is raised with it

    exports = sorted(set(archil.__all__) | {"__version__"})
    json.dump({"missing": missing, "codes": sorted(codes), "exports": exports}, sys.stdout)


def _archil_backend(archil):
    """The Archil backend's class, for names that only it has (`backend.client`). None without the official SDK."""
    try:
        return archil.ArchilBackend
    except Exception:
        return None


if __name__ == "__main__":
    main()
