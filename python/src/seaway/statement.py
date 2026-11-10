"""Statements: work that runs next to the data.

``ctx.sh(...)``, ``ctx.grep(...)`` and ``ctx.sql(...)`` each return a statement.
A statement does nothing until you ask: ``explain()`` returns the plan,
``run()`` executes it. Statements are immutable values, so ``map``, ``into``,
``sized`` and ``within`` each return a new one.

The planner never guesses. A command is split across calls only when the caller
says which input to split on and how to put the pieces back together. A call
sees only the paths the statement declares; a statement that declares none sees
the whole context.
"""

from __future__ import annotations

import base64
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Optional, Union

from .backends import ExecOutput, MountSpec, Vm, egress_policy
from .context import META
from .errors import Error, ExecFailed, ValidationError
from .plan import Plan, Task, canonical
from .pricing import Budget, Estimate, estimate, fmt_bytes
from .shell import FileStat, Glob, Raw, Ref, check_params, parent, quote, render, sql_literal

SHARD_BYTES = 256 * 1024 * 1024
SHARD_FILES = 2000
INLINE_LIST_BYTES = 48 * 1024


# --------------------------------------------------------------------------
# results


@dataclass
class Meta:
    calls: int = 0
    call_units: int = 0
    usd: float = 0.0
    wall_ms: float = 0.0
    queue_ms: float = 0.0
    execute_ms: float = 0.0

    def to_dict(self) -> dict:
        return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


@dataclass
class Result:
    kind: str
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    value: Any = None  # what the reducer produced, or parsed output
    rows: Optional[list[dict]] = None  # sql and grep
    paths: list[str] = field(default_factory=list)  # files written by into()
    truncated: bool = False
    results: list["Result"] = field(default_factory=list)  # batch: one per statement
    shards: list[ExecOutput] = field(default_factory=list)  # fan-out: one per call
    plan: Optional[Plan] = None
    meta: Meta = field(default_factory=Meta)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0

    @property
    def text(self) -> str:
        return self.stdout

    @property
    def lines(self) -> list[str]:
        return self.stdout.splitlines()

    def json(self) -> Any:
        return json.loads(self.stdout)

    def check(self) -> "Result":
        if not self.ok:
            raise ExecFailed(self.exit_code, self.stderr, self.plan.statement if self.plan else "")
        return self

    def __repr__(self) -> str:
        body = self.stdout if len(self.stdout) <= 200 else self.stdout[:200] + "…"
        return f"<Result {self.kind} exit={self.exit_code} calls={self.meta.calls} {body!r}>"


# --------------------------------------------------------------------------
# reducers: how the outputs of many calls become one answer


_NUM = re.compile(r"^-?\d+(?:\.\d+)?$")


def _bad_line(reducer: str, line: str, expected: str) -> Error:
    return Error(f"the '{reducer}' reducer cannot read this line of output: {line[:120]!r}", code="bad_reduce_input",
                 suggestion=f"each line must be {expected}; change the command, or reduce with 'lines' and combine yourself")


