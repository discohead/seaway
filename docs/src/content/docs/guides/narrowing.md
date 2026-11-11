---
title: Limit reach, network and spend
description: Before you hand a context to a sub-agent or a model, shrink it. narrow limits what it can reach, an egress policy limits where its commands can send data, and a budget limits what it can spend.
sidebar:
  label: Limit reach and spend
---

A model's commands are not trusted. What they can reach is decided by the context they run in, so hand over less than you have. There are three limits, and each returns a new context.

::example-context

```python
helper = (
    ctx.narrow("docs/security", "memory/notes")  # only these sub-trees, same path names
       .with_egress("deny")                      # its commands cannot reach the network
       .with_budget(max_usd=0.02)                # and it cannot spend more than this
)
print(helper.describe())
```

```ts
const helper = ctx
  .narrow(["docs/security", "memory/notes"])  // only these sub-trees, same path names
  .withEgress("deny")                         // its commands cannot reach the network
  .withBudget({ maxUsd: 0.02 });              // and it cannot spend more than this
console.log(helper.describe());
```

```text output
context "context" on local
  docs/security/  read    handbook
  memory/notes/   owned   agent-memory
Paths are <mount>/<path>. read/ls/write/append are direct; sh/grep/sql run next to the data and bill per call (≈ $0.00005). explain() prices a statement first.
Commands run with egress denied.
```

## Reach

`narrow` returns a context that reaches only the given sub-trees. Paths keep their names, so a prompt written for the full context still reads correctly. It can only take access away.

```python
reader = ctx.narrow("docs/security", "memory/notes", read_only=True)
# only what is under those two directories
print(reader.sh("find -L . -type f").run().text)

for path in ("docs/onboarding.md", "team/standup.md"):
    try:
        reader.read_text(path)
    except archil.ValidationError as e:
        print(path, "->", e.code)
```

```ts
const reader = ctx.narrow(["docs/security", "memory/notes"], { readOnly: true });
// only what is under those two directories
console.log((await reader.sh`find -L . -type f`.run()).text);

for (const path of ["docs/onboarding.md", "team/standup.md"]) {
  try {
    await reader.readText(path);
  } catch (e) {
    if (!(e instanceof archil.ValidationError)) throw e;
    console.log(path, "->", e.code);
  }
}
```

```text output
./docs/security/keys.md
./memory/notes/eng-1.md

docs/onboarding.md -> out_of_scope
team/standup.md -> unknown_mount
```

- **Mounts that no path names are dropped.** With several paths on one mount, the mount is narrowed to the deepest directory that contains them all.
- **`read_only=True` forces every remaining mount read-only.** Its mode then reads as `read`. A `frozen` mount stays `frozen`.
- **With no paths, nothing is dropped.** `ctx.narrow(read_only=True)` keeps every mount and only makes them read-only.
- **A path outside the narrowed tree is an error:** `out_of_scope` on a mount that was kept, `unknown_mount` on one that was dropped.
- **A narrowed directory has to exist before a command runs.** A narrowed mount is a subdirectory mount, and a read-only one cannot be made of a directory that is not there. The call comes back with exit 1 and `mount failed`.

### What enforces it

Inside a call the boundary is the mount map. A disk that is not in it does not exist in the VM, and a narrowed mount is a subdirectory mount.

For direct reads and writes, the SDK checks paths itself, because Archil credentials cover a whole disk. So the holder of the context is trusted, and the commands it runs are not. That is the right way round for a harness that holds the context and lets a model issue commands.

## The network

A mount map limits what a command can read. It does not limit where the command can send it. On Archil a command has the whole internet unless it is given a policy.

```python
# nothing leaves
offline = ctx.with_egress("deny")
# only these hosts
pypi = ctx.with_egress(["pypi.org", "files.pythonhosted.org"])
# for a single statement
one = ctx.sh("curl -fsS https://example.com").egress(["example.com"])

print(offline.describe().splitlines()[-1])
print(one.explain())
```

