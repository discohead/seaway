---
name: setup
description: Get this machine ready for seaway after the plugin is installed. Finds a checkout of the seaway repository or clones one, points the plugin's MCP server at it, checks that it is found, and offers to install what else is missing, such as DuckDB and jq.
argument-hint: "[path to a checkout]"
disable-model-invocation: true
allowed-tools: Bash(seaway-doctor:*)
---

# Set up seaway

The plugin does not carry the SDKs. Installed from GitHub it has the skills, the agents, the linter and the hooks, and an MCP server with nothing to load. This command finds a checkout of the seaway repository, points the plugin at it, and offers to install what else is missing. The argument, if any, is the path of a checkout.

## What is here

!`seaway-doctor`

If the block above shows no report, run `seaway-doctor` yourself and read it before going on.

The plugin's "seaway checkout" option is `${user_config.sdk_path}` (empty when it was never set). A `seaway-doctor` run from a shell does not see that option, so its node line can say NOT FOUND when the option is already right.

## Steps

1. **See whether there is anything to do.** The MCP server is already served when either is true:
   - the report's node line says `TypeScript SDK at …`: the project is a checkout, is inside one, or installed seaway;
   - the option names a directory that has `typescript/src/index.ts`.

   Then say so, and go to step 5.

2. **Find a checkout.** A checkout is a directory with `typescript/src/index.ts` and `python/src/seaway/` in it. Take the first of these that is one:
   - the argument;
   - the option, when it is set;
   - the copy Claude Code cloned when the marketplace was added. `claude plugin marketplace list --json` lists the marketplaces: take the `installLocation` of the entry whose `repo` is `discohead/seaway`, or whose `name` is `seaway`. A marketplace added with `--sparse` has no SDK in it, so check for the files;
   - a place the user names. Ask whether they already have a checkout.

   If there is none, offer to clone one, and say the command before running it:

   ```bash
   git clone https://github.com/discohead/seaway <directory>
   ```

   Ask where. `~/seaway` is a fair suggestion. Never clone into a directory that exists and is not empty.

   **About the marketplace's copy.** Claude Code owns it, and updates it when the marketplace is updated, which keeps the SDK at the plugin's version. Loading the SDK from it is all the MCP server needs. Do not edit it, and do not run `npm install` or `pip install -e` inside it. A user who will change seaway, or install it into projects of their own, should have a clone of their own: ask which they want when it matters.

3. **Point the plugin at it**, with the checkout's absolute path:

   ```bash
   printf '{"sdk_path": "%s"}' "/absolute/path/to/seaway" | claude plugin configure seaway --values-stdin
   ```

   Options left out keep their values. `claude plugin configure seaway` then shows what is set. If the command is refused, the user can set "seaway checkout" themselves with `claude plugin configure seaway`: give them the path.

   This is not needed when the project is itself a checkout or sits inside one. The server looks there first.

4. **Check that it is found.** Run the doctor with the path it will be given:

   ```bash
   SEAWAY_SDK="/absolute/path/to/seaway" seaway-doctor
   ```

   The node line should say `TypeScript SDK at /absolute/path/to/seaway/typescript/src/index.ts`. If Node is older than 22.19, the server cannot load it whatever the path: say so, and that this is the user's to upgrade.

   The MCP server reads the option when it starts. Tell the user to reconnect it (`/mcp`) or start a new session. After that, `describe_context` says which SDK it loaded.

5. **Offer what else is missing.** Go by the report. List everything first, each with its one command, and ask once which to run. Run only what the user agrees to.
   - `duckdb` missing: `ctx.sql` cannot run locally. `brew install duckdb`, or `pip install duckdb-cli` into the project's environment.
   - `jq` missing: the examples and most statements over JSON lines use it. `brew install jq`, or the system's package manager.
   - Python older than 3.10, or none: the Python SDK needs 3.10 or later. Which Python to install, and how, is the user's choice: say what is needed and leave it.
   - seaway does not import, and the project is going to use the Python SDK: `pip install -e <checkout>/python` into the project's virtual environment. If there is none, offer to make one rather than installing into the system Python.
   - The project is going to use the TypeScript SDK: `npm install <checkout>/typescript`, which installs it as a link.
   - The official SDKs (`archil`, `disk`) are needed only to reach Archil. Do not install them here unless asked.

   A project that does not exist yet needs none of the last three: `/seaway:new` does them when it scaffolds one.

6. **Report** in a few lines: where the checkout is, what the option is now, what was installed, and what is still missing. Then what to do next: `/seaway:new` to start a project, `/seaway:open` to open a context once the server has been reconnected, `/seaway:doctor` to see the state of things again.

## What not to do

- Do not install or clone anything the user has not agreed to in this session.
- Do not set `ARCHIL_API_KEY`, and do not run anything with `--archil`. Setup is local.
- Do not change the plugin's other options. The backend stays `local` unless the user changes it.
- Do not guess a path. A path that is not a checkout is worse than an empty option, because the server then looks nowhere else.
