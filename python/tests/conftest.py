import shutil

import pytest

import seaway as archil


@pytest.fixture
def backend(tmp_path):
    return archil.LocalBackend(root=tmp_path / "archil")


@pytest.fixture
def ctx(backend):
    """A context with one mount of each kind a test is likely to need."""
    return archil.context(
        {
            "logs": archil.disk("app-logs", "append", create=True, description="service logs"),
            "ref": archil.disk("reference", "read", create=True),
            "work": archil.disk("workspace", "owned", create=True),
            "team": archil.disk("team-shared", "shared", create=True),
        },
        backend=backend,
        name="test",
    )


@pytest.fixture
def seeded(ctx, backend):
    """Reference data is read-only to the context, so tests seed it through the backend."""
    backend.put("reference", "docs/a.md", b"alpha\nneedle one\n")
    backend.put("reference", "docs/b.md", b"beta\n")
    backend.put("reference", "data/n1.txt", b"1\n2\n3\n")
    backend.put("reference", "data/n2.txt", b"10\n20\n")
    backend.put("reference", "data/deep/n3.txt", b"100\n")
    return ctx


needs_duckdb = pytest.mark.skipif(shutil.which("duckdb") is None, reason="duckdb CLI not installed")
needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
needs_curl = pytest.mark.skipif(shutil.which("curl") is None, reason="curl not installed")
