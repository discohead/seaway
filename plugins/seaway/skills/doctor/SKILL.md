---
name: doctor
description: Check that this machine and this project are ready for seaway. Reports where a context would act (the local backend or the live Archil account), the Python and Node versions, whether the SDKs import, whether DuckDB and jq are installed, and what the local backend really enforces here.
disable-model-invocation: true
allowed-tools: Bash(seaway-doctor:*)
---

# seaway doctor

## The report

!`seaway-doctor`

If no report shows above, run `seaway-doctor` and use its output. It reads the environment and runs `--version` on what it finds. It contacts nothing and changes nothing.

## What to say

Give the user the state of things in order of what would stop them, not in the report's order.

1. **Where a context would act.** If the backend line says LIVE, say so first and plainly: a script that opens a context without a backend reaches the Archil account, creates and writes real disks, and bills per call. `ARCHIL_BACKEND=local` on a command forces the local backend; passing a `LocalBackend` in code does it for good.
2. **What is missing or too old,** each with the one command that fixes it:
   - Python older than 3.10, or none: the Python SDK needs 3.10 or later.
   - seaway does not import: `pip install -e '<checkout>/python[dev]'`, or `PYTHONPATH=<checkout>/python/src` to try it without installing.
   - Node older than 22.19: the TypeScript SDK, and this plugin's MCP server, need it.
   - The TypeScript SDK was not found: run Claude Code from a checkout, set the plugin's "seaway checkout" option, or `npm install <checkout>/typescript` in the project.
   - `duckdb` missing: `ctx.sql` cannot run locally. `pip install duckdb-cli` or `brew install duckdb`.
   - `jq` missing: the examples and most statements over JSON lines use it.
   - The official SDK (`archil`, `disk`) is needed only to reach Archil.
3. **What the local backend enforces here.** With symlink mounts: a write to a read-only mount is reported after the command, not refused; a network policy is not enforced; `find` and `du` need `-L`. Archil enforces all three, so a test that passes locally can still be refused there.
4. **Nothing to fix:** say that, in one line.

Do not install anything unless the user asks. When they do, say what the command will change first. `/seaway:setup` does the fixing: it finds or clones a checkout, points the plugin at it, and offers the rest. If the plugin's MCP server is in use, `describe_context` shows which SDK it loaded and what is open.
