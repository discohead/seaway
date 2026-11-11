/**
 * __NAME__: __SUMMARY__
 *
 *     node app.ts              # on a local backend under ./.archil-local: no account, nothing leaves this machine
 *     node app.ts --archil     # on Archil: needs ARCHIL_API_KEY and ARCHIL_REGION, creates the disks below, bills per call
 */

import * as archil from "seaway";

const NAME = "__NAME__";

/** Local unless asked otherwise. An exported ARCHIL_API_KEY alone does not send this program to an account. */
function backend(): archil.Backend {
  if (process.argv.includes("--archil")) return new archil.ArchilBackend();
  return new archil.LocalBackend({ root: ".archil-local" });
}

/** Which disks, and under what rules. The mode says who may change each one. */
function openContext(backend: archil.Backend): Promise<archil.Context> {
  return archil.context(
    {
      data: archil.disk(`${NAME}-data`, "append", { create: true, description: "records, appended as they arrive" }),
      work: archil.disk(`${NAME}-work`, "owned", { create: true, description: "this program's own: reports, notes, journal" }),
    },
    {
      backend,
      name: NAME,
      journal: "work/journal", // one line per statement: what it read, wrote and cost
      egress: "deny", // commands cannot reach the network unless a statement says otherwise
    },
  );
}

const ctx = await openContext(backend());
console.log(ctx.describe(), "\n");

// 1. Data arrives as records in a log: a directory per hour, a file per writer.
const log = ctx.log("data/events", { writer: "example" });
await log.append([{ kind: "signup", plan: "free" }, { kind: "signup", plan: "pro" }, { kind: "cancel", plan: "free" }]);

// 2. A question is a statement. It names what it reads, so the call mounts that and nothing else.
//    A plain function, not an async one: awaiting a statement runs it.
const count = (events: archil.Selection): archil.Statement =>
  ctx.sh`cat ${events} | grep -o '"kind":"[a-z]*"' | sort | uniq -c`;
const byKind = count(log.last("1h"));
console.log(String(await byKind.explain()), "\n"); // what it would mount and cost; nothing has run yet
console.log((await byKind.run({ check: true })).text);

// 3. Something read more than once is a view: it rebuilds only when its inputs changed.
const report = ctx.view("work/reports/by-kind.txt", () => count(log.all()));
await report.refresh();
console.log("the report is fresh:", await report.fresh(), "\n");

// 4. Changes that belong together land together, or not at all.
await ctx.transaction(
  async (turn) => {
    await turn.write("work/notes/last-run.md", "Counted events by kind.\n");
  },
  { writes: ["work"] },
);

console.log(String(ctx.spend)); // what this run costs on Archil, by the public price sheet
