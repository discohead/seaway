---
title: Docs for LLMs
description: Every page of these docs is also published as Markdown, with an index a model can read first. How to copy a page, open it in a model, and point a coding agent at the whole site.
---

seaway is new, so a model knows nothing about it. These docs are published in a form a model can read: plain Markdown, at stable addresses, with an index.

## What is published

| Address | Is |
|---|---|
| [`/llms.txt`](/llms.txt) | the index: every page, with one line on what it covers, as links to Markdown |
| [`/llms-full.txt`](/llms-full.txt) | every page in one Markdown document, in reading order |
| `<page>index.md` | one page as Markdown. For this page, [`/agents/llms/index.md`](/agents/llms/index.md) |
| `<page>.md` | the same file under the other common address: `/agents/llms.md` |

```bash
curl -s https://discohead.github.io/seaway/llms.txt
curl -s https://discohead.github.io/seaway/guides/statements/index.md
```

Each HTML page also names its Markdown twin in its `<head>`, as `<link rel="alternate" type="text/markdown">`, so a crawler that has the page can find the text without guessing.

`llms.txt` follows [llmstxt.org](https://llmstxt.org): a title, a summary, a few notes on what is easy to get wrong, then the pages by section.

## The page menu

At the top of every page there is a **Copy page** button, with a menu beside it.

| Item | Does |
|---|---|
| Copy page | copies the page as Markdown, ready to paste into a model |
| View as Markdown | opens the page's `index.md` |
| Open in Claude | opens [claude.ai](https://claude.ai) with a prompt that names the page's Markdown |
| Open in ChatGPT | the same, in ChatGPT |
| Open in Claude Code | starts a Claude Code session with the prompt filled in |
| Open in Codex | starts a Codex thread with the prompt filled in |
| Open in Cursor | starts a Cursor chat with the prompt filled in |

The last three hand the prompt to a desktop app, so they need the app installed. Each prompt asks the model to read the page's Markdown from this site, so it works where the model can fetch a URL.

## Point a coding agent at the docs

Paste this into the file your agent reads at the start of a session: `AGENTS.md`, `CLAUDE.md`, or a rules file.

```markdown
## seaway

This project uses seaway (https://github.com/discohead/seaway), a framework for Archil.
seaway is new and is not in your training data. It does not work like the libraries it resembles.

- Before writing or reviewing code that imports seaway, read https://discohead.github.io/seaway/llms.txt
  and then the page for the task. Every page is Markdown at `<page URL>index.md`.
- A path a statement touches is a parameter (`ctx.path`, `ctx.glob`, `ctx.out`, a log selection), and so
  is every value. Never build a command by pasting text into it.
- Nothing runs until `.run()` (in TypeScript, `await`). Read `.explain()` when reach or cost matters.
- Do not run anything against Archil unless asked. Pass a `LocalBackend`, or set `ARCHIL_BACKEND=local`.
```

For Claude Code there is more than a pointer: [the plugin](/agents/claude-code/) carries the API as skills, a linter that runs after each edit, and an MCP server.

## What the Markdown is

A page's Markdown is built from the same source as the page, when the site is built. It cannot drift from it.

- **It is the page.** The same headings, text, tables and examples.
- **Both languages are there.** Where the site shows a Python example and its TypeScript twin as two tabs, the Markdown has both, one after the other.
- **Links stay in Markdown.** A link to another page is the absolute address of that page's Markdown twin, so a reader that follows links never lands on HTML.
- **What only a browser can draw is put in words.** A note is a quotation that starts with its label. A printed plan is a `text` block. A diagram is its description.

## The examples are run

Every example in these docs is run as written, in both languages, on each change to the docs or to either SDK. The TypeScript is type-checked, and where a page shows what an example prints, that is checked against what it really printed.

So an example a model copies from here is one that ran. Three kinds of block are shown without being run: code that reaches Archil or a model provider, signatures in the [API reference](/reference/), and fragments that show what not to write. [The example context](/guides/example-context/) has the setup the short examples assume.

## Next

:::cards
- [The Claude Code plugin](/agents/claude-code/) Skills, a linter, agents and an MCP server.
- [Core concepts](/start/concepts/#what-to-get-right) The eleven things that are easy to get wrong.
- [API reference](/reference/) Every public name, in both languages.
:::
