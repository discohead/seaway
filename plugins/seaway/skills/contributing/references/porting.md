# Porting from Python to TypeScript

The TypeScript SDK has to produce the same plans, the same messages and the same files as the Python one. Most of a port is mechanical. The part that is not is everything Python does without being asked: how strings sort, how a float prints, where a line ends, what `json.dumps` looks like. JavaScript's defaults differ in each, and a difference shows up as a hash that does not match or a view that one SDK built and the other finds stale.

## The mechanical part

| Python | TypeScript |
|---|---|
| keyword arguments: `narrow(*paths, read_only=False)` | an options object: `narrow(paths, { readOnly })` |
| `snake_case` names in the API | `camelCase` |
| a function that touches the backend | `async`, returning a promise |
| a frozen dataclass, changed with `replace(...)` | a class with `readonly` fields and a method that returns a copy (`mount.with({...})`, a private `#with` on `Statement`) |
| a `dict` whose order is part of the answer | a `Map`: a plain object lists keys that look like integers first |
| `bytes` | `Uint8Array` (a `Buffer` where one is made) |
| `datetime`, `timedelta` | `Date`, and milliseconds |
| `uuid.uuid4().hex[:n]` | `randomUUID().replaceAll("-", "").slice(0, n)` |
| `class Error(Exception)` | `class ArchilError extends Error`; `message` is the message alone, `toString()` adds code, path and suggestion |
| `with ctx.transaction() as turn:` | `ctx.transaction(async (turn) => { … })`, and `new Transaction(ctx)` for the explicit form |
| truthiness: `if changes:` | a getter: `changes.empty` |
| a property: `view.fresh` | a method to await: `view.fresh()` |
| `__getattr__` passing a turn's verbs on | not needed: the callback receives the turn's `Context` |
| lazy import of the official SDK | `await import("disk")` inside the Archil backend, on first use |

Names that are written to a disk or into a plan are already camel case in the Python (`readOnly`, `callUnits`, `vcpuCount`, `builtAt`, `bytesTouched`). They are part of the format, and are the same in both.

## Where Python's defaults are written out: compat.ts

Everything of this kind lives in `typescript/src/compat.ts`, and nowhere else. If a port needs one more Python behaviour, add it there with a comment saying what Python does.

| Python | In `compat.ts` | Why it differs |
|---|---|---|
| `sorted(items, key=...)`, `a < b` on strings | `sorted(items, key)`, `cmp(a, b)` | Python compares by code point; JavaScript's `<` compares UTF-16 units, and they disagree above U+FFFF |
| `len(text)`, `text[:n]`, `text[-n:]` | `len`, `head`, `tail` | counted in code points, not UTF-16 units |
| `text.strip()`, `text.rstrip()` | `strip`, `rstrip` | `trim()` also takes U+FEFF and leaves U+001C to U+001F and U+0085 |
| `text.splitlines()` | `splitlines` | every line boundary Python knows, and no empty last line |
| `data.decode("utf-8", errors="replace")` | `decode` | bad bytes become U+FFFD, and a leading BOM stays |
| `text.ljust(width)` | `ljust` | width in code points |
| `f"{x:.1f}"`, `round(x, n)` | `fixed(x, digits)`, `round(x, digits)` | `toFixed` sends an exact tie away from zero; Python sends it to the even digit, so 1280 bytes is `1.2 KiB` |
| `str(x)`, `repr(x)` of a number | `numberText`, `intText`, `floatRepr` | Python switches to exponent form below 1e-4, JavaScript below 1e-7; a float that is whole keeps its `.0` in `repr` |
| `str(value)`, `repr(value)` | `str`, `repr` | `None`, `True`, `False`; which quote a string gets; how lists and dicts print |
| `json.dumps(value, sort_keys=…, separators=…, ensure_ascii=…)` | `dumps(value, { sortKeys, compact, ascii })` | `JSON.stringify` cannot write `", "` and `": "`, escapes differently, and orders integer-like keys first |

Two more are in `plan.ts` and `shell.ts` because they are part of the format:

- `canonical(value)`: JSON with sorted keys, no spaces, and non-ASCII left as it is. Both SDKs hash this form, so it is how they agree on a plan's identity and on a view's fingerprint.
- `quote(value)`: one shell word, as `shlex.quote` writes it. `None` is `''`, and booleans are `true` and `false`. The fixture's `quote` table pins it.

## Things to carry over exactly

- **Order.** Every listing is sorted by path before it is used, so plans are reproducible on any backend. Sort with `sorted()` from `compat.ts`, not `Array.prototype.sort()`.
- **Times in files.** A log's `ts` is ISO 8601 with milliseconds and a `Z`, which `toISOString()` writes. A view's `builtAt` is Python's `isoformat()`, with microseconds and `+00:00`; the TypeScript writes that shape on purpose.
- **A local file's version** is the modification time in nanoseconds and the size, in hex: `f"{st.st_mtime_ns:x}-{st.st_size:x}"`. The TypeScript reads the time as a `bigint` to get the same string.
- **State file names.** The first 16 hex characters of the SHA-1 of the path, as `<mount>/<path>`.
- **Messages.** A message or a suggestion that reaches a plan's notes, a tool's output or a test is part of the behaviour. Port the words, not the gist.

## What TypeScript adds

These have no Python twin, and so no fixture case from the generator. Test them in `typescript/test/`.

- **Tagged templates.** `tagged()` in `shell.ts` turns a template into the named form with parameters `p0`, `p1`, …. From there it is the same statement, with a different hash from one written with other names.
- **A statement is thenable.** `Statement.then` runs it. Internal code must never return a statement from an `async` function or pass one through a promise. `harness.ts` is not `async` for this reason.
- **`asFileSystem`** in `tools.ts`, for the official tool layer.
- **Checkouts on the mount.** The official TypeScript client can ask for a checkout in the mount spec (`queueMs`, `checkoutPaths`). The Python client cannot, so the Python backend takes one by running `archil checkout` at the start of the command.

## What the compiler asks for

The package runs from its `.ts` sources under Node's type stripping, with no build step. `tsconfig.json` holds it to syntax that can simply be erased:

- no enums, no namespaces, no parameter properties (`erasableSyntaxOnly`);
- `import type` for types (`verbatimModuleSyntax`), and import paths that end in `.ts`;
- private state as `#fields`;
- `strict`, checked by `npm run typecheck`, since nothing else compiles the code.

## Checking a port

1. `node --test test/conformance.test.ts` replays every plan and table in the fixture, and names the case that differs.
2. The module's own test file, written to mirror the Python one.
3. `npm run typecheck`.
4. `./interop/run.sh`, which catches what a plan does not show: files written by one SDK and read by the other.

When a plan's hash differs and the printed plan looks the same, compare `JSON.stringify(plan)` with the fixture's `plan` field by field. It is almost always a number written differently, a key order, or a sort.
