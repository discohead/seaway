"""Statements: prepared parameters, scope, fan-out, grep, sql, batch, budgets."""

import json

import pytest

import seaway as archil
from seaway.shell import FileStat
from seaway.statement import make_shards

from conftest import needs_duckdb


def test_values_are_quoted_so_they_cannot_become_shell(seeded, backend):
    hostile = "x'; touch work/owned; echo '"
    result = seeded.sh("printf '%s' {v}", v=hostile).run()
    assert result.text == hostile
    assert not seeded.exists("work/owned")
    # the parameter never reached the shell as code: one exec, and the value arrived intact
    assert len(backend.exec_log) == 1


def test_a_parameter_that_is_not_in_the_command_is_an_error(seeded):
    with pytest.raises(archil.ValidationError) as exc:
        seeded.sh("cat {file}", flie=seeded.path("ref/docs/a.md")).explain()
    assert exc.value.code == "unused_parameter"


def test_declared_paths_decide_what_is_mounted(seeded, backend):
    plan = seeded.sh("cat {f}", f=seeded.path("ref/docs/a.md")).explain()
    mounts = plan.tasks[0].mounts
    assert list(mounts) == ["ref/docs"] and mounts["ref/docs"].read_only
    assert plan.unmounted == ["logs", "work", "team"]
    assert plan.estimate.calls == 1 and plan.estimate.bytes_touched == len(b"alpha\nneedle one\n")

    plan = seeded.sh("ls").explain()
    assert len(plan.tasks[0].mounts) == 4
    assert any("no paths declared" in note for note in plan.notes)
    assert not plan.estimate.complete


def test_read_only_mounts_are_enforced(seeded):
    result = seeded.sh("echo tamper >> {f}", f=seeded.path("ref/docs/a.md")).run()
    assert result.exit_code != 0 and "Read-only file system" in result.stderr
    assert seeded.read_text("ref/docs/a.md") == "alpha\nneedle one\n" or seeded.backend.isolation == "symlink"


def test_into_writes_a_file_and_returns_its_path(seeded):
    result = seeded.sh("sort -n {d}/n1.txt {d}/n2.txt", d=seeded.path("ref/data")).into("work/out/sorted.txt").run(check=True)
    assert result.paths == ["work/out/sorted.txt"] and result.text == ""
    assert seeded.read_text("work/out/sorted.txt").split() == ["1", "2", "3", "10", "20"]
    plan = seeded.sh("sort {d}", d=seeded.path("ref/data")).into("work/out/x.txt").explain()
    assert plan.writes == ["work/out/x.txt"] and set(plan.tasks[0].mounts) == {"ref/data", "work"}


def test_map_splits_only_on_request_and_combines_as_told(seeded, backend):
    numbers = seeded.glob("ref/data/**/*.txt")
    one = seeded.sh("cat {files}", files=numbers)
    assert len(one.explain().tasks) == 1  # a glob alone is expanded, not split

    mapped = seeded.sh("cat {files}", files=numbers).map(reduce="sum", shards=3)
    plan = mapped.explain()
    assert len(plan.tasks) == 3 and plan.reduce == "sum" and plan.files == 3
    assert plan.estimate.calls == 3 and plan.estimate.usd_calls == pytest.approx(3 * 0.00005)
    before = len(backend.exec_log)
    result = mapped.run(check=True)
    assert result.value == 136 and result.meta.calls == 3
    assert len(backend.exec_log) - before == 3

    counted = seeded.sh("wc -l {files} | grep -v total | awk '{print $2 \":\" $1}'", files=numbers).map(reduce="sum_by_key").run()
    assert counted.value == {"ref/data/n1.txt": 3, "ref/data/n2.txt": 2, "ref/data/deep/n3.txt": 1}


def test_map_into_writes_one_part_per_shard(seeded):
    result = seeded.sh("cat {files}", files=seeded.glob("ref/data/**/*.txt")).map(shards=2).into("team/parts").run(check=True)
    assert result.paths == ["team/parts/part-00000", "team/parts/part-00001"]
    merged = sorted(int(x) for p in result.paths for x in seeded.read_text(p).split())
    assert merged == [1, 2, 3, 10, 20, 100]


def test_map_needs_to_know_what_to_split(seeded):
    with pytest.raises(archil.ValidationError):
        seeded.sh("echo hi").map()
    with pytest.raises(archil.ValidationError):
        seeded.sh("cat {f}", f=seeded.glob("ref/data/*.txt")).map(reduce="no-such-reducer")


