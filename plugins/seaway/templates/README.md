# __NAME__

__SUMMARY__

Built on seaway, a framework for Archil: a context says which disks there are and under what rules, and statements ask questions of them. Nothing runs between questions.

## Run it

```bash
__RUN__              # on a local backend under ./.archil-local: no account, nothing leaves this machine
__RUN__ --archil     # on Archil: needs ARCHIL_API_KEY and ARCHIL_REGION, creates the disks below, bills per call
```

The local run needs nothing but __RUNTIME__ and the seaway SDK. `.archil-local/` holds the local disks; delete it to start again.

## The context

| Mount | Disk | Mode | What is on it |
|---|---|---|---|
| `data` | `__NAME__-data` | `append` | records, appended as they arrive |
| `work` | `__NAME__-work` | `owned` | this program's own: reports, notes, journal |

## Layout

```text
data/events/<date>/<hour>/<writer>.ndjson    one JSON object per line, each with ts and id
work/reports/by-kind.txt                     a view: rebuilt only when the events changed
work/notes/                                  written inside a turn
work/journal/<date>/<session>.ndjson         one line per statement: what it read, wrote and cost
```
