# Errors, exit codes and cut output

Every error carries a stable `code`, a plain `message`, the `path` it concerns when there is one, and a `suggestion` that says what to do next. A request is validated before anything is sent, so one refused that way has changed nothing. Four codes are raised after work was done, and their rows say what: `undeclared_write`, `bad_key`, `bad_checkpoint` and `delete_failed`.

## Contents

- [The classes](#the-classes)
- [Reading one](#reading-one)
- [Codes, and what to do](#codes-and-what-to-do)
- [Exit codes](#exit-codes)
- [When something looks wrong but nothing was raised](#when-something-looks-wrong-but-nothing-was-raised)

## The classes

| Class | `code` | Raised when | Did anything run |
|---|---|---|---|
| `Error` (Python), `ArchilError` (TypeScript) | varies | the base class; also raised directly for `bad_reduce_input`, `bad_state`, `commit_failed` | varies |
| `ValidationError` | the first issue's code | the request is wrong. `issues` lists every problem found | no, but for the four codes named above |
| `BudgetExceeded` | `budget_exceeded` | the plan costs more than the statement's or the context's budget allows | no |
| `Conflict` | `conflict` | a turn could not commit because someone else changed the same paths. `paths` lists them | the turn's work ran on its branch; nothing was applied |
| `Busy` | `busy` | on Archil, a direct write to a disk whose checkout a statement is holding | no |
| `NotSupported` | `not_supported` | the backend cannot do this, or the official SDK is not installed | no |
| `ExecFailed` | `exec_failed` | a command exited non-zero and the caller asked for that to raise (`check=True`). It has `exit_code`, `stderr`, `command` | yes |

All of them derive from the base class, so one `except archil.Error` (`catch` and test `instanceof archil.ArchilError`) takes any of them. A failure of the backend's own client, such as a refused request or a dropped connection, is raised as that client's exception and is not one of these.

## Reading one

```python
try:
    ctx.sh("cat {f}", f=ctx.path("reports/q3.md")).run()
except archil.ValidationError as e:
    print(e.code)             # unknown_mount
    print(e.path)             # reports/q3.md
    print(e.suggestion)       # paths start with a mount name: docs/…, logs/…, memory/…, team/…
    print(e)                  # unknown_mount [reports/q3.md]: no mount named 'reports' — paths start with …
    print(e.to_dict())        # {'code': 'unknown_mount', 'issues': [{'code': …, 'message': …, 'path': …, 'suggestion': …}]}

result = ctx.sh("ls {d}", d=ctx.path("docs/nowhere")).run()      # a command that fails is a result
print(result.ok, result.exit_code, result.stderr.strip())
try:
    result.check()                                               # or run(check=True)
except archil.ExecFailed as e:
    print(e.exit_code, "|", e)
```

```ts
try {
  await ctx.sh`cat ${ctx.path("reports/q3.md")}`;
} catch (e) {
  if (!(e instanceof archil.ValidationError)) throw e;
  console.log(e.code, e.path, e.suggestion);
  console.log(String(e));                 // the one-line form, safe to show a model
  console.log(JSON.stringify(e));         // {"code":"unknown_mount","issues":[…]}
}

const result = await ctx.sh`ls ${ctx.path("docs/nowhere")}`.run();
console.log(result.ok, result.exitCode, result.stderr.trim());
try {
  result.check();
} catch (e) {
  if (!(e instanceof archil.ExecFailed)) throw e;
  console.log(e.exitCode, "|", String(e));
}
```

`str(error)` (`String(error)`) is `code [path]: message — suggestion`. It is safe to show a model, and it is what the tools from `ctx.tools()` return. In TypeScript `error.message` is the message alone.

## Codes, and what to do

**Paths and mounts**

| Code | Meaning | Do |
|---|---|---|
| `unknown_mount` | the path's first segment is not a mount | start the path with one of the context's mount names |
| `out_of_scope` | the path is outside what this context was narrowed to | ask the holder of the wider context |
| `read_only` | a write or an append to a mount whose mode does not allow it; or a turn on a context that can write nothing | mount the disk as `owned` or `shared`; for an `append` mount use `append()` or a log |
| `bad_path` | `..` in a path; or `rm` of a mount's root | address files from the top of the context; name a file or a directory below the mount |
| `not_found` | no such file, or no such checkpoint | check with `ls` or `exists` |
| `exists` | `write(..., if_absent=True)` on a file that is there; on the local backend, also a checkpoint or branch name already used on that disk. On Archil a used checkpoint name is `bad_checkpoint`, and a used branch name comes back as the official client's own error | choose a new name |
| `invalid` | the code a `ValidationError` has when no other fits. A direct `append` of more than 1 MiB gets it | send the append in pieces, or use a log, which splits its own |

**Composing a context**

| Code | Meaning | Do |
|---|---|---|
| `bad_mode` | not one of the five modes; or `frozen` without `at` | use `read`, `frozen`, `owned`, `shared` or `append`; give a frozen mount its checkpoint |
| `unknown_disk` | no disk has that name | pass `create=True`, or on Archil use the `dsk-` id |
| `bad_mount` | a mount name that is not one path segment, or is `.px` | name mounts like `logs` |
| `empty_context` | no mounts | give at least one |
| `bad_manifest` | not a context manifest | it needs `"archilContext": 0` |
| `bad_egress` | not `"deny"`, `"allow"` or a list of hosts | use one of those |
| `bad_checkpoint` | Archil refused the checkpoint's name. The call that asked had already run, and no checkpoint was taken | it has to be new on its disk, and made of letters, digits, `-` and `_` |

**Statements**

| Code | Meaning | Do |
|---|---|---|
| `unused_parameter` | a parameter that never appears in the template as `{name}` | fix the typo; the error lists the placeholders it found |
| `bad_template` | TypeScript tagged templates: a value straight after `$` or a backslash, or text that looks like a generated name | write the statement with named parameters |
| `bad_map` | `map` on something other than `sh`; an unknown reducer; no single input to split | pass `on=`, or pass exactly one glob; use a reducer from the list |
| `bad_batch` | a batch that is empty, or holds a mapped or `grep` statement, or one with its own egress | run those on their own; set egress on the batch |
| `command_too_large` | the compiled command is over 100 KiB | spread the inputs across calls with `.map()` |
| `bad_reduce_input` | `sum` or `sum_by_key` met a line it cannot read | change the command's output, or reduce with `lines` and combine yourself |
| `budget_exceeded` | the plan is over the budget | narrow the paths, use `grep` for a regex search, or raise the budget |

**Turns, logs and recipes**

| Code | Meaning | Do |
|---|---|---|
| `conflict` | paths the turn changed were changed by someone else | run the turn again from the new state |
| `undeclared_write` | the turn changed a path outside its `writes`. Raised at commit: the turn's work ran on its branch, nothing was applied, and the turn is over. The journal's own file counts when it is on a disk the turn writes | add it to `writes`, or leave `writes` out |
| `bad_isolation` | not `snapshot` or `serializable`; or `serializable` with no `reads` | list the paths the turn's decisions depend on |
| `bad_state` | a transaction used before `begin()` or after it ended | begin a new one |
| `commit_failed` | the copy to the main line failed part-way | some paths may have been applied; the branch still holds the whole turn |
| `bad_duration` | a span that cannot be read | use `15m`, `2h`, `7d` |
| `bad_time` | TypeScript: a time, or a record's `ts`, that cannot be read. Python raises a plain `ValueError` there | use ISO 8601, like `2026-11-09T14:30:00.000Z` |
| `bad_partition` | not `hour`, `day` or `none` | use one of those |
| `record_too_large` | one log record over 1 MiB | store the payload as a file and log its path |
| `bad_key` | a recipe produced an empty key, or one under `.px`. The entries listed before it were already written | fix the recipe's `list` |
| `unpinned_download`, `bad_sha256` | `archil.duckdb` given a version or URL with no usable SHA-256 | pass the archive's `sha256` |
| `delete_failed` | Archil could not delete an object. The others under the same path were deleted | read the message |

## Exit codes

A command's own exit code is passed through. Three are also used for failures that are not the command's, the same way on both backends, so code written against one reads the same on the other.

| Exit | Meaning | Do |
|---|---|---|
| 1 | with `mount failed: …` in stderr: a mount could not be made, usually a subdirectory that does not exist on the disk; or the command was over the size limit | check the path; a directory has to exist before it is mounted read-only |
| 30 | the checkout of an `owned` mount was not granted within five seconds: another call holds it. On the local backend with symlink mounts, also a write that was detected on a read-only mount | retry; or declare the write with `ctx.out` |
| 124 | the command ran past five minutes | split the work with `.map()`, or give the VM more with `sized()` |
| 127 | the shell could not find a program, such as `duckdb` or `jq` | install it locally; on Archil put it on a disk and name it in `tools` |

## When something looks wrong but nothing was raised

- **Nothing happened.** The statement was built and never run. In Python call `.run()`; in TypeScript `await` it.
- **`rows` is `None`.** The `sql` statement failed, or its output was not JSON. Look at `result.exit_code` and `result.stderr`.
- **`rows` is `[]` and no call was made.** A path or a selection matched no files. The plan says `nothing to run`.
- **The output ends in `[output truncated]`.** It passed 4 MiB; `result.truncated` is true and only the first bytes are there. Send it `into()` a file and read part of it.
- **A value arrived with quotes or spaces intact.** That is the point: a value is one word. To pass several words, pass a list. To pass shell syntax, it is not a value: put it in the template.
- **`{name}` came through literally.** No parameter of that name was passed, so it was left alone, as `${HOME}` and `awk '{print $1}'` are.
- **The plan says `(input size unknown)` and mounts everything.** The statement declared no paths.
- **`find` finds nothing on the local backend.** With symlink mounts, `find` does not cross them: use `find -L`.
- **A view rebuilds every time, or a feed hands the same file over twice.** On Archil, an input written within the last second or two is not trusted yet; see [backends.md](backends.md#versions-rest-on-a-clock). Otherwise something really is rewriting the input.
- **A sum came back as a string.** DuckDB writes a `HUGEINT` as a string in JSON: cast it, `sum(n)::bigint`.
- **It worked locally and fails on Archil.** The usual causes: `duckdb` is not in the exec image; the image's `sqlite3` is older; a path was written as `/mnt/archil/...` or as a local absolute path; the network is denied by an egress policy; the disk names differ.
