---
name: new
description: Scaffold a new seaway project in Python or TypeScript. Writes a context, a first script that runs on a local backend, and a README with the layout, then runs it to show that it works.
argument-hint: "[name] [python|typescript]"
disable-model-invocation: true
allowed-tools: Bash(seaway-doctor:*)
---

# Start a seaway project

Scaffold a small, complete seaway program in the current directory and prove that it runs. Arguments, if any: a project name, and `python` or `typescript`.

## What is here

!`seaway-doctor`

If the block above shows no report, run `seaway-doctor` yourself and read it before going on.

## Steps

1. **Settle the name and the language.** The name is the first argument, else the directory's name, in lower case with hyphens. It becomes the context's name and the prefix of its disks. The language is the second argument; else what the project already uses (`pyproject.toml` or `requirements.txt` means Python, `package.json` or `tsconfig.json` means TypeScript); else ask.

2. **Do not overwrite.** If `app.py`, `app.ts` or `README.md` exists, choose another file name or ask. Never replace a file that was not made by this command.

3. **Find the SDK.** The report says whether seaway imports (Python) or where the TypeScript SDK is. If it is not there:
   - the plugin's "seaway checkout" option is `${user_config.sdk_path}` (empty when it was never set); use it if it names a checkout;
   - otherwise ask where the checkout is. Do not guess a path and do not install anything from the network unasked.

   Then make it importable, saying what you are about to run:
   - Python: `pip install -e <checkout>/python` into the project's environment. If there is no virtual environment, offer to make one rather than installing into the system Python. To try the scaffold before installing anything, `PYTHONPATH=<checkout>/python/src` is enough.
   - TypeScript: a `package.json` with `"type": "module"`, then `npm install <checkout>/typescript`. That installs it as a link, which matters: Node will not run TypeScript from a copy under `node_modules`.

4. **Write the files** from the templates, replacing every `__PLACEHOLDER__`:

   | Template | Becomes | Placeholders |
   |---|---|---|
   | `${CLAUDE_PLUGIN_ROOT}/templates/python/app.py` | `app.py` | `__NAME__`, `__SUMMARY__` |
   | `${CLAUDE_PLUGIN_ROOT}/templates/typescript/app.ts` | `app.ts` | `__NAME__`, `__SUMMARY__` |
   | `${CLAUDE_PLUGIN_ROOT}/templates/README.md` | `README.md` | `__NAME__`, `__SUMMARY__`, `__RUN__` (`python app.py` or `node app.ts`), `__RUNTIME__` (`Python 3.10 or later` or `Node 22.19 or later`) |

   `__SUMMARY__` is one sentence saying what the program is for. Add `.archil-local/` to `.gitignore`.

5. **Run it on the local backend**: `python app.py` or `node app.ts`. Never with `--archil` here. It should print the context, a plan that mounts one hour's directory of one disk read-only, the counts, `the report is fresh: True`, and what the run would have cost. If it fails, fix the cause; do not paper over it.

6. **Make it theirs.** The scaffold counts example events. If the user has said what they are building, design that with the `seaway:design` skill and replace the example with it: the disks and their modes, the layout, and the statements that answer their questions. Keep the shape of the scaffold: a `backend()` that is local unless asked, one function that opens the context, statements that declare their paths.

7. **Report** what was written, how to run it, and how to point it at Archil: `--archil`, with `ARCHIL_API_KEY` and `ARCHIL_REGION` set, creates the two disks in the account and bills per call.

Use the `seaway:sdk` skill for anything about the API. Its references are the authority, not memory.