def test_shards_balance_bytes_and_fit_in_a_command():
    files = [FileStat(f"m/f{i:03d}", size) for i, size in enumerate([900, 100, 100, 100, 100, 100, 100, 100, 100, 100])]
    shards = make_shards(files, 2, max_command_bytes=100_000, base_len=10)
    assert sorted(len(s) for s in shards) == [1, 9]  # the big file alone; the small ones together
    many = [FileStat(f"m/{'x' * 40}{i:05d}", 1) for i in range(1000)]
    for shard in make_shards(many, 1, max_command_bytes=8_000, base_len=10):
        assert sum(len(f.path) + 3 for f in shard) < 8_000  # one shard was asked for; the limit forced more


def test_a_command_too_large_for_one_call_says_to_map(seeded, backend):
    for i in range(300):
        backend.put("reference", f"many/{'long-name-' * 8}{i}.txt", b"x")
    tight = archil.context({"ref": archil.disk("reference")},
                           backend=archil.LocalBackend(root=backend.root, limits=archil.Limits(max_command_bytes=4096)))
    with pytest.raises(archil.ValidationError) as exc:
        tight.sh("cat {f}", f=tight.glob("ref/many/*.txt")).explain()
    assert exc.value.code == "command_too_large" and "map()" in exc.value.suggestion
    result = tight.sh("cat {f}", f=tight.glob("ref/many/*.txt")).map().run(check=True)
    assert result.meta.calls > 1 and result.text.count("x") == 300  # every file read once, across several calls


def test_budgets_stop_a_plan_before_it_runs(seeded, backend):
    stmt = seeded.sh("cat {files}", files=seeded.glob("ref/data/**/*.txt")).map(shards=3)
    with pytest.raises(archil.BudgetExceeded):
        stmt.within(max_calls=2).run()
    assert backend.exec_log == []
    capped = seeded.with_budget(archil.Budget(max_usd=0.00012))
    capped.sh("true").run()
    capped.sh("true").run()
    with pytest.raises(archil.BudgetExceeded):  # the context budget is cumulative
        capped.sh("true").run()
    # a budget counts from when it was set: a helper is not charged for what its parent already spent
    helper = seeded.with_budget(archil.Budget(max_calls=1))
    helper.sh("true").run()
    with pytest.raises(archil.BudgetExceeded):
        helper.sh("true").run()
    assert seeded.spend.snapshot().calls == 3  # and everything still lands on the one ledger


def test_larger_vms_bill_as_multiples(seeded):
    plan = seeded.sh("true").sized(vcpu=8, mem_mib=16384).explain()
    assert plan.estimate.call_units == 4
    assert any("bills as 4 calls" in n for n in plan.notes)


def test_grep_is_one_call_and_returns_context_paths(seeded):
    stmt = seeded.grep("needle", "ref/docs")
    assert stmt.explain().estimate.calls == 1
    result = stmt.run()
    assert result.rows == [{"file": "ref/docs/a.md", "line": 2, "text": "needle one"}]
    assert result.value["exhaustive"] is True
    assert seeded.grep("NEEDLE", "ref", ignore_case=True).run().rows[0]["file"] == "ref/docs/a.md"


def test_plan_notes_point_at_the_cheaper_route(seeded):
    plan = seeded.sh("rg -c needle {d}", d=seeded.path("ref/docs")).explain()
    assert any("ctx.grep()" in n for n in plan.notes)


@needs_duckdb
def test_sql_reads_files_as_tables_and_binds_values(seeded, backend):
    backend.put("reference", "events/a.ndjson", b'{"user":"ana","n":1}\n{"user":"bo","n":5}\n')
    backend.put("reference", "events/b.ndjson", b'{"user":"ana","n":2}\n')
    stmt = seeded.sql("select user, sum(n)::int as total from {events} where user <> {skip} group by 1 order by 1",
                      events=seeded.path("ref/events"), skip="o'brien")
    plan = stmt.explain()
    assert list(plan.tasks[0].mounts) == ["ref/events"]
    assert stmt.run(check=True).rows == [{"user": "ana", "total": 3}, {"user": "bo", "total": 5}]

    out = seeded.sql("select user, n from {events} where n > {min}", events=seeded.glob("ref/events/*.ndjson"), min=1)
    result = out.into("work/big.parquet").run(check=True)
    assert result.paths == ["work/big.parquet"] and result.rows is None
    back = seeded.sql("select count(*)::int as c from {t}", t=seeded.path("work/big.parquet")).run(check=True)
    assert back.rows == [{"c": 2}]


