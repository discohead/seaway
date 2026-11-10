"""The Archil backend, checked against a stand-in for the official client.

These tests do not reach Archil. They pin down the exact calls the backend makes
through the official ``archil`` SDK, so that what a plan says it will do and what
is sent are the same thing. The stand-in behaves the way the live service was
seen to behave on 9 November 2026: a listing carries an entry per directory, an
ETag does not move when a file is rewritten through a mount, and a path under
someone's checkout answers 409.
"""

import importlib
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import seaway as archil
from seaway.archil_backend import checkout_prelude, wrap

sdk = pytest.importorskip("archil", reason="the official archil SDK is not installed")

T0 = datetime(2026, 11, 9, tzinfo=timezone.utc)


class FakeDisk:
    def __init__(self, id, name, calls):
        self.id, self.name, self.calls = id, name, calls
        self.objects: dict[str, bytes] = {}
        self.etags: dict[str, str] = {}
        self.modified: dict[str, datetime] = {}
        self.busy = False  # a client holds a checkout of the whole disk
        self.checkpoints: set[str] = set()
        self.branches: dict[str, str] = {}

    # how the service stamps a file: an ETag from the content when it comes through the object API
    def _stamp(self, key, body, at=T0):
        self.objects[key] = body
        self.etags[key] = f'"etag-{len(body)}-{abs(hash(body)) % 1000}"'
        self.modified[key] = at

    def mount_write(self, key, body, at):
        """A command rewrites the file in place through a mount: new bytes and time, the same ETag."""
        self.objects[key] = body
        self.modified[key] = at

    def _refuse_if_busy(self, operation):
        if self.busy:
            raise sdk.ArchilS3Error(operation=operation, status_code=409, code="OperationAborted",
                                    message="The destination path has a conflicting write delegation held by another client.")

    def _meta(self, key):
        return SimpleNamespace(key=key, size=len(self.objects[key]), etag=self.etags[key], last_modified=self.modified[key])

    def get_object(self, key):
        self.calls.append(("get_object", self.id, key))
        if key not in self.objects:
            raise sdk.ArchilS3Error(operation="GetObject", status_code=404, code="NoSuchKey")
        return self.objects[key]

    def put_object(self, key, body, content_type=None):
        self.calls.append(("put_object", self.id, key))
        self._refuse_if_busy("PutObject")
        self._stamp(key, body)

    def append_object(self, key, body, content_type=None):
        self.calls.append(("append_object", self.id, key, len(body)))
        self._refuse_if_busy("AppendObject")
        self._stamp(key, self.objects.get(key, b"") + body)

    def delete_object(self, key):
        self.calls.append(("delete_object", self.id, key))
        self._refuse_if_busy("DeleteObject")
        self.objects.pop(key, None)

    def delete_objects(self, keys):
        self.calls.append(("delete_objects", self.id, list(keys)))
        for key in keys:
            self.objects.pop(key, None)
        return SimpleNamespace(deleted=list(keys), errors=[])

    def object_exists(self, key):
        return key in self.objects

    def head_object(self, key):
        return self._meta(key) if key in self.objects else None

    def _directories(self):
        out = set()
        for key in self.objects:
            parts = key.split("/")[:-1]
            out |= {"/".join(parts[: i + 1]) + "/" for i in range(len(parts))}
        return out

    def list_objects(self, prefix=None, *, recursive=False):
        self.calls.append(("list_objects", self.id, prefix, recursive))
        prefix = prefix or ""
        files = [k for k in sorted(self.objects) if k.startswith(prefix)]
        markers = [d for d in sorted(self._directories()) if d.startswith(prefix)]
        if recursive:
            objs = [self._meta(k) for k in files] + [SimpleNamespace(key=d, size=0, etag='"d41d8"', last_modified=T0) for d in markers]
            return SimpleNamespace(objects=sorted(objs, key=lambda o: o.key), common_prefixes=[])
        here = [k for k in files if "/" not in k[len(prefix):]]
        below = sorted({prefix + k[len(prefix):].split("/")[0] + "/" for k in files if "/" in k[len(prefix):]})
        return SimpleNamespace(objects=[self._meta(k) for k in here], common_prefixes=below)

    def grep(self, **kw):
        self.calls.append(("grep", self.id, kw))
        return SimpleNamespace(matches=[SimpleNamespace(file="api/x.log", line=7, text="ERROR boom")],
                               stopped_reason="completed")

    def share(self, key, expires_in=None):
        return SimpleNamespace(url=f"https://share.example/{key}?e={expires_in}")

    def create_branch(self, name, from_checkpoint):
        self.calls.append(("create_branch", self.id, name, from_checkpoint))
        if from_checkpoint not in self.checkpoints:
            raise sdk.ArchilApiError(f'Checkpoint "{from_checkpoint}" not found', 404, "not_found")
        if name in self.branches:
            raise sdk.ArchilApiError(f'Branch "{name}" already exists', 409, "conflict")
        self.branches[name] = f"dsk-branch-{name}"
        return SimpleNamespace(filesystem_id=self.branches[name])

    def get_branch(self, name):
        self.calls.append(("get_branch", self.id, name))
        return SimpleNamespace(filesystem_id=self.branches[name])


