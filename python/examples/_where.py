"""Where an example runs.

    python examples/quickstart.py             # the local backend: no account, nothing leaves this machine
    python examples/quickstart.py --archil    # the same code on Archil (set ARCHIL_API_KEY and ARCHIL_REGION)

On Archil, every disk an example names gets a prefix that is new for the run. So an
example never opens a disk that already exists in your account, and two runs never
meet. When it ends it prints the disks it created. Add ``--cleanup`` to have it
delete them; deleting a disk also removes the branches and checkpoints a run left on it.
"""

from __future__ import annotations

import atexit
import sys
import tempfile
import uuid

import seaway as archil

ON_ARCHIL = "--archil" in sys.argv
PREFIX = f"px-{uuid.uuid4().hex[:6]}-" if ON_ARCHIL else ""
_names: list[str] = []


def backend(tag: str):
    """The backend for this run: a temporary directory, or your Archil account."""
    if not ON_ARCHIL:
        return archil.LocalBackend(root=tempfile.mkdtemp(prefix=f"archil-{tag}-"))
    live = archil.ArchilBackend()
    atexit.register(_finish, live)
    return live


def disk(name: str, mode: str = "read", **options):
    """``archil.disk``, under this run's prefix when the run is on Archil."""
    if PREFIX + name not in _names:
        _names.append(PREFIX + name)
    return archil.disk(PREFIX + name, mode, **options)


def _finish(live) -> None:
    created = [d for name in _names for d in live.client.disks.list(name=name)]
    if not created:
        return
    print(f"\nThis run created {len(created)} disk(s) on Archil:")
    for d in created:
        print(f"  {d.id}  {d.name}")
    if "--cleanup" in sys.argv:
        for d in created:
            d.delete()
        print("All of them were deleted (--cleanup).")
    else:
        print("They are yours to look at. Run with --cleanup next time to delete them when the example ends.")
