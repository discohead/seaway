---
title: Manifests
description: A manifest is a context as a small JSON document. Save one as an agent.json, hand it to another process, and open the same context again.
---

Because a context is a plain value, it has a plain form: a small JSON document with the disks, the modes, and what was narrowed. `manifest()` writes it and `from_manifest()` opens it.

::example-context

## Write one and open it again

```python
import json

manifest = ctx.with_egress("deny").manifest()
print(json.dumps(manifest, indent=2))

# a dict, a JSON string, or a path to a file
again = archil.from_manifest(manifest, backend=backend)
print(again.describe().splitlines()[-1])
```

```ts
const manifest = ctx.withEgress("deny").manifest();
console.log(JSON.stringify(manifest, null, 2));

// an object, a JSON string, or a path to a file
const again = await archil.fromManifest(manifest, { backend });
console.log(again.describe().split("\n").at(-1));
```

```json output
{
  "archilContext": 0,
  "name": "context",
  "mounts": {
    "docs": {
      "disk": "handbook",
      "mode": "read"
    },
    "logs": {
      "disk": "app-logs",
      "mode": "append"
    },
    "memory": {
      "disk": "agent-memory",
      "mode": "owned"
    },
    "team": {
      "disk": "team-notes",
      "mode": "shared"
    }
  },
  "egress": "deny"
}
Commands run with egress denied.
```

`from_manifest` takes the document itself, a JSON string, or a path to a file. Save the document as `agent.json` and the path opens it.

## A narrowed context keeps its limits

What `narrow` took away is written down, so a manifest can be handed to another process and open with the same reach.

```python
helper = ctx.narrow("docs/security", read_only=True)
print(helper.manifest()["mounts"])
```

```ts
const helper = ctx.narrow(["docs/security"], { readOnly: true });
console.log(helper.manifest().mounts);
```

```text output
{'docs': {'disk': 'handbook', 'mode': 'read', 'allow': 'security', 'readOnly': True}}
```

## The format

| Field | Meaning |
|---|---|
| `archilContext` | the format's version. It is `0` |
| `name` | the context's name |
| `mounts` | one entry per mount, by mount name |
| `journal` | optional: the path where every statement is recorded |
| `tools` | optional: where DuckDB is, as `{"duckdb": "memory/bin/duckdb"}` |
| `egress` | optional: `"deny"` or a list of hosts. Left out, the network is open |
| `locked` | only in a manifest returned by `lock()`: the name of the lock |

Each mount:

| Field | Meaning |
|---|---|
| `disk` | the disk's name or id. Required |
| `mode` | `read` when it is left out |
| `at` | the checkpoint of a `frozen` mount |
| `subdirectory` | mount this directory of the disk |
| `description` | a note |
| `allow` | the sub-tree the mount was narrowed to |
| `readOnly` | `true` when narrowing forced it read-only |

A document without `"archilContext": 0` is refused with `bad_manifest`.

## What it does not carry

A manifest describes the context, not the session that opens it. It has no `create`: the disks it names have to exist. And it has no budget, no price sheet and no backend. Those belong to whoever opens it:

```python
capped = archil.from_manifest(
    ctx.manifest(),
    backend=backend,
    budget=archil.Budget(max_usd=0.05),
)
print(capped.budget.max_usd)        # 0.05
```

```ts
const capped = await archil.fromManifest(ctx.manifest(), {
  backend,
  budget: { maxUsd: 0.05 },
});
console.log(capped.budget?.maxUsd); // 0.05
```

It can be written by anything that writes JSON. An agent with only bash can produce one.

## Where manifests turn up

- **`lock()`** returns a manifest in which every mount is `frozen`. Opening it gives the same bytes every time. See [Checkpoint, lock and fork](/guides/checkpoints/).
- **`fork()`** returns a context whose manifest names the fork's branches, so the manifest opens the fork and not the original.
- **The Claude Code plugin's MCP server** opens a context from a manifest. See [The MCP server](/agents/mcp-server/).

## Next

:::cards
- [Checkpoint, lock and fork](/guides/checkpoints/) Pin a context in time, or branch it.
- [What the framework writes](/architecture/files-on-disk/) Every file format, including this one.
:::