class FakeClient:
    def __init__(self):
        self.calls: list = []
        self._disks = {"dsk-logs": FakeDisk("dsk-logs", "app-logs", self.calls),
                       "dsk-work": FakeDisk("dsk-work", "workspace", self.calls)}
        self.disks = SimpleNamespace(
            list=lambda name=None: [d for d in self._disks.values() if d.name == name],
            get=lambda id: self._disks.setdefault(id, FakeDisk(id, id, self.calls)),
            create=self._create,
        )
        self.answer = SimpleNamespace(exit_code=0, stdout="ok\n", stderr="")
        self.refuse = None  # an error the next exec raises instead of answering

    def _create(self, name):
        disk = FakeDisk(f"dsk-new-{name}", name, self.calls)
        self._disks[disk.id] = disk
        return SimpleNamespace(disk=disk, token="adt_once")

    def exec(self, *, disks, command, **vm):
        self.calls.append(("exec", disks, command, vm))
        if self.refuse is not None:
            raise self.refuse
        if "archil checkpoints create disk" in command:
            name = command.split("archil checkpoints create disk ", 1)[1].split("\n", 1)[0]
            disk = self._disks[disks["disk"].disk]
            if name in disk.checkpoints:
                return SimpleNamespace(exit_code=1, stdout="", timing=SimpleNamespace(queue_ms=1, execute_ms=1, total_ms=2),
                                       stderr='Failed to create checkpoint: ServerError("Failed to create checkpoint: InvalidArguments")\n')
            disk.checkpoints.add(name)
        return SimpleNamespace(exit_code=self.answer.exit_code, stdout=self.answer.stdout, stderr=self.answer.stderr,
                               timing=SimpleNamespace(queue_ms=37, execute_ms=45, total_ms=82))


@pytest.fixture
def client():
    return FakeClient()


@pytest.fixture
def ctx(client):
    backend = archil.ArchilBackend(client=client)
    return archil.context({"logs": archil.disk("app-logs", "append"), "work": archil.disk("workspace", "owned"),
                           "team": archil.disk("team-notes", "shared", create=True)}, backend=backend)


def execs(client):
    return [c for c in client.calls if c[0] == "exec"]


def test_disks_resolve_by_name_and_are_created_only_on_request(client, ctx):
    assert ctx.mounts["logs"].handle == "dsk-logs"
    assert ctx.mounts["team"].handle == "dsk-new-team-notes"
    with pytest.raises(archil.ValidationError):
        archil.context({"x": archil.disk("missing")}, backend=archil.ArchilBackend(client=client))


def test_a_client_passed_by_position_is_the_client_used(client):
    """It used to become the backend's name, and the backend then made a client of its own from the environment."""
    backend = archil.ArchilBackend(client)
    assert backend.client is client and backend.name == "archil"
    ctx = archil.context({"work": archil.disk("workspace", "owned")}, backend=backend)
    ctx.write("work/a.txt", "x")
    assert ("put_object", "dsk-work", "a.txt") in client.calls
    with pytest.raises(TypeError):
        archil.ArchilBackend(client, "a-key")  # a key, a region and the rest are passed by keyword


