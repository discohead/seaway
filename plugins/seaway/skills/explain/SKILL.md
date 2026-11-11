---
name: explain
description: Show the plan and the price of a seaway statement without running it. Says what the call would mount, how many calls it makes, what it reads and writes, what it costs, and what each of the plan's notes means for the code.
argument-hint: "[file:line, a function, or a statement]"
disable-model-invocation: true
---

# Explain a statement

Show what a seaway statement would do before it does it. The argument names the statement: a `file:line`, a function, or the statement itself. With no argument, take the statement under discussion, or the ones in the current changes.

**Nothing runs.** `explain()` compiles a statement and lists the files it names. It executes no command. Do not call `.run()`, do not `await` a statement, and do not use `--archil` or a live backend unless the user asks for live sizes.

## Steps

1. **Find the statement and its context.** Read how the code opens its context: the mounts and their modes, anything narrowed, the egress policy, the budget, the `tools` map. A plan depends on all of them.

2. **Get the plan.** Choose the first that fits.
   - *The plugin's MCP server has this context open:* call `explain_statement` with the statement as `{kind, template, params}`. Paths are `{"path"}`, `{"glob"}`, `{"out"}` or `{"log"}`; anything else is a value.
   - *The code can be imported without running it:* write a short script in the scratch directory that builds the same statement and prints `explain()`. Open the context on a `LocalBackend`. If the project keeps local disks (`.archil-local`), use that root so the sizes are real; otherwise use a temporary root and create the disks with `create=True`.
   - *Neither:* rebuild the context and the statement in a script from what the code says, the same way.

   Set `ARCHIL_BACKEND=local` on the command, so that nothing reaches an account by accident.

3. **Show the plan as printed,** in a code block, unedited.

4. **Say what it means,** line by line where it matters:
   - `scope`: what the call can see, and what it can change. Name any disk that is mounted and not needed.
   - the number of calls, and the reducer if it is split.
   - `price`: the estimate, and whether it is `(input size unknown)`.
   - each `note`, with the change it asks for written out as code.

5. **If it declares nothing,** write the version that passes its paths as parameters and show both plans, so the difference in scope and price is visible. If it is a plain `rg` or `grep`, show the `ctx.grep` form. If it reads more than about 256 MiB or 2,000 files in one call, show `.map(reduce=...)` with a reducer that is correct for that command.

6. **Leave the code alone** unless asked to change it.

On a temporary local root with no data, a plan shows the right scope and the wrong sizes: say so. The `seaway:sdk` skill's `plans-and-prices.md` explains every line of a plan and every note.
