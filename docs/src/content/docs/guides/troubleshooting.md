---
title: Troubleshooting
description: What to check when something looks wrong and nothing was raised. Nothing happened, rows are missing, output is cut, a plan mounts everything, or it worked locally and fails on Archil.
---

Most surprises in seaway come with no error at all. Start with what the machine says, then find the symptom below.

## Start here

- **Print the plan.** `print(statement.explain())` shows what the call can see, how many calls it makes and what it costs. Most questions end there.
- **Look at the result.** `result.exit_code`, `result.stderr`, and `result.plan` for the plan that actually ran.
- **Ask the doctor.** [`seaway-doctor`](/agents/lint/#seaway-doctor) says where a context would act and which tools are missing.

## Nothing happened

The statement was built and never run. Building a statement contacts nothing.

- In Python, call `.run()`.
- In TypeScript, `await` it, or call `.run()`.

The [linter](/agents/lint/) reports this as `never-run`.

## The plan mounts everything

The plan says `(input size unknown)` and its scope lists every mount. The statement declared no paths. Pass them as parameters: `ctx.path`, `ctx.glob`, `ctx.out`, or a log selection.

Two ways to declare nothing without noticing:

- **The path is a value.** `ctx.sh("cat {f}", f="docs/x.md")` quotes the string and declares nothing. Write `f=ctx.path("docs/x.md")`.
- **The path is in the text.** `read_json_auto('logs/**/*.ndjson')` inside a query, or `cat docs/x.md` in a command.

## A file is not there inside a call

A call sees only the disks its statement names.

- **A statement with `into()` and no declared reads sees only the output's disk.** `into` is a declared write, so the call is given that disk and nothing else. Declare what the command reads.
- **A disk the statement only reads is mounted at the smallest directory that covers the reads.** A sibling directory is not there.
- **`/mnt/archil/...` exists only on Archil.** Address files as the context does: `cat docs/onboarding.md`.

## `{name}` came through literally

No parameter of that name was passed, so it was left alone, as `${HOME}` and `awk '{print $1}'` are. Check the spelling. A parameter that is passed and never used is the error `unused_parameter`; a placeholder with no parameter is not an error.

## A value arrived with its quotes or spaces intact

That is the point: a value is one word. To pass several words, pass a list. To pass shell syntax, it is not a value: put it in the template, or use `archil.raw(text)` for a constant.

## SQL

| Symptom | Cause | Do |
|---|---|---|
| `rows` is `None` (`null`) | the query failed, or its output was not JSON, or it was sent `into()` a file, whose path is in `result.paths` | look at `result.exit_code` and `result.stderr`, or pass `check=True` |
| `rows` is `[]` and no call was made | a path or a selection matched no files. The plan says `nothing to run` | check the path, the partition and the time range |
| a sum came back as a string | DuckDB writes a `HUGEINT` as a string in JSON | cast it: `sum(n)::bigint`, `count(*)::int` |
| exit 127 | `duckdb` was not found | install it locally. On Archil, [put it on a disk](/guides/archil/#sql-needs-duckdb-on-a-disk) |
| files in a directory are missing from the table | a directory is read by its first file's extension | keep one format in a directory, or use a glob |

## Output

- **It ends in `[output truncated]`.** It passed 4 MiB. `result.truncated` is true and only the first bytes are there. Send it [`into()`](/guides/results/#keep-large-output-on-the-disk) a file and read part of it.
- **`result.text` is empty after `into()`.** The output went to the file. Its path is in `result.paths`.
- **A mapped `sort | head -5` gives too many lines.** Each shard returned its own five. Choose a [reducer that is right for the command](/guides/batch-and-map/#choose-a-reducer-that-is-right-for-the-command).

## Exit codes that are not the command's

| Exit | Meaning | Do |
|---|---|---|
| 1, with `mount failed` in stderr | a subdirectory to mount does not exist | create it first, or mount its parent |
| 30 | the checkout of an `owned` mount was not granted in five seconds | run it again |
| 124 | the command ran past five minutes | split it with `.map()`, or use `sized()` |
| 127 | a program was not found | install it; on Archil, put it on a disk |

## Turns

- **`Conflict` on every attempt.** Something keeps changing the same path. Give writers a file each, or check whether your own code writes through the outer context inside the turn.
- **`undeclared_write` at commit.** The turn changed a path outside its `writes`. Often that is the [journal](/guides/journal/#where-to-put-it), when it lives on a disk the turn writes.
- **A write survived a failed turn.** It went to a mount that `writes` did not name, to an `append` mount, or through the outer context. None of those is part of the turn.
- **`commit_failed` on Archil.** The commit copies the turn's changes under the mount's checkout. If another call held it, or the copy failed part-way, some paths may have been applied. The branch still holds the whole turn.

## Views and feeds

- **A view rebuilds every time,** or **a feed hands the same file over twice.** On Archil, an input written within the last second or two is not trusted yet. See [Versions and clocks](/architecture/versions/). Otherwise something really is rewriting the input.
- **A view never rebuilds.** Its inputs are the statement's read parameters, and paths passed in a list are not among them. If the output depends on more than the parameters name, list everything in [`inputs`](/guides/views/#inputs).
- **A feed returns the same changes again.** `ack()` was not called. That is by design: delivery is at least once.

## The local backend

- **`find` finds nothing.** With symlink mounts, `find` does not cross them. Use `find -L`, or start from a path inside the mount.
- **A write to a read-only mount "worked".** With symlink mounts the write is detected after the command, which then reports exit 30. On Linux with namespaces, and on Archil, it is refused.
- **A command reached the network with egress denied.** With symlink mounts a policy is not enforced.

`seaway-doctor` says which kind of mount this machine gets.

## It worked locally and fails on Archil

- `duckdb` is not in the exec image.
- The image's `sqlite3` is 3.37.2, older than yours.
- A path was written as `/mnt/archil/...` or as a local absolute path.
- The network is denied by an egress policy.
- The disk names differ, or a disk was created locally with `create=True` and not on Archil.
- A direct write raised `Busy`: a statement was holding that disk's checkout.

[Run on Archil](/guides/archil/) covers each.

## It acted on the live account

A context opened without a `backend` uses Archil when `ARCHIL_API_KEY` is set. Pass a `LocalBackend`, or set `ARCHIL_BACKEND=local`. See [which one a context gets](/guides/backends/#which-one-a-context-gets).

## Next

:::cards
- [Errors and exit codes](/guides/errors/) Every code, and what to do about each.
- [Status and known limits](/architecture/status/) What is not built, and what is known to be imperfect.
:::