def test_a_statement_becomes_one_exec_with_the_planned_mount_map(client, ctx):
    client._disks["dsk-logs"]._stamp("api/2026-11-09/14/web-1.ndjson", b"{}\n")
    result = ctx.sh("wc -l {f}", f=ctx.path("logs/api/2026-11-09/14/web-1.ndjson")).run()
    (_, disks, command, vm), = execs(client)
    assert command == wrap("wc -l logs/api/2026-11-09/14/web-1.ndjson") and vm == {}
    spec = disks["logs/api/2026-11-09/14"]
    assert isinstance(spec, sdk.ExecMountSpec)
    assert (spec.disk, spec.subdirectory, spec.read_only, spec.conditional) == ("dsk-logs", "api/2026-11-09/14", True, False)
    assert result.text == "ok\n" and result.meta.queue_ms == 37 and result.meta.execute_ms == 45


def test_the_command_starts_where_the_disks_are_and_is_run_by_bash():
    sent = wrap("set -o pipefail; diff <(echo a) <(echo a)")
    assert sent.splitlines()[0] == "cd /mnt/archil || exit 1"
    assert "px_script=$(cat <<'PX_EOF'\nset -o pipefail; diff <(echo a) <(echo a)\nPX_EOF\n)" in sent
    assert sent.endswith('then exec bash -c "$px_script"; else exec sh -c "$px_script"; fi')
    # the command is not quoted, so it does not grow; and a line that is the marker moves the marker
    assert len(wrap("x" * 90_000)) < 90_000 + 200
    assert "<<'PX_EOF_'\ncat <<PX_EOF\nhi\nPX_EOF\nPX_EOF_\n" in wrap("cat <<PX_EOF\nhi\nPX_EOF")


def test_mount_modes_map_to_archil_mount_modes(client, ctx):
    ctx.sh("echo hi > {f}", f=ctx.out("team/ana/hi.txt")).run()
    ctx.sh("echo hi > {f}", f=ctx.out("work/hi.txt")).run()
    shared, owned = execs(client)
    assert shared[1]["team"].conditional is True  # shared: conditional, no checkout
    assert "archil checkout" not in shared[2]
    spec = owned[1]["work"]
    assert spec.conditional is False and spec.read_only is False
    if not hasattr(spec, "queue_ms"):  # this SDK version cannot ask for a checkout, so the command takes it
        assert owned[2] == wrap("echo hi > work/hi.txt", checkout_prelude(["work"], 5000))


def test_a_checkout_taken_by_the_command_waits_its_turn_and_says_why_it_could_not():
    prelude = checkout_prelude(["work", "notes/a b"], 5000)
    assert "px_end=$(( $(date +%s) + 5 ))" in prelude  # the same five seconds a queueMs mount waits
    assert "until px_err=$(archil checkout work 2>&1); do" in prelude
    assert "until px_err=$(archil checkout 'notes/a b' 2>&1); do" in prelude
    assert "exit 30" in prelude and "archil: could not take checkout" in prelude
    assert "this image has no archil CLI" in prelude  # a custom image: say so, do not fail obscurely
    assert "+ 1 ))" in checkout_prelude(["work"], 200)


def test_vm_size_and_image_are_passed_through(client, ctx):
    ctx.sh("true").sized(vcpu=8, mem_mib=16384, image="python:3.13").run()
    assert execs(client)[0][3] == {"vcpu_count": 8, "mem_size_mib": 16384, "base_image": "python:3.13"}


def test_an_egress_policy_becomes_the_network_of_the_call(client, ctx):
    ctx.sh("true").run()
    ctx.sh("true").egress("deny").run()
    ctx.sh("pip install x").egress(["pypi.org", "files.pythonhosted.org"]).run()
    ctx.with_egress("deny").sh("true").run()
    ctx.with_egress("deny").sh("true").egress("allow").run()
    nets = [c[3].get("network") for c in execs(client)]
    assert nets[0] is None and nets[4] is None  # open: nothing is sent, which is Archil's default
    assert nets[1] == sdk.SandboxNetwork(egress=sdk.SandboxEgressPolicy(default="deny"))
    assert nets[2] == sdk.SandboxNetwork(egress=sdk.SandboxEgressPolicy(default="deny", allow=["pypi.org", "files.pythonhosted.org"]))
    assert nets[3] == nets[1]