def _numbers(text: str) -> list[float]:
    """One number per line. Anything else is an error: a reducer must not drop output quietly."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if not _NUM.match(line):
            raise _bad_line("sum", line, "a single number (for example the output of `wc -l < file`)")
        out.append(float(line))
    return out


def _fmt_num(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else repr(x)


def _r_concat(outs: list[str]):
    text = "".join(o if o.endswith("\n") or not o else o + "\n" for o in outs)
    return text, text


def _r_lines(outs: list[str]):
    lines = [l for o in outs for l in o.splitlines()]
    return lines, "\n".join(lines) + ("\n" if lines else "")


def _r_sorted(outs: list[str]):
    lines = sorted(l for o in outs for l in o.splitlines())
    return lines, "\n".join(lines) + ("\n" if lines else "")


def _r_unique(outs: list[str]):
    lines = sorted({l for o in outs for l in o.splitlines()})
    return lines, "\n".join(lines) + ("\n" if lines else "")


def _r_count(outs: list[str]):
    n = sum(len(o.splitlines()) for o in outs)
    return n, f"{n}\n"


def _r_sum(outs: list[str]):
    total = sum(x for o in outs for x in _numbers(o))
    return total, _fmt_num(total) + "\n"


_UNIQ = re.compile(r"^\s+(\d+(?:\.\d+)?)\s+(.*)$")
_LEAD = re.compile(r"^(\d+(?:\.\d+)?)\s+(.*)$")


def _key_count(line: str) -> Optional[tuple[str, float]]:
    """Read one line as (key, count). Three forms, tried in this order:

    ``   12 key`` (``uniq -c``: the count first, after leading spaces), ``key:12`` or
    ``key<TAB>12`` (``rg -c --with-filename``, ``awk``), and ``12 key``.
    """
    m = _UNIQ.match(line)
    if m:
        return m.group(2), float(m.group(1))
    for sep in (":", "\t"):
        key, found, tail = line.rpartition(sep)
        if found and _NUM.match(tail.strip()):
            return key, float(tail)
    m = _LEAD.match(line)
    if m:
        return m.group(2), float(m.group(1))
    return None


def _r_sum_by_key(outs: list[str]):
    """Add up counts per key across calls. See ``_key_count`` for the line forms it reads."""
    totals: dict[str, float] = {}
    for o in outs:
        for line in o.splitlines():
            if not line.strip():
                continue
            pair = _key_count(line)
            if pair is None:
                raise _bad_line("sum_by_key", line, "'key:count', 'key<TAB>count' or 'count key' "
                                "(with rg -c, add --with-filename so a shard of one file still names it)")
            key, num = pair
            totals[key] = totals.get(key, 0) + num
    ordered = dict(sorted(totals.items(), key=lambda kv: (-kv[1], kv[0])))
    value = {k: (int(v) if float(v).is_integer() else v) for k, v in ordered.items()}
    return value, "".join(f"{k}\t{v}\n" for k, v in value.items())


def _r_json(outs: list[str]):
    merged: list = []
    for o in outs:
        if not o.strip():
            continue
        parsed = json.loads(o)
        merged.extend(parsed if isinstance(parsed, list) else [parsed])
    return merged, json.dumps(merged, separators=(",", ":"), ensure_ascii=False)


REDUCERS: dict[str, Callable[[list[str]], tuple[Any, str]]] = {
    "concat": _r_concat, "lines": _r_lines, "sorted": _r_sorted, "unique": _r_unique,
    "count": _r_count, "sum": _r_sum, "sum_by_key": _r_sum_by_key, "json": _r_json,
}


# --------------------------------------------------------------------------
# the statement


@dataclass(frozen=True)
class Statement:
    ctx: Any
    kind: str  # sh | grep | sql | batch
    template: str
    params: tuple = ()
    split: Optional[str] = None
    reduce: Any = None
    shards: Optional[int] = None
    out: Optional[Ref] = None
    vm: Vm = Vm()
    budget: Optional[Budget] = None
    opts: tuple = ()
    children: tuple = ()

    # -- builders ------------------------------------------------------------
    def map(self, on: Optional[str] = None, *, reduce: Any = "concat", shards: Optional[int] = None) -> "Statement":
        """Run once per shard of an input, in parallel, and combine the outputs.

        ``on`` names the parameter to split. It can be left out when exactly one
        parameter is a glob or a selection. ``reduce`` says how to combine:
        one of ``concat``, ``lines``, ``sorted``, ``unique``, ``count``, ``sum``,
        ``sum_by_key``, ``json``, or a function of the list of outputs.
        """
        if self.kind != "sh":
            raise ValidationError("only sh statements can be mapped", code="bad_map",
                                  suggestion="grep already fans out; give sql a larger VM with sized()")
        params = dict(self.params)
        if on is None:
            candidates = [n for n, v in params.items() if _is_selection(v)]
            if len(candidates) != 1:
                raise ValidationError(
                    f"map() needs to know which input to split; found {len(candidates)} candidates",
                    code="bad_map", suggestion="pass on='<parameter name>', or pass exactly one glob",
                )
            on = candidates[0]
        elif on not in params:
            raise ValidationError(f"no parameter named '{on}'", code="bad_map")
        if isinstance(reduce, str) and reduce not in REDUCERS:
            raise ValidationError(f"unknown reducer '{reduce}'", code="bad_map",
                                  suggestion="use one of: " + ", ".join(REDUCERS))
        return replace(self, split=on, reduce=reduce, shards=shards)

    def into(self, path: Union[str, Ref]) -> "Statement":
        """Send output to a file in the context instead of returning it. Results become paths."""
        ref = path if isinstance(path, Ref) else self.ctx.out(path)
        return replace(self, out=replace(ref, write=True))

    def sized(self, *, vcpu: Optional[int] = None, mem_mib: Optional[int] = None,
              image: Optional[str] = None) -> "Statement":
        """Choose the VM for each call. Anything above 2 vCPU / 4 GiB bills as a multiple of a call."""
        return replace(self, vm=Vm(vcpu or self.vm.vcpu, mem_mib or self.vm.mem_mib, image or self.vm.image,
                                   self.vm.egress))

    def egress(self, policy: Any) -> "Statement":
        """Say what this call may reach on the network: ``"deny"`` (nothing leaves), a list of hosts
        (only those), or ``"allow"`` (open). Left alone, a statement has its context's policy, and a
        context has Archil's default, which is open.

        The mount map decides what a command can read; this decides where it can send it.
        """
        return replace(self, vm=replace(self.vm, egress=egress_policy(policy)))

    def within(self, budget: Optional[Budget] = None, **limits: Any) -> "Statement":
        """Refuse to run if the plan would exceed this budget."""
        return replace(self, budget=budget or Budget(**limits))

    # -- plan and run -----------------------------------------------------------
    def explain(self) -> Plan:
        return _compile(self).plan

    def run(self, *, check: bool = False) -> Result:
        compiled = _compile(self)
        plan, ctx = compiled.plan, self.ctx
        if self.budget:
            self.budget.check(plan.estimate)
        if ctx.budget:
            ctx.budget.check(plan.estimate, ctx.spent_under_budget())
        started = time.perf_counter()
        result = compiled.execute()
        result.plan = plan
        units = ctx.prices.call_units(plan.vm.vcpu, plan.vm.mem_mib) if plan.route == "exec" else 1
        # The plan priced every byte it touches as newly active for an hour. The ledger knows what
        # this session has already made active, and charges only for what is new or kept warm longer.
        fresh, usd_active = ctx.spend.warm(compiled.touched) if result.meta.calls else (0, 0.0)
        actual = replace(estimate(ctx.prices, calls=result.meta.calls, units_per_call=units),
                         bytes_touched=fresh, usd_active=usd_active)
        result.meta.call_units = actual.call_units
        result.meta.usd = actual.usd
        result.meta.wall_ms = (time.perf_counter() - started) * 1000
        ctx.spend.add(actual)
        ctx._record({
            "kind": self.kind, "plan": plan.hash, "statement": plan.statement[:240],
            "reads": plan.reads, "writes": plan.writes, "calls": result.meta.calls,
            "callUnits": result.meta.call_units, "usd": round(result.meta.usd, 8),
            "ms": round(result.meta.wall_ms, 1), "exit": result.exit_code,
        })
        return result.check() if check else result

    def __repr__(self) -> str:
        return f"<Statement {self.kind}: {self.template[:60]!r}>"


def _is_selection(value: Any) -> bool:
    return isinstance(value, Glob) or hasattr(value, "resolve")


def describe_param(value: Any) -> str:
    """A parameter as text, written the same way by both SDKs. Used to fingerprint a statement."""
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(describe_param(v) for v in value) + "]"
    if isinstance(value, Ref):
        return ("out:" if value.write else "path:") + value.path
    if isinstance(value, Glob):
        return "glob:" + value.path
    if isinstance(value, Raw):
        return "raw:" + value.text
    if hasattr(value, "resolve"):
        return "sel:" + str(value)
    try:
        return "val:" + canonical(value)
    except TypeError:
        return "val:" + canonical(str(value))


# --------------------------------------------------------------------------
# compiling statements into plans


@dataclass
class _Compiled:
    plan: Plan
    execute: Callable[[], Result]
    reads: list[tuple[str, str]] = field(default_factory=list)  # (mount, directory)
    writes: list[tuple[str, str]] = field(default_factory=list)  # (mount, path)
    declared: bool = True
    touched: dict[str, int] = field(default_factory=dict)  # every file the statement reads: path -> size


def _compile(s: Statement) -> _Compiled:
    return {"sh": _compile_sh, "sql": _compile_sql, "grep": _compile_grep, "batch": _compile_batch}[s.kind](s)


def _run_tasks(ctx, plan: Plan) -> list[ExecOutput]:
    tasks = plan.tasks
    if not tasks:
        return []
    workers = min(len(tasks), plan.parallel)
    if workers <= 1:
        return [ctx.backend.exec(t.mounts, t.command, plan.vm) for t in tasks]
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda t: ctx.backend.exec(t.mounts, t.command, plan.vm), tasks))


def _unmounted(ctx, mounts: dict[str, MountSpec]) -> list[str]:
    seen = {key.split("/")[0] for key in mounts}
    return [name for name in ctx.mounts if name not in seen]


def _gather(ctx, params: dict, split: Optional[str], *, tables: bool = False):
    """Walk the parameters: resolve inputs, and collect what the statement reads and writes.

    ``files`` holds the resolved file list for every glob or selection, for the
    parameter being split, and (when ``tables`` is set) for every path that is read.
    """
    reads: list[tuple[str, str]] = []
    writes: list[tuple[str, str]] = []
    shown_r: list[str] = []
    shown_w: list[str] = []
    paths_r: list[str] = []  # the same reads as paths and globs, for the plan's effects
    files: dict[str, list[FileStat]] = {}
    sizes: dict[str, int] = {}  # every file read, once
    touched = 0
    for name, value in params.items():
        for item in value if isinstance(value, (list, tuple)) else [value]:
            if isinstance(item, Ref):
                ctx._resolve(item, write=item.write)
                if item.write:
                    writes.append((item.mount, item.rel))
                    shown_w.append(item.path)
                    continue
                shown_r.append(item.path)
                paths_r.append(item.path)
                listed = ctx.expand(item)
                is_dir = any(f.path != item.path for f in listed)
                reads.append((item.mount, item.rel if is_dir else parent(item.rel)))
                touched += sum(f.size for f in listed)
                sizes.update((f.path, f.size) for f in listed)
                if tables or name == split:
                    files.setdefault(name, []).extend(listed)
            elif _is_selection(item):
                listed = ctx.expand(item)
                files.setdefault(name, []).extend(listed)
                touched += sum(f.size for f in listed)
                sizes.update((f.path, f.size) for f in listed)
                shown_r.append(str(item))
                if isinstance(item, Glob):
                    ctx._resolve(Ref(item.mount, item.static_prefix()))
                    reads.append((item.mount, item.static_prefix()))
                    paths_r.append(str(item))
                else:
                    roots = item.roots()
                    reads.extend(roots)
                    paths_r.extend(f"{m}/{d}" if d else m for m, d in roots)
    return reads, writes, shown_r, shown_w, files, touched, paths_r, sizes


def _render_value(value: Any, files: Optional[list[FileStat]]) -> str:
    if files is not None and _is_selection(value):
        return " ".join(quote(f.path) for f in files)
    if isinstance(value, Ref):
        return quote(value.path)
    if isinstance(value, Raw):
        return value.text
    if isinstance(value, (list, tuple)):
        return " ".join(_render_value(v, None) for v in value)
    return quote(value)


def make_shards(files: list[FileStat], n: Optional[int], max_command_bytes: int, base_len: int) -> list[list[FileStat]]:
    """Group files into shards of similar size, each small enough to fit in one command."""
    if not files:
        return []
    total = sum(f.size for f in files)
    if n is None:
        n = max(math.ceil(total / SHARD_BYTES), math.ceil(len(files) / SHARD_FILES), 1)
    n = max(1, min(n, len(files)))
    bins: list[list[FileStat]] = [[] for _ in range(n)]
    loads = [0] * n
    for f in sorted(files, key=lambda f: (-f.size, f.path)):
        i = loads.index(min(loads))
        bins[i].append(f)
        loads[i] += max(f.size, 1)
    room = max(1024, max_command_bytes - base_len - 1024)
    shards: list[list[FileStat]] = []
    for b in bins:
        current: list[FileStat] = []
        used = 0
        for f in sorted(b, key=lambda f: f.path):
            need = len(quote(f.path)) + 1
            if current and used + need > room:
                shards.append(current)
                current, used = [], 0
            current.append(f)
            used += need
        if current:
            shards.append(current)
    return shards


def _wrap_out(command: str, target: str) -> str:
    directory = parent(target)
    prefix = f"mkdir -p {quote(directory)} && " if directory else ""
    return f"{prefix}{{\n{command}\n}} > {quote(target)}"


def _check_size(ctx, command: str) -> None:
    limit = ctx.backend.limits.max_command_bytes
    if len(command.encode()) > limit:
        raise ValidationError(
            f"the compiled command is {fmt_bytes(len(command.encode()))}; the limit is {fmt_bytes(limit)}",
            code="command_too_large", suggestion="use .map() to spread the inputs across calls",
        )


def _compile_sh(s: Statement) -> _Compiled:
    ctx = s.ctx
    params = dict(s.params)
    check_params(s.template, params)
    if s.split and s.split not in params:
        raise ValidationError(f"no parameter named '{s.split}'", code="bad_map")
    reads, writes, shown_r, shown_w, files, touched, paths_r, sizes = _gather(ctx, params, s.split)
    if s.out:
        ctx._resolve(s.out, write=True)
        writes.append((s.out.mount, s.out.rel))
        shown_w.append(s.out.path)
    declared = bool(reads or writes)
    mounts = ctx.scope(reads, writes)
    limits = ctx.backend.limits

    groups: list[Optional[list[FileStat]]]
    if s.split:
        groups = list(make_shards(files.get(s.split, []), s.shards, limits.max_command_bytes, len(s.template)))
    else:
        groups = [None]

    tasks: list[Task] = []
    out_paths: list[str] = []
    for index, group in enumerate(groups):
        def render_param(name: str, value: Any, group=group) -> str:
            if name == s.split:
                return " ".join(quote(f.path) for f in group or [])
            return _render_value(value, files.get(name))

        command = render(s.template, params, render_param)
        # a declared output's directory is created first, so `> {out}` works on a path that is new
        made = sorted({parent(f"{m}/{rel}") for m, rel in writes if not s.out or (m, rel) != (s.out.mount, s.out.rel)})
        made = [d for d in made if "/" in d]
        if made:
            command = "mkdir -p " + " ".join(quote(d) for d in made) + " && " + command
        if s.out:
            target = f"{s.out.path}/part-{index:05d}" if s.split else s.out.path
            command = _wrap_out(command, target)
            out_paths.append(target)
        _check_size(ctx, command)
        tasks.append(Task(command, mounts, label=f"shard {index}" if s.split else ""))

    units = ctx.prices.call_units(s.vm.vcpu, s.vm.mem_mib)
    reducer_name = (s.reduce if isinstance(s.reduce, str) else "function") if s.split else None
    plan = Plan(
        kind="sh", route="exec", statement=s.template, tasks=tasks, vm=s.vm,
        reads=shown_r, writes=shown_w, reduce=reducer_name,
        estimate=estimate(ctx.prices, calls=len(tasks), units_per_call=units,
                          bytes_touched=touched, complete=declared),
        files=sum(len(v) for v in files.values()),
        parallel=limits.max_parallel, unmounted=_unmounted(ctx, mounts), read_paths=paths_r,
    )
    _advise(s, plan, declared, files, touched, units)

    def execute() -> Result:
        outputs = _run_tasks(ctx, plan)
        code = next((o.exit_code for o in outputs if o.exit_code != 0), 0)
        stderr = "".join(o.stderr for o in outputs)
        if s.split:
            reducer = REDUCERS[s.reduce] if isinstance(s.reduce, str) else (lambda outs: (s.reduce(outs), ""))
            value, stdout = reducer([o.stdout for o in outputs])
            if not isinstance(s.reduce, str):
                stdout = value if isinstance(value, str) else json.dumps(value, default=str)
        else:
            stdout = outputs[0].stdout if outputs else ""
            value = stdout
        return Result(
            kind="sh", exit_code=code, stdout=stdout, stderr=stderr, value=value,
            # only the parts that were written: a shard that failed left no file, or half of one
            paths=[p for p, o in zip(out_paths, outputs) if o.exit_code == 0],
            truncated=any(o.truncated for o in outputs),
            shards=outputs if s.split else [],
            meta=Meta(calls=len(outputs), queue_ms=sum(o.queue_ms for o in outputs),
                      execute_ms=sum(o.execute_ms for o in outputs)),
        )

    return _Compiled(plan, execute, reads, writes, declared, sizes)


def _advise(s: Statement, plan: Plan, declared: bool, files: dict, touched: int, units: int) -> None:
    """Notes that would change what a careful author does next."""
    ctx = s.ctx
    if not declared:
        plan.notes.append(
            f"no paths declared, so all {len(ctx.mounts)} mount(s) are attached; pass paths as parameters "
            "to mount only what the command needs"
        )
    if not s.split and any(files.values()):
        count = sum(len(v) for v in files.values())
        if touched > SHARD_BYTES or count > SHARD_FILES:
            calls = max(math.ceil(touched / SHARD_BYTES), math.ceil(count / SHARD_FILES))
            plan.notes.append(f"{count} files in one call; .map() would spread this over about {calls} calls")
    if s.split and plan.tasks and any(ctx.mounts[m].mode == "owned" for m, _ in
                                      ([(s.out.mount, "")] if s.out else [])):
        plan.notes.append("parallel calls writing to an 'owned' mount queue for its checkout; "
                          "a 'shared' mount lets them write at once")
    if units > 1:
        plan.notes.append(f"this VM size bills as {units} calls each")
    if re.match(r"^\s*(rg|grep)\s", s.template) and "|" not in s.template and not s.out and declared:
        plan.notes.append("a plain regex search is one call per disk with ctx.grep(), however many files")
    if not ctx.backend.inside_archil and not s.out:
        plan.notes.append("the caller is outside Archil: only stdout crosses the network, not the files")


# -- sql ---------------------------------------------------------------------

_READERS = {
    "parquet": "read_parquet", "csv": "read_csv_auto", "tsv": "read_csv_auto",
    "json": "read_json_auto", "ndjson": "read_json_auto", "jsonl": "read_json_auto",
}
_COPY_FORMATS = {"parquet": "PARQUET", "csv": "CSV", "json": "JSON", "ndjson": "JSON", "jsonl": "JSON"}


def _ext(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _table(value: Any, files: list[FileStat]) -> str:
    """The DuckDB table expression for a path, a glob or a selection."""
    ext = _ext(files[0].path)
    reader = _READERS.get(ext, "read_json_auto")
    if isinstance(value, Glob):
        return f"{reader}({sql_literal(value.path)}, union_by_name=true)"
    if isinstance(value, Ref) and any(f.path != value.path for f in files):  # a directory
        pattern = f"{value.path}/**/*.{ext}" if ext else f"{value.path}/**/*"
        return f"{reader}({sql_literal(pattern)}, union_by_name=true)"
    names = "[" + ", ".join(sql_literal(f.path) for f in files) + "]"
    if len(names) > INLINE_LIST_BYTES and getattr(value, "dir_complete", False):
        dirs = sorted({(parent(f.path), _ext(f.path)) for f in files})
        names = "[" + ", ".join(sql_literal(f"{d}/*.{e}") for d, e in dirs) + "]"
    table = f"{reader}({names}, union_by_name=true)"
    # a log selection is a time range: the files are the partitions that cover it, and this makes
    # the table exactly the records inside it
    where = value.predicate() if hasattr(value, "predicate") else None
    return f"(select * from {table} where {where})" if where else table


def _compile_sql(s: Statement) -> _Compiled:
    ctx = s.ctx
    params = dict(s.params)
    check_params(s.template, params)
    # any path parameter is a table: a file, a directory, a glob or a selection
    reads, writes, shown_r, shown_w, files, touched, paths_r, sizes = _gather(ctx, params, None, tables=True)
    empty = [name for name, value in params.items()
             if ((isinstance(value, Ref) and not value.write) or _is_selection(value)) and not files.get(name)]

    if s.out:
        ctx._resolve(s.out, write=True)
        writes.append((s.out.mount, s.out.rel))
        shown_w.append(s.out.path)
    declared = bool(reads or writes)

    # DuckDB is not in Archil's exec image, so it usually lives on a disk in the context. Mount its
    # directory beside what the query declares. It is a tool, not an input: a query that declares
    # nothing still sees the whole context, which already includes the tool's disk.
    engine = ctx.tools_map.get("duckdb", "duckdb")
    engine_cmd = engine
    if "/" in engine and engine.split("/")[0] in ctx.mounts:
        ref = ctx.path(engine)
        if declared:
            reads.append((ref.mount, parent(ref.rel)))
        engine_cmd = quote(ref.path)

    def render_param(name: str, value: Any) -> str:
        if isinstance(value, Ref) or _is_selection(value):
            return _table(value, files[name])
        if isinstance(value, Raw):
            return value.text
        return sql_literal(value)

    tasks: list[Task] = []
    mounts = ctx.scope(reads, writes)
    if not empty:
        query = render(s.template, params, render_param).strip().rstrip(";")
        command = f"{engine_cmd} -json -c {quote(query)}"
        if s.out:
            fmt = _COPY_FORMATS.get(_ext(s.out.path), "JSON")
            copy = f"COPY ({query}) TO {sql_literal(s.out.path)} (FORMAT {fmt})"
            directory = parent(s.out.path)
            command = (f"mkdir -p {quote(directory)} && " if directory else "") + f"{engine_cmd} -c {quote(copy)}"
        _check_size(ctx, command)
        tasks.append(Task(command, mounts))

    units = ctx.prices.call_units(s.vm.vcpu, s.vm.mem_mib)
    plan = Plan(
        kind="sql", route="exec", statement=s.template.strip(), tasks=tasks, vm=s.vm,
        reads=shown_r, writes=shown_w,
        estimate=estimate(ctx.prices, calls=len(tasks), units_per_call=units, bytes_touched=touched,
                          complete=declared),
        files=sum(len(v) for v in files.values()), parallel=1,
        unmounted=_unmounted(ctx, mounts) if tasks else [], read_paths=paths_r,
    )
    if empty:
        plan.notes.append("no input files for " + ", ".join(empty) + ": nothing to run, zero rows returned")
    if units > 1:
        plan.notes.append(f"this VM size bills as {units} calls")

    def execute() -> Result:
        if empty:
            return Result(kind="sql", stdout="[]", rows=[], value=[])
        out = ctx.backend.exec(tasks[0].mounts, tasks[0].command, s.vm)
        rows: Optional[list[dict]] = None
        if out.exit_code == 0 and not s.out:
            try:
                rows = json.loads(out.stdout) if out.stdout.strip() else []
            except json.JSONDecodeError:
                rows = None
        return Result(
            kind="sql", exit_code=out.exit_code, stdout=out.stdout, stderr=out.stderr, rows=rows, value=rows,
            paths=[s.out.path] if s.out and out.exit_code == 0 else [], truncated=out.truncated,
            meta=Meta(calls=1, queue_ms=out.queue_ms, execute_ms=out.execute_ms),
        )

    return _Compiled(plan, execute, reads, writes, declared, sizes)


# -- grep ---------------------------------------------------------------------


def _grep_command(pattern: str, where: str, opts: dict) -> str:
    """How a grep task is written in a plan. It is a description: the grep route takes the fields, not this line."""
    words = ["grep"]
    if opts.get("ignore_case"):
        words.append("-i")
    if not opts.get("recursive", True):
        words.append("--no-recursive")
    for g in opts.get("globs") or []:
        words += ["--glob", quote(g)]
    if opts.get("max_results") is not None:
        words += ["--max-results", str(int(opts["max_results"]))]
    return " ".join(words + ["-e", quote(pattern), quote(where)])


def _glob_literal(name: str) -> str:
    """A file name as a ripgrep glob that matches that name and nothing else."""
    return re.sub(r"([\\*?\[\]{}!])", r"\\\1", name)


def _compile_grep(s: Statement) -> _Compiled:
    ctx = s.ctx
    over = dict(s.params).get("over")
    opts = dict(s.opts)
    opts.setdefault("recursive", True)
    targets = [(ctx.mounts[over.mount], over.rel)] if over is not None else [(m, m.allow) for m in ctx.mounts.values()]
    touched, nfiles, tasks, shown = 0, 0, [], []
    sizes: dict[str, int] = {}
    searches: list[tuple[Any, str, dict]] = []  # what the backend is asked: (mount, directory, options)
    for m, rel in targets:
        found = ctx.expand(Ref(m.name, rel))
        touched += sum(f.size for f in found)
        nfiles += len(found)
        sizes.update((f.path, f.size) for f in found)
        where = f"{m.name}/{rel}" if rel else m.name
        shown.append(where)
        # Search takes a directory. One file is searched as its directory, not below it, for that name.
        one_file = bool(rel) and len(found) == 1 and found[0].path == where
        directory = parent(rel) if one_file else rel
        asked = {**opts, "recursive": False, "globs": [_glob_literal(rel.rsplit("/", 1)[-1])]} if one_file else opts
        searches.append((m, directory, asked))
        mounted = f"{m.name}/{directory}" if directory else m.name
        tasks.append(Task(_grep_command(s.template, where, opts),
                          {mounted: MountSpec(m.handle, m.key(directory) or None, read_only=True)}))
    plan = Plan(
        kind="grep", route="grep", statement=s.template, tasks=tasks,
        reads=shown, estimate=estimate(ctx.prices, calls=len(tasks), bytes_touched=touched), files=nfiles,
        unmounted=[n for n in ctx.mounts if n not in {m.name for m, _ in targets}],
    )

    def execute() -> Result:
        rows: list[dict] = []
        reasons: list[str] = []
        for m, directory, asked in searches:
            hits, reason = ctx.backend.grep(m.handle, m.key(directory), s.template, **asked)
            reasons.append(reason)
            for h in hits:
                r = m.rel(h.file)
                if not r.startswith(META + "/"):
                    rows.append({"file": f"{m.name}/{r}", "line": h.line, "text": h.text})
        exhaustive = all(r == "completed" for r in reasons)
        stdout = "".join(f"{r['file']}:{r['line']}:{r['text']}\n" for r in rows)
        return Result(
            kind="grep", stdout=stdout, rows=rows,
            value={"exhaustive": exhaustive, "stopped_reason": next((r for r in reasons if r != "completed"), "completed")},
            meta=Meta(calls=len(targets)),
        )

    reads = [(m.name, rel) for m, rel in targets]
    return _Compiled(plan, execute, reads, [], True, sizes)


# -- batch ---------------------------------------------------------------------


def _compile_batch(s: Statement) -> _Compiled:
    ctx = s.ctx
    if not s.children:
        raise ValidationError("batch() needs at least one statement", code="bad_batch")
    parts = []
    for child in s.children:
        if child.kind not in ("sh", "sql") or child.split:
            raise ValidationError("batch() takes plain sh and sql statements", code="bad_batch",
                                  suggestion="run mapped and grep statements on their own")
        # One VM, so one network policy: the batch's. A statement that asked for its own is refused
        # rather than quietly run under another.
        if child.vm.egress != s.vm.egress and child.vm.egress != ctx.egress:
            raise ValidationError("the statements in a batch run in one VM, so they share its network policy",
                                  code="bad_batch", suggestion="set egress on the batch or on the context, not on one statement")
        parts.append(_compile(child))
    declared = all(p.declared for p in parts)
    reads = [r for p in parts for r in p.reads] if declared else []
    writes = [w for p in parts for w in p.writes] if declared else []
    mounts = ctx.scope(reads, writes)
    runnable = [(i, p) for i, p in enumerate(parts) if p.plan.tasks]

    lines = ['__d=$(mktemp -d)']
    for i, p in runnable:
        lines.append(f'(\n{p.plan.tasks[0].command}\n) >"$__d/{i}.out" 2>"$__d/{i}.err"; echo $? >"$__d/{i}.rc"')
    ids = " ".join(str(i) for i, _ in runnable)
    lines.append(
        f'for i in {ids}; do printf \'%s %s %s %s\\n\' "$i" "$(cat "$__d/$i.rc")" '
        '"$(base64 < "$__d/$i.out" | tr -d \'\\n\')" "$(base64 < "$__d/$i.err" | tr -d \'\\n\')"; done'
    )
    command = "\n".join(lines)
    _check_size(ctx, command)
    tasks = [Task(command, mounts)] if runnable else []
    touched = sum(p.plan.estimate.bytes_touched for p in parts)
    plan = Plan(
        kind="batch", route="exec", statement=f"{len(parts)} statements", tasks=tasks, vm=s.vm,
        reads=[r for p in parts for r in p.plan.reads], writes=[w for p in parts for w in p.plan.writes],
        read_paths=[r for p in parts for r in (p.plan.reads if p.plan.read_paths is None else p.plan.read_paths)],
        estimate=estimate(ctx.prices, calls=len(tasks), units_per_call=ctx.prices.call_units(s.vm.vcpu, s.vm.mem_mib),
                          bytes_touched=touched, complete=declared),
        unmounted=_unmounted(ctx, mounts),
    )
    plan.notes.append(f"{len(parts)} statements in one call instead of {len(parts)}")

    def execute() -> Result:
        results: list[Result] = [
            Result(kind=p.plan.kind, plan=p.plan, rows=[] if p.plan.kind == "sql" else None) for p in parts
        ]
        if not tasks:
            return Result(kind="batch", results=results, value=results)
        out = ctx.backend.exec(mounts, command, s.vm)
        for line in out.stdout.splitlines():
            fields = line.split(" ", 3)
            if len(fields) != 4 or not fields[0].isdigit():
                continue
            i = int(fields[0])
            child = results[i]
            child.exit_code = int(fields[1] or 1)
            child.stdout = base64.b64decode(fields[2]).decode("utf-8", errors="replace")
            child.stderr = base64.b64decode(fields[3]).decode("utf-8", errors="replace")
            child.value = child.stdout
            if child.kind == "sql" and child.exit_code == 0:
                try:
                    child.rows = json.loads(child.stdout) if child.stdout.strip() else []
                    child.value = child.rows
                except json.JSONDecodeError:
                    pass
        code = out.exit_code or next((r.exit_code for r in results if r.exit_code), 0)
        return Result(
            kind="batch", exit_code=code, stdout="".join(r.stdout for r in results), stderr=out.stderr,
            results=results, value=results, truncated=out.truncated,
            meta=Meta(calls=1, queue_ms=out.queue_ms, execute_ms=out.execute_ms),
        )

    return _Compiled(plan, execute, reads, writes, declared, {k: v for p in parts for k, v in p.touched.items()})


__all__ = ["Statement", "Result", "Meta", "REDUCERS", "make_shards", "Estimate"]
