---
title: Tools for a model
description: ctx.tools() turns a context into tools a model can call, with JSON schemas in Anthropic's and OpenAI's shapes. One of them prices a command before it runs.
---

`ctx.tools()` turns a context into tools a model can call. The set is small on purpose, and uses the names Archil's own agent tools use. There are two additions: `sql`, and `plan`, which shows what a command would mount and cost without running it.

::example-context

## The tools

```python
tools = ctx.tools()
print([tool.name for tool in tools])

by_name = {tool.name: tool for tool in tools}
# a tool is called with the model's arguments
print(by_name["list_files"](path="docs", recursive=True))
print(by_name["run_bash"](command="ls docs | wc -l").strip())
```

```ts
const tools = ctx.tools();
console.log(tools.map((tool) => tool.name));

const byName = new Map(tools.map((tool) => [tool.name, tool]));
// a tool is called with the model's arguments
console.log(await byName.get("list_files")?.call({ path: "docs", recursive: true }));
console.log(
  (await byName.get("run_bash")?.call({ command: "ls docs | wc -l" }))?.trim(),
);
```

```text output
['read_file', 'write_file', 'delete_file', 'list_files', 'grep', 'run_bash', 'sql', 'plan']
docs/expenses.md	50
docs/onboarding.md	53
docs/security/keys.md	71
exit 0
3
```

| Tool | Arguments | What it does |
|---|---|---|
| `read_file` | `path` | reads a file as text. Direct: no compute |
| `write_file` | `path`, `content` | creates or replaces a file on a writable mount |
| `delete_file` | `path` | deletes a file, or a directory and what is under it |
| `list_files` | `path`, `recursive` | lists a directory. Directories end in `/`, and files come with their size. An empty path lists the mounts |
| `grep` | `pattern`, `path`, `ignore_case` | a regex search next to the data: one call per disk |
| `run_bash` | `command` | runs a bash command in a fresh VM with the context mounted at the working directory |
| `sql` | `query` | runs a DuckDB query over files in the context |
| `plan` | `command` | shows what a bash command would mount and cost, without running it |

- `write_file` and `delete_file` are left out when the context can write nothing. A model is not handed tools that could only fail.
- `ctx.tools(["read_file", "list_files", "grep"])` returns just the tools named.
- `read_file`'s description names the context's mounts and their modes, so build the tools from the context the model will really have.

:::caution[`run_bash` and `sql` mount everything the context has]
They take free text, so the statements they make declare nothing. Each call mounts every disk the context has, in its own mode. That is what [narrowing](/guides/narrowing/) is for: the context you build the tools from is the limit.
:::

## Schemas

Each tool carries a JSON schema, in the two common shapes.

```python
read_file = next(tool for tool in ctx.tools() if tool.name == "read_file")
print(read_file.to_anthropic()["input_schema"])
print(list(read_file.to_openai()["function"]))
```

```ts
const readFile = ctx.tools().find((tool) => tool.name === "read_file");
console.log(readFile?.toAnthropic().input_schema);
console.log(Object.keys(readFile?.toOpenAI().function ?? {}));
```

```text output
{'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path'], 'additionalProperties': False}
['name', 'description', 'parameters']
```

| | Python | TypeScript | Shape |
|---|---|---|---|
| Anthropic | `tool.to_anthropic()` | `tool.toAnthropic()` | `{name, description, input_schema}` |
| OpenAI | `tool.to_openai()` | `tool.toOpenAI()` | `{type: "function", function: {name, description, parameters}}` |

## Before you hand them over

A model's commands are not trusted. What they can reach is decided by the context the tools are built from, so shrink it first.

```python
agent = (
    ctx.narrow("docs", "memory/notes")  # only these sub-trees, under the same paths
       .with_egress("deny")             # its commands cannot reach the network
       .with_budget(max_usd=0.05)       # and it cannot spend more than this
)
tools = agent.tools()
# a few lines a model can read: the mounts, their modes, how paths work
system = agent.describe()
print(system)
```