def test_the_data_plane_uses_the_object_api_and_no_compute(client, ctx):
    ctx.write("work/a.txt", "one")
    assert ctx.read_text("work/a.txt") == "one"
    ctx.append("logs/raw.ndjson", "{}\n")
    assert [f.path for f in ctx.ls("work")] == ["work/a.txt"]
    assert execs(client) == []
    assert ("append_object", "dsk-logs", "raw.ndjson", 3) in client.calls
    with pytest.raises(archil.ValidationError) as exc:
        ctx.read("work/missing.txt")
    assert exc.value.code == "not_found"
    assert ctx.spend.snapshot().egress_bytes == 3  # outside Archil by default, so reads are counted as egress


def test_a_version_changes_when_a_file_is_rewritten_in_place_through_a_mount(client, ctx):
    disk = client._disks["dsk-work"]
    ctx.write("work/status.txt", "state=OPEN\n")
    (before,) = ctx.expand("work/status.txt")
    listed = {f.path: f.version for f in ctx.expand("work")}
    assert listed["work/status.txt"] == before.version  # a file reads the same through HEAD and through a listing
    disk.mount_write("status.txt", b"state=DONE\n", T0 + timedelta(seconds=5))  # same size, same ETag, a later time
    (after,) = ctx.expand("work/status.txt")
    assert (after.size, disk.etags["status.txt"]) == (before.size, before.version.split("@")[0])
    assert after.version != before.version

    # so the structures built on versions see it: a view goes stale, a feed reports it
    view = ctx.view("work/report.txt", lambda: ctx.sh("cat {f}", f=ctx.path("work/status.txt")))
    view.refresh()
    disk._stamp("report.txt", b"x")  # the stand-in's exec does not run the command; say the build wrote its file
    assert view.fresh
    feed = ctx.feed("work", cursor="work/cursor.json")
    feed.poll().ack()
    disk.mount_write("status.txt", b"state=OPEN\n", T0 + timedelta(seconds=9))
    assert not view.fresh
    assert [f.path for f in feed.poll().modified] == ["work/status.txt"]


def test_listings_hide_archils_own_directory_and_directory_entries(client, ctx):
    disk = client._disks["dsk-work"]
    for key in ("a.txt", "dir/b.txt", ".archil/client-1/x"):
        disk._stamp(key, b"x")
    assert [f.path for f in ctx.ls("work")] == ["work/dir/", "work/a.txt"]
    assert [f.path for f in ctx.ls("work", recursive=True)] == ["work/a.txt", "work/dir/b.txt"]
    assert [f.path for f in ctx.expand("work")] == ["work/a.txt", "work/dir/b.txt"]


def test_rm_removes_a_directory_and_everything_under_it(client, ctx):
    disk = client._disks["dsk-work"]
    for key in ("tree/a.txt", "tree/deep/er/b.txt", "tree-sibling/c.txt", "keep.txt"):
        disk._stamp(key, b"x")
    ctx.rm("work/tree")
    assert sorted(disk.objects) == ["keep.txt", "tree-sibling/c.txt"]
    deletes = [c for c in client.calls if c[0].startswith("delete_object")]
    assert deletes == [
        ("delete_object", "dsk-work", "tree"),  # a file of that name, if there is one
        ("delete_objects", "dsk-work", ["tree/a.txt", "tree/deep/er/b.txt"]),
        ("delete_object", "dsk-work", "tree/deep/er/"),  # then the directories, deepest first
        ("delete_object", "dsk-work", "tree/deep/"),
        ("delete_object", "dsk-work", "tree/"),
    ]
    ctx.rm("work/keep.txt")
    ctx.rm("work/never-there")
    assert sorted(disk.objects) == ["tree-sibling/c.txt"]
    with pytest.raises(archil.ValidationError) as exc:
        ctx.rm("work")
    assert exc.value.code == "bad_path"


