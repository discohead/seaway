"""The Python half of the interop check. Usage: side.py <root> <step> <outfile> [args]"""
import errno, hashlib, json, os, subprocess, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python", "src"))
import seaway as archil

root, step, outfile = sys.argv[1:4]
HERE = os.path.dirname(os.path.abspath(__file__))
NOW = datetime(2026, 11, 9, 14, 30, tzinfo=timezone.utc)
backend = archil.LocalBackend(root=root)
ctx = archil.context({
    "logs": archil.disk("app-logs", "append", create=True, description="service logs"),
    "ref": archil.disk("reference", "read", create=True),
    "work": archil.disk("workspace", "owned", create=True),
    "team": archil.disk("team-shared", "shared", create=True),
}, backend=backend, name="interop", journal="work/journal")

ISSUES = [{"id": "ENG-1", "title": "Checkout fails: expired coupon", "state": "open", "labels": ["bug", "p1"], "n": 3, "ok": True, "none": None, "body": "Steps…"},
          {"id": "ENG-2", "title": "Añadir modo oscuro", "state": "done", "labels": [], "n": 0, "ok": False, "none": None, "body": ""}]
SKILLS = {"review.md": "# How we review\n", "deploy.md": "# How we deploy\n", "sub/ünï.md": "x\n"}

def listing():
    out = {}
    for sel in ["ref", "logs", "work", "team", "ref/**/*.txt", "logs/api/**/*.ndjson"]:
        out[sel] = [[f.path, f.size, f.version] for f in ctx.expand(sel)]
    out["ls work"] = [[f.path, f.size, f.version] for f in ctx.ls("work")]
    out["ls ref -r"] = [[f.path, f.size, f.version] for f in ctx.ls("ref", recursive=True)]
    return out

def statements():
    log = ctx.log("logs/api")
    return {
        "cat": ctx.sh("cat {f}", f=ctx.path("ref/docs/a.md")),
        "glob": ctx.sh("wc -c {files}", files=ctx.glob("ref/**/*")),
        "map": ctx.sh("cat {files}", files=ctx.glob("ref/data/**/*.txt")).map(reduce="sum", shards=2),
        "sql": ctx.sql("select level, count(*)::int as n from {events} group by 1 order by 1", events=log.between(NOW - timedelta(minutes=90), NOW)),
        "sql-all": ctx.sql("select count(*)::int as n from {events} where ms > {min}", events=log.all(), min=1.5),
        "grep": ctx.grep("ERROR", "logs/api", ignore_case=True),
        "grep-all": ctx.grep("needle"),
        "into": ctx.sh("sort -n {d}/n1.txt", d=ctx.path("ref/data")).into("work/out/sorted.txt"),
        "batch": ctx.batch([ctx.sh("cat {f}", f=ctx.path("ref/docs/b.md")), ctx.sql("select count(*)::int as c from {t}", t=ctx.path("logs/api"))]),
    }

def errors_view():
    return ctx.view("work/reports/errors.txt", lambda: ctx.sh("cat {events} | grep -c ERROR", events=ctx.log("logs/api").all()))

def count_view():
    return ctx.view("work/reports/count.txt", lambda: ctx.sh("cat {events} | wc -l", events=ctx.log("logs/api").all()))

def dump(out):
    out["listing"] = listing()
    out["plans"] = {name: {"plan": s.explain().to_dict(), "text": str(s.explain())} for name, s in statements().items()}
    out["errors_fingerprint"] = errors_view().fingerprint()
    out["errors_fresh"] = errors_view().fresh
    out["manifest"] = ctx.manifest()
    out["describe"] = ctx.describe()
    out["issue_files"] = {k: ctx.read_text(f"team/issues/{k}") for k in ("ENG-1.md", "ENG-2.md")}
    out["state_files"] = {f.path: ctx.read_text(f.path) for m in ("work", "team") for f in ctx.ls(f"{m}/.px", recursive=True) if "/recipes/" in f.path or "/views/" in f.path} if False else {}

out = {}
if step == "write":
    ctx.write(sys.argv[4], sys.argv[5])
elif step == "seed":
    files = {"docs/a.md": "alpha\nneedle one\n", "docs/b.md": "beta\n", "data/n1.txt": "1\n2\n3\n", "data/n2.txt": "10\n20\n", "data/deep/n3.txt": "100\n",
             "names/it's here.txt": "quoted\n", "names/ünïcode.txt": "utf8\n", "names/" + chr(0x1f600) + ".txt": "astral\n", "names/" + chr(0xffff) + ".txt": "high\n"}
    for key, text in files.items():
        try:
            backend.put("reference", key, text.encode())
        except OSError as error:  # a file system that cannot hold the name: macOS refuses U+FFFF. Both SDKs skip it.
            if error.errno != errno.EILSEQ:
                raise
    for h in range(3):
        ctx.log("logs/api", writer="py-1").append([{"level": "ERROR" if i % 5 == 0 else "INFO", "ms": i, "msg": "héllo"} for i in range(10)], at=NOW - timedelta(hours=h))
    out["view_first"] = errors_view().refresh().stdout
    changes = ctx.feed("logs/api", cursor="work/cursors/api.json").poll()
    out["feed_added"] = [f.path for f in changes.added]
    changes.ack()
    out["sync_skills"] = ctx.sync(archil.Static(SKILLS, name="skills", layout="One Markdown file per skill."), "work/skills")
    out["sync_issues"] = ctx.sync(archil.Records("issues", lambda: ISSUES, key="id", body="body", layout="One file per issue."), "team/issues")
    ctx.sh("true").run()
    ctx.write("work/tmp/old.md", "old\n")
    tx = ctx.transaction(writes=["work"], name="tx-py").begin()
    tx.write("work/from-py.md", "py\n")
    tx.rm("work/tmp/old.md")
    commit = tx.commit()
    out["commit"] = [commit.applied, commit.deleted, commit.calls]
    out["apply_script"] = backend.exec_log[-1]["command"]
    out["apply_mounts"] = backend.exec_log[-1]["mounts"]
    out["tx_manifest"] = backend.get("workspace@tx-py", ".px/tx/tx-py.changes").decode()
    dump(out)