```ts
// nothing leaves
const offline = ctx.withEgress("deny");
// only these hosts
const pypi = ctx.withEgress(["pypi.org", "files.pythonhosted.org"]);
// for a single statement
const one = ctx.sh`curl -fsS https://example.com`.egress(["example.com"]);

console.log(offline.describe().split("\n").at(-1));
console.log(String(await one.explain()));
```

```plan output
Commands run with egress denied.
plan 4c68b785c2d1  sh · 1 call
  route   exec · 2 vCPU / 4 GiB · egress only to example.com
```

- `"deny"`: nothing leaves. A list of hosts: only those. `"allow"`: open, which is Archil's default.
- A statement's own `.egress(...)` overrides its context's policy for that call.
- The statements in a `batch` run in one VM, so they share one policy. Set it on the batch or on the context.
- The policy is written to the [manifest](/guides/manifests/), and shown in the `route` line of every plan that runs a command. A `grep` runs no command of yours and carries no policy.

:::caution[Where the policy is enforced]
Archil enforces an egress policy, and takes one on the Developer plan and above. The local backend can only cut the network entirely, and only where it runs calls in a namespace, which is most Linux hosts. With symlink mounts, macOS included, the network stays open.
:::

Hand a model the tools of `ctx.with_egress("deny")` unless its commands need the network. Then prefer a list of hosts.

## Spend

Every plan carries a price, so a ceiling can be checked before anything runs.

```python
capped = ctx.with_budget(max_usd=0.01, max_calls=50)
try:
    # one statement can carry a tighter ceiling
    capped.sh("ls").within(max_usd=0.00001).run()
except archil.BudgetExceeded as e:
    print(e)
# 0: the statement was refused, so nothing was sent
print(capped.spent_under_budget().calls)
```

```ts
const capped = ctx.withBudget({ maxUsd: 0.01, maxCalls: 50 });
try {
  // one statement can carry a tighter ceiling
  await capped.sh`ls`.within({ maxUsd: 0.00001 }).run();
} catch (e) {
  if (!(e instanceof archil.BudgetExceeded)) throw e;
  console.log(String(e));
}
// 0: the statement was refused, so nothing was sent
console.log(capped.spentUnderBudget().calls);
```

```text output
budget_exceeded: plan exceeds budget: $0.00005 > $0.00001 — narrow the paths, use grep() for regex search, or raise the budget
0
```

- A budget has three limits, each optional: `max_usd`, `max_calls` (counted in call units) and `max_bytes_touched`.
- **The check is the plan's estimate plus what was spent under the budget.** Over the ceiling, `run()` raises `BudgetExceeded` and nothing is sent.
- **A budget counts from the moment it is set.** A helper handed a budgeted context is not charged for what its parent already did. It is charged for everything sent after that on the same ledger: by the helper, by its parent, and by any other context made from the parent. `with_budget(None)` removes the ceiling.
- `statement.within(...)` puts a ceiling on one statement, checked against that statement's plan alone. `explain()` is not affected: a plan can always be read.

`ctx.spend` is the ledger: what the context has sent so far. [Prices and budgets](/guides/prices/) explains what it counts.

## Put them together

For a model, build the tools from the shrunken context:

```python
agent = ctx.narrow("docs", "memory/notes").with_egress("deny")
agent = agent.with_budget(max_usd=0.05)
tools = agent.tools()
print([tool.name for tool in tools])
```

```ts
const agent = ctx
  .narrow(["docs", "memory/notes"])
  .withEgress("deny")
  .withBudget({ maxUsd: 0.05 });
const tools = agent.tools();
console.log(tools.map((tool) => tool.name));
```

```text output
['read_file', 'write_file', 'delete_file', 'list_files', 'grep', 'run_bash', 'sql', 'plan']
```

For attempts that should not see each other's writes, give each a [fork](/guides/checkpoints/) instead of a narrowing. For a run that must be repeatable, use a [lock](/guides/checkpoints/).

## Next

:::cards
- [Tools for a model](/guides/model-tools/) What each tool does, and a loop to run them in.
- [A helper that is handed less](/blueprints/helper/) The worked design, with a journal the helper cannot rewrite.
:::
