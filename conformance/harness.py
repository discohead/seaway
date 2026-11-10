"""Builds the conformance fixture and turns a case into a statement.

The fixture is language-neutral JSON (``conformance.json``). The Python SDK
generates the expected values; the TypeScript SDK has to reproduce them. The
same file is replayed by both test suites.
"""

from __future__ import annotations

from datetime import datetime

import seaway as archil

DISKS = {
    "reference": {
        "docs/a.md": "alpha\nneedle one\n",
        "docs/b.md": "beta\n",
        "data/n1.txt": "1\n2\n3\n",
        "data/n2.txt": "10\n20\n",
        "data/deep/n3.txt": "100\n",
        "events/a.ndjson": '{"user":"ana","n":1}\n{"user":"bo","n":5}\n',
        "events/b.ndjson": '{"user":"ana","n":2}\n',
        "names/it's here.txt": "quoted\n",
        "names/ünïcode.txt": "utf8\n",
    },
    "app-logs": {
        "api/2026-11-09/12/web-1.ndjson": '{"ts":"2026-11-09T12:10:00.000Z","id":"000000000001","level":"INFO"}\n',
        "api/2026-11-09/13/web-1.ndjson": '{"ts":"2026-11-09T13:10:00.000Z","id":"000000000002","level":"ERROR"}\n',
        "api/2026-11-09/13/web-2.ndjson": '{"ts":"2026-11-09T13:20:00.000Z","id":"000000000003","level":"INFO"}\n',
        "api/2026-11-09/14/web-1.ndjson": '{"ts":"2026-11-09T14:05:00.000Z","id":"000000000004","level":"ERROR"}\n',
        "api/2026-11-10/00/web-2.ndjson": '{"ts":"2026-11-10T00:01:00.000Z","id":"000000000005","level":"INFO"}\n',
    },
    "workspace": {"a/one.txt": "1", "b/two.txt": "2"},
    "team-shared": {},
}

CONTEXT = {
    "name": "conformance",
    "mounts": {
        "logs": {"disk": "app-logs", "mode": "append", "description": "service logs"},
        "ref": {"disk": "reference", "mode": "read"},
        "work": {"disk": "workspace", "mode": "owned"},
        "team": {"disk": "team-shared", "mode": "shared"},
    },
}


def build(backend, disks=DISKS, context=CONTEXT):
    for name, files in disks.items():
        backend.resolve_disk(name, create=True)
        for key, text in files.items():
            backend.put(name, key, text.encode())
    mounts = {n: archil.disk(m["disk"], m["mode"], description=m.get("description", ""))
              for n, m in context["mounts"].items()}
    return archil.context(mounts, backend=backend, name=context["name"])


def _time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def param(ctx, spec):
    """Decode one parameter: {"path"}, {"out"}, {"glob"}, {"raw"}, {"value"}, {"log", ...} or a list of these.

    A log is {"log": path} for all of it, with "between": [start, end] or "last": span and "now": time for a range.
    """
    if isinstance(spec, list):
        return [param(ctx, s) for s in spec]
    if "path" in spec:
        return ctx.path(spec["path"])
    if "out" in spec:
        return ctx.out(spec["out"])
    if "glob" in spec:
        return ctx.glob(spec["glob"])
    if "raw" in spec:
        return archil.Raw(spec["raw"])
    if "log" in spec:
        log = ctx.log(spec["log"], partition=spec.get("partition", "hour"))
        if "between" in spec:
            return log.between(_time(spec["between"][0]), _time(spec["between"][1]))
        if "last" in spec:
            return log.last(spec["last"], now=_time(spec["now"]))
        return log.all()
    return spec["value"]


def statement(ctx, case):
    if "narrow" in case:
        ctx = ctx.narrow(*case["narrow"]["paths"], read_only=case["narrow"].get("readOnly", False))
    kind = case["kind"]
    if kind == "batch":
        stmt = ctx.batch([statement(ctx, child) for child in case["children"]])
    elif kind == "grep":
        names = {"ignoreCase": "ignore_case", "maxResults": "max_results", "recursive": "recursive", "globs": "globs"}
        stmt = ctx.grep(case["pattern"], case.get("over"), **{names[k]: v for k, v in case.get("options", {}).items()})
    else:
        params = {name: param(ctx, spec) for name, spec in case.get("params", {}).items()}
        stmt = (ctx.sh if kind == "sh" else ctx.sql)(case["template"], **params)
    if case.get("map"):
        stmt = stmt.map(case["map"].get("on"), reduce=case["map"].get("reduce", "concat"), shards=case["map"].get("shards"))
    if case.get("into"):
        stmt = stmt.into(case["into"])
    if case.get("sized"):
        stmt = stmt.sized(vcpu=case["sized"].get("vcpu"), mem_mib=case["sized"].get("memMib"))
    if case.get("egress") is not None:
        stmt = stmt.egress(case["egress"])
    return stmt
