"""Defining context: composition, modes, narrowing, manifests, locks."""

import json

import pytest

import seaway as archil
from seaway.shell import norm, render


def test_paths_start_with_a_mount_and_errors_say_which(ctx):
    with pytest.raises(archil.ValidationError) as exc:
        ctx.read("nope/file.txt")
    assert exc.value.code == "unknown_mount"
    assert "logs/…" in exc.value.suggestion


def test_dotdot_is_rejected_before_anything_runs():
    with pytest.raises(archil.ValidationError):
        norm("logs/../secrets")


def test_modes_decide_what_can_be_written(ctx):
    ctx.write("work/notes.md", "mine")
    ctx.write("team/ana/notes.md", "ours")
    assert ctx.read_text("work/notes.md") == "mine"
    with pytest.raises(archil.ValidationError) as exc:
        ctx.write("ref/docs/a.md", "x")
    assert exc.value.code == "read_only"
    with pytest.raises(archil.ValidationError) as exc:
        ctx.write("logs/api/x.ndjson", "x")
    assert "append" in exc.value.suggestion
    ctx.append("logs/raw.txt", "line\n")  # append-only mounts take appends
    ctx.append("logs/raw.txt", "line\n")
    assert ctx.read_text("logs/raw.txt") == "line\nline\n"


def test_scope_with_nothing_declared_mounts_every_disk_in_its_own_mode(ctx):
    scope = ctx.scope([], [])
    assert set(scope) == {"logs", "ref", "work", "team"}
    assert scope["logs"].read_only and scope["ref"].read_only
    assert scope["work"].queue_ms and not scope["work"].conditional  # owned: takes a checkout
    assert scope["team"].conditional and scope["team"].queue_ms is None  # shared: conditional, no checkout


def test_scope_with_declared_paths_is_the_smallest_mount_map(seeded):
    scope = seeded.scope(reads=[("ref", "data/deep")], writes=[])
    assert list(scope) == ["ref/data/deep"]  # one disk, narrowed, at the same path the context uses
    spec = scope["ref/data/deep"]
    assert spec.read_only and spec.subdirectory == "data/deep"

    scope = seeded.scope(reads=[("ref", "data")], writes=[("work", "out/report.md")])
    assert set(scope) == {"ref/data", "work"}
    assert not scope["work"].read_only


def test_narrow_keeps_path_names_and_only_removes_access(seeded):
    seeded.write("work/a/one.txt", "1")
    seeded.write("work/b/two.txt", "2")
    sub = seeded.narrow("work/a", "ref/docs")
    assert set(sub.mounts) == {"work", "ref"}
    assert sub.read_text("work/a/one.txt") == "1"  # same path as in the parent
    with pytest.raises(archil.ValidationError) as exc:
        sub.read("work/b/two.txt")
    assert exc.value.code == "out_of_scope"
    # a command run in the narrowed context cannot see the sibling directory either
    listing = sub.sh("find -L . -type f | sort").run().text
    assert "work/a/one.txt" in listing and "two.txt" not in listing and "data" not in listing

    ro = seeded.narrow("work/a", read_only=True)
    with pytest.raises(archil.ValidationError):
        ro.write("work/a/one.txt", "changed")


def test_manifest_round_trip(seeded, backend):
    narrowed = seeded.narrow("work/a", "ref/docs", read_only=True)
    again = archil.from_manifest(narrowed.manifest(), backend=backend)
    assert again.manifest() == narrowed.manifest()
    assert again.mounts["work"].allow == "a" and again.mounts["work"].mode == "read"


def test_lock_freezes_every_mount_at_a_checkpoint(seeded, backend):
    seeded.write("work/model.txt", "v1")
    manifest = seeded.lock("eval-1")
    seeded.write("work/model.txt", "v2")
    backend.put("reference", "docs/a.md", b"changed after the lock\n")

    frozen = archil.from_manifest(manifest, backend=backend)
    assert all(m.mode == "frozen" for m in frozen.mounts.values())
    assert frozen.read_text("work/model.txt") == "v1"
    assert frozen.read_text("ref/docs/a.md").startswith("alpha")
    assert frozen.sh("cat {f}", f=frozen.path("work/model.txt")).run().text == "v1"
    with pytest.raises(archil.ValidationError):
        frozen.write("work/model.txt", "v3")
    # opening the same lock twice is fine: the frozen branches are reused
    assert archil.from_manifest(manifest, backend=backend).read_text("work/model.txt") == "v1"