@needs_duckdb
def test_sql_over_nothing_costs_nothing(seeded, backend):
    stmt = seeded.sql("select count(*) from {events}", events=seeded.glob("ref/none/*.ndjson"))
    assert stmt.explain().estimate.calls == 0
    result = stmt.run()
    assert result.rows == [] and result.meta.calls == 0 and backend.exec_log == []


def test_batch_runs_many_statements_in_one_call(seeded, backend):
    batch = seeded.batch([
        seeded.sh("cat {f}", f=seeded.path("ref/docs/b.md")),
        seeded.sh("echo oops >&2; exit 3"),
        seeded.sh("wc -l < {f}", f=seeded.path("ref/data/n1.txt")),
    ])
    assert batch.explain().estimate.calls == 1
    result = batch.run()
    assert len(backend.exec_log) == 1 and result.meta.calls == 1
    first, second, third = result.results
    assert first.text == "beta\n" and first.ok
    assert second.exit_code == 3 and second.stderr.strip() == "oops"
    assert third.text.strip() == "3"
    assert result.exit_code == 3  # the batch reports the first failure


def test_every_run_is_added_to_the_ledger_and_the_journal(backend):
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=backend, journal="work/journal")
    ctx.sh("true").run()
    ctx.sh("echo hi > {f}", f=ctx.out("work/hi.txt")).run()
    assert ctx.spend.statements == 2 and ctx.spend.snapshot().calls == 2
    entries = [json.loads(line) for f in ctx.ls("work/journal", recursive=True) for line in ctx.read_text(f.path).splitlines()]
    assert [e["kind"] for e in entries] == ["sh", "sh"]
    assert entries[1]["writes"] == ["work/hi.txt"] and entries[1]["calls"] == 1 and "plan" in entries[1]


def test_plans_are_plain_data(seeded):
    plan = seeded.sh("cat {f}", f=seeded.path("ref/docs/a.md")).explain()
    data = json.loads(json.dumps(plan.to_dict()))
    assert data["tasks"][0]["disks"] == {"ref/docs": {"disk": "reference", "readOnly": True, "conditional": False,
                                                        "subdirectory": "docs"}}
    assert data["effects"] == {"reads": ["ref/docs/a.md"], "writes": []}
    assert data["hash"] == seeded.sh("cat {f}", f=seeded.path("ref/docs/a.md")).explain().hash
    assert "scope" in str(plan) and "price" in str(plan)


def test_a_tool_on_a_disk_does_not_narrow_what_an_undeclared_query_sees(seeded, backend):
    backend.put("workspace", "bin/duckdb", b"#!/bin/sh\n")
    ctx = archil.context({"ref": archil.disk("reference"), "work": archil.disk("workspace", "owned")},
                         backend=backend, tools={"duckdb": "work/bin/duckdb"})
    # a declared query sees what it declares, and the tool's directory beside it, read-only
    declared = ctx.sql("select count(*) from {t}", t=ctx.path("ref/data")).explain()
    assert list(declared.tasks[0].mounts) == ["ref/data", "work/bin"] and declared.tasks[0].mounts["work/bin"].read_only
    assert declared.tasks[0].command.startswith("work/bin/duckdb -json -c ")
    # a query that names its files in its own text declares nothing, so it sees the whole context:
    # the tool is not an input, and must not become the only thing mounted
    free = ctx.sql("select count(*) from read_json_auto('ref/events/*.ndjson')").explain()
    assert list(free.tasks[0].mounts) == ["ref", "work"] and not free.estimate.complete
    # written with into(), the output is declared, so the tool's disk has to be asked for again
    out = ctx.sql("select 1 as one").into("work/one.json").explain()
    assert list(out.tasks[0].mounts) == ["work"]


