"""Compose a context, ask a question, read the plan, run it.

    python examples/quickstart.py             # on the local backend: no account needed
    python examples/quickstart.py --archil    # the same code on Archil; see _where.py
"""

from __future__ import annotations

import seaway as archil

import _where as where

backend = where.backend("quickstart")

# The publisher's view of the handbook: it is the one writer.
publisher = archil.context({"docs": where.disk("handbook", "owned", create=True)}, backend=backend)
publisher.sync(
    archil.Static(
        {
            "onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
            "expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
            "security/keys.md": "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
        },
        name="handbook",
        layout="One Markdown file per policy. Security policies are under security/.",
    ),
    into="docs",
)

# 1. A context is a value: which disks, and under what rules. The same handbook is
#    read-only here, and the agent's notes are its own.
ctx = archil.context(
    {
        "docs": where.disk("handbook", description="company policies, one file each"),
        "notes": where.disk("my-notes", "owned", create=True, description="this agent's working notes"),
    },
    backend=backend,
    name="quickstart",
)
print(ctx.describe(), "\n")

# 2. A statement is work that runs next to the data. Building one runs nothing.
#    The paths it is given are the only paths the call will be able to see.
words = ctx.sh("wc -w {files} | sort -n", files=ctx.glob("docs/**/*.md"))
print(words.explain(), "\n")
print(words.run().text)

# 3. Search is one call per disk, however many files there are.
for hit in ctx.grep("rotate", "docs", ignore_case=True).run().rows:
    print(f"{hit['file']}:{hit['line']}: {hit['text']}")
print()

# 4. Writes go where the context allows, and nowhere else.
ctx.sh("grep -l key {files} > {out}", files=ctx.glob("docs/**/*.md"), out=ctx.out("notes/mentions-keys.txt")).run(check=True)
print("notes/mentions-keys.txt:", ctx.read_text("notes/mentions-keys.txt").split())
try:
    ctx.write("docs/onboarding.md", "rewritten")
except archil.ValidationError as e:
    print(f"refused: {e.code}: {e.suggestion}\n")

# 5. A turn's changes land together, or not at all.
with ctx.transaction() as turn:
    turn.write("notes/todo.md", "- read the security policies\n")
    turn.sh("date -u +%F > {f}", f=turn.out("notes/started.txt")).run(check=True)
    print("inside the turn, the main line still has:", [f.path for f in ctx.ls("notes")])
print("after the commit:", [f.path for f in ctx.ls("notes")], "\n")

# 6. Hand a helper less than you have. Same path names, smaller reach.
helper = ctx.narrow("docs/security", read_only=True)
print(helper.describe().splitlines()[1])
print(helper.sh("find -L . -type f").run().text)

# 7. The context kept count.
print(ctx.spend)