def test_lock_keeps_existing_pins_and_narrowing(seeded, backend):
    seeded.write("work/a/model.txt", "v1")
    seeded.lock("r1")
    pinned = archil.context({"ref": archil.disk("reference", "frozen", at="r1"),
                             "work": archil.disk("workspace", "owned")}, backend=backend)
    second = pinned.narrow("work/a", "ref").lock("r2")
    assert second["mounts"]["ref"] == {"disk": "reference", "mode": "frozen", "at": "r1"}  # already pinned
    assert second["mounts"]["work"] == {"disk": "workspace", "mode": "frozen", "at": "r2", "allow": "a"}
    pinned.write("work/a/model.txt", "v2")
    again = archil.from_manifest(second, backend=backend)
    assert again.read_text("work/a/model.txt") == "v1" and again.mounts["work"].allow == "a"


def test_a_forks_manifest_opens_the_fork(seeded, backend):
    fork = seeded.fork("try-1")
    fork.write("work/idea.md", "from the fork")
    reopened = archil.from_manifest(fork.manifest(), backend=backend)
    assert reopened.read_text("work/idea.md") == "from the fork" and not seeded.exists("work/idea.md")
    locked = archil.from_manifest(fork.lock("keep"), backend=backend)  # a lock of a fork pins the fork
    fork.write("work/idea.md", "changed later")
    assert locked.read_text("work/idea.md") == "from the fork"


def test_fork_gives_each_attempt_its_own_writes(seeded):
    seeded.write("work/plan.md", "start")
    a, b = seeded.fork("attempt-a"), seeded.fork("attempt-b")
    a.write("work/plan.md", "a's idea")
    b.sh("echo \"b's idea\" > {f}", f=b.out("work/plan.md")).run(check=True)
    assert seeded.read_text("work/plan.md") == "start"
    assert a.read_text("work/plan.md") == "a's idea"
    assert b.read_text("work/plan.md").strip() == "b's idea"


def test_describe_fits_in_a_prompt(ctx):
    text = ctx.describe()
    assert "logs/" in text and "append" in text and "service logs" in text
    assert len(text) < 800


def test_templates_leave_ordinary_shell_braces_alone():
    out = render("awk '{print $1}' {file} | head -n {n}; echo ${HOME} {a,b}", {"file": "f", "n": 3},
                 lambda name, value: f"<{value}>")
    assert out == "awk '{print $1}' <f> | head -n <3>; echo ${HOME} {a,b}"


def test_rm_takes_a_file_or_a_directory_but_never_a_whole_disk(ctx):
    ctx.write("work/tree/a.txt", "a")
    ctx.write("work/tree/deep/b.txt", "b")
    ctx.write("work/keep.txt", "k")
    ctx.rm("work/tree")
    ctx.rm("work/never-there")
    assert [f.path for f in ctx.ls("work", recursive=True)] == ["work/keep.txt"]
    for whole in ("work", "work/"):
        with pytest.raises(archil.ValidationError) as exc:
            ctx.rm(whole)
        assert exc.value.code == "bad_path"
    assert ctx.exists("work/keep.txt")


def test_turns_locks_and_forks_count_their_checkpoints(seeded):
    before = seeded.spend.snapshot().call_units
    with seeded.transaction(writes=["work"]) as turn:
        turn.write("work/a.txt", "x")
    assert seeded.spend.snapshot().call_units - before == 2  # the checkpoint the turn starts from, and the apply
    seeded.lock("eval-1")  # four mounts
    seeded.fork("attempt-1")  # two writable mounts
    assert seeded.spend.snapshot().call_units - before == 2 + 4 + 2
    with pytest.raises(archil.ValidationError):
        seeded.lock("eval-1")  # the name is taken; the first refusal still cost a call
    assert seeded.spend.snapshot().call_units - before == 2 + 4 + 2 + 1


def test_the_journal_stamps_each_entry_when_it_happened(backend):
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=backend, journal="work/journal")
    ctx.sh("true").run()
    assert ctx.journal_pending == 0
    (entry,) = [json.loads(line) for f in ctx.ls("work/journal", recursive=True) for line in ctx.read_text(f.path).splitlines()]
    assert list(entry)[:3] == ["ts", "id", "kind"] and entry["ts"].endswith("Z") and len(entry["id"]) == 12


def test_a_local_backends_positional_argument_is_its_root(tmp_path, monkeypatch):
    """It used to set the backend's name, and the files went to ``.archil-local`` in the current directory."""
    monkeypatch.chdir(tmp_path)
    backend = archil.LocalBackend(tmp_path / "here")
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=backend)
    ctx.write("work/a.txt", "x")
    assert backend.name == "local" and (tmp_path / "here/disks/w/a.txt").read_text() == "x"
    assert not (tmp_path / ".archil-local").exists()
    with pytest.raises(TypeError):
        archil.LocalBackend(tmp_path / "here", "a-name")  # everything after the root is passed by keyword
