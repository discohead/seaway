---
title: Example programs
description: Three complete programs in the repository, each in Python and TypeScript. What each one shows, how to run it locally, and how to run it on Archil.
---

The repository carries three programs, each in both languages. They are the best long-form reference: every part of the framework appears in one of them, and each prints what it does.

| Example | Shows | Python | TypeScript |
|---|---|---|---|
| Quickstart | a context, a statement, a plan, a turn, narrowing | [`quickstart.py`](https://github.com/discohead/seaway/blob/main/python/examples/quickstart.py) | [`quickstart.ts`](https://github.com/discohead/seaway/blob/main/typescript/examples/quickstart.ts) |
| An agent's context | five disks under five rules; recipes, turns, forks, locks, tools | [`agent_context.py`](https://github.com/discohead/seaway/blob/main/python/examples/agent_context.py) | [`agent-context.ts`](https://github.com/discohead/seaway/blob/main/typescript/examples/agent-context.ts) |
| The Datadog afternoon | observability on a disk: ingest, triage, search, a report, an alert | [`datadog_afternoon.py`](https://github.com/discohead/seaway/blob/main/python/examples/datadog_afternoon.py) | [`datadog-afternoon.ts`](https://github.com/discohead/seaway/blob/main/typescript/examples/datadog-afternoon.ts) |

## Run them

Everything runs on a local backend, with no account. Each run uses a temporary directory of its own.

```bash
git clone https://github.com/discohead/seaway && cd seaway
```

```bash
cd python
pip install -e '.[dev]'                 # Python 3.10+; brings pytest and the duckdb CLI
python examples/quickstart.py
python examples/agent_context.py
python examples/datadog_afternoon.py    # needs the duckdb CLI and jq
```

```bash
cd typescript
npm install                             # Node 22.19+, which runs .ts directly
node examples/quickstart.ts
node examples/agent-context.ts
node examples/datadog-afternoon.ts      # needs the duckdb CLI and jq
```

## An agent's context

Five kinds of data under five rules: what the organisation knows how to do (`frozen` at a release), reference data from a tracker (`read`), the agent's own memory (`owned`), notes a team shares (`shared`), and a record of what was done (`append`).

It runs two agents from the same starting state against a shared note:

```text
agent-8 commits: ['team/standup.md']
agent-7 conflicts on: ['team/standup.md'] and its memory is untouched: True
after the retry: ['- agent-8: rewrote the file', '- agent-7: ENG-1 is done']
```

Agent 7 lost. Its write to its own memory disk was not applied either, because the turn is the unit. It ran the turn again from the new state and committed.

The same program syncs a tracker through a [recipe](/guides/recipes/), [forks](/guides/checkpoints/) the context for three attempts, [locks](/guides/checkpoints/) it for a replay, and [narrows](/guides/narrowing/) it for a helper. The [agent's context blueprint](/blueprints/agent-context/) is the short form.

## The Datadog afternoon

Observability on a disk. It follows Archil's [Agentic observability](https://docs.archil.com/guides/agents/agentic-observability) guide (the same two disks, the same hourly layout), so the two can be read side by side.

| Piece | Is |
|---|---|
| Ingest | services appending JSON lines. There is no collector, and no compute |
| Triage | one `sql` statement comparing the last fifteen minutes with the hour before |
| Search | `ctx.grep(...)`: one call |
| The question nobody planned for | a `jq` pipeline, mapped across four calls and summed |
| A report | a view. Refresh it twice and the second does nothing |
| An alert | a feed. When nothing has changed, the poll makes no call |
| The agent's own telemetry | a journal on its own disk: one line per statement, with its plan, its reads and writes, and its cost |

The whole example is six statements over about thirteen thousand log lines. It comes to nine calls:

```text
6 statement(s): 9 call unit(s) $0.00045, 1.5 MiB kept active <$0.00001, 0 B egress $0; total ≈ $0.00045
```

This is not Datadog: there is no UI, no alert routing, and no metrics or traces. The claim is narrower. The back end reduces to a layout and a handful of statements, and those are things an agent can write. The [observability blueprint](/blueprints/observability/) is the short form, and [Prices and budgets](/guides/prices/#what-a-workload-costs-in-a-month) works out what it costs in a month.

## Run them on Archil

Set `ARCHIL_API_KEY` and `ARCHIL_REGION`, then run any example with `--archil`:

```bash
python examples/datadog_afternoon.py --archil --cleanup
node examples/datadog-afternoon.ts --archil --cleanup
```

- Every disk an example names gets a prefix that is new for the run (`px-` and six hex characters), so an example never opens a disk that is already in your account.
- It prints the disks it created.
- `--cleanup` deletes them when it ends, and with them the branches and checkpoints the run left.
- A run costs a fraction of a cent.

The same pattern suits your own tests against Archil: a fresh prefix per run, and delete the disks afterwards. [Run on Archil](/guides/archil/) has what else changes.

## Check the SDKs themselves

```bash
(cd python && python -m pytest -q)  # 134 tests
(cd typescript && npm test)         # 168 tests, plus one that needs zod
./interop/run.sh                    # both SDKs, one disk, each way; prints PROBLEMS: 0
```

None of these needs an account. [Two SDKs, one framework](/architecture/two-sdks/) explains what the last one checks.
