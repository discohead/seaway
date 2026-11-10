"""Write conformance.json from the Python SDK, which is the reference implementation.

    python conformance/generate.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "python" / "src")]

import seaway as archil  # noqa: E402
from harness import CONTEXT, DISKS, build, statement  # noqa: E402
from seaway.plan import canonical  # noqa: E402
from seaway.shell import Glob, quote, render, sql_literal  # noqa: E402
from seaway.statement import REDUCERS, describe_param  # noqa: E402

CASES = [
    {"name": "one file is mounted as its directory, read-only", "kind": "sh", "template": "cat {f}",
     "params": {"f": {"path": "ref/docs/a.md"}}},
    {"name": "no declared paths mounts the whole context", "kind": "sh", "template": "ls"},
    {"name": "values are quoted", "kind": "sh", "template": "printf '%s %s %s %s' {a} {b} {c} {d}",
     "params": {"a": {"value": "x'; rm -rf /; echo '"}, "b": {"value": 3}, "c": {"value": True}, "d": {"value": None}}},
    {"name": "shell braces are left alone", "kind": "sh",
     "template": "awk '{print $1}' {f} | head -n {n}; echo ${HOME} {a,b}",
     "params": {"f": {"path": "ref/data/n1.txt"}, "n": {"value": 2}}},
    {"name": "raw text and a list of paths", "kind": "sh", "template": "cat {files} {flags}",
     "params": {"files": [{"path": "ref/docs/a.md"}, {"path": "ref/data/n1.txt"}], "flags": {"raw": "| wc -l"}}},
    {"name": "a glob is expanded, not split", "kind": "sh", "template": "cat {files}",
     "params": {"files": {"glob": "ref/data/**/*.txt"}}},
    {"name": "file names that need quoting", "kind": "sh", "template": "wc -c {files}",
     "params": {"files": {"glob": "ref/names/*.txt"}}},
    {"name": "map splits into shards and names the reducer", "kind": "sh", "template": "cat {files}",
     "params": {"files": {"glob": "ref/data/**/*.txt"}}, "map": {"reduce": "sum", "shards": 3}},
    {"name": "map chooses the shard count from the input when not told", "kind": "sh", "template": "rg -c n {files}",
     "params": {"files": {"glob": "ref/**/*"}}, "map": {"reduce": "sum_by_key"}},
    {"name": "map into a directory writes one part per shard", "kind": "sh", "template": "cat {files}",
     "params": {"files": {"glob": "ref/data/**/*.txt"}}, "map": {"shards": 2}, "into": "team/parts"},
    {"name": "into a file on an owned mount takes a checkout", "kind": "sh", "template": "sort -n {d}/n1.txt {d}/n2.txt",
     "params": {"d": {"path": "ref/data"}}, "into": "work/out/sorted.txt"},
    {"name": "a declared output gets its directory", "kind": "sh", "template": "echo hi > {f}",
     "params": {"f": {"out": "work/new/dir/hi.txt"}}},
    {"name": "a shared mount is conditional", "kind": "sh", "template": "date > {f}",
     "params": {"f": {"out": "team/ana/now.txt"}}},
    {"name": "a larger VM bills as a multiple", "kind": "sh", "template": "true",
     "sized": {"vcpu": 8, "memMib": 16384}},
    {"name": "a plain search is pointed at grep", "kind": "sh", "template": "rg -c needle {d}",
     "params": {"d": {"path": "ref/docs"}}},
    {"name": "narrowing keeps path names", "kind": "sh", "template": "find -L . -type f",
     "narrow": {"paths": ["work/a", "ref/docs"]}},
    {"name": "narrowing read-only", "kind": "sh", "template": "cat {f}", "params": {"f": {"path": "work/a/one.txt"}},
     "narrow": {"paths": ["work/a"], "readOnly": True}},
    {"name": "sql over a directory binds values", "kind": "sql",
     "template": "select user, sum(n)::int as total from {events} where user <> {skip} and n >= {min} group by 1 order by 1",
     "params": {"events": {"path": "ref/events"}, "skip": {"value": "o'brien"}, "min": {"value": 1}}},
    {"name": "sql over a glob into parquet", "kind": "sql", "template": "select user, n from {events} where n > {min};",
     "params": {"events": {"glob": "ref/events/*.ndjson"}, "min": {"value": 1}}, "into": "work/big.parquet"},
    {"name": "sql over one file", "kind": "sql", "template": "select count(*) as c from {t}",
     "params": {"t": {"path": "ref/events/a.ndjson"}}},
    {"name": "sql over nothing costs nothing", "kind": "sql", "template": "select count(*) from {events}",
     "params": {"events": {"glob": "ref/none/*.ndjson"}}},
    {"name": "sql over a log selection reads only the partitions in range", "kind": "sql",
     "template": "select level, count(*)::int as n from {events} group by 1 order by 1",
     "params": {"events": {"log": "logs/api", "between": ["2026-11-09T13:15:00Z", "2026-11-09T14:30:00Z"]}}},
    {"name": "sql over the last ninety minutes of a log has no upper bound", "kind": "sql",
     "template": "select count(*)::int as n from {events}",
     "params": {"events": {"log": "logs/api", "last": "90m", "now": "2026-11-09T14:30:00Z"}}},
    {"name": "sql over a whole log", "kind": "sql", "template": "select count(*)::int as n from {events}",
     "params": {"events": {"log": "logs/api"}}},
    {"name": "bash over a log selection gets the files of the partitions", "kind": "sh", "template": "cat {events} | wc -l",
     "params": {"events": {"log": "logs/api", "between": ["2026-11-09T13:15:00Z", "2026-11-09T14:30:00Z"]}}},
    {"name": "grep under a path", "kind": "grep", "pattern": "needle", "over": "ref/docs"},
    {"name": "grep over the whole context", "kind": "grep", "pattern": "ERROR|needle", "options": {"ignoreCase": True}},
    {"name": "grep with globs and a result limit", "kind": "grep", "pattern": "it's", "over": "ref",
     "options": {"globs": ["*.md", "*.txt"], "maxResults": 5, "recursive": True}},
    {"name": "grep over one file searches its directory for that name", "kind": "grep", "pattern": "needle",
     "over": "ref/docs/a.md"},
    {"name": "egress can be denied for a call", "kind": "sh", "template": "cat {f}",
     "params": {"f": {"path": "ref/docs/a.md"}}, "egress": "deny"},
    {"name": "egress to named hosts only, on a larger VM", "kind": "sh", "template": "pip install -r {f}",
     "params": {"f": {"path": "ref/docs/a.md"}}, "egress": ["pypi.org", "files.pythonhosted.org"],
     "sized": {"vcpu": 4, "memMib": 4096}},
    {"name": "batch runs several statements in one call", "kind": "batch", "children": [
        {"kind": "sh", "template": "cat {f}", "params": {"f": {"path": "ref/docs/b.md"}}},
        {"kind": "sh", "template": "echo oops >&2; exit 3"},
        {"kind": "sql", "template": "select count(*)::int as c from {t}", "params": {"t": {"path": "ref/events"}}},
    ]},
    {"name": "batch of declared statements mounts only what they need", "kind": "batch", "children": [
        {"kind": "sh", "template": "wc -l < {f}", "params": {"f": {"path": "ref/data/n1.txt"}}},
        {"kind": "sh", "template": "echo done > {f}", "params": {"f": {"out": "work/done.txt"}}},
    ]},
]

QUOTE = ["", "plain", "two words", "it's", "a/b-c_d.e:f,g@h%i+j=k", "$(rm -rf /)", "ünïcode", "tab\there",
         "new\nline", 0, 42, -7, 1.5, True, False, None]
SQL = ["plain", "o'brien", 0, 42, 1.5, True, False, None]
RENDER = [
    {"template": "awk '{print $1}' {file} | head -n {n}; echo ${HOME} {a,b} \\{n} {missing}", "params": {"file": "f", "n": 3}},
    {"template": "{a}{a} {b}", "params": {"a": "x", "b": "y"}},
    {"template": "find . -exec rm {} +", "params": {}},
]
GLOBS = [
    {"pattern": "m/**/*.txt", "paths": ["a.txt", "d/b.txt", "d/e/c.txt", "d/c.md", "x.txt.bak"]},
    {"pattern": "m/*.txt", "paths": ["a.txt", "d/b.txt"]},
    {"pattern": "m/d/**", "paths": ["d/b.txt", "d/e/c.txt", "a.txt", "dd/x"]},
    {"pattern": "m/log-?.ndjson", "paths": ["log-1.ndjson", "log-10.ndjson", "log-.ndjson"]},
    {"pattern": "m/a+b/(x).[y]", "paths": ["a+b/(x).[y]", "aab/(x).y"]},
    {"pattern": "m/plain/file.txt", "paths": ["plain/file.txt", "plain/file_txt"]},
]
REDUCE = {
    "concat": [["a\nb", "", "c\n"]],
    "lines": [["a\nb\n", "c"]],
    "sorted": [["b\na\n", "c\nA\n"]],
    "unique": [["b\na\n", "a\nc\n"]],
    "count": [["a\nb\n", "c\n", ""]],
    "sum": [["1\n2\n", " 3.5 \n\n", ""], ["1\n", "2\n"], ["-4\n", "1\n"], ["3 file.txt\n"], ["1e3\n"]],
    "sum_by_key": [["a.txt:3\nb.txt:1\n", "a.txt:2\nc d.txt:4\n"], ["   3 /pay\n   1 /cart\n", "   2 /cart\n  10 /item\n"],
                   ["k\t1.5\n", "k\t1\n\n"], ["12 host:8080\n", "host:8080\t3\n"], ["a:1\n", "no count here\n"]],
    "json": [['[{"a":1}]', "", '{"b":2}', "[3]"]],
}
DESCRIBE = [{"value": "x"}, {"value": 3}, {"value": True}, {"value": None}, {"path": "ref/docs/a.md"},
            {"out": "work/x.txt"}, {"glob": "ref/**/*.txt"}, {"raw": "| wc -l"},
            [{"path": "ref/docs"}, {"value": "y"}], {"log": "logs/api"},
            {"log": "logs/api", "between": ["2026-11-09T13:15:00Z", "2026-11-09T14:30:00Z"]},
            {"log": "logs/api", "last": "90m", "now": "2026-11-09T14:30:00Z"}]


def reduced(name: str, outs: list) -> dict:
    try:
        value, stdout = REDUCERS[name](outs)
    except archil.Error as e:
        return {"reduce": name, "outputs": outs, "error": e.code}
    return {"reduce": name, "outputs": outs, "value": value, "stdout": stdout}


def main() -> None:
    from harness import param

    backend = archil.LocalBackend(root=tempfile.mkdtemp(prefix="archil-conformance-"))
    ctx = build(backend)
    prices = archil.PriceSheet()
    cases = []
    for case in CASES:
        plan = statement(ctx, case).explain()
        cases.append({**case, "plan": plan.to_dict(), "text": str(plan)})
    narrowed = ctx.narrow("work/a", "ref/docs", read_only=True)
    out = {
        "about": "Generated by conformance/generate.py from the Python SDK. Do not edit by hand. "
                 "Numbers named usd* are compared to within 1e-9; everything else must match exactly.",
        "disks": DISKS,
        "context": CONTEXT,
        "manifest": ctx.manifest(),
        "describe": ctx.describe(),
        "narrowed": {"paths": ["work/a", "ref/docs"], "readOnly": True, "manifest": narrowed.manifest(),
                     "describe": narrowed.describe()},
        "cases": cases,
        "quote": [{"value": v, "shell": quote(v)} for v in QUOTE],
        "sqlLiteral": [{"value": v, "sql": sql_literal(v)} for v in SQL],
        "render": [{**r, "out": render(r["template"], r["params"], lambda name, value: f"<{value}>")} for r in RENDER],
        "globs": [{**g, "prefix": Glob("m", g["pattern"][2:]).static_prefix(),
                   "matches": [p for p in g["paths"] if Glob("m", g["pattern"][2:]).regex().match(p)]} for g in GLOBS],
        "reducers": [reduced(name, outs) for name, sets in REDUCE.items() for outs in sets],
        "describeParam": [{"param": d, "text": describe_param(param(ctx, d))} for d in DESCRIBE],
        "canonical": [{"value": v, "json": canonical(v)} for v in
                      [{"b": 1, "a": [True, None, "é", "\n"]}, {"z": {"y": 1, "x": "a b"}, "n": 0}]],
        "pricing": {
            "asOf": prices.as_of,
            "callUsd": prices.call_usd,
            "callUnits": [{"vcpu": v, "memMib": m, "units": prices.call_units(v, m)}
                          for v, m in [(2, 4096), (1, 1024), (4, 4096), (2, 16384), (8, 16384), (32, 65536), (3, 5000)]],
            "activeUsd1GiB": prices.active_usd(1024**3),
            "egressUsd1GB": prices.egress_usd(1000**3),
            "sandboxHourUsd": prices.sandbox_hour_usd(2, 4096),
            "breakevenCallsPerHour": prices.breakeven_calls_per_hour(),
        },
    }
    target = HERE / "conformance.json"
    target.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {target} ({len(cases)} plans)")


if __name__ == "__main__":
    main()
