---
title: Backends
description: Reference for LocalBackend and ArchilBackend, the interface a backend of your own provides, and the Limits, MountSpec and Vm that plans are made of, in Python and TypeScript.
---

A backend provides the small set of operations everything compiles to. The guides are [Local and Archil backends](/guides/backends/) and [Run on Archil](/guides/archil/).

## LocalBackend

Disks are directories, and exec is local bash. No account.

```py
archil.LocalBackend(root=".archil-local", *, isolation="auto",
                    verify_read_only=True, limits=Limits(), name="local",
                    inside_archil=True, capabilities=...)
```

```typescript
new archil.LocalBackend({
  root, isolation, verifyReadOnly, limits, name, insideArchil, capabilities,
})
```

| Python | TypeScript | Default | Meaning |
|---|---|---|---|
| `root` | `root` | `.archil-local` | where the disks are kept: `<root>/disks/<disk>/` |
| `isolation` | `isolation` | `"auto"` | `"namespace"`, `"symlink"`, or `"auto"` to use a mount namespace where one is available |
| `verify_read_only` | `verifyReadOnly` | `true` | with symlink mounts, detect a write to a read-only mount after the command |
| `limits` | `limits` | Archil's | the [limits](/reference/limits/) it imposes |
| `name` | `name` | `"local"` | shown in `describe()` |
| `inside_archil` | `insideArchil` | `true` | reads are not counted as egress |
| `capabilities` | `capabilities` | all four | which of `checkpoint`, `branch`, `grep`, `share` it offers |

In Python the root is the first argument. In TypeScript every option is in one object.

`backend.exec_log` (`backend.execLog`) lists every exec the backend ran: its mounts and its command. It is handy in a test.

## ArchilBackend

Sends the same plans to Archil, through the official SDK: `archil` on PyPI, `disk` on npm. The official package is loaded only when this backend is used.

```py
archil.ArchilBackend(client=None, *, api_key=None, region=None,
                     inside_archil=False, limits=Limits(),
                     name="archil", exec_timeout_s=330.0, capabilities=...)
```

```typescript
new archil.ArchilBackend({
  client, apiKey, region, insideArchil, limits, name, capabilities,
})
```

| Python | TypeScript | Default | Meaning |
|---|---|---|---|
| `client` | `client` | made from the key and the region | an official client of your own |
| `api_key` | `apiKey` | `ARCHIL_API_KEY` | the key |
| `region` | `region` | `ARCHIL_REGION` | the region, such as `aws-us-west-2` |
| `inside_archil` | `insideArchil` | `false` | set it when the caller runs inside Archil, so reads are not counted as egress |
| `limits` | `limits` | Archil's | the [limits](/reference/limits/) the planner designs around |
| `name` | `name` | `"archil"` | shown in `describe()` |
| `exec_timeout_s` | | `330.0` | Python only: the client's request timeout, set a little above the five minutes a call may run |

The official client is at `backend.client` in Python and `await backend.client()` in TypeScript, for what seaway does not wrap, such as deleting a disk. Without the official package installed, using this backend raises `NotSupported`.

## What a backend is

| Python | TypeScript | Is |
|---|---|---|
| `backend.name` | `backend.name` | its name |
| `backend.limits` | `backend.limits` | a `Limits` |
| `backend.inside_archil` | `backend.insideArchil` | `false` when the caller is outside Archil, and reads pay egress |
| `backend.capabilities` | `backend.capabilities` | a set of `"checkpoint"`, `"branch"`, `"grep"`, `"share"` |
| `backend.checkpoint_calls` | `backend.checkpointCalls` | what one checkpoint bills as: `1` |
| `backend.version_granularity_s` | `backend.versionGranularityS` | how coarse a file's version is, in seconds: `0` locally, `1` on Archil |

## What a backend does

