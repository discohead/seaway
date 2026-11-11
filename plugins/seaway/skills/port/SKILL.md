---
name: port
description: Port code that uses seaway from Python to TypeScript or back, keeping the meaning and, where it matters, the plans the same.
argument-hint: "<file or function> [to python|typescript]"
disable-model-invocation: true
---

# Port seaway code between the SDKs

The two SDKs have one API. A port is mostly renaming, plus a handful of places where the languages differ. The argument names what to port; the target is the other language unless one is given.

This is for code that *uses* seaway. To port a change inside the SDKs themselves, use `/seaway:parity` and the `seaway:contributing` skill.

## Steps

1. **Read the source** and the `seaway:sdk` skill's `typescript-api.md` (its first section lists every difference) and the table in the skill's `SKILL.md`.

2. **Translate,** keeping the structure.

   | Python | TypeScript |
   |---|---|
   | `archil.context({...}, backend=b)` | `await archil.context({...}, { backend: b })` |
   | a call that reaches a backend | the same call, awaited |
   | `ctx.sh("wc {f}", f=ctx.glob(p))` | `ctx.sh("wc {f}", { f: ctx.glob(p) })`, or the tagged form ``ctx.sh`wc ${ctx.glob(p)}` `` |
   | `stmt.run(check=True)` | `await stmt.run({ check: true })` |
   | `ctx.narrow("a", "b", read_only=True)` | `ctx.narrow(["a", "b"], { readOnly: true })` |
   | `with ctx.transaction(writes=[…]) as turn:` | `await ctx.transaction(async (turn) => { … }, { writes: […] })` |
   | `tx = ctx.transaction().begin()`; `tx.write(…)` | `const tx = await new archil.Transaction(ctx).begin()`; `await tx.ctx.write(…)` |
   | `if changes:` / `if not changes:` | `if (!changes.empty)` / `if (changes.empty)` |
   | `view.fresh` | `await view.fresh()` |
   | `log.last(timedelta(minutes=15))` | `log.last(15 * 60_000)` |
   | `except archil.Conflict as c:` | `catch (c) { if (!(c instanceof archil.Conflict)) throw c; … }` |
   | `archil.Error` | `archil.ArchilError` |
   | `result.exit_code`, `meta.call_units` | `result.exitCode`, `meta.callUnits` |
   | `tool(**args)` | `await tool.call(args)` |
   | a mapped `sum_by_key` value: a `dict` | a `Map` |

3. **Mind what does not translate by renaming.**
   - A TypeScript statement is thenable. A function that builds and returns one must not be `async`. A view's builder is a plain function.
   - ``ctx.sh(`…${x}…`)`` is a call with a template literal, not a tagged template: the value is pasted. Going to TypeScript, use the tag or named parameters. Going to Python, never an f-string: `{name}` and a keyword argument.
   - A tagged template names its parameters `p0`, `p1`, …, so its plan hash differs from the named form's. If the two programs must produce the same plan (a shared journal, a view both refresh), use named parameters with the same names in both.
   - A view both programs refresh has to be the same statement: the template text and the parameters are in its fingerprint.
   - Python truthiness, properties and context managers become explicit getters, awaited methods and callbacks.

4. **Check it.** Build the ported statements on a local backend and compare `explain()` with the original's: the scope, the reads and writes and the price should match, and with named parameters so should the hash. Run `seaway-lint` on the new file. If the source has tests, port them and run them.

5. **Say what changed in meaning,** if anything had to: for example a turn that became a callback and now commits at a different point.