```ts
const agent = ctx
  .narrow(["docs", "memory/notes"])
  .withEgress("deny")
  .withBudget({ maxUsd: 0.05 });
const tools = agent.tools();
// a few lines a model can read: the mounts, their modes, how paths work
const system = agent.describe();
console.log(system);
```

```text output
context "context" on local
  docs/          read    handbook
  memory/notes/  owned   agent-memory
Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to the data and bill per call (≈ $0.00005). explain() prices a statement first.
Commands run with egress denied.
```

- **Narrow.** `narrow(..., read_only=True)` for a reader. A sub-agent gets a slice. Several attempts each get a [fork](/guides/checkpoints/).
- **Deny egress.** A mount map limits what a command can read, not where it can send it. Leave the network open only for a model whose commands need it, and then prefer a list of hosts.
- **Budget.** Every tool call that runs a statement is checked against the budget before it runs. A refusal comes back to the model as text it can act on.
- **Journal.** Open the context with `journal=` and every statement the model runs is on record with what it read, wrote and cost, as long as the context the tools are built from can still append to the journal. See [The journal](/guides/journal/#a-narrowed-context-writes-its-own-lines).
- **A turn.** For changes that should land together, build the tools inside a [turn](/guides/turns/) (`turn.tools()`) and let it commit when the model is done.

## A loop

The tools are plain JSON-schema tools with their own handlers, so any tool-calling loop works. This one uses the Anthropic SDK.

```py
import anthropic

client = anthropic.Anthropic()
tools = {tool.name: tool for tool in agent.tools()}
question = "Which policies mention API keys? Save a summary to memory/notes/keys.md."
messages = [{"role": "user", "content": question}]

while True:
    response = client.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=16000,
        output_config={"effort": "medium"},
        betas=["server-side-fallback-2026-07-01"],
        # on a policy decline, the same call re-runs on a fallback model
        fallbacks="default",
        system=agent.describe(),
        tools=[tool.to_anthropic() for tool in tools.values()],
        messages=messages,
    )
    if response.stop_reason != "tool_use":
        break   # end_turn; or max_tokens / refusal, which the caller should check
    messages.append({"role": "assistant", "content": response.content})

    results = []
    for block in response.content:
        if block.type == "tool_use":
            tool = tools.get(block.name)
            # never raises
            text = tool(**block.input) if tool else f"error: no tool named {block.name}"
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": text,
                "is_error": text.startswith("error:"),
            })
    # every result, in one message
    messages.append({"role": "user", "content": results})

print(agent.spent_under_budget().usd)   # what the model's calls cost
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const tools = new Map(agent.tools().map((tool) => [tool.name, tool]));
const question =
  "Which policies mention API keys? Save a summary to memory/notes/keys.md.";
const messages: Anthropic.Beta.BetaMessageParam[] = [
  { role: "user", content: question },
];

while (true) {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    // on a policy decline, the same call re-runs on a fallback model
    fallbacks: "default",
    system: agent.describe(),
    tools: [...tools.values()].map((tool) => ({
      ...tool.toAnthropic(),
      input_schema: { ...tool.parameters },
    })),
    messages,
  });
  // end_turn; or max_tokens / refusal, which the caller should check
  if (response.stop_reason !== "tool_use") break;
  messages.push({ role: "assistant", content: response.content });

  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    const tool = tools.get(block.name);
    const text = tool
      ? await tool.call(block.input as Record<string, unknown>)
      : `error: no tool named ${block.name}`;
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: text,
      is_error: text.startsWith("error:"),
    });
  }
  // every result, in one message
  messages.push({ role: "user", content: results });
}

console.log(agent.spentUnderBudget().usd);   // what the model's calls cost
```

What is seaway's here is the tools, `describe()` for the system prompt, and the context they are built from. The rest is the provider's:

- **Model names and request options change faster than this page.** Take them from the provider's current documentation when you write a real loop. This one was checked against `anthropic` 2.8 and `@anthropic-ai/sdk` 1.8.
- **Append the whole `response.content`,** not just its text, and return every tool result in one user message.
- **In TypeScript, spread the schema** as the example does. `toAnthropic()` returns seaway's own schema type, and the spread is what makes it fit the SDK's.

For OpenAI-style function calling, `tool.to_openai()` gives the function shape. The arguments arrive as JSON to parse and pass the same way.

## What a tool returns

- **Always text, and it never raises.** A failure comes back as `error: <code> [<path>]: <message> — <suggestion>`, so the model can correct itself on the next step. Bad arguments come back as `error: bad arguments for <tool>: …`.
- **Long output is cut** at 12,000 characters, with a line saying how much more there was, and to narrow the request or write the output to a file.

```python
by_name = {tool.name: tool for tool in ctx.tools()}
print(by_name["read_file"](path="reports/q3.md"))
print(by_name["write_file"](path="docs/onboarding.md", content="rewritten"))
```

```ts
const byName = new Map(ctx.tools().map((tool) => [tool.name, tool]));
console.log(await byName.get("read_file")?.call({ path: "reports/q3.md" }));
console.log(await byName.get("write_file")?.call({
  path: "docs/onboarding.md",
  content: "rewritten",
}));
```

```text output
error: unknown_mount [reports/q3.md]: no mount named 'reports' — paths start with a mount name: docs/…, logs/…, memory/…, team/…
error: read_only [docs/onboarding.md]: 'docs' is read; it cannot be written — mount the disk as 'owned' or 'shared' to write to it
```

| Tool | Returns |
|---|---|
| `run_bash` | `exit <code>`, then stdout, then `[stderr]` and stderr when there is any. It says when the output was cut |
| `sql` | the rows as JSON, or `exit <code>` and stderr when the query failed |
| `grep` | `file:line:text` lines, or `(no matches)`, and a note when the search stopped early and the results are a sample |
| `list_files` | one entry per line, a file as `path<TAB>size`, or `(empty)` |
| `plan` | the printed plan |
| `write_file`, `delete_file` | a line saying what was done |

Hand a model `plan` next to `run_bash`, and it can see what a command will cost before it runs it.

## The official tool layer

TypeScript only. `archil.asFileSystem(ctx)` gives a context the shape of the official `disk` package's `FileSystem`, so the official tools and the adapters built on them can be pointed at a composed context instead of one disk.

```ts
const fs = archil.asFileSystem(ctx.withEgress("deny"));
console.log(fs.diskNames());  // [ 'docs', 'logs', 'memory', 'team' ]

const listing = await fs.listObjects("docs/", { recursive: true });
console.log(listing.objects.map((object) => object.key));

const found = await fs.grep({
  directory: "docs",
  pattern: "rotate",
  ignoreCase: true,
  recursive: true,
});
console.log(found.matches.length);
```

- **Keys are context paths,** `<mount>/<path>`. Every operation goes through the context, so its modes and narrowing apply: a write to a read-only mount is refused exactly as `ctx.write` refuses it.
- It has `getObject`, `putObject`, `deleteObject`, `listObjects`, `grep`, `exec` and `diskNames`.
- `listObjects` treats its prefix as a directory and reads `recursive` and `limit`. `grep` reads `directory`, `pattern`, `recursive`, `ignoreCase`, `globs` and `maxResults`.
- `exec` runs the command as written, with every mount attached. The official `run_bash` tool begins its commands with `cd /mnt/archil`, which exists in an Archil call and not on the local backend.
- `createDiskTools` from `@archildata/ai-sdk` is typed to take a `Disk` or a `Workspace`, so TypeScript needs a cast to hand it this.

## Next

:::cards
- [Limit reach, network and spend](/guides/narrowing/) The three limits, in detail.
- [The Claude Code plugin](/agents/claude-code/) The same context, opened as MCP tools that keep their parameters.
- [Tools reference](/reference/tools/) `Tool`, its schema, and `asFileSystem`.
:::
