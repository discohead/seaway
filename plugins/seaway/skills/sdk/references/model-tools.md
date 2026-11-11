# A context as tools for a model

`ctx.tools()` turns a context into tools a model can call, with JSON schemas in Anthropic's and OpenAI's shapes. The set is small on purpose and uses the names Archil's own agent tools use, with two additions: `sql`, and `plan`, which prices a command and shows what it would be allowed to touch without running it.

## Contents

- [The tools](#the-tools)
- [Before you hand them over](#before-you-hand-them-over)
- [A loop](#a-loop)
- [What a tool returns](#what-a-tool-returns)
- [The official tool layer: asFileSystem](#the-official-tool-layer-asfilesystem)

## The tools

```python
tools = ctx.tools()
print([tool.name for tool in tools])
# ['read_file', 'write_file', 'delete_file', 'list_files', 'grep', 'run_bash', 'sql', 'plan']

by_name = {tool.name: tool for tool in tools}
print(by_name["list_files"](path="docs", recursive=True))      # a tool is called with the model's arguments
print(by_name["plan"](command="wc -l docs/*.md"))
print(by_name["read_file"].to_anthropic())                     # {'name', 'description', 'input_schema'}
print(by_name["read_file"].to_openai())                        # {'type': 'function', 'function': {...}}
```

```ts
const tools = ctx.tools();
console.log(tools.map((tool) => tool.name));

const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
console.log(await byName.list_files.call({ path: "docs", recursive: true }));
console.log(await byName.plan.call({ command: "wc -l docs/*.md" }));
console.log(byName.read_file.toAnthropic(), byName.read_file.toOpenAI());
```

| Tool | Arguments | What it does |
|---|---|---|
| `read_file` | `path` | reads a file as text. Direct: no compute |
| `write_file` | `path`, `content` | creates or replaces a file on a writable mount |
| `delete_file` | `path` | deletes a file, or a directory and what is under it |
| `list_files` | `path`, `recursive` | lists a directory; directories end in `/`, files come with their size. An empty path lists the mounts |
| `grep` | `pattern`, `path`, `ignore_case` | a regex search next to the data: one call per disk |
| `run_bash` | `command` | runs a bash command in a fresh VM with the context mounted at the working directory |
| `sql` | `query` | runs a DuckDB query over files in the context |
| `plan` | `command` | shows what a bash command would mount and cost, without running it |

- `write_file` and `delete_file` are left out when the context can write nothing: a model is not handed tools that could only fail.
- `ctx.tools(["read_file", "list_files", "grep"])` returns just the tools named.
- `read_file`'s description names the context's mounts and their modes, so build the tools from the context the model will really have.
- `run_bash` and `sql` take free text, so the statements they make declare nothing: each call mounts every disk the context has, in its own mode. That is what narrowing is for.

## Before you hand them over

A model's commands are not trusted. What they can reach is decided by the context the tools are built from, so shrink it first.

```python
agent = (
    ctx.narrow("docs", "memory/notes")       # only these sub-trees, under the same path names
       .with_egress("deny")                  # its commands cannot reach the network
       .with_budget(max_usd=0.05)            # and it cannot spend more than this
)
tools = agent.tools()
system = agent.describe()                    # a few lines a model can read: the mounts, their modes, how paths work
print(system)
```

```ts
const agent = ctx.narrow(["docs", "memory/notes"]).withEgress("deny").withBudget({ maxUsd: 0.05 });
const tools = agent.tools();
const system = agent.describe();
console.log(system);
```

- **Narrow.** `narrow(..., read_only=True)` for a reader. A sub-agent gets a slice; several attempts each get a `fork`.
- **Deny egress.** A mount map limits what a command can read, not where it can send it. Leave the network open only for a model whose commands need it, and then prefer a list of hosts.
- **Budget.** Every tool call that runs a statement is checked against the budget before it runs, and a refusal comes back to the model as text it can act on.
- **Journal.** Open the context with `journal=` and every statement the model runs is on record with what it read, wrote and cost, as long as the context the tools are built from can still append to the journal. A narrowed context writes the journal through itself, so keep the journal's directory in the narrowing, on an `append` mount. A context narrowed with `read_only=True` keeps no journal at all. See [contexts.md](contexts.md#the-journal).
- **A turn.** For changes that should land together, build the tools inside a turn (`turn.tools()`) and let it commit when the model is done. See [turns.md](turns.md).

## A loop

The tools are plain JSON-schema tools with their own handlers, so any tool-calling loop works. With the Anthropic SDK:

```py
import anthropic

client = anthropic.Anthropic()
tools = {tool.name: tool for tool in agent.tools()}
messages = [{"role": "user", "content": "Which policies mention API keys? Save a summary to memory/notes/keys.md."}]

while True:
    response = client.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=16000,
        output_config={"effort": "medium"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",                      # on a policy decline, the same call re-runs on a fallback model
        system=agent.describe(),
        tools=[tool.to_anthropic() for tool in tools.values()],
        messages=messages,
    )
    if response.stop_reason != "tool_use":
        break                                     # end_turn; or max_tokens / refusal, which the caller should check
    messages.append({"role": "assistant", "content": response.content})
    results = []
    for block in response.content:
        if block.type == "tool_use":
            text = tools[block.name](**block.input)             # never raises: an error comes back as "error: …"
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": text,
                            "is_error": text.startswith("error:")})
    messages.append({"role": "user", "content": results})       # every result, in one message

print(agent.spent_under_budget().usd)             # what the model's calls cost; agent.spend is the ledger it shares with ctx
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const tools = Object.fromEntries(agent.tools().map((tool) => [tool.name, tool]));
const messages = [{ role: "user", content: "Which policies mention API keys? Save a summary to memory/notes/keys.md." }];

while (true) {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: agent.describe(),
    tools: Object.values(tools).map((tool) => tool.toAnthropic()),
    messages,
  });
  if (response.stop_reason !== "tool_use") break;
  messages.push({ role: "assistant", content: response.content });
  const results = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    const text = await tools[block.name].call(block.input);
    results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: text.startsWith("error:") });
  }
  messages.push({ role: "user", content: results });
}
```

Model names and request options change faster than this file. Take them from the provider's current documentation when writing a real loop. What is seaway's here is the tools, `describe()` for the system prompt, and the context they are built from.

For OpenAI-style function calling, `tool.to_openai()` (`toOpenAI()`) gives the `{"type": "function", "function": {...}}` shape, and the arguments arrive as JSON to parse and pass the same way.

## What a tool returns

- **Always text, and it never raises.** A failure comes back as `error: <code> [<path>]: <message> — <suggestion>`, so the model can correct itself on the next step. Bad arguments come back as `error: bad arguments for <tool>: …`.
- **Long output is cut** at 12,000 characters, with a line saying how much more there was and to narrow the request or write the output to a file.
- `run_bash` returns `exit <code>`, then stdout, then `[stderr]` and stderr when there is any, and says when the output was cut.
- `sql` returns the rows as JSON, or `exit <code>` and stderr when the query failed.
- `grep` returns `file:line:text` lines, `(no matches)`, and a note when the search stopped early and the results are a sample.
- `list_files` returns one entry per line, a file as `path<TAB>size`, or `(empty)`.
- `plan` returns the printed plan.

## The official tool layer: asFileSystem

TypeScript only. `archil.asFileSystem(ctx)` gives a context the shape of the official `disk` package's `FileSystem`, so the official tools and the adapters built on them can be pointed at a composed context instead of one disk.

```ts
const fs = archil.asFileSystem(ctx.withEgress("deny"));
console.log(fs.diskNames());                                  // [ 'docs', 'logs', 'memory', 'team' ]
const listing = await fs.listObjects("docs/", { recursive: true });
console.log(listing.objects.map((o) => o.key));
const found = await fs.grep({ directory: "docs", pattern: "rotate", ignoreCase: true, recursive: true });
console.log(found.matches);
```

- Keys are context paths, `<mount>/<path>`. Every operation goes through the context, so its modes and narrowing apply: a write to a read-only mount is refused exactly as `ctx.write` refuses it.
- It has `getObject`, `putObject`, `deleteObject`, `listObjects`, `grep`, `exec` and `diskNames`.
- `listObjects` treats its prefix as a directory and reads `recursive` and `limit`. `grep` reads `directory`, `pattern`, `recursive`, `ignoreCase`, `globs` and `maxResults`.
- `exec` runs the command as written with every mount attached. The official `run_bash` tool begins its commands with `cd /mnt/archil`, which exists in an Archil call and not on the local backend.
- `createDiskTools` from `@archildata/ai-sdk` is typed to take a `Disk` or a `Workspace`, so TypeScript needs a cast to hand it this.
