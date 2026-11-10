"""Recipes, the tool surface for models, and the price model."""

import hashlib
import subprocess
import tarfile

import pytest

import seaway as archil
from seaway.recipes import DUCKDB_SHA256

from conftest import needs_curl, needs_git


def test_a_recipe_materialises_incrementally(ctx):
    skills = archil.Static({"review.md": "# How we review\n", "deploy.md": "# How we deploy\n"},
                           name="skills", layout="One Markdown file per skill.")
    assert ctx.sync(skills, "work/skills") == {"written": 2, "unchanged": 0, "deleted": 0, "into": "work/skills"}
    assert ctx.read_text("work/skills/README.md") == "One Markdown file per skill.\n"
    assert ctx.sync(skills, "work/skills")["unchanged"] == 2

    fewer = archil.Static({"review.md": "# How we review (v2)\n"}, name="skills")
    assert ctx.sync(fewer, "work/skills") == {"written": 1, "unchanged": 0, "deleted": 1, "into": "work/skills"}
    assert not ctx.exists("work/skills/deploy.md")
    assert [f.path for f in ctx.ls("work/skills")] == ["work/skills/README.md", "work/skills/review.md"]


def test_records_become_markdown_with_front_matter(ctx):
    issues = [
        {"id": "ENG-1", "title": "Checkout fails: expired coupon", "state": "open", "labels": ["bug"], "updated": "2026-11-01",
         "body": "Steps to reproduce…"},
        {"id": "ENG-2", "title": "Add dark mode", "state": "done", "labels": [], "updated": "2026-10-20", "body": ""},
    ]
    calls = []

    def fetch():
        calls.append(1)
        return issues

    recipe = archil.Records("issues", fetch, key="id", version="updated", body="body",
                            layout="One file per issue. Front matter holds the fields.")
    assert ctx.sync(recipe, "team/issues")["written"] == 2
    text = ctx.read_text("team/issues/ENG-1.md")
    assert text.startswith("---\nid: ENG-1\ntitle: \"Checkout fails: expired coupon\"\nstate: open\nlabels: [\"bug\"]")
    assert text.endswith("---\nSteps to reproduce…\n")
    # the files are ordinary files: every other verb works on them with no integration
    assert ctx.grep("state: open", "team/issues").run().rows[0]["file"] == "team/issues/ENG-1.md"

    issues[1]["updated"] = "2026-11-09"
    stats = ctx.sync(archil.Records("issues", lambda: issues, key="id", version="updated", body="body"), "team/issues")
    assert (stats["written"], stats["unchanged"]) == (1, 1)


@needs_git
def test_a_recipe_can_be_a_statement_that_runs_next_to_the_data(ctx, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "README.md").write_text("hello from the repo\n")
    for cmd in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]):
        subprocess.run(["git", *cmd], cwd=repo, check=True)
    stmt = archil.git(ctx, repo.as_uri(), "work/repos/demo")
    assert stmt.explain().writes == ["work/repos/demo"]
    stmt.run(check=True)
    assert ctx.read_text("work/repos/demo/README.md") == "hello from the repo\n"


def test_records_are_fetched_again_on_every_sync(ctx):
    source = [{"id": "A-1", "updated": "1", "body": "first"}]
    recipe = archil.Records("things", lambda: [dict(r) for r in source], version="updated", body="body")
    assert ctx.sync(recipe, "work/things")["written"] == 1
    source[0] = {"id": "A-1", "updated": "2", "body": "second"}
    source.append({"id": "A-2", "updated": "1", "body": "new"})
    assert ctx.sync(recipe, "work/things") == {"written": 2, "unchanged": 0, "deleted": 0, "into": "work/things"}
    assert ctx.read_text("work/things/A-1.md").endswith("second\n")


def test_a_context_that_cannot_write_offers_no_write_tools(seeded):
    reader = seeded.narrow("ref/docs", "work", read_only=True)
    assert [t.name for t in reader.tools()] == ["read_file", "list_files", "grep", "run_bash", "sql", "plan"]
    assert [t.name for t in reader.tools(["write_file"])] == ["write_file"]  # asked for by name: given, and it refuses
    assert reader.tools(["write_file"])[0](path="work/x.txt", content="x").startswith("error: read_only")


def test_tools_have_schemas_and_never_raise(seeded):
    tools = {t.name: t for t in seeded.tools()}
    assert list(tools) == ["read_file", "write_file", "delete_file", "list_files", "grep", "run_bash", "sql", "plan"]
    assert tools["read_file"].to_openai()["function"]["parameters"]["required"] == ["path"]
    assert tools["read_file"].to_anthropic()["input_schema"]["properties"] == {"path": {"type": "string"}}

    assert tools["read_file"](path="ref/docs/b.md") == "beta\n"
    assert tools["list_files"]() == "logs/\nref/\nwork/\nteam/"
    assert "ref/docs/a.md:2:needle one" in tools["grep"](pattern="needle", path="ref")
    assert tools["run_bash"](command="cat ref/docs/b.md").startswith("exit 0\nbeta")
    assert "scope" in tools["plan"](command="ls") and "price" in tools["plan"](command="ls")

    refused = tools["write_file"](path="ref/docs/b.md", content="x")
    assert refused.startswith("error: read_only") and "owned" in refused  # the model is told what to do instead
    assert tools["read_file"](path="nope/x").startswith("error: unknown_mount")
    assert [t.name for t in seeded.tools(["grep", "run_bash"])] == ["grep", "run_bash"]


