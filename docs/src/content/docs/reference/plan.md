---
title: Plan
description: Reference for Plan and Task. The fields of a plan, its printed form, its JSON form, and how its hash is computed, in Python and TypeScript.
---

A plan is what a statement will do, written down before it does it. `explain()` returns one, and `result.plan` is the one that ran. The guide is [Read a plan](/guides/plans/).

## Plan

| Python | TypeScript | Is |
|---|---|---|
| `plan.hash` | `plan.hash` | 12 hex characters that name what the plan does |
| `plan.kind` | `plan.kind` | `sh`, `sql`, `grep` or `batch` |
| `plan.route` | `plan.route` | `exec`, or `grep` for the native search |
| `plan.statement` | `plan.statement` | the template, with its placeholders |
| `plan.tasks` | `plan.tasks` | a list of `Task`: one per call |
| `plan.vm` | `plan.vm` | the [`Vm`](/reference/backends/#vm) each call runs in |
| `plan.reads` | `plan.reads` | what the statement declared it reads, as the printed plan shows it: `logs[last 15m]` |
| `plan.read_paths` | `plan.readPaths` | the same reads as paths and globs, when `reads` holds labels |
| `plan.writes` | `plan.writes` | what the statement declared it writes |
| `plan.unmounted` | `plan.unmounted` | the context's mounts that the call cannot see |
| `plan.files` | `plan.files` | how many files its globs and log selections matched. `sql` counts the files under its paths too, and `grep` every file it searches. A single path in `sh` is not counted, and a `batch` has 0 |
| `plan.reduce` | `plan.reduce` | the reducer's name, `"function"`, or none |
| `plan.parallel` | `plan.parallel` | how many calls may run at once |
| `plan.estimate` | `plan.estimate` | an [`Estimate`](/reference/pricing/#estimate) |
| `plan.notes` | `plan.notes` | advice, as a list of strings |
| `str(plan)` | `String(plan)` | the printed plan |
| `plan.to_dict()` | `plan.toJSON()` | the plan as a JSON document. `JSON.stringify(plan)` uses it |

## Task

One call: a command and the mount map it runs under.

| Python | TypeScript | Is |
|---|---|---|
| `task.command` | `task.command` | the command, with every parameter rendered |
| `task.mounts` | `task.mounts` | path in the VM to [`MountSpec`](/reference/backends/#mountspec) |
| `task.label` | `task.label` | `shard 0`, `shard 1`, … for a mapped statement. Empty otherwise |
| `task.to_dict()` | `task.toJSON()` | `{"command", "disks"}`: nearly the body of an exec request |

## The printed form

```plan
plan f381e1d9ce0c  sh · 2 file(s), 58 B · 1 call
  route   exec · 2 vCPU / 4 GiB
  scope   team/leads → team-notes:/leads (read-only)
          memory → agent-memory (read-write, checkout /)
          not mounted: docs, logs
  reads   team/leads/*.csv
  writes  memory/leads.csv
  price   1 call unit $0.00005 + 58 B active for an hour <$0.00001 ≈ $0.00005
```

| Line | Holds |
|---|---|
| `plan` | the hash; the kind; the files counted and the bytes read, when `files` is not 0; the number of calls; the reducer, with more than one call |
| `route` | `exec`, the VM size, a custom image, the network policy, and how many run at once. Or `grep` |
| `scope` | one line per mount: `path in the VM → disk:/subdirectory (how)`. Then `not mounted:` |
| `reads` | the declared reads. `— (not declared)` when nothing was declared |
| `writes` | the declared writes, or `—` |
| `price` | call units and their cost; bytes made active for an hour and theirs; egress when there is any; the total. `(input size unknown)` when the estimate is not complete |
| `note` | one line per note |

`how` is `read-only`, `read-write, checkout /` or `read-write, conditional`.

## The JSON form

```json
{
  "plan": 0,
  "hash": "ed578d40c885",
  "kind": "sh",
  "route": "exec",
  "statement": "wc -w {files}",
  "vm": { "vcpuCount": 2, "memSizeMib": 4096 },
  "parallel": 64,
  "reduce": null,
  "effects": { "reads": ["docs/*.md"], "writes": [] },
  "tasks": [
    { "command": "wc -w docs/expenses.md docs/onboarding.md",
      "disks": { "docs": { "disk": "handbook", "readOnly": true, "conditional": false } } }
  ],
  "estimate": { "calls": 1, "callUnits": 1, "bytesTouched": 103, "egressBytes": 0,
                "usd": 5e-05, "usdCalls": 5e-05, "usdActive": 0.0, "usdEgress": 0.0, "complete": true },
  "notes": []
}
```

| Field | Is |
|---|---|
| `plan` | the format's version. It is `0` |
| `hash`, `kind`, `route`, `statement`, `parallel`, `reduce`, `notes` | as on the object |
| `vm` | `vcpuCount`, `memSizeMib`, and when set `baseImage` and `network` |
| `effects` | `reads` and `writes`. `reads` is `read_paths` when that is set |
| `tasks` | each a `command` and a `disks` map |
| `estimate` | the [`Estimate`](/reference/pricing/#estimate) as JSON. Money is rounded to eight places |

A disk in `disks` has `disk`, `readOnly` and `conditional`, and when set `subdirectory`, `checkoutPaths` and `queueMs`.

## The hash

The first 12 hex characters of the SHA-256 of this object, written as JSON with sorted keys and no spaces:

```json
{"kind": "…", "reduce": null, "statement": "…", "tasks": [], "vm": {}}
```

- It covers what a plan does, and not what it costs.
- Both SDKs hash the same form. A statement written with named parameters gets the same hash from each.
- A TypeScript tagged template names its parameters `p0`, `p1`, …, so its `statement` and its hash differ from the named form's.
- For `sh`, it changes when the set of files a glob matches changes, because the command names each file. A `sql` command names the glob itself, so its hash stays the same.
