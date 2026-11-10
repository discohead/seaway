"""An agent's context, composed: several disks, each under its own rules.

The four ingredients from "Who will build Vercel for agents?" (an organisation's
skills, reference data from a system of record, agent-owned memory and shared
memory), plus an audit log. Then what a context being a value buys: a manifest,
pinning, turns that commit or don't, forks, locks, and handing a helper less.

    python examples/agent_context.py             # on the local backend: no account needed
    python examples/agent_context.py --archil    # the same code on Archil; see _where.py
"""

from __future__ import annotations

import json

import seaway as archil

import _where as where

backend = where.backend("context")

# -- what would already exist in a real organisation ---------------------------

# Skills are published by a platform team, which checkpoints each release.
platform = archil.context({"skills": where.disk("org-skills", "owned", create=True)}, backend=backend)
platform.sync(
    archil.Static(
        {"triage.md": "# Triage\nReproduce first. Then bisect.\n", "writing.md": "# Writing\nLead with the answer.\n"},
        name="skills", layout="One Markdown file per skill.",
    ),
    into="skills",
)
platform.checkpoint("2026-11-01")

# Reference data comes from a system of record through a recipe: an adapter with the shape of
# an object store (list the keys, get one) and a note describing the layout it writes.
ISSUES = [
    {"id": "ENG-1", "title": "Checkout fails with an expired coupon", "status": "open", "updated": "2026-11-08T09:00:00Z",
     "description": "Steps: add a coupon that expired yesterday, then pay."},
    {"id": "ENG-2", "title": "Add dark mode", "status": "open", "updated": "2026-11-07T15:30:00Z", "description": ""},
    {"id": "ENG-3", "title": "Rotate the signing key", "status": "done", "updated": "2026-11-01T11:00:00Z", "description": ""},
]
issues = archil.Records(
    "issues", lambda: ISSUES,  # the lambda stands in for a call to the tracker's API
    key="id", version="updated", body="description",
    layout="One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.",
)
mirror = archil.context({"tracker": where.disk("tracker-mirror", "owned", create=True)}, backend=backend)
print("first sync: ", mirror.sync(issues, into="tracker/issues"))
ISSUES[0].update(status="done", updated="2026-11-09T10:00:00Z")
print("second sync:", mirror.sync(issues, into="tracker/issues"), "\n")  # only the issue that changed is written

# -- the agent's context -------------------------------------------------------

ctx = archil.context(
    {
        "skills": where.disk("org-skills", "frozen", at="2026-11-01", description="how we work, pinned to a release"),
        "tracker": where.disk("tracker-mirror", "read", description="issues, mirrored from the tracker"),
        "memory": where.disk("agent-7-memory", "owned", create=True, description="this agent's own notes"),
        "team": where.disk("team-notes", "shared", create=True, description="notes the whole team writes"),
        "audit": where.disk("audit-log", "append", create=True, description="what was done, and by whom"),
    },
    backend=backend, name="agent-7", journal="audit/agent-7",
)
print(ctx.describe(), "\n")
print(json.dumps(ctx.manifest(), indent=2), "\n")

# A statement sees the paths it is given and nothing else: here one directory of one disk, read-only.
open_issues = ctx.sh("grep -l 'status: open' {issues} | wc -l", issues=ctx.glob("tracker/issues/*.md"))
print(open_issues.explain())
print("open issues:", open_issues.run().text.strip(), "\n")

# Pinned means pinned: the platform team publishes a new version, and this context still reads the old one.
platform.write("skills/triage.md", "# Triage\nAsk the customer first.\n")
print("skills/triage.md says:", ctx.read_text("skills/triage.md").splitlines()[1], "\n")

# -- turns ----------------------------------------------------------------------

# Two agents start from the same state and both change the same shared note. The first to
# commit wins. The second is told which path, and none of its turn is applied.
ctx.write("team/standup.md", "- nothing yet\n")
other = archil.context({"team": where.disk("team-notes", "shared")}, backend=backend, name="agent-8")
mine = ctx.transaction(writes=["team", "memory"]).begin()
theirs = other.transaction().begin()
mine.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=mine.out("team/standup.md")).run(check=True)
mine.write("memory/eng-1.md", "Closed after the coupon fix.\n")
theirs.write("team/standup.md", "- agent-8: rewrote the file\n")
print("agent-8 commits:", theirs.commit().applied)
try:
    mine.commit()
except archil.Conflict as conflict:
    print("agent-7 conflicts on:", conflict.paths, "and its memory is untouched:", not ctx.exists("memory/eng-1.md"))

# The loser runs its turn again from the new state. An agent can do that, which is why
# optimistic control suits a turn.
with ctx.transaction(writes=["team", "memory"]) as turn:
    turn.sh("echo '- agent-7: ENG-1 is done' >> {note}", note=turn.out("team/standup.md")).run(check=True)
    turn.write("memory/eng-1.md", "Closed after the coupon fix.\n")
print("after the retry:", ctx.read_text("team/standup.md").splitlines(), "\n")

# -- forks, locks, and less -----------------------------------------------------

# Three attempts at one task, each on its own copy-on-write fork of the writable disks.
attempts = [ctx.fork(f"attempt-{i}") for i in range(3)]
for i, attempt in enumerate(attempts):
    attempt.write("memory/plan.md", f"plan {i}\n")
print("attempts:", [a.read_text("memory/plan.md").strip() for a in attempts],
      "| main line has a plan:", ctx.exists("memory/plan.md"))

# A lock is a manifest with every mount frozen at a checkpoint: the input to a replay or an eval.
lock = ctx.lock("eval-2026-11-09")
ctx.write("memory/eng-1.md", "Edited after the lock.\n")
replay = archil.from_manifest(lock, backend=backend)
print("replay reads:", replay.read_text("memory/eng-1.md").strip(), "| modes:", sorted({m.mode for m in replay.mounts.values()}))

# A helper gets less than you have: the same path names, a smaller reach, and no writes.
reviewer = ctx.narrow("tracker/issues", "memory", read_only=True)
print(reviewer.describe().splitlines()[1:3])
print("the helper's bash sees:", reviewer.sh("ls").run().text.split())
print("the tools a model would be given:", [tool.name for tool in reviewer.tools()], "\n")

# The audit disk is append-only, and the journal on it is a log like any other.
print(ctx.spend)
print([f.path for f in ctx.ls("audit/agent-7", recursive=True)])