def test_grep_over_one_file_matches_that_file_only(seeded, backend, monkeypatch):
    backend.put("reference", "docs/sub/a.md", b"needle in a file of the same name, one level down\n")
    backend.put("reference", "docs/we*ird[1].md", b"needle in a name full of glob characters\n")
    for rg in (True, False):  # with ripgrep, and with the search written in Python
        if not rg:
            monkeypatch.setattr(archil.local.shutil, "which", lambda name: None)
        one = seeded.grep("needle", "ref/docs/a.md").run()
        assert [(r["file"], r["line"]) for r in one.rows] == [("ref/docs/a.md", 2)] and one.value["exhaustive"]
        odd = seeded.grep("needle", "ref/docs/we*ird[1].md").run()
        assert [r["file"] for r in odd.rows] == ["ref/docs/we*ird[1].md"]
        everything = seeded.grep("needle", "ref/docs").run()
        assert sorted(r["file"] for r in everything.rows) == ["ref/docs/a.md", "ref/docs/sub/a.md", "ref/docs/we*ird[1].md"]
    plan = seeded.grep("needle", "ref/docs/a.md").explain()
    assert plan.reads == ["ref/docs/a.md"] and plan.files == 1
    assert plan.tasks[0].mounts["ref/docs"].subdirectory == "docs"  # its directory is what is searched


def test_search_without_ripgrep_reads_lines_and_globs_the_way_ripgrep_does(seeded, backend, monkeypatch):
    separator = " "  # a line separator inside a line is part of the line
    backend.put("reference", "lines/a.txt", f"one\nNeedle two\nneedle{separator}three\n".encode())
    backend.put("reference", "lines/b.md", b"needle in b\n")
    backend.put("reference", "lines/gen/c.txt", b"needle in c\n")
    # what Archil's search does with these was checked against the live service: hidden files are
    # searched, ignore files are not honoured, and a binary file is passed over
    backend.put("reference", "odd/.hidden.txt", b"needle hidden\n")
    backend.put("reference", "odd/.gitignore", b"ignored.txt\n")
    backend.put("reference", "odd/ignored.txt", b"needle ignored\n")
    backend.put("reference", "odd/binary.dat", b"needle\0binary\n")

    def hits(where="ref/lines", **opts):
        return sorted((r["file"], r["line"], r["text"]) for r in seeded.grep("needle", where, **opts).run().rows)

    def every():
        return [hits(), hits(globs=["*.txt"]), hits(globs=["*.txt", "!gen/**"]), hits(ignore_case=True, recursive=False),
                hits("ref/odd")]

    with_rg = every()
    monkeypatch.setattr(archil.local.shutil, "which", lambda name: None)
    without = every()
    assert [h[0] for h in without[4]] == ["ref/odd/.hidden.txt", "ref/odd/ignored.txt"]
    assert without[0] == [("ref/lines/a.txt", 3, f"needle{separator}three"), ("ref/lines/b.md", 1, "needle in b"),
                          ("ref/lines/gen/c.txt", 1, "needle in c")]
    assert [h[0] for h in without[1]] == ["ref/lines/a.txt", "ref/lines/gen/c.txt"]
    assert [h[0] for h in without[2]] == ["ref/lines/a.txt"]
    assert [(h[0], h[1]) for h in without[3]] == [("ref/lines/a.txt", 2), ("ref/lines/a.txt", 3), ("ref/lines/b.md", 1)]
    assert with_rg == without  # with ripgrep or without it, the same answer


def test_paths_name_only_the_parts_that_were_written(seeded, backend):
    backend.put("reference", "parts/good.txt", b"1\n")
    backend.put("reference", "parts/bad.txt", b"bad\n")
    result = seeded.sh("grep -q bad {files} && exit 3; cat {files}", files=seeded.glob("ref/parts/*.txt")) \
        .map(shards=2).into("team/parts").run()
    assert result.exit_code == 3 and result.meta.calls == 2
    assert len(result.paths) == 1 and seeded.read_text(result.paths[0]) == "1\n"  # the shard that failed is not offered as output


