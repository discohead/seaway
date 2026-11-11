---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
description: In TypeScript a statement is a tagged template or takes named parameters; a call with a template literal pastes
tags: [typescript, statements]
---

TypeScript, with `import * as archil from "seaway"` and an open context `ctx` that has a read-only mount `docs`.

Write `async function wordCount(ctx: archil.Context, dir: string): Promise<number>` that returns the total number of words in every Markdown file under `docs/<dir>`, at any depth. `dir` is given by a user. Reply with the function only, plus a line on anything a reader should watch out for. Do not run anything.
