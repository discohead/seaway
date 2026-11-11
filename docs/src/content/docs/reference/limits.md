---
title: Limits
description: Every platform limit seaway designs around, the setting that holds it, and what happens when a statement reaches it.
---

These follow Archil's documented limits, except calls at once: Archil allows hundreds by default, and 64 is seaway's own cap. The local backend imposes the same limits, so code that runs locally meets them before it goes live. It has no checkouts, so it never waits for one.

## The limits

| Limit | Value | `Limits` field | What happens at it |
|---|---|---|---|
| A compiled command | 100 KiB | `max_command_bytes` | `ValidationError` with `command_too_large`, before anything is sent |
| Output, per stream | 4 MiB | `max_output_bytes` | the first bytes are kept, the stream ends in `[output truncated]`, and `result.truncated` is true |
| Time, per call | 5 minutes | `exec_timeout_s` | exit 124, and `Exec timed out` in stderr |
| Calls at once | 64 | `max_parallel` | a mapped statement with more shards keeps 64 running until all are done |
| One append | 1 MiB | `append_max_bytes` | a log splits its appends to fit. One record over the limit is `record_too_large`. A direct `ctx.append` over it is `invalid` |
| Search results | 1,000 | `grep_max_results` | the search stops, and `result.value` says so. `max_results` on the statement overrides it |
| The wait for an `owned` mount's checkout | 5 seconds | `checkout_queue_ms` | exit 30 |

In TypeScript the fields are camel case: `maxCommandBytes`, `maxOutputBytes`, `execTimeoutS`, `maxParallel`, `appendMaxBytes`, `grepMaxResults`, `checkoutQueueMs`.

A backend's limits are at `backend.limits`. To change one, give the backend a `Limits` of your own:

```py
tight = archil.LocalBackend(
    root,
    limits=archil.Limits(max_parallel=8, exec_timeout_s=60.0),
)
```

```typescript
const tight = new archil.LocalBackend({
  root,
  limits: new archil.Limits({ maxParallel: 8, execTimeoutS: 60 }),
});
```

Raising a limit above what Archil allows does not change what Archil allows. On Archil the time limit and the search limit are the platform's own: a `Limits` given to `ArchilBackend` changes what seaway checks and plans around, such as the command size and how many calls run at once.

## Thresholds the planner uses

Not platform limits, but numbers that decide what a plan looks like.

| Threshold | Value | Decides |
|---|---|---|
| Bytes per shard | 256 MiB | how many shards a mapped statement gets when `shards` is left out. Also when a plan suggests `.map()` |
| Files per shard | 2,000 | the same, by file count. Whichever asks for more shards wins |
| The default VM | 2 vCPU, 4 GiB | one call unit. A larger VM bills as a multiple |
| The active window | 1 hour | how long a touched byte is billed as active |
| A statement in the journal | 240 characters | where the recorded template is cut |
| A tool's output | 12,000 characters | where a tool from `ctx.tools()` cuts what it returns to a model |
| A version's age | about 1.5 seconds | on Archil, how old a file's version has to be before it is trusted |

## Exit codes

A command's own exit code is passed through. Three are also used for failures that are not the command's, the same way on both backends.

| Exit | Meaning | Do |
|---|---|---|
| 1 | with `mount failed: …` in stderr: a mount could not be made; or the command was over the size limit | check the path. A directory has to exist before it is mounted read-only |
| 30 | the checkout of an `owned` mount was not granted in time. With symlink mounts locally, also a write detected on a read-only mount | retry; or declare the write with `ctx.out` |
| 124 | the command ran past the time limit | split the work with `.map()`, or give the VM more with `sized()` |
| 127 | the shell could not find a program | install it locally. On Archil, put it on a disk and call it by its path there. `tools` names one program only: `duckdb`, for `ctx.sql` |

## Names

| What | Rule |
|---|---|
| A mount name | one path segment. Not `.px`, and in TypeScript not `__proto__` |
| A path | starts with a mount name. A leading slash is dropped. `..` is refused, with `bad_path` |
| A checkpoint, fork, lock or turn name | new on its disk. Letters, digits, `-` and `_` |
| A log writer | ASCII letters, digits, `_`, `.` and `-`. Anything else becomes `-` |
| A `Records` file name | the key, with characters other than letters, digits, `-`, `_` and `.` replaced by `-`, then `.md` |
