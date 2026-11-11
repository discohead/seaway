---
name: parity
description: In a seaway checkout, check that the Python and TypeScript SDKs are in step. Runs both test suites, the typecheck, a regeneration of the conformance fixture and the interop check, says what is out of step, and can port the difference.
argument-hint: "[check | port]"
disable-model-invocation: true
allowed-tools: Bash(seaway-doctor:*)
---

# Keep the two SDKs in step

Only for a checkout of seaway itself: `python/src/seaway`, `typescript/src`, `conformance/` and `interop/` side by side. If this is not one, say so and stop.

The `seaway:contributing` skill has the rules. The one that matters most: Python is the reference, so a difference is closed by changing the TypeScript, unless the Python is what is wrong.

## What is here

!`seaway-doctor`

If no report shows above, run `seaway-doctor`. Before going on, settle two things from it:

- **A Python 3.10 or later that imports seaway.** `interop/run.sh` and the generator run the `python3` on the PATH, so put the right one first (activate the virtual environment). If seaway is not installed, `PYTHONPATH=python/src` will do.
- **Nothing reaches an account.** Prefix every command below with `ARCHIL_BACKEND=local`. The suites pass their backends explicitly, but this costs nothing and rules it out.

## Check

Run these from the repository's root, and keep each one's result. Do not stop at the first failure: the pattern across them says where the difference is.

1. `git status --short`, so that what changes below can be told from what was already changed.
2. Python tests: `cd python && python -m pytest -q`.
3. The fixture: `python conformance/generate.py`, then `git diff --stat conformance/conformance.json`. No diff means the fixture already matches the Python.
4. TypeScript tests: `cd typescript && npm test`. Tests that need the official SDK are skipped unless `npm install` has been run.
5. The typecheck: `cd typescript && npm run typecheck`. It needs `npm install`; if `node_modules` is missing, say it was skipped rather than installing unasked.
6. Interop: `./interop/run.sh`. The last line is `PROBLEMS: 0` when the two agree.

Then say where things stand:

| What you see | What it means |
|---|---|
| everything passes, and the fixture did not change | in step |
| the fixture changed, and the TypeScript conformance test fails | the Python moved and the TypeScript has not followed. Port it |
| the fixture did not change, and the TypeScript conformance test fails | the TypeScript drifted. Fix the TypeScript |
| the Python tests fail | fix the Python first. Nothing downstream means anything until they pass |
| conformance passes and interop reports problems | the plans agree and the files do not: a format, a fingerprint or a version is written differently. Look in `compat.ts` |
| only the typecheck fails | types, not behaviour |

If the fixture changed, show the part of the diff that matters and say in a sentence what in the Python caused it. A diff nobody intended is a finding in itself.

## Port

With the argument `port`, or when the user says to go on:

1. Hand the work to the `seaway:sdk-porter` agent. Give it the Python diff (`git diff -- python/src`), the fixture diff, and the names of the failing TypeScript tests. It changes `typescript/src` and its tests, and nothing else.
2. Run the whole check again yourself. Do not take the agent's word that it passes.
3. Report what was ported, file by file, and anything it could not make match.

## Afterwards

- Leave `conformance/conformance.json` regenerated if the Python change was intended. If it was not, restore it: `git checkout -- conformance/conformance.json`.
- Update what the README and CONTRIBUTING.md state as fact: test counts, known limits, the table of files the framework writes.
- Do not commit. Say what is ready to be committed.
