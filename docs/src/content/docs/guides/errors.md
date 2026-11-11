---
title: Errors and exit codes
description: Every error carries a stable code, a plain message, the path it concerns and a suggestion that says what to do next. A request is validated before anything is sent.
---

Every error carries a stable `code`, a plain `message`, the `path` it concerns when there is one, and a `suggestion` that says what to do next. A request is validated before anything is sent, so one refused that way has changed nothing.

::example-context

## Read one

```python
try:
    ctx.sh("cat {f}", f=ctx.path("reports/q3.md")).run()
except archil.ValidationError as e:
    print(e.code)
    print(e.path)
    print(e.suggestion)
    print(e)                  # the one-line form, safe to show a model
```

```ts
try {
  await ctx.sh`cat ${ctx.path("reports/q3.md")}`.run();
} catch (e) {
  if (!(e instanceof archil.ValidationError)) throw e;
  console.log(e.code);
  console.log(e.path);
  console.log(e.suggestion);
  console.log(String(e));     // the one-line form, safe to show a model
}
```

```text output
unknown_mount
reports/q3.md
paths start with a mount name: docs/…, logs/…, memory/…, team/…
unknown_mount [reports/q3.md]: no mount named 'reports' — paths start with a mount name: docs/…, logs/…, memory/…, team/…
```

`str(error)` (`String(error)`) is `code [path]: message — suggestion`. It is safe to show a model, and it is what the tools from `ctx.tools()` return. In TypeScript, `error.message` is the message alone.

`error.to_dict()` in Python and `JSON.stringify(error)` in TypeScript give `{"code", "issues": [{"code", "message", "path", "suggestion"}]}` for a `ValidationError`, which lists every problem it found.

## The classes

| Class | `code` | Raised when | Did anything run |
|---|---|---|---|
| `Error` (Python), `ArchilError` (TypeScript) | varies | the base class. Also raised directly for `bad_reduce_input`, `bad_state`, `commit_failed` | varies |
| `ValidationError` | the first issue's code | the request is wrong. `issues` lists every problem found | no, except the codes below |
| `BudgetExceeded` | `budget_exceeded` | the plan costs more than the statement's or the context's budget allows | no |
| `Conflict` | `conflict` | a turn could not commit because someone else changed the same paths. `paths` lists them | the turn's work ran on its branch; nothing was applied |
| `Busy` | `busy` | on Archil, a direct write to a disk whose checkout a statement is holding | no |
| `NotSupported` | `not_supported` | the backend cannot do this, or the official SDK is not installed | no, except a checkpoint that Archil refused: the call that asked had run |
| `ExecFailed` | `exec_failed` | a command exited non-zero and the caller asked for that to raise (`check=True`). It has `exit_code`, `stderr`, `command` | yes |

All of them derive from the base class, so one `except archil.Error` (or `catch`, then `instanceof archil.ArchilError`) takes any of them.

A failure of the backend's own client, such as a refused request or a dropped connection, is raised as that client's exception. It is not one of these.

:::note[A few codes are raised after work was done]
`undeclared_write`, `bad_key`, `bad_checkpoint` and `delete_failed`, and `bad_path` when it comes from a recipe's key. Their rows below say what had already happened.
:::

## Codes, and what to do

### Paths and mounts

| Code | Meaning | Do |
|---|---|---|
| `unknown_mount` | the path's first segment is not a mount | start the path with one of the context's mount names |
| `out_of_scope` | the path is outside what this context was narrowed to | ask the holder of the wider context |
| `read_only` | a write or an append to a mount whose mode does not allow it; or a turn on a context that can write nothing | mount the disk as `owned` or `shared`. For an `append` mount use `append()` or a log |
| `bad_path` | `..` in a path; or `rm` of a mount's root. From a recipe's key during `sync`, the entries listed before it were already written | address files from the top of the context. Name a file or a directory below the mount |
| `not_found` | no such file, or no such checkpoint | check with `ls` or `exists` |
| `exists` | `write(..., if_absent=True)` on a file that is there. On the local backend, also a checkpoint or branch name already used on that disk | choose a new name |
| `invalid` | the code a `ValidationError` has when no other fits. A direct `append` of more than 1 MiB gets it | send the append in pieces, or use a log, which splits its own |

### Composing a context

| Code | Meaning | Do |
|---|---|---|
| `bad_mode` | not one of the five modes; or `frozen` without `at` | use `read`, `frozen`, `owned`, `shared` or `append`. Give a frozen mount its checkpoint |
| `unknown_disk` | no disk has that name | pass `create=True`, or on Archil use the `dsk-` id |
| `bad_mount` | a mount name that is not one path segment, or is `.px` | name mounts like `logs` |
| `empty_context` | no mounts | give at least one |
| `bad_manifest` | not a context manifest | it needs `"archilContext": 0` |
| `bad_egress` | not `"deny"`, `"allow"` or a list of hosts | use one of those |
| `bad_checkpoint` | Archil refused the checkpoint's name. The call that asked had already run, and no checkpoint was taken | it has to be new on its disk, and made of letters, digits, `-` and `_` |

### Statements