def test_a_write_under_someones_checkout_is_busy_and_the_journal_keeps_what_it_could_not_write(client):
    backend = archil.ArchilBackend(client=client)
    ctx = archil.context({"work": archil.disk("workspace", "owned")}, backend=backend, journal="work/journal")
    disk = client._disks["dsk-work"]
    disk.busy = True  # a statement is running with the disk checked out
    for attempt in (lambda: ctx.write("work/a.txt", "x"), lambda: ctx.append("work/a.log", "x"), lambda: ctx.rm("work/a.txt")):
        with pytest.raises(archil.Busy) as exc:
            attempt()
        assert exc.value.code == "busy" and "retry" in exc.value.suggestion
    ctx.sh("true").run()
    ctx.sh("true").run()
    assert ctx.journal_pending == 2 and not disk.objects  # not lost, not written yet
    disk.busy = False
    ctx.sh("true").run()
    assert ctx.journal_pending == 0
    (journal,) = [k for k in disk.objects if k.startswith("journal/")]
    assert disk.objects[journal].count(b'"kind":"sh"') == 3


def test_failures_that_are_not_the_commands_come_back_as_results(client, ctx):
    statement = ctx.sh("true")
    client.refuse = sdk.ArchilApiError("API request failed with status 504", 504)
    out = statement.run()
    assert (out.exit_code, out.stderr) == (124, "Exec timed out")  # what the local backend reports for a timeout
    client.refuse = sdk.ArchilApiError("Exec failed: disk dsk-1: the configured subdirectory does not exist", 400, "invalid_request")
    out = statement.run()
    assert out.exit_code == 1 and out.stderr.startswith("mount failed: ")
    client.refuse = sdk.ArchilApiError("Exec failed: Unable to mount Archil disk because the client queued for the root "
                                       "delegation for 5s and failed to acquire it in time.", 400, "invalid_request")
    out = statement.run()
    assert out.exit_code == 30 and out.stderr.startswith("archil: could not take checkout: ")
    client.refuse = sdk.ArchilApiError("allowance exhausted", 403, "allowance_exhausted")
    with pytest.raises(sdk.ArchilApiError):  # anything else is still the caller's to see
        statement.run()
    assert "error: ArchilApiError" in ctx.tools(["run_bash"])[0](command="true")  # but a tool never raises


def test_output_that_was_cut_is_reported(client):
    backend = archil.ArchilBackend(client=client, limits=archil.Limits(max_output_bytes=1000))
    ctx = archil.context({"work": archil.disk("workspace", "owned")}, backend=backend)
    client.answer.stdout = "a" * 400
    assert not ctx.sh("true").run().truncated
    client.answer.stdout = "a" * 982 + "\n[output truncated]"  # the first bytes, then the marker: 1000 in all
    assert ctx.sh("true").run().truncated
    client.answer.stdout = "short\n[output truncated]"  # a command may print those words itself
    assert not ctx.sh("true").run().truncated


def test_a_command_too_large_once_wrapped_is_not_sent(client):
    backend = archil.ArchilBackend(client=client, limits=archil.Limits(max_command_bytes=400))
    ctx = archil.context({"work": archil.disk("workspace", "owned")}, backend=backend)
    out = ctx.sh("echo " + "x" * 300).run()  # fits the limit on its own, not with what is sent around it
    assert out.exit_code == 1 and "command exceeds 400 bytes" in out.stderr and execs(client) == []


def test_grep_is_the_native_parallel_grep(client, ctx):
    rows = ctx.grep("ERROR", "logs/api", ignore_case=True).run().rows
    assert rows == [{"file": "logs/api/x.log", "line": 7, "text": "ERROR boom"}]
    call = next(c for c in client.calls if c[0] == "grep")
    assert call[2] == {"directory": "api", "pattern": "ERROR", "recursive": True, "ignore_case": True}
    assert execs(client) == []


def test_grep_over_one_file_searches_its_directory_for_that_name(client, ctx):
    client._disks["dsk-logs"]._stamp("api/we*ird[1].log", b"ERROR boom\n")
    ctx.grep("ERROR", "logs/api/we*ird[1].log").run()
    call = next(c for c in client.calls if c[0] == "grep")
    # Archil's search takes a directory: asked for a file, it finds nothing and says it finished
    assert call[2] == {"directory": "api", "pattern": "ERROR", "recursive": False, "globs": [r"we\*ird\[1\].log"]}


