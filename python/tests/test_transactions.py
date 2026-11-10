"""Turns as transactions: snapshot isolation over files, first committer wins."""

import pytest

import seaway as archil


@pytest.fixture
def work(backend):
    ctx = archil.context({"work": archil.disk("workspace", "owned", create=True),
                          "ref": archil.disk("reference", "read", create=True)}, backend=backend)
    ctx.write("work/plan.md", "v1\n")
    ctx.write("work/notes/a.md", "a\n")
    return ctx


def test_commit_applies_everything_the_turn_did(work):
    with work.transaction(writes=["work"]) as tx:
        tx.write("work/plan.md", "v2\n")
        tx.sh("echo generated > {f}", f=tx.out("work/out/report.md")).run(check=True)
        tx.rm("work/notes/a.md")
        assert work.read_text("work/plan.md") == "v1\n"  # nobody else sees the turn until it commits
        assert not work.exists("work/out/report.md")
        assert tx.read_text("work/plan.md") == "v2\n"  # the turn reads its own writes
    assert work.read_text("work/plan.md") == "v2\n"
    assert work.read_text("work/out/report.md") == "generated\n"
    assert not work.exists("work/notes/a.md")
    assert tx.state == "committed"


def test_a_failed_turn_leaves_no_trace(work):
    with pytest.raises(RuntimeError):
        with work.transaction(writes=["work"]) as tx:
            tx.write("work/plan.md", "half-finished\n")
            tx.write("work/junk.txt", "x")
            raise RuntimeError("the model gave up")
    assert work.read_text("work/plan.md") == "v1\n" and not work.exists("work/junk.txt")
    assert tx.state == "rolled_back"


def test_first_committer_wins_and_the_loser_is_told_which_paths(work):
    a = work.transaction(writes=["work"]).begin()
    b = work.transaction(writes=["work"]).begin()
    a.write("work/plan.md", "from a\n")
    b.write("work/plan.md", "from b\n")
    b.write("work/b-only.md", "b\n")
    a.commit()
    with pytest.raises(archil.Conflict) as exc:
        b.commit()
    assert exc.value.paths == ["work/plan.md"]
    assert work.read_text("work/plan.md") == "from a\n"
    assert not work.exists("work/b-only.md")  # all or nothing: b's other write was not applied either


def test_turns_that_touch_different_paths_both_commit(work):
    a = work.transaction(writes=["work"]).begin()
    b = work.transaction(writes=["work"]).begin()
    a.write("work/a.md", "a\n")
    b.write("work/b.md", "b\n")
    assert a.commit().applied == ["work/a.md"]
    assert b.commit().applied == ["work/b.md"]
    assert work.read_text("work/a.md") == "a\n" and work.read_text("work/b.md") == "b\n"


def test_a_change_made_outside_any_transaction_also_conflicts(work):
    tx = work.transaction(writes=["work"]).begin()
    tx.write("work/plan.md", "turn\n")
    work.write("work/plan.md", "someone edited this directly\n")
    with pytest.raises(archil.Conflict):
        tx.commit()
    assert work.read_text("work/plan.md") == "someone edited this directly\n"


def test_serializable_also_protects_what_the_turn_read(work, backend):
    backend.put("reference", "prices.json", b'{"usd": 10}')
    snapshot = work.transaction(writes=["work"]).begin()
    strict = work.transaction(writes=["work"], reads=["ref/prices.json"], isolation="serializable").begin()
    for tx in (snapshot, strict):
        price = tx.read_text("ref/prices.json")
        tx.write(f"work/quote-{tx.isolation}.md", f"quoted from {price}\n")
    backend.put("reference", "prices.json", b'{"usd": 12}')  # the input changes under both turns
    snapshot.commit()  # snapshot isolation only checks what was written
    with pytest.raises(archil.Conflict) as exc:
        strict.commit()
    assert exc.value.paths == ["ref/prices.json"]


def test_commit_is_one_call_per_disk_and_reports_what_it_applied(work, backend):
    tx = work.transaction(writes=["work/out"]).begin()
    for i in range(5):
        tx.write(f"work/out/{i}.txt", str(i))
    before = len(backend.exec_log)
    commit = tx.commit()
    assert commit.calls == 1 and len(backend.exec_log) - before == 1
    assert sorted(commit.applied) == [f"work/out/{i}.txt" for i in range(5)]
    apply = backend.exec_log[-1]
    assert apply["mounts"]["src"]["readOnly"] is True  # the turn's branch is read-only during the copy
    assert "queueMs" in apply["mounts"]["dst"]  # an owned mount commits under its checkout


def test_an_empty_turn_commits_without_a_call(work, backend):
    tx = work.transaction(writes=["work"]).begin()
    tx.sh("cat {f}", f=tx.path("work/plan.md")).run()
    before = len(backend.exec_log)
    assert tx.commit().empty and len(backend.exec_log) == before


def test_backends_that_cannot_branch_say_so(tmp_path):
    class NoBranches(archil.LocalBackend):
        pass

    backend = NoBranches(root=tmp_path / "x", capabilities=frozenset({"grep"}))
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=backend)
    with pytest.raises(archil.NotSupported) as exc:
        ctx.transaction()
    assert "checkpoint" in str(exc.value)


def test_a_turn_cannot_write_outside_what_it_declared(work):
    tx = work.transaction(writes=["work/notes"]).begin()
    tx.write("work/notes/b.md", "declared")
    tx.write("work/elsewhere.md", "not declared")
    assert tx.changes() == {"work": (["elsewhere.md", "notes/b.md"], [])}  # the turn sees everything it did
    with pytest.raises(archil.ValidationError) as exc:
        tx.commit()
    assert exc.value.code == "undeclared_write" and "work/elsewhere.md" in str(exc.value)
    assert tx.state == "aborted" and not work.exists("work/notes/b.md")  # refused whole, not applied in part


def test_budget_limits_can_be_given_as_keywords(work):
    capped = work.with_budget(max_calls=1)
    capped.sh("true").run()
    with pytest.raises(archil.BudgetExceeded):
        capped.sh("true").run()
    assert work.sh("echo {x}", x=archil.raw("a b")).run().text == "a b\n"  # raw() is Raw()
