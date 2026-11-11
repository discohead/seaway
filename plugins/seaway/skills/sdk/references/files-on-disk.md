# What the framework writes

Everything seaway keeps is a plain file on the disk it concerns. So the framework is really a set of file conventions, and the SDKs are two implementations of them. Either SDK can read what the other wrote, and an agent with only bash can take part: the journal is JSON lines it can `jq`, a manifest is JSON it can write, a view is a file it can `cat`.

## Contents

- [Where things are](#where-things-are)
- [A context manifest](#a-context-manifest)
- [A log record](#a-log-record)
- [The journal](#the-journal)
- [View state](#view-state)
- [Recipe state](#recipe-state)
- [A feed cursor](#a-feed-cursor)
- [A turn's changes](#a-turns-changes)
- [A plan](#a-plan)
- [A file's version](#a-files-version)
- [With only bash](#with-only-bash)

## Where things are

| What | Where | Format |
|---|---|---|
| Context manifest | wherever you save it | one JSON object |
| Log record | `<log>/<YYYY-MM-DD>/<HH>/<writer>.ndjson`, in UTC | one JSON object per line |
| Journal | the path given as `journal`, as a log partitioned by day | one JSON object per line |
| View state | `<mount>/.px/views/<id>.json` | one JSON object |
| Recipe state | `<mount>/.px/recipes/<id>.json` | one JSON object |
| Feed cursor | the path given as `cursor` | one JSON object |
| A turn's changes | `<mount>/.px/tx/<turn id>.changes`, on the turn's branch | lines of `W<TAB>path` or `D<TAB>path` |
| Plan | not stored; `plan.to_dict()`, `JSON.stringify(plan)` | one JSON object |

`.px/` at the root of a mount is the framework's own bookkeeping. `ls`, globs, searches, feeds and turns all pass over it, and a mount cannot be named `.px`. (`.archil/` is Archil's, and is left alone.) An `<id>` is the first 16 hex characters of the SHA-1 of a path: the view's path, or the recipe's target directory, each written as `<mount>/<path>`.

## A context manifest

```json
{
  "archilContext": 0,
  "name": "agent-7",
  "mounts": {
    "skills": { "disk": "org-skills", "mode": "frozen", "at": "2026-11-01", "description": "how we work, pinned to a release" },
    "tracker": { "disk": "tracker-mirror", "mode": "read", "allow": "issues", "readOnly": true },
    "memory": { "disk": "agent-7-memory", "mode": "owned", "subdirectory": "agent-7" },
    "audit": { "disk": "audit-log", "mode": "append" }
  },
  "journal": "audit/agent-7",
  "tools": { "duckdb": "memory/bin/duckdb" },
  "egress": ["api.example.com"]
}
```

- `archilContext` is the format's version, and is 0.
- A mount needs `disk`. `mode` is `read` when it is left out. `at` is the checkpoint of a `frozen` mount. `subdirectory` mounts one directory of the disk. `description` is a note. `allow` is the sub-tree the mount was narrowed to, and `readOnly` says it was forced read-only.
- `journal`, `tools` and `egress` are optional. `egress` is `"deny"` or a list of hosts; left out, the network is open.
- A manifest returned by `lock()` also has `"locked": "<name>"`, and every mount in it is `frozen`: at that checkpoint, or at the one it was already pinned to.

## A log record

```json
{"ts":"2026-11-09T14:10:00.000Z","id":"1e30fa3b844f","level":"ERROR","service":"checkout","msg":"payments-gateway unreachable"}
```

`ts` is ISO 8601 in UTC with milliseconds and a `Z`, so the strings sort in time order. `id` is 12 hex characters. Both are added in front of the record's own fields unless it already has them. The file is `<log>/<date>/<hour>/<writer>.ndjson`: the date and hour are the record's own, in UTC. With `partition="day"` there is no hour directory, and with `"none"` no date directory either.

To write a log from something that is not the SDK, append lines of that shape to a file of that name. To read one, any tool that reads JSON lines will do.

## The journal

The journal is a log partitioned by day, with one file per session: `<journal>/<date>/<session>.ndjson`.

```json
{"ts":"2026-11-10T09:31:11.187Z","id":"88013b9a8903","kind":"sh","plan":"2ff7769484c0","statement":"cat {f} | wc -l","reads":["logs/**/*.ndjson"],"writes":["obs/reports/n.txt"],"calls":1,"callUnits":1,"usd":5e-05,"ms":7.8,"exit":0}
{"ts":"2026-11-10T09:31:11.188Z","id":"4fa27d6ad183","kind":"sync","recipe":"s","written":1,"unchanged":0,"deleted":0,"into":"obs/skills"}
{"ts":"2026-11-10T09:31:11.206Z","id":"bea92007a92a","kind":"commit","tx":"t1","applied":1,"deleted":0,"calls":1}
{"ts":"2026-11-10T09:31:12.004Z","id":"0c2f6f0d1b7e","kind":"rollback","tx":"t2"}
```

| `kind` | Fields |
|---|---|
| `sh`, `sql`, `grep`, `batch` | `plan` (the hash), `statement` (the template, at most 240 characters), `reads`, `writes`, `calls`, `callUnits`, `usd`, `ms`, `exit` |
| `sync` | `recipe`, `written`, `unchanged`, `deleted`, `into` |
| `commit` | `tx`, `applied`, `deleted`, `calls` |
| `rollback` | `tx` |

`ts` is when the thing happened, which can be before the line was written. Direct reads and writes (`read`, `write`, `append`, `ls`) are not journaled.

## View state

`<mount>/.px/views/<id>.json`, beside the view's output on the same mount:

```json
{"path": "obs/reports/n.txt", "fingerprint": "c982ee4ab99f…", "plan": "2ff7769484c0", "builtAt": "2026-11-10T09:31:11.187584+00:00", "usd": 5e-05}
```

`fingerprint` is a SHA-256 over the statement (its kind, template and parameters) and each input file's path, size and version. A view is fresh when its output exists and this equals the fingerprint computed now. A fingerprint that ends in `~` is provisional: the view builds once more. The view's definition is not here: rebuilding needs the code that defined it.

## Recipe state

`<mount>/.px/recipes/<id>.json` maps each key the recipe produced to the version it had when it was last synced:

```json
{"ENG-1.md": "2026-11-09T10:00:00Z", "ENG-2.md": "2026-11-07T15:30:00Z"}
```

Delete this file to make the next sync write everything again.

## A feed cursor

At the path given as `cursor`:

```json
{"feed":0,"path":"logs","seen":{"logs/2026-11-10/09/api-a.ndjson":[80,"18e6a522f903616c-50"]}}
```

`seen` maps each file under the path to its size and version at the last `ack()`. A version that ends in `~` is provisional: the file is handed over again. Delete the cursor to make the next poll hand over everything.

## A turn's changes

At commit, the SDK writes the turn's change list to its branch, at `.px/tx/<turn id>.changes`, and the call that applies the turn reads it:

```text
W	notes/eng-1.md
D	notes/old.md
```

`W` is a path written, `D` one deleted, each relative to the mount. The file stays on the branch, which still holds the whole turn if applying it failed.

## A plan

See [plans-and-prices.md](plans-and-prices.md#a-plan-as-data). A plan is not written anywhere by the SDK. Its hash is what the journal and a view's state record.

## A file's version

A version is a string that changes when the content does. It is what views, feeds and turns compare.

| Backend | Version |
|---|---|
| local | the modification time in nanoseconds and the size, in hex: `18e6a522f903616c-50` |
| Archil | the ETag and the modification time in whole seconds: `<etag>@<seconds>` |

Versions from one backend mean nothing on the other, so a cursor or a view's state does not carry over between a local root and a disk.

## With only bash

```bash
# what did this agent run today, and what did it cost?
cat memory/journal/$(date -u +%F)/*.ndjson | jq -s 'map(select(.usd)) | {statements: length, calls: (map(.calls) | add), usd: (map(.usd) | add)}'

# the statements that failed
cat memory/journal/*/*.ndjson | jq -c 'select(.exit != null and .exit != 0) | {ts, statement, exit}'

# the last hour of a log, without the SDK
cat logs/$(date -u +%F)/$(date -u +%H)/*.ndjson | jq -r 'select(.level == "ERROR") | .ts + " " + .service + " " + .msg'

# append a record the way the SDK does
printf '{"ts":"%s","id":"%s","level":"INFO","msg":"hello"}\n' "$(date -u +%FT%T.000Z)" "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')" \
  >> "logs/$(date -u +%F)/$(date -u +%H)/shell-1.ndjson"
```

Run inside a statement, those paths are as written: a command starts where the disks are mounted. The last one needs the mount to be writable in the call, and on an `append` mount it is not: commands see append-only data read-only, and records go in through `append`.
