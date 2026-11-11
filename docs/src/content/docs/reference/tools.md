---
title: Tools
description: Reference for ctx.tools and Tool, the eight tools a context becomes for a model, their arguments and what each returns, and asFileSystem for the official tool layer.
---

A context as tools a model can call. The guide is [Tools for a model](/guides/model-tools/).

## ctx.tools

```py
ctx.tools(names=None) -> list[Tool]
```

```typescript
ctx.tools(names?: string[] | null): Tool[]
```

With no names, returns every tool the context can use: the two write tools are left out when nothing is writable. With names, returns just those.

## The tools

| Name | Arguments | Required | Returns |
|---|---|---|---|
| `read_file` | `path` | `path` | the file as text |
| `write_file` | `path`, `content` | both | `wrote <path> (<n> bytes)` |
| `delete_file` | `path` | `path` | `deleted <path>` |
| `list_files` | `path`, `recursive` | none | one entry per line: a directory ending in `/`, a file as `path<TAB>size`. Or `(empty)` |
| `grep` | `pattern`, `path`, `ignore_case` | `pattern` | `file:line:text` lines, or `(no matches)`, and a note when the search stopped early |
| `run_bash` | `command` | `command` | `exit <code>`, then stdout, then `[stderr]` and stderr when there is any |
| `sql` | `query` | `query` | the rows as JSON, or `exit <code>` and stderr when the query failed |
| `plan` | `command` | `command` | the printed plan of that command. Runs nothing |

Every argument is a string, except `recursive` and `ignore_case`, which are booleans. Every schema has `additionalProperties: false`.

`run_bash` and `sql` take free text, so the statements they make declare nothing. Each call mounts every disk the context has.

## Tool

| Python | TypeScript | Is |
|---|---|---|
| `tool.name` | `tool.name` | the tool's name |
| `tool.description` | `tool.description` | what it does. `read_file`'s names the context's mounts and their modes |
| `tool.parameters` | `tool.parameters` | the JSON schema of its arguments |
| `tool(**args)` | `await tool.call(args)` | runs it with a model's arguments. Returns text. Never raises |
| `tool.to_anthropic()` | `tool.toAnthropic()` | `{name, description, input_schema}` |
| `tool.to_openai()` | `tool.toOpenAI()` | `{type: "function", function: {name, description, parameters}}` |

What calling a tool returns:

- **Always text.** A failure is `error: <code> [<path>]: <message> — <suggestion>`. Bad arguments are `error: bad arguments for <tool>: …`.
- **At most 12,000 characters of output.** Longer output is cut there, and a line says how much more there was.

## asFileSystem

TypeScript only. Gives a context the shape of the official `disk` package's `FileSystem`.

```typescript
archil.asFileSystem(ctx: Context): ContextFileSystem
```

Keys are context paths, `<mount>/<path>`. Every operation goes through the context, so its modes and narrowing apply.

| Method | Does |
|---|---|
| `getObject(key)` | reads a file |
| `putObject(key, body)` | writes one. Refused on a mount that cannot be written |
| `deleteObject(key)` | deletes one |
| `listObjects(prefix, options)` | lists a directory. Treats the prefix as a directory, and reads `recursive` and `limit` |
| `grep(options)` | searches. Reads `directory`, `pattern`, `recursive`, `ignoreCase`, `globs` and `maxResults` |
| `exec(command)` | runs a command as written, with every mount attached |
| `diskNames()` | the mount names |

The official `run_bash` tool begins its commands with `cd /mnt/archil`, which exists in an Archil call and not on the local backend. `createDiskTools` from `@archildata/ai-sdk` is typed to take a `Disk` or a `Workspace`, so TypeScript needs a cast to hand it this.