def test_egress_is_part_of_what_a_plan_does(seeded):
    plain = seeded.sh("true").explain()
    denied = seeded.sh("true").egress("deny").explain()
    listed = seeded.sh("true").egress(["pypi.org", "files.pythonhosted.org"]).explain()
    assert "network" not in plain.to_dict()["vm"] and "egress" not in str(plain)
    assert denied.to_dict()["vm"]["network"] == {"egress": {"default": "deny"}}
    assert listed.to_dict()["vm"]["network"] == {"egress": {"default": "deny", "allow": ["pypi.org", "files.pythonhosted.org"]}}
    assert "  route   exec · 2 vCPU / 4 GiB · egress denied" in str(denied)
    assert "· egress only to pypi.org, files.pythonhosted.org" in str(listed)
    assert len({plain.hash, denied.hash, listed.hash}) == 3  # a different network is a different plan
    # the policy survives the other builders, and a context can set it for everything it runs
    assert seeded.sh("true").egress("deny").sized(vcpu=4).vm.egress == ()
    offline = seeded.with_egress("deny")
    assert offline.sh("true").explain().hash == denied.hash and offline.sql("select 1").vm.egress == ()
    assert offline.sh("true").egress("allow").explain().hash == plain.hash
    assert offline.narrow("ref/docs").egress == () and offline.manifest()["egress"] == "deny"
    assert "Commands run with egress denied." in offline.describe()
    assert archil.from_manifest(seeded.with_egress(["pypi.org"]).manifest(), backend=seeded.backend).egress == ("pypi.org",)
    with pytest.raises(archil.ValidationError) as exc:
        seeded.sh("true").egress("sometimes")
    assert exc.value.code == "bad_egress"
    with pytest.raises(archil.ValidationError) as exc:  # one VM, one network: a batch cannot mix policies
        seeded.batch([seeded.sh("true"), seeded.sh("true").egress("deny")]).explain()
    assert exc.value.code == "bad_batch"
    assert seeded.batch([seeded.sh("true")]).egress("deny").explain().to_dict()["vm"]["network"] == {"egress": {"default": "deny"}}


def test_a_denied_network_is_enforced_where_the_local_backend_can(seeded, backend):
    if backend.isolation != "namespace":
        pytest.skip("this host has no unprivileged namespaces: the local backend cannot cut the network")
    interfaces = "tail -n +3 /proc/net/dev | wc -l"
    assert int(seeded.sh(interfaces).egress("deny").run(check=True).text) == 1  # the loopback, and nothing else
    assert int(seeded.sh(interfaces).egress(["example.com"]).run(check=True).text) == 1  # a list is all or nothing here
    assert int(seeded.sh(interfaces).run(check=True).text) >= 1


def test_a_command_reads_no_input_and_output_is_cut_after_its_first_bytes(tmp_path):
    small = archil.LocalBackend(root=tmp_path / "s", limits=archil.Limits(max_output_bytes=100))
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=small)
    assert ctx.sh("cat; echo done").run().text == "done\n"  # no stdin: nothing to wait for
    whole = ctx.sh("printf '%0100d' 7").run()
    assert len(whole.stdout) == 100 and not whole.truncated
    cut = ctx.sh("printf 'START'; printf '%0300d' 7; printf 'END'").run()
    assert cut.truncated and len(cut.stdout) == 100  # as Archil cuts it: the first bytes, then the marker
    assert cut.stdout.startswith("START") and cut.stdout.endswith("\n[output truncated]") and "END" not in cut.stdout
    assert "only its first bytes" in ctx.tools(["run_bash"])[0](command="printf '%0300d' 7")
    with pytest.raises(archil.Error) as exc:  # a strict reducer refuses the marker instead of adding up half an answer
        ctx.write("work/n.txt", "1\n")
        ctx.sh("cat {f}; printf '%0300d\\n' 7", f=ctx.glob("work/*.txt")).map(reduce="sum").run()
    assert exc.value.code == "bad_reduce_input"


def test_the_ledger_counts_bytes_once_while_they_are_warm(seeded):
    now = [1_000_000.0]
    seeded.spend.clock = lambda: now[0]
    files = seeded.glob("ref/data/**/*.txt")  # 6 + 6 + 4 bytes
    first = seeded.sh("cat {f}", f=files).run()
    again = seeded.sh("wc -c {f}", f=files).run()
    spent = seeded.spend.snapshot()
    assert spent.calls == 2 and spent.bytes_touched == 16  # two statements, the same sixteen bytes
    hour = seeded.prices.active_usd(16)
    assert first.meta.usd == pytest.approx(seeded.prices.call_usd + hour)
    assert again.meta.usd == pytest.approx(seeded.prices.call_usd)  # already warm: the second look added no time
    now[0] += 1800  # half an hour on, a touch keeps them warm for half an hour more
    later = seeded.sh("cat {f}", f=files).run()
    assert later.meta.usd == pytest.approx(seeded.prices.call_usd + hour / 2)
    now[0] += 7200  # two hours on they have gone cold, and are made active again
    cold = seeded.grep("1", "ref/data").run()
    assert cold.meta.usd == pytest.approx(seeded.prices.call_usd + hour)
    assert seeded.spend.snapshot().bytes_touched == 32 and "32 B kept active" in str(seeded.spend)
    # a plan still prices a statement on its own, as if nothing were warm
    assert seeded.sh("cat {f}", f=files).explain().estimate.usd_active == pytest.approx(hour)
