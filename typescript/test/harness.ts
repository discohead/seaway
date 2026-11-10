/**
 * Turns a case from conformance.json into a statement: the TypeScript side of conformance/harness.py.
 *
 * The fixture is language-neutral JSON. The Python SDK generates the expected
 * values; this SDK has to reproduce them. The same file is replayed by both suites.
 */

import * as archil from "../src/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export async function build(backend: archil.Backend, disks: Json, context: Json): Promise<archil.Context> {
  for (const [name, files] of Object.entries<Record<string, string>>(disks)) {
    await backend.resolveDisk(name, { create: true });
    for (const [key, text] of Object.entries(files)) await backend.put(name, key, Buffer.from(text));
  }
  const mounts: Record<string, archil.Source> = {};
  for (const [name, m] of Object.entries<Json>(context.mounts)) {
    mounts[name] = archil.disk(m.disk, m.mode, { description: m.description ?? "" });
  }
  return archil.context(mounts, { backend, name: context.name });
}

/** Decode one parameter: {path}, {out}, {glob}, {raw}, {value}, {log, ...} or a list of these. */
export function param(ctx: archil.Context, spec: Json): unknown {
  if (Array.isArray(spec)) return spec.map((s) => param(ctx, s));
  if ("path" in spec) return ctx.path(spec.path);
  if ("out" in spec) return ctx.out(spec.out);
  if ("glob" in spec) return ctx.glob(spec.glob);
  if ("raw" in spec) return archil.raw(spec.raw);
  if ("log" in spec) {
    const log = ctx.log(spec.log, { partition: spec.partition ?? "hour" });
    if ("between" in spec) return log.between(new Date(spec.between[0]), new Date(spec.between[1]));
    if ("last" in spec) return log.last(spec.last, { now: new Date(spec.now) });
    return log.all();
  }
  return spec.value;
}

/** Not async on purpose: a statement returned from an async function would be run by the await. */
export function statement(ctx: archil.Context, c: Json): archil.Statement {
  if (c.narrow) ctx = ctx.narrow(c.narrow.paths, { readOnly: c.narrow.readOnly ?? false });
  let stmt: archil.Statement;
  if (c.kind === "batch") {
    stmt = ctx.batch(c.children.map((child: Json) => statement(ctx, child)));
  } else if (c.kind === "grep") {
    stmt = ctx.grep(c.pattern, c.over, c.options ?? {}); // the fixture's option names are this SDK's own
  } else {
    const params: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(c.params ?? {})) params[name] = param(ctx, spec);
    stmt = c.kind === "sh" ? ctx.sh(c.template, params) : ctx.sql(c.template, params);
  }
  if (c.map) stmt = stmt.map({ on: c.map.on, reduce: c.map.reduce ?? "concat", shards: c.map.shards });
  if (c.into) stmt = stmt.into(c.into);
  if (c.sized) stmt = stmt.sized({ vcpu: c.sized.vcpu, memMib: c.sized.memMib });
  if (c.egress != null) stmt = stmt.egress(c.egress);
  return stmt;
}
