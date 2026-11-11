---
title: Contributing
description: How to work on seaway itself. Setting up both SDKs, the order a change has to go in, the checks that keep the two SDKs one framework, and how to change these docs.
---

This is for people changing seaway itself. The full guide is [`CONTRIBUTING.md`](https://github.com/discohead/seaway/blob/main/CONTRIBUTING.md) in the repository. This page is the short form.

```text
python/        the Python SDK (the reference), its tests and examples
typescript/    the TypeScript SDK (a port), its tests and examples
conformance/   33 statements with the plans both SDKs must compile them to
interop/       a check that the two SDKs can work on the same disk, each way round
plugins/       a Claude Code plugin for working with seaway
docs/          this site
```

## The rule

**Python is the reference. TypeScript is a port of it.** A change in behaviour is made in the Python first. The fixture is then regenerated from the Python, and the TypeScript is changed until it reproduces the fixture. Never the other way round, and never by editing the fixture.

## Set up

Each block starts from the repository's root. Nothing here needs an Archil account.

```bash
# Python 3.10+; the package has no runtime dependencies
cd python
pip install -e '.[dev]'  # pytest, the official archil SDK, the duckdb CLI
python -m pytest -q      # the whole suite: 134 tests
```

```bash
# Node 22.19+, which runs .ts directly; there is no build step
cd typescript
npm install        # typescript, @types/node, and the official disk SDK
npm test           # 168 tests, plus one that needs zod
npm run typecheck  # tsc --noEmit
```

```bash
# rewrites conformance/conformance.json from the Python SDK
python conformance/generate.py
# both SDKs on one local root, each way round; prints PROBLEMS: 0
./interop/run.sh
# the plugin: linter, hooks, MCP server, and every example in its skills
node --test plugins/seaway/tests/
```

Things that catch people out:

- **Check which Python `python3` is.** The generator and the interop check run whatever is first on the PATH, and the SDK needs 3.10 or later. The `python3` that ships with macOS is older.
- **The SQL tests and examples need the `duckdb` CLI and `jq`** on the PATH. A test that cannot run is skipped, and says why.
- **On macOS the local backend mounts by symlink,** and the two tests that need a mount namespace are skipped.

## The order of a change

1. **Change the Python** in `python/src/seaway/`, with a test in `python/tests/`.
2. **Run the Python tests.**
3. **Regenerate the fixture** if anything a plan, a table or `describe()` shows could have changed. Read the diff of `conformance/conformance.json`. It should show what you meant to change, and nothing else.
4. **Port the change** to the twin file in `typescript/src/`, with its test in `typescript/test/`.
5. **Run the TypeScript tests and the typecheck.** The conformance test says, case by case, what does not match yet.
6. **Run the interop check.**
7. **Update the prose** that states a number or a behaviour: the README, the plugin's skills, and these docs. The examples in the skills and in these docs are run, so the checks say which ones no longer hold.

A change to an on-disk format, an error code or a plan's shape is a change to both SDKs and to every disk already written. Say so, and prefer adding to changing.

## What not to do

- Do not edit `conformance/conformance.json`, or change the TypeScript to behave differently from the Python and leave it there.
- Do not add a runtime dependency to either SDK. Both have none.
- Do not change a file format, a `.px/` path, an error code or a plan field in one SDK only.
- Do not write to `.archil/` on a disk.
- Do not let a test reach an account, or depend on the clock, the locale or the order of a directory listing.

## Keep tests off an account

The tests never need an account. They run on local backends in temporary directories, and the Archil backend is tested against a fake client that behaves the way the live service did.

With `ARCHIL_API_KEY` exported, anything that opens a context without a backend reaches the live account. The suites pass backends explicitly. A script of your own may not. `ARCHIL_BACKEND=local` forces the local one.

## These docs

The site is in `docs/`. It is [Astro](https://astro.build) with [Starlight](https://starlight.astro.build), and every page is a Markdown file under `docs/src/content/docs/`.

```bash
# Node 22.23.4+, which Astro needs
cd docs
npm install
npm run dev             # the site, at http://localhost:4321/seaway/
npm run check:examples  # run every example on the site, in both languages
npm run check:api       # check every API name in the docs against both SDKs
npm run check:types     # type-check the site's own code
npm run build           # build the site, then check every link in it
```

### Examples are run

A fenced block marked `python` or `ts` is an example. It is run as written, against the SDKs in this repository, on a local backend. The TypeScript is type-checked as well.

- **An example that imports seaway is a whole program,** and runs as it is.
- **Any other is a few lines** that use `archil`, `backend` and `ctx`. It runs pasted at the end of the setup on [The example context](/guides/example-context/), as a reader would run it, so it cannot declare a name the setup already has.
- **A block marked `continues`** is the next part of the program its page is building.
- **A block of output marked `output`** is checked, line by line, against what the Python example before it printed. `…` in a line stands for anything.
- **A block marked `py` or `typescript`** is there to be read: a signature, something that needs an account, something not to write. It is not run.

A Python example followed directly by its TypeScript twin is shown as one block with two tabs. Write both.

Keep code to 88 columns. That is what a block shows without scrolling, and the check fails a wider line. Output, plans and file contents are shown as they are, and wrap.

### Pages are also Markdown

Every page is published as Markdown beside its HTML, and listed in `llms.txt`. That is built from the same source, so there is nothing to keep in step. See [Docs for LLMs](/agents/llms/).

- Give every page a `title` and a `description`. The description is the sentence under the title, the line in `llms.txt`, and the search snippet.
- Write links from the root: `/guides/contexts/`.
- Add a new page to `docs/src/sidebar.mjs`. The build fails for a page that is not in it.

### How the docs are written

Plain English, short sentences, and the answer first. Say what a thing does before saying why. Prefer a table to a paragraph when there are three or more parallel facts, and an example to a description when there is anything to run.

## Send a change

Open an issue or a pull request at [github.com/discohead/seaway](https://github.com/discohead/seaway). Say what changed in behaviour, and whether it touches a plan, an error code or a file on disk.

A pull request is ready when the Python tests, the TypeScript tests and typecheck, the interop check, the plugin's tests and the docs' checks all pass, and the fixture's diff shows only what you meant.

seaway is released under the [MIT licence](https://github.com/discohead/seaway/blob/main/LICENSE).
