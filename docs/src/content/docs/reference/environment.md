---
title: Environment variables
description: What the SDKs, the local backend and the Claude Code plugin read from the environment, and what each variable does.
---

## The SDKs

Read when a context is opened without a `backend`, and when a backend is made without its options.

| Variable | Read by | Effect |
|---|---|---|
| `ARCHIL_API_KEY` | choosing a backend; `ArchilBackend` | with a key set, a context opened without a backend uses Archil |
| `ARCHIL_REGION` | `ArchilBackend` | the region, such as `aws-us-west-2` |
| `ARCHIL_BACKEND` | choosing a backend | `local` forces the local backend, even though a key is set |
| `ARCHIL_LOCAL_ROOT` | choosing a backend | where the local backend keeps its disks. `.archil-local` in the current directory when unset |
| `ARCHIL_LOCAL_ISOLATION` | `LocalBackend` | `namespace` or `symlink`, to force how the local backend mounts. It wins over the `isolation` option |

### Which backend a context gets

1. The `backend` argument, when there is one.
2. Otherwise Archil, when `ARCHIL_API_KEY` is set and `ARCHIL_BACKEND` is not `local`.
3. Otherwise the local backend, rooted at `ARCHIL_LOCAL_ROOT`, or `.archil-local`.

:::danger[An exported key sends a script to the live account]
A script that passes no backend acts wherever the environment points it. With `ARCHIL_API_KEY` exported, that is real disks and billed calls. Pass a `LocalBackend`, or set `ARCHIL_BACKEND=local`.
:::

To check what a context would get without opening one, run [`seaway-doctor`](/agents/lint/#seaway-doctor).

## The Claude Code plugin

The plugin's MCP server reads these, and its hooks the last, from the environment Claude Code was started in. The first four are set for you from the plugin's [options](/agents/claude-code/#options).

| Variable | Default | Effect |
|---|---|---|
| `SEAWAY_SDK` | a checkout, or an install, in or above the project | where the MCP server loads the TypeScript SDK from. The "seaway checkout" option |
| `SEAWAY_MANIFEST` | none | a manifest to open on first use. The "Context manifest" option |
| `SEAWAY_MCP_BACKEND` | `local` | `local` or `archil`: where contexts open when a call does not say. The "Backend" option |
| `SEAWAY_MCP_MAX_USD` | `0.25` | the most one session may spend. `none` lifts it. The "Session budget" option |
| `SEAWAY_MCP_EGRESS` | `deny` | `deny`, `allow`, or hosts separated by commas |
| `SEAWAY_MCP_READ_ONLY` | off | `1` opens every mount read-only |
| `SEAWAY_MCP_TRACE` | off | a file to append every message the server receives and sends to, for debugging |
| `SEAWAY_HOOK_TRACE` | off | a file to append a line to each time a hook fires, for debugging |

The MCP trace holds every message in full, what a statement printed included. Treat the file as you would the data. The hook trace holds the event, the tool's name and the plugin's options.

## The checks in the repository

| Variable | Read by | Effect |
|---|---|---|
| `SEAWAY_PYTHON` | the plugin's tests, and the check that runs these docs' examples | the Python to use. It has to be 3.10 or later. Unset, the first `python3` or `python` that qualifies |
| `SEAWAY_DOCS_SHOW` | the plugin's tests | `1` also prints what each example in the skills printed |

The plugin's tests and the docs' checks remove `ARCHIL_API_KEY` from their own environment and set `ARCHIL_BACKEND=local`. The Python and TypeScript suites pass a local backend, or a fake client, to everything they open. Neither can reach an account, whatever the shell holds.