elif step == "dump":
    dump(out)
elif step == "check-and-change":
    # 1. everything the other SDK left is as this SDK would have left it
    dump(out)
    out["sync_skills_same"] = ctx.sync(archil.Static(SKILLS, name="skills", layout="One Markdown file per skill."), "work/skills")
    out["sync_issues_same"] = ctx.sync(archil.Records("issues", lambda: ISSUES, key="id", body="body", layout="One file per issue."), "team/issues")
    feed = ctx.feed("logs/api", cursor="work/cursors/api.json")
    out["feed_empty"] = not feed.poll()
    out["errors_refresh_ran"] = errors_view().refresh() is not None
    # 2. now change things from this side
    ctx.log("logs/api", writer="ts-1").append([{"level": "ERROR", "ms": 99, "msg": "from ts ✓"}, {"level": "INFO", "ms": 1}], at=NOW)
    changes = feed.poll()
    out["feed_added"] = [f.path for f in changes.added]
    changes.ack()
    count_view().refresh()
    out["count_first"] = ctx.read_text("work/reports/count.txt")
    out["sync_skills_changed"] = ctx.sync(archil.Static({**SKILLS, "review.md": "# How we review (v2)\n"}, name="skills", layout="One Markdown file per skill."), "work/skills")
    tx = ctx.transaction(writes=["work"], name="tx-ts").begin()
    tx.write("work/from-ts.md", "ts\n")
    tx.rm("work/from-py.md")
    commit = tx.commit()
    out["commit"] = [commit.applied, commit.deleted, commit.calls]
    json.dump(ctx.lock("interop-lock"), open(sys.argv[4], "w"))
    # 3. a turn begun here, a write from the other SDK in between: the commit must name the path
    tx = ctx.transaction(writes=["work"]).begin()
    tx.write("work/contested-ts.md", "ts\n")
    subprocess.run(["node", f"{HERE}/side.ts", root, "write", "/dev/null", "work/contested-ts.md", "py\n"], check=True, capture_output=True)
    try:
        tx.commit(); out["conflict"] = "committed"
    except archil.Conflict as e:
        out["conflict"] = e.paths
    out["after"] = listing()
elif step == "verify":
    dump(out)
    out["count_fresh"] = count_view().fresh  # a view the other SDK built
    out["feed_empty_after_ts_ack"] = not ctx.feed("logs/api", cursor="work/cursors/api.json").poll()
    out["sync_skills_again"] = ctx.sync(archil.Static({**SKILLS, "review.md": "# How we review (v2)\n"}, name="skills", layout="One Markdown file per skill."), "work/skills")
    out["sync_issues_again"] = ctx.sync(archil.Records("issues", lambda: ISSUES, key="id", body="body", layout="One file per issue."), "team/issues")
    frozen = archil.from_manifest(sys.argv[4], backend=backend)
    out["frozen_modes"] = sorted({m.mode for m in frozen.mounts.values()})
    out["frozen_read"] = frozen.read_text("work/from-ts.md")
    journal = [json.loads(line) for f in ctx.ls("work/journal", recursive=True) for line in ctx.read_text(f.path).splitlines()]
    out["journal_kinds"] = sorted({e["kind"] for e in journal})
    out["journal_sql"] = ctx.sql("select kind, count(*)::int as n from {j} group by 1 order by 1", j=ctx.path("work/journal")).run(check=True).rows
    out["log_sql"] = ctx.sql("select count(*)::int as n, count(distinct id)::int as ids, count(distinct ts)::int as stamps from {e}", e=ctx.log("logs/api").all()).run(check=True).rows
    out["ts_tx_manifest"] = backend.get("workspace@tx-ts", ".px/tx/tx-ts.changes").decode()
    state = "work/.px/views/" + hashlib.sha1(b"work/reports/count.txt").hexdigest()[:16] + ".json"
    out["ts_view_state"] = ctx.read_text(state)
    # a turn begun here, a write from the other SDK in between: the commit must name the path
    tx = ctx.transaction(writes=["work"]).begin()
    tx.write("work/contested.md", "py\n")
    subprocess.run(["node", f"{HERE}/side.ts", root, "write", "/dev/null", "work/contested.md", "ts\n"], check=True, capture_output=True)
    try:
        tx.commit(); out["conflict"] = "committed"
    except archil.Conflict as e:
        out["conflict"] = e.paths
    out["contested"] = ctx.read_text("work/contested.md")

json.dump(out, open(outfile, "w"), ensure_ascii=False, indent=1)
print("python", step, "done")