| Code | Meaning | Do |
|---|---|---|
| `unused_parameter` | a parameter that never appears in the template as `{name}` | fix the typo. The error lists the placeholders it found |
| `bad_template` | TypeScript tagged templates: a value straight after `$` or a backslash, or text that looks like a generated name | write the statement with named parameters |
| `bad_map` | `map` on something other than `sh`; an unknown reducer; no single input to split | pass `on=`, or pass exactly one glob. Use a reducer from the list |
| `bad_batch` | a batch that is empty, or holds a mapped or `grep` statement, or one with its own egress | run those on their own. Set egress on the batch |
| `command_too_large` | the compiled command is over 100 KiB | spread the inputs across calls with `.map()` |
| `bad_reduce_input` | `sum` or `sum_by_key` met a line it cannot read | change the command's output, or reduce with `lines` and combine yourself |
| `budget_exceeded` | the plan is over the budget | narrow the paths, use `grep` for a regex search, or raise the budget |

### Turns, logs and recipes

| Code | Meaning | Do |
|---|---|---|
| `conflict` | paths the turn changed were changed by someone else | run the turn again from the new state |
| `undeclared_write` | the turn changed a path outside its `writes`. Raised at commit: the turn's work ran on its branch, nothing was applied, and the turn is over | add it to `writes`, or leave `writes` out |
| `bad_isolation` | not `snapshot` or `serializable`; or `serializable` with no `reads` | list the paths the turn's decisions depend on |
| `bad_state` | a transaction used before `begin()` or after it ended | begin a new one |
| `commit_failed` | the copy to the main line failed part-way | some paths may have been applied. The branch still holds the whole turn |
| `bad_duration` | a span that cannot be read | use `15m`, `2h`, `7d` |
| `bad_time` | TypeScript: a record's `ts` that cannot be read. Python raises a plain `ValueError` there. An invalid `Date` passed as `at`, to `between` or as `now` throws a plain `RangeError` | use ISO 8601, like `2026-11-09T14:30:00.000Z` |
| `bad_partition` | not `hour`, `day` or `none` | use one of those |
| `record_too_large` | one log record over 1 MiB | store the payload as a file and log its path |
| `bad_key` | a recipe produced an empty key, or one under `.px`. The entries listed before it were already written | fix the recipe's `list` |
| `unpinned_download`, `bad_sha256` | `archil.duckdb` given a version or URL with no usable SHA-256 | pass the archive's `sha256` |
| `delete_failed` | Archil could not delete an object. The others under the same path were deleted | read the message |

## Exit codes

A command's own exit code is passed through. A command that fails is a result, not an exception: see [a command that fails is a result](/guides/results/#a-command-that-fails-is-a-result).

Three codes are also used for failures that are not the command's, the same way on both backends, so code written against one reads the same on the other.

| Exit | Meaning | Do |
|---|---|---|
| 1 | with `mount failed: …` in stderr: a mount could not be made, usually a subdirectory that does not exist on the disk; or the command was over the size limit | check the path. A directory has to exist before it is mounted read-only |
| 30 | the checkout of an `owned` mount was not granted within five seconds: another call holds it. On the local backend with symlink mounts, also a write that was detected on a read-only mount | retry; or declare the write with `ctx.out` |
| 124 | the command ran past five minutes | split the work with `.map()`, or give the VM more with `sized()` |
| 127 | the shell could not find a program, such as `duckdb` or `jq` | install it locally. On Archil put it on a disk and call it by its path there. For `duckdb`, name that path in `tools` |

## Handle them in one place

```python
def run(stmt):
    """Run a statement and say what happened, without raising."""
    try:
        result = stmt.run()
    except archil.BudgetExceeded as e:
        return f"over budget: {e.message}"
    except archil.ValidationError as e:
        return f"wrong request ({e.code}): {e.suggestion}"
    except archil.Error as e:
        return f"failed ({e.code}): {e.message}"
    if result.exit_code == 30:
        return "busy: another call holds the checkout; run it again"
    return (result.text if result.ok
            else f"exit {result.exit_code}: {result.stderr.strip()}")

print(run(ctx.sh("cat {f}", f=ctx.path("docs/onboarding.md")).within(max_calls=0)))
print(run(ctx.sh("cat {f}", f=ctx.path("docs/onboarding.md"), unused="x")))
print(run(ctx.sh("head -n 1 {f}", f=ctx.path("docs/onboarding.md"))).strip())
```

```ts
async function run(stmt: archil.Statement): Promise<string> {
  // Run a statement and say what happened, without throwing.
  let result: archil.Result;
  try {
    result = await stmt.run();
  } catch (e) {
    if (e instanceof archil.BudgetExceeded) return `over budget: ${e.message}`;
    if (e instanceof archil.ValidationError)
      return `wrong request (${e.code}): ${e.suggestion}`;
    if (e instanceof archil.ArchilError) return `failed (${e.code}): ${e.message}`;
    throw e;
  }
  if (result.exitCode === 30)
    return "busy: another call holds the checkout; run it again";
  return result.ok ? result.text : `exit ${result.exitCode}: ${result.stderr.trim()}`;
}

console.log(
  await run(ctx.sh`cat ${ctx.path("docs/onboarding.md")}`.within({ maxCalls: 0 })),
);
console.log(
  await run(ctx.sh("cat {f}", { f: ctx.path("docs/onboarding.md"), unused: "x" })),
);
console.log((await run(ctx.sh`head -n 1 ${ctx.path("docs/onboarding.md")}`)).trim());
```

```text output
over budget: plan exceeds budget: 1 calls > 0
wrong request (unused_parameter): placeholders found: ['f']
# Onboarding
```

Catch the specific classes before the base class. `BudgetExceeded` and `ValidationError` both derive from it.

## Next

:::cards
- [Troubleshooting](/guides/troubleshooting/) When something looks wrong but nothing was raised.
- [Errors reference](/reference/errors/) Every class and its fields, in both languages.
:::
