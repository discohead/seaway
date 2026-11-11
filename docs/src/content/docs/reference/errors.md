---
title: Errors
description: Reference for the error classes and their fields, in Python and TypeScript, with every error code in one table.
---

Every error carries a stable code, a plain message, the path it concerns when there is one, and a suggestion. The guide, with what to do about each code, is [Errors and exit codes](/guides/errors/).

## The classes

| Python | TypeScript | `code` | Raised when |
|---|---|---|---|
| `archil.Error` | `archil.ArchilError` | varies | the base class |
| `archil.ValidationError` | `archil.ValidationError` | the first issue's code | the request is wrong |
| `archil.BudgetExceeded` | `archil.BudgetExceeded` | `budget_exceeded` | the plan is over a budget |
| `archil.Conflict` | `archil.Conflict` | `conflict` | a turn lost to another writer |
| `archil.Busy` | `archil.Busy` | `busy` | a direct write to a disk whose checkout a statement holds |
| `archil.NotSupported` | `archil.NotSupported` | `not_supported` | the backend cannot do this, or the official SDK is not installed |
| `archil.ExecFailed` | `archil.ExecFailed` | `exec_failed` | a command exited non-zero, and the caller asked for that to raise |

All of them derive from the base class.

## On every error

| Python | TypeScript | Is |
|---|---|---|
| `error.code` | `error.code` | a stable code |
| `error.message` | `error.message` | the message alone |
| `error.path` | `error.path` | the path it concerns, or none |
| `error.suggestion` | `error.suggestion` | what to do next, or none |
| `str(error)` | `String(error)` | `code [path]: message — suggestion`. Safe to show a model |
| `error.to_dict()` | `error.toJSON()` | `{code, message, path, suggestion}` as a document. A `ValidationError` gives `{code, issues}`. `JSON.stringify(error)` uses it |

## On particular errors

| Class | Python | TypeScript | Is |
|---|---|---|---|
| `ValidationError` | `error.issues` | `error.issues` | every problem found: each has `code`, `message`, `path`, `suggestion` |
| `Conflict` | `error.paths` | `error.paths` | every path that changed under the turn |
| `ExecFailed` | `error.exit_code` | `error.exitCode` | the command's exit code |
| `ExecFailed` | `error.stderr` | `error.stderr` | what it wrote to stderr |
| `ExecFailed` | `error.command` | `error.command` | the statement's template |

`archil.Issue` is one problem: `code`, `message`, `path`, `suggestion`. It is a class in Python and a type in TypeScript, where `archil.issueText(issue)` writes one as a line.

## Every code

| Code | Class | Area |
|---|---|---|
| `unknown_mount` | `ValidationError` | paths |
| `out_of_scope` | `ValidationError` | paths |
| `read_only` | `ValidationError` | paths; turns |
| `bad_path` | `ValidationError` | paths |
| `not_found` | `ValidationError` | paths |
| `exists` | `ValidationError` | paths |
| `invalid` | `ValidationError` | the code when no other fits |
| `bad_mode` | `ValidationError` | composing a context |
| `unknown_disk` | `ValidationError` | composing a context |
| `bad_mount` | `ValidationError` | composing a context |
| `empty_context` | `ValidationError` | composing a context |
| `bad_manifest` | `ValidationError` | composing a context |
| `bad_egress` | `ValidationError` | composing a context |
| `bad_checkpoint` | `ValidationError` | checkpoints, on Archil |
| `unused_parameter` | `ValidationError` | statements |
| `bad_template` | `ValidationError` | statements, in TypeScript |
| `bad_map` | `ValidationError` | statements |
| `bad_batch` | `ValidationError` | statements |
| `command_too_large` | `ValidationError` | statements |
| `bad_reduce_input` | the base class | statements |
| `budget_exceeded` | `BudgetExceeded` | statements |
| `exec_failed` | `ExecFailed` | statements |
| `conflict` | `Conflict` | turns |
| `undeclared_write` | `ValidationError` | turns |
| `bad_isolation` | `ValidationError` | turns |
| `bad_state` | the base class | turns |
| `commit_failed` | the base class | turns |
| `bad_duration` | `ValidationError` | logs |
| `bad_time` | `ValidationError` | logs, in TypeScript. Python raises a plain `ValueError` there |
| `bad_partition` | `ValidationError` | logs |
| `record_too_large` | `ValidationError` | logs |
| `bad_key` | `ValidationError` | recipes |
| `unpinned_download` | `ValidationError` | recipes |
| `bad_sha256` | `ValidationError` | recipes |
| `delete_failed` | `ValidationError` | deleting, on Archil |
| `busy` | `Busy` | direct writes, on Archil |
| `not_supported` | `NotSupported` | backends |

A failure of the backend's own client, such as a refused request or a dropped connection, is raised as that client's exception. It is not one of these.

## Exit codes

Not errors, but results. A command's own exit code is passed through, and three are also used for failures that are not the command's.

| Exit | Meaning |
|---|---|
| 1 | with `mount failed: …` in stderr, a mount could not be made. With `command exceeds … bytes`, the command was over the size limit |
| 30 | the checkout of an `owned` mount was not granted in time. With symlink mounts locally, also a write detected on a read-only mount |
| 124 | the command ran past five minutes |
| 127 | the shell could not find a program |
