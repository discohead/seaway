---
name: open
description: Open a seaway context in this session through the plugin's MCP server and show what is on it, so that it can be explored and worked on with plans and prices.
argument-hint: "[a manifest path, or mounts such as docs=handbook notes=my-notes:owned] [--archil] [--create] [--read-only]"
disable-model-invocation: true
---

# Open a context

The plugin's `context` MCP server holds one seaway context per session. Its tools are named `mcp__plugin_seaway_context__<tool>`: `open_context`, `describe_context`, `list_files`, `read_file`, `write_file`, `delete_file`, `explain_statement`, `run_statement`, the four turn tools, `append_log`, `poll_feed`, `ack_feed` and `refresh_view`.

## Steps

1. **Read the arguments.**
   - A path ending in `.json`, or any path that exists: a context manifest. Pass it as `manifest`.
   - `name=disk` or `name=disk:mode` pairs: mounts. `docs=handbook notes=my-notes:owned` is `{"docs": {"disk": "handbook"}, "notes": {"disk": "my-notes", "mode": "owned"}}`.
   - `--archil`: pass `backend: "archil"`. Without it, leave `backend` out: the server's own setting applies, which is local unless the user changed it.
   - `--create`: pass `create: true`, so that disks that do not exist are made.
   - `--read-only`: pass `read_only: true`.
   - Nothing: call `describe_context`. If a context is already open, show it. If none is, look for a context manifest in the project (a JSON file with `"archilContext": 0`) and offer to open it; otherwise ask what to mount.

2. **Before opening on Archil, be sure that is what is wanted.** `--archil` typed by the user is their say-so. Do not add it yourself. With `--archil --create`, name the disks that would be created in the account and confirm first.

3. **Open it** with `open_context`, and show what comes back as it is: the mounts and their modes, the backend, what is writable, the network policy and the budget.

4. **Look around,** cheaply: `list_files` on each mount (not recursive), and `read_file` on any `README.md` at the top of a mount or of a directory. Listings and reads use no compute. Summarise what is on each mount in a line or two.

5. **Say what can be done next,** in terms of this context: a question it could answer with `explain_statement` then `run_statement`, a turn for changes that belong together.

## Working in an open context

- `explain_statement` before `run_statement`, whenever it is not obvious what a statement will mount or cost.
- Pass what a statement touches as `{"path"}`, `{"glob"}`, `{"out"}` or `{"log"}` parameters. A statement with none mounts every disk.
- On the local backend a statement is bash on this machine, run as the user. On Archil it is a billed call against real disks.
- The session has a budget (25 cents unless changed). A statement that would pass it is refused before it runs; say so rather than working around it.
- A network policy of `deny` is the default. If a statement needs the network, set `egress` on that statement to the hosts it needs.

## If the tools are not there

The server needs Node 22.19 or later and has to find the seaway TypeScript SDK. Run `seaway-doctor`. The usual fixes: start Claude Code from inside a seaway checkout, or set the plugin's "seaway checkout" option (`claude plugin configure seaway`), then reconnect the server from `/mcp`.
