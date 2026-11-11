"""__NAME__: __SUMMARY__

    python app.py              # on a local backend under ./.archil-local: no account, nothing leaves this machine
    python app.py --archil     # on Archil: needs ARCHIL_API_KEY and ARCHIL_REGION, creates the disks below, bills per call
"""

from __future__ import annotations

import sys

import seaway as archil

NAME = "__NAME__"


def backend():
    """Local unless asked otherwise. An exported ARCHIL_API_KEY alone does not send this program to an account."""
    if "--archil" in sys.argv:
        return archil.ArchilBackend()
    return archil.LocalBackend(".archil-local")


def open_context(backend) -> archil.Context:
    """Which disks, and under what rules. The mode says who may change each one."""
    return archil.context(
        {
            "data": archil.disk(f"{NAME}-data", "append", create=True, description="records, appended as they arrive"),
            "work": archil.disk(f"{NAME}-work", "owned", create=True, description="this program's own: reports, notes, journal"),
        },
        backend=backend,
        name=NAME,
        journal="work/journal",     # one line per statement: what it read, wrote and cost
        egress="deny",              # commands cannot reach the network unless a statement says otherwise
    )


def main() -> None:
    ctx = open_context(backend())
    print(ctx.describe(), "\n")

    # 1. Data arrives as records in a log: a directory per hour, a file per writer.
    log = ctx.log("data/events", writer="example")
    log.append([{"kind": "signup", "plan": "free"}, {"kind": "signup", "plan": "pro"}, {"kind": "cancel", "plan": "free"}])

    # 2. A question is a statement. It names what it reads, so the call mounts that and nothing else.
    count = "cat {events} | grep -o '\"kind\":\"[a-z]*\"' | sort | uniq -c"
    by_kind = ctx.sh(count, events=log.last("1h"))
    print(by_kind.explain(), "\n")              # what it would mount and cost; nothing has run yet
    print(by_kind.run(check=True).text)

    # 3. Something read more than once is a view: it rebuilds only when its inputs changed.
    report = ctx.view("work/reports/by-kind.txt", lambda: ctx.sh(count, events=log.all()))
    report.refresh()
    print("the report is fresh:", report.fresh, "\n")

    # 4. Changes that belong together land together, or not at all.
    with ctx.transaction(writes=["work"]) as turn:
        turn.write("work/notes/last-run.md", "Counted events by kind.\n")

    print(ctx.spend)                            # what this run costs on Archil, by the public price sheet


if __name__ == "__main__":
    main()