| Python | TypeScript | Does |
|---|---|---|
| `backend.resolve_disk(ref, create=False)` | `await backend.resolveDisk(ref, { create })` | a disk's name or id to a handle |
| `backend.exec(mounts, command, vm)` | `await backend.exec(mounts, command, vm)` | runs a command with a mount map. Returns an `ExecOutput` |
| `backend.grep(disk, directory, pattern, **opts)` | `await backend.grep(disk, directory, pattern, options)` | searches. Returns the hits, and why the search stopped |
| `backend.get(disk, key)` | `await backend.get(disk, key)` | reads an object |
| `backend.put(disk, key, data, if_absent=False)` | `await backend.put(disk, key, data, { ifAbsent })` | writes one |
| `backend.append(disk, key, data)` | `await backend.append(disk, key, data)` | appends to one |
| `backend.delete(disk, key)` | `await backend.delete(disk, key)` | removes a file, or a directory and everything under it |
| `backend.list(disk, prefix="", recursive=True)` | `await backend.list(disk, prefix, { recursive })` | lists objects: a list of `ObjectInfo` |
| `backend.head(disk, key)` | `await backend.head(disk, key)` | one object's `ObjectInfo`, or none |
| `backend.share(disk, key, expires_in)` | `await backend.share(disk, key, expiresIn)` | a link that expires |
| `backend.checkpoint(disk, name)` | `await backend.checkpoint(disk, name)` | takes a checkpoint. Returns its name |
| `backend.branch(disk, name, from_checkpoint, exist_ok=False)` | `await backend.branch(disk, name, fromCheckpoint, { existOk })` | makes a writable branch. Returns its handle |
| `backend.commit_lock(disk)` | `await backend.commitLock(disk)` | held while a turn validates and applies |

### A backend of your own

In Python, subclass `archil.Backend` and implement those methods. In TypeScript, any object that satisfies the `Backend` interface is one, `checkpointCalls` and `versionGranularityS` included.

- An operation the backend cannot do raises `NotSupported`, and its name is left out of `capabilities`.
- Turns, forks and locks need `"checkpoint"` and `"branch"`.
- `commit_lock` does nothing unless it is overridden. In Python it returns a context manager. In TypeScript it resolves to a function that releases the lock.
- A backend whose versions are coarser than its writes says so in `version_granularity_s`.

## Limits

The platform limits the planner designs around. [Limits](/reference/limits/) says what happens at each.

```py
archil.Limits(max_command_bytes=102400, max_output_bytes=4194304,
              exec_timeout_s=300.0, max_parallel=64,
              append_max_bytes=1048576, grep_max_results=1000, checkout_queue_ms=5000)
```

```typescript
new archil.Limits({
  maxCommandBytes, maxOutputBytes, execTimeoutS, maxParallel,
  appendMaxBytes, grepMaxResults, checkoutQueueMs,
})
```

## MountSpec

One disk as a single call sees it. Field for field, Archil's exec mount spec.

```py
archil.MountSpec(disk, subdirectory=None, read_only=False,
                 conditional=False, checkout_paths=(), queue_ms=None)
```

```typescript
new archil.MountSpec(disk, {
  subdirectory, readOnly, conditional, checkoutPaths, queueMs,
})
```

| Python | TypeScript | In JSON | Is |
|---|---|---|---|
| `disk` | `disk` | `disk` | the backend's handle for the disk |
| `subdirectory` | `subdirectory` | `subdirectory` | mount this directory of the disk |
| `read_only` | `readOnly` | `readOnly` | the call cannot write it |
| `conditional` | `conditional` | `conditional` | no checkout: a `shared` mount |
| `checkout_paths` | `checkoutPaths` | `checkoutPaths` | the paths a checkout covers. Empty means the mount root |
| `queue_ms` | `queueMs` | `queueMs` | how long to wait for a checkout |

`to_dict()` (`toJSON()`) gives the JSON, and `describe()` the text a printed plan shows in `scope`.

## Vm

The VM each call of a statement runs in.

```py
archil.Vm(vcpu=2, mem_mib=4096, image=None, egress=None)
```

```typescript
new archil.Vm({ vcpu, memMib, image, egress })
```

| Python | TypeScript | In JSON | Is |
|---|---|---|---|
| `vcpu` | `vcpu` | `vcpuCount` | vCPUs |
| `mem_mib` | `memMib` | `memSizeMib` | memory |
| `image` | `image` | `baseImage` | a custom base image |
| `egress` | `egress` | `network` | none: open. Empty: nothing leaves. Hosts: only these |

You rarely make one. `stmt.sized(...)` and `stmt.egress(...)` do.

## What comes back

| Type | Fields |
|---|---|
| `ExecOutput` | `exit_code`, `stdout`, `stderr`, `queue_ms`, `execute_ms`, `total_ms`, `truncated`. Camel case in TypeScript |
| `ObjectInfo` | `key`, `size`, `modified` (seconds since the epoch), `etag`, and `version` |
| `GrepHit` | `file`, `line`, `text` |