def test_the_price_model_follows_the_public_price_sheet():
    prices = archil.PriceSheet()
    assert prices.call_usd == pytest.approx(0.00005)
    assert prices.call_units(2, 4096) == 1
    assert prices.call_units(4, 4096) == 2  # the larger of the vCPU and memory multiples
    assert prices.call_units(8, 16384) == 4
    assert prices.active_usd(1024**3) == pytest.approx(0.20 / 730)  # one GiB active for one hour
    assert prices.egress_usd(1000**3) == pytest.approx(0.07)
    assert prices.sandbox_hour_usd(2, 4096) == pytest.approx(0.19)
    assert prices.breakeven_calls_per_hour() == 3800  # calls per hour at which a warm 2 vCPU sandbox is cheaper

    cheap = archil.PriceSheet(call_usd=0.00001)
    est = archil.pricing.estimate(cheap, calls=10, bytes_touched=2 * 1024**3)
    assert est.usd == pytest.approx(10 * 0.00001 + 2 * 0.20 / 730)


def test_reads_from_outside_archil_are_counted_as_egress(tmp_path):
    outside = archil.LocalBackend(root=tmp_path / "o", inside_archil=False)
    ctx = archil.context({"work": archil.disk("w", "owned", create=True)}, backend=outside)
    ctx.write("work/big.bin", b"x" * 1_000_000)
    ctx.read("work/big.bin")
    assert ctx.spend.snapshot().egress_bytes == 1_000_000
    assert ctx.spend.snapshot().usd_egress == pytest.approx(0.07 / 1000)
    plan = ctx.sh("wc -c {f}", f=ctx.path("work/big.bin")).explain()
    assert any("only stdout crosses the network" in n for n in plan.notes)


def test_duckdb_can_be_put_on_a_disk_for_archil(ctx):
    install = archil.duckdb(ctx, "work/bin")
    plan = install.explain()
    assert plan.writes == ["work/bin/duckdb"] and list(plan.tasks[0].mounts) == ["work"]
    command = plan.tasks[0].command
    assert command.startswith("mkdir -p work/bin && set -euo pipefail; ")
    assert "releases/download/v2.0.0/duckdb-cli-linux-amd64.tar.gz" in command and command.endswith("work/bin/duckdb")
    # the archive is checked against the pinned hash before anything is unpacked
    assert f"want={DUCKDB_SHA256['2.0.0']}; " in command
    assert command.index("sha256sum") < command.index("exit 1") < command.index("tar -xzf")
    # another version, or an archive from somewhere else, has to bring its own hash
    for other in ({"version": "9.9.9"}, {"url": "https://mirror.example/duckdb.tgz"}):
        with pytest.raises(archil.ValidationError) as refused:
            archil.duckdb(ctx, "work/bin", **other)
        assert refused.value.issues[0].code == "unpinned_download"
    mirrored = archil.duckdb(ctx, "work/bin", url="https://mirror.example/duckdb.tgz", sha256="AB" * 32)
    assert f'want={"ab" * 32}; curl -fsSL -o "$f" https://mirror.example/duckdb.tgz; ' in mirrored.explain().tasks[0].command
    with pytest.raises(archil.ValidationError) as malformed:
        archil.duckdb(ctx, "work/bin", sha256="not a hash")
    assert malformed.value.issues[0].code == "bad_sha256"
    with pytest.raises(archil.ValidationError):
        archil.duckdb(ctx, "ref/bin")  # it has to go somewhere the context can write


@needs_curl
def test_the_duckdb_recipe_installs_only_what_matches_its_hash(ctx, tmp_path):
    # a stand-in for the release: an archive that holds one executable called duckdb
    binary = tmp_path / "duckdb"
    binary.write_text("#!/bin/sh\necho stand-in\n")
    archive = tmp_path / "duckdb-cli.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(binary, arcname="duckdb")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    installed = archil.duckdb(ctx, "work/bin", url=archive.as_uri(), sha256=digest).run()
    assert installed.ok, installed.stderr
    assert ctx.read_text("work/bin/duckdb") == "#!/bin/sh\necho stand-in\n"
    assert ctx.sh("test -x {tool} && echo executable", tool=ctx.path("work/bin/duckdb")).run().text == "executable\n"

    refused = archil.duckdb(ctx, "work/other", url=archive.as_uri(), sha256="0" * 64).run()
    assert refused.exit_code == 1
    assert f"the download has SHA-256 {digest}, not the pinned {'0' * 64}" in refused.stderr
    assert not ctx.exists("work/other/duckdb")
