# The Python API

The whole surface of `import seaway as archil`, as signatures. Python 3.10 or later; the package has no runtime dependencies. The source is the authority: `python/src/seaway/`, read in this order: `context.py`, `statement.py`, `plan.py`, `transaction.py`, `structures.py`, `recipes.py`, `tools.py`, `pricing.py`, then `backends.py`, `local.py`, `archil_backend.py`. Paths, globs and quoting are in `shell.py`, and the errors in `errors.py`.

Everything is synchronous. Options are keyword arguments. The [TypeScript API](typescript-api.md) has the same names in camel case.

## Contents

- [Composing](#composing)
- [Context](#context)
- [Statement, Result, Plan](#statement-result-plan)
- [Transaction](#transaction)
- [Log, View, Feed](#log-view-feed)
- [Recipes](#recipes)
- [Prices](#prices)
- [Tools](#tools)
- [Backends](#backends)
- [Errors](#errors)

## Composing

```py
archil.disk(ref, mode="read", *, subdirectory="", at=None, create=False, description="") -> Source
archil.context(mounts, *, backend=None, name="context", prices=None, budget=None,
               journal=None, tools=None, egress=None) -> Context
archil.from_manifest(manifest, *, backend=None, prices=None, budget=None) -> Context   # a dict, a JSON string, or a path
archil.MODES                                  # ("read", "frozen", "owned", "shared", "append")
archil.__version__
```

`mounts` maps a mount name to a `Source` from `archil.disk(...)`, or to a disk's name as a string, which is a `read` mount. `budget` is an `archil.Budget`.

## Context

```py
# what it is
ctx.name            ctx.backend         ctx.mounts          # {name: Mount}
ctx.prices          ctx.budget          ctx.egress          # None: open. (): nothing leaves. (hosts…): only these
ctx.journal         ctx.session         ctx.spend           # the Ledger
ctx.tools_map                                 # what was given as tools=; ctx.tools is the method below
ctx.describe() -> str                         # a few lines a model can read
ctx.manifest() -> dict
ctx.journal_pending -> int                    # journal entries not yet on the disk
ctx.spent_under_budget() -> Estimate          # what has been spent since the budget was set

# contexts made from it: each returns a new Context
ctx.narrow(*paths, read_only=False)
ctx.with_egress(egress)                       # "deny", "allow", or a list of hosts
ctx.with_budget(budget=None, **limits)        # Budget(...) or max_usd=, max_calls=, max_bytes_touched=; None removes it
ctx.mount(name, source)                       # one more mount, or one replaced
ctx.fork(name)                                # private branches of the owned and shared mounts

# paths, as statement parameters
ctx.path(path) -> Ref                         # a file or directory the command reads
ctx.glob(pattern) -> Glob                     # files that match; ** crosses directories, * does not
ctx.out(path) -> Ref                          # a path the command writes
ctx.expand(sel) -> list[FileStat]             # the files a path, glob or selection covers now; metadata only

# the data plane: direct, no compute
ctx.read(path) -> bytes
ctx.read_text(path) -> str
ctx.write(path, data, *, if_absent=False) -> str      # str or bytes; returns the path
ctx.append(path, data) -> str
ctx.exists(path) -> bool
ctx.rm(path) -> None                          # a file, or a directory and everything under it
ctx.ls(path="", *, recursive=False) -> list[FileStat] # directories end in "/"; "" lists the mounts
ctx.share(path, *, expires_in=86400) -> str   # a link; seconds

# statements: nothing runs until .run()
ctx.sh(command, **params) -> Statement
ctx.sql(query, **params) -> Statement
ctx.grep(pattern, over=None, **options) -> Statement  # ignore_case=False, globs=None, max_results=None, recursive=True
ctx.batch(statements) -> Statement

# time
ctx.checkpoint(name) -> dict[str, str]        # {mount: checkpoint}, for owned, shared and append mounts
ctx.lock(name) -> dict                        # a manifest with every mount frozen at that point
ctx.transaction(*, writes=None, reads=None, isolation="snapshot", name=None) -> Transaction

# structures
ctx.log(path, *, partition="hour", writer=None) -> Log
ctx.view(path, build, *, inputs=None) -> View
ctx.feed(path, *, cursor) -> Feed
ctx.sync(recipe, into) -> dict
ctx.tools(names=None) -> list[Tool]
```

```py
Mount:      name, source, handle, allow, read_only;  .mode  .writable  .appendable
Source:     disk, mode, subdirectory, at, create, description
Ref:        mount, rel, write;  .path;  ref / "sub"      # a path in the context
Glob:       mount, pattern;  .path
FileStat:   path, size, modified, version
archil.raw(text) -> Raw                       # text put into a command as written
```

## Statement, Result, Plan

```py
stmt.map(on=None, *, reduce="concat", shards=None) -> Statement     # sh only
stmt.into(path) -> Statement
stmt.sized(*, vcpu=None, mem_mib=None, image=None) -> Statement
stmt.egress(policy) -> Statement
stmt.within(budget=None, **limits) -> Statement
stmt.explain() -> Plan
stmt.run(*, check=False) -> Result

archil.REDUCERS                               # concat, lines, sorted, unique, count, sum, sum_by_key, json
```

```py
Result:  kind, exit_code, stdout, stderr, value, rows, paths, truncated, results, shards, plan, meta
         .ok  .text  .lines  .json()  .check()
Meta:    calls, call_units, usd, wall_ms, queue_ms, execute_ms;  .to_dict()
Plan:    kind, route, statement, tasks, vm, reads, writes, reduce, estimate, notes, files, parallel, unmounted, read_paths
         .hash  .to_dict()  str(plan)
Task:    command, mounts, label;  .to_dict()
```

`ctx.grep` takes its options as keywords and passes over one it does not know, so a misspelt option is ignored, not refused. `plan.reads` holds what the printed plan shows, such as `logs[last 15m]`. `plan.read_paths`, when it is set, holds the same reads as paths, and is what `to_dict()["effects"]["reads"]` reports.

## Transaction

```py
with ctx.transaction(writes=[...]) as turn:   # begins; commits at the end of the block; rolls back if it raises
    turn.write(...); turn.sh(...).run()       # turn has a context's verbs; turn.view is that context
    turn.view.view(path, build)               # so a view inside a turn is made through turn.view

tx = ctx.transaction(*, writes=None, reads=None, isolation="snapshot", name=None)
tx.begin() -> Transaction
tx.changes() -> dict[str, tuple[list[str], list[str]]]      # {mount: (written, deleted)}
tx.commit() -> Commit                         # raises Conflict
tx.rollback() -> None
tx.id   tx.state   tx.isolation   tx.view   tx.base   tx.write_roots   tx.read_roots

Commit:  id, applied, deleted, calls;  .empty
```

## Log, View, Feed

```py
log = ctx.log(path, *, partition="hour", writer=None)       # partition: "hour", "day", "none"
log.append(records, *, at=None) -> list[str]  # a dict or an iterable of dicts; returns the files written
log.last(span, *, now=None) -> Selection      # "30s", "15m", "2h", "7d", or a timedelta
log.between(start, end) -> Selection          # start <= ts < end
log.all() -> Selection
log.path   log.partition   log.writer

view = ctx.view(path, build, *, inputs=None)  # build: a Statement, or a function that returns one
view.refresh(*, force=False) -> Result | None # None when nothing ran
view.fresh -> bool                            # a property
view.read() -> bytes        view.read_text() -> str
view.share(*, expires_in=86400) -> str
view.fingerprint() -> str   view.statement() -> Statement   view.path

feed = ctx.feed(path, *, cursor)
changes = feed.poll() -> Changes
changes.added   changes.modified              # lists of FileStat
changes.removed                               # paths
changes.previous                              # {path: size before}, for modified files
changes.files   changes.refs()   changes.ack()
bool(changes)                                 # False when there is nothing to do
```

## Recipes

```py
ctx.sync(recipe, into) -> {"written", "unchanged", "deleted", "into"}       # also archil.sync(ctx, recipe, into)
archil.Static(files, *, name="static", layout="")
archil.Records(name, fetch, *, key="id", version=None, body=None, layout="")
archil.Recipe                                 # subclass: name, layout, list() -> iterable of Entry, get(key) -> bytes
archil.Entry(key, version="")
archil.git(ctx, url, into, *, depth=1) -> Statement
archil.duckdb(ctx, into, *, version="2.0.0", url=None, sha256=None) -> Statement
```

## Prices

```py
archil.PriceSheet(as_of="2026-11", source="https://archil.com/pricing", call_usd=0.00005, call_vcpu=2, call_mem_mib=4096,
                  active_gib_month_usd=0.20, archive_gb_month_usd=0.025,
                  sandbox_vcpu_hour_usd=0.055, sandbox_gib_hour_usd=0.020, egress_gb_usd=0.07,
                  active_window_hours=1.0, hours_per_month=730.0)
prices.call_units(vcpu=2, mem_mib=4096) -> int
prices.active_usd(nbytes) -> float            # keeping nbytes active for one window
prices.egress_usd(nbytes) -> float
prices.sandbox_hour_usd(vcpu, mem_mib) -> float
prices.breakeven_calls_per_hour(vcpu=2, mem_mib=4096) -> int

archil.Budget(max_usd=None, max_calls=None, max_bytes_touched=None)
Estimate:  calls, call_units, bytes_touched, egress_bytes, usd_calls, usd_active, usd_egress, complete
           .usd  .since(earlier)  .to_dict()  a + b
Ledger:    ctx.spend.total  .statements  .snapshot() -> Estimate;  str(ctx.spend)
```

Pass prices by keyword: `archil.PriceSheet(call_usd=0.00004)`.

## Tools

```py
tools = ctx.tools(names=None)                 # read_file, write_file, delete_file, list_files, grep, run_bash, sql, plan
                                              # with no names, the two write tools are left out when nothing is writable
tool.name   tool.description   tool.parameters
tool(**args) -> str                           # never raises; an error is "error: …"
tool.to_anthropic() -> {"name", "description", "input_schema"}
tool.to_openai() -> {"type": "function", "function": {...}}
```

## Backends

```py
archil.LocalBackend(root=".archil-local", *, isolation="auto", verify_read_only=True, limits=Limits(),
                    name="local", inside_archil=True, capabilities=...)
archil.ArchilBackend(client=None, *, api_key=None, region=None, inside_archil=False, limits=Limits(),
                     name="archil", exec_timeout_s=330.0, capabilities=...)

backend.name   backend.limits   backend.inside_archil
backend.capabilities                          # a set of "checkpoint", "branch", "grep", "share"
backend.checkpoint_calls                      # what one checkpoint bills as: 1
backend.version_granularity_s                 # how coarse a file's version is: 0.0 locally, 1.0 on Archil
backend.resolve_disk(ref, *, create=False) -> str
backend.exec(mounts, command, vm) -> ExecOutput
backend.grep(disk, directory, pattern, **opts) -> (list[GrepHit], stopped_reason)
backend.get(disk, key)   backend.put(disk, key, data, *, if_absent=False)   backend.append(disk, key, data)
backend.delete(disk, key)   backend.list(disk, prefix="", *, recursive=True)   backend.head(disk, key)
backend.share(disk, key, expires_in)   backend.checkpoint(disk, name)   backend.branch(disk, name, from_checkpoint, *, exist_ok=False)
backend.commit_lock(disk)                     # a context manager held while a turn validates and applies

archil.Limits(max_command_bytes=102400, max_output_bytes=4194304, exec_timeout_s=300.0, max_parallel=64,
              append_max_bytes=1048576, grep_max_results=1000, checkout_queue_ms=5000)
archil.MountSpec(disk, subdirectory=None, read_only=False, conditional=False, checkout_paths=(), queue_ms=None)
archil.Vm(vcpu=2, mem_mib=4096, image=None, egress=None)
ExecOutput:  exit_code, stdout, stderr, queue_ms, execute_ms, total_ms, truncated
ObjectInfo:  key, size, modified, etag;  .version
GrepHit:     file, line, text
```

A backend of your own subclasses `archil.Backend` and implements those methods. Turns, forks and locks need `"checkpoint"` and `"branch"` in its `capabilities`; without them a transaction raises `NotSupported`. `commit_lock` does nothing unless it is overridden, and a backend whose versions are coarser than its writes says so in `version_granularity_s`.

`LocalBackend.exec_log` lists every exec the backend ran, which is handy in tests. `ArchilBackend.client` is the official client, for what this SDK does not wrap, such as deleting a disk. Its `exec_timeout_s` is that client's request timeout, set a little above the five minutes a call may run.

## Errors

```py
archil.Error                                  # the base: .code  .message  .path  .suggestion  .to_dict()  str(e)
archil.ValidationError                        # .issues: list of Issue(code, message, path, suggestion)
archil.BudgetExceeded
archil.Conflict                               # .paths
archil.Busy
archil.NotSupported
archil.ExecFailed                             # .exit_code  .stderr  .command
```

Codes and what to do about each are in [errors.md](errors.md).