def test_checkpoint_and_branch_calls(client, ctx):
    backend = ctx.backend
    backend.checkpoint("dsk-work", "turn-1")
    (_, disks, command, _), = execs(client)
    assert command == wrap("archil checkpoints create disk turn-1") and disks["disk"].disk == "dsk-work"
    assert (disks["disk"].read_only, disks["disk"].conditional) == (False, True)  # a read-only mount cannot checkpoint
    assert backend.branch("dsk-work", "tx-1", "turn-1") == "dsk-branch-tx-1"
    assert ("create_branch", "dsk-work", "tx-1", "turn-1") in client.calls


def test_checkpoint_and_branch_failures_say_what_is_wrong(client, ctx):
    backend = ctx.backend
    backend.checkpoint("dsk-work", "release-1")
    with pytest.raises(archil.ValidationError) as exc:
        backend.checkpoint("dsk-work", "release-1")  # Archil answers a used name with "InvalidArguments"
    assert exc.value.code == "bad_checkpoint" and "new on its disk" in exc.value.suggestion
    with pytest.raises(archil.ValidationError) as exc:
        backend.branch("dsk-work", "b", "never-taken")
    assert exc.value.code == "not_found"  # the same error the local backend raises
    assert backend.branch("dsk-work", "frozen-release-1", "release-1", exist_ok=True) == "dsk-branch-frozen-release-1"
    assert backend.branch("dsk-work", "frozen-release-1", "release-1", exist_ok=True) == "dsk-branch-frozen-release-1"
    with pytest.raises(sdk.ArchilApiError):
        backend.branch("dsk-work", "frozen-release-1", "release-1")


def test_checkpoints_are_counted_as_the_calls_they_are(client, ctx):
    before = ctx.spend.snapshot().call_units
    with ctx.transaction(writes=["work"]) as turn:
        turn.write("work/a.txt", "x")
    spent = ctx.spend.snapshot().call_units - before
    assert spent == len(execs(client)) == 2  # one exec for the turn's checkpoint, one to apply it
    ctx.lock("eval-1")
    assert ctx.spend.snapshot().call_units - before == len(execs(client)) == 5  # three mounts, three checkpoints


def test_a_version_too_new_to_trust_is_not_trusted(client, monkeypatch):
    """A listing carries times in whole seconds, so a file written this very second can be rewritten
    in place, at the same size, without its version moving. Nothing is concluded from such a version."""
    backend = archil.ArchilBackend(client=client)
    ctx = archil.context({"work": archil.disk("workspace", "owned")}, backend=backend)
    disk = client._disks["dsk-work"]
    now = datetime.now(timezone.utc)
    disk._stamp("fresh.csv", b"a,1\n", now)
    disk._stamp("old.csv", b"a,1\n", now - timedelta(seconds=30))

    # a view built from it is recorded as provisional, so the next refresh builds once more
    fresh = ctx.view("work/from-fresh.txt", lambda: ctx.sh("cat {f}", f=ctx.path("work/fresh.csv")))
    old = ctx.view("work/from-old.txt", lambda: ctx.sh("cat {f}", f=ctx.path("work/old.csv")))
    for view in (fresh, old):
        view.refresh()
        disk._stamp(view.path.split("/", 1)[1], b"x")  # the stand-in's exec does not run the command
    assert old.fresh and not fresh.fresh
    recorded = [json.loads(body)["fingerprint"] for key, body in disk.objects.items() if key.startswith(".px/views/")]
    assert sorted(f.endswith("~") for f in recorded) == [False, True]

    # a feed hands it over again on the next poll
    feed = ctx.feed("work", cursor="work/cursor.json")
    feed.poll().ack()
    assert [f.path for f in feed.poll().modified] == ["work/fresh.csv"]

    # and a turn does not take its snapshot until the file is older than that
    waits: list[float] = []
    # the package's `context` is the function; the module of that name is where the wait lives
    monkeypatch.setattr(importlib.import_module("seaway.context").time, "sleep", waits.append)
    ctx.transaction(writes=["work"]).begin()
    assert waits and all(0 < w <= 1.5 for w in waits)
    waits.clear()
    disk._stamp("fresh.csv", b"a,1\n", now - timedelta(seconds=30))
    ctx.transaction(writes=["work"]).begin()
    assert waits == []  # nothing was written recently: no wait

    # the local backend's versions change on every write, so none of this applies there
    assert archil.LocalBackend.version_granularity_s == 0 and backend.version_granularity_s == 1
