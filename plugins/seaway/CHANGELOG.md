# Changelog

## 0.1.0

The first version, for seaway 0.1.0.

- Skills: `sdk`, `design` and `contributing`, which Claude uses by itself, and `setup`, `new`, `explain`, `review`, `port`, `cost`, `open`, `doctor` and `parity`, which you call.
- Agents: `reviewer`, `sdk-porter`, `cost-analyst` and `context-explorer`.
- `seaway-lint` (13 rules) and `seaway-doctor`, on the PATH while the plugin is enabled.
- Hooks: what a session should know about the project, a question before anything acts on the live account (a command with `--archil`, or the MCP server opening a context there), and a lint after an edit.
- The `context` MCP server: a seaway context as 16 tools, with plans and prices, local unless told otherwise.
- Templates for a new project in Python and TypeScript.
- Eight eval cases for `claude plugin eval`.
