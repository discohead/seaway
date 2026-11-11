/**
 * Does the TypeScript SDK have these names? The TypeScript half of check-api.mjs.
 *
 * Reads {"sdk": <path to typescript/>, "root": <a scratch directory>, "queries": [{receiver, member}]}
 * on stdin. Builds one real object for each receiver on a local backend, and reports the members
 * that are not there, the error codes the source names, and what the package exports. Writes
 * {"missing": ["receiver.member"], "codes": [...], "exports": [...]}.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  sdk: string;
  root: string;
  queries: { receiver: string; member: string }[];
}

const job: Job = JSON.parse(readFileSync(0, "utf8"));
delete process.env.ARCHIL_API_KEY;
process.env.ARCHIL_BACKEND = "local";

const archil = await import(pathToFileURL(path.join(job.sdk, "src", "index.ts")).href);

const backend = new archil.LocalBackend({ root: path.join(job.root, "ts") });
const ctx = await archil.context(
  {
    docs: archil.disk("handbook", "owned", { create: true }),
    logs: archil.disk("app-logs", "append", { create: true }),
    memory: archil.disk("agent-memory", "owned", { create: true }),
  },
  { backend },
);
await ctx.write("docs/a.md", "a\n");
const stmt = ctx.sh("cat {f}", { f: ctx.path("docs/a.md") });
const result = await stmt.run();
const plan = await stmt.explain();
const log = ctx.log("logs");
await log.append({ level: "INFO" });
const feed = ctx.feed("docs", { cursor: "memory/cursor.json" });
const tx = await new archil.Transaction(ctx, { writes: ["memory"] }).begin();
await tx.ctx.write("memory/x.md", "x\n");
const turn = tx.ctx;
const commit = await tx.commit();

let validation: unknown;
try {
  await ctx.read("nowhere/x");
} catch (e) {
  validation = e;
}
const errors: object[] = [validation as object, new archil.Conflict(["docs/a.md"]), new archil.ExecFailed(1, "", "cat"), new archil.ArchilError("x")];

const objects: Record<string, object> = {
  archil,
  ctx,
  stmt,
  result,
  meta: result.meta,
  plan,
  estimate: plan.estimate,
  task: plan.tasks[0],
  tx,
  turn,
  commit,
  conflict: errors[1]!,
  log,
  selection: log.all(),
  view: ctx.view("memory/view.txt", () => stmt),
  feed,
  changes: await feed.poll(),
  prices: ctx.prices,
  budget: new archil.Budget({ maxUsd: 1 }),
  ledger: ctx.spend,
  tool: ctx.tools()[0],
  backend,
  mount: ctx.mounts.get("docs"),
  ref: ctx.path("docs/a.md"),
  glob: ctx.glob("docs/*.md"),
  file: (await ctx.ls("docs"))[0],
};

const missing: string[] = [];
for (const { receiver, member } of job.queries) {
  const found =
    receiver === "error"
      ? errors.some((error) => member in error)
      : receiver === "backend"
        ? member in backend || member in archil.ArchilBackend.prototype // a name only the Archil backend has
        : member in objects[receiver]!;
  if (!found) missing.push(`${receiver}.${member}`);
}

const codes = new Set<string>();
for (const name of readdirSync(path.join(job.sdk, "src")).filter((n) => n.endsWith(".ts"))) {
  const text = readFileSync(path.join(job.sdk, "src", name), "utf8");
  for (const m of text.matchAll(/\bcode(?:: string)?\s*[:=]\s*"([a-z_0-9]+)"/g)) codes.add(m[1]!);
}
codes.delete("error"); // the base class's placeholder: nothing is thrown with it

// Types are exported too, and are not there at run time: read them from the index.
const index = readFileSync(path.join(job.sdk, "src", "index.ts"), "utf8");
const types = new Set<string>();
for (const m of index.matchAll(/export type \{([^}]+)\}/g)) {
  for (const name of m[1]!.split(",")) if (name.trim()) types.add(name.trim());
}

process.stdout.write(
  JSON.stringify({ missing, codes: [...codes].sort(), exports: Object.keys(archil).sort(), types: [...types].sort() }),
);
