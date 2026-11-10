/**
 * Compose a context, ask a question, read the plan, run it.
 *
 *     node examples/quickstart.ts
 *
 *     node examples/quickstart.ts             # on the local backend: no account needed
 *     node examples/quickstart.ts --archil    # the same code on Archil; see _where.ts
 */

import * as archil from "seaway";

import * as where from "./_where.ts";

const backend = where.backend("quickstart");

// The publisher's view of the handbook: it is the one writer.
const publisher = await archil.context({ docs: where.disk("handbook", "owned", { create: true }) }, { backend });
await publisher.sync(
  new archil.Static(
    {
      "onboarding.md": "# Onboarding\nRead the handbook. Ask questions early.\n",
      "expenses.md": "# Expenses\nFile within 30 days. Keep the receipt.\n",
      "security/keys.md": "# Keys\nRotate API keys every 90 days.\nNever paste a key into a ticket.\n",
    },
    { name: "handbook", layout: "One Markdown file per policy. Security policies are under security/." },
  ),
  "docs",
);

// 1. A context is a value: which disks, and under what rules. The same handbook is
//    read-only here, and the agent's notes are its own.
const ctx = await archil.context(
  {
    docs: where.disk("handbook", "read", { description: "company policies, one file each" }),
    notes: where.disk("my-notes", "owned", { create: true, description: "this agent's working notes" }),
  },
  { backend, name: "quickstart" },
);
console.log(ctx.describe(), "\n");

// 2. A statement is work that runs next to the data. Building one runs nothing.
//    The paths it is given are the only paths the call will be able to see.
const words = ctx.sh`wc -w ${ctx.glob("docs/**/*.md")} | sort -n`;
console.log(String(await words.explain()), "\n");
console.log((await words).text); // awaiting a statement runs it

// 3. Search is one call per disk, however many files there are.
for (const hit of (await ctx.grep("rotate", "docs", { ignoreCase: true })).rows!) {
  console.log(`${hit.file}:${hit.line}: ${hit.text}`);
}
console.log();

// 4. Writes go where the context allows, and nowhere else. (The same statement form with
//    named parameters, as the Python SDK writes it; the two compile to the same plan.)
await ctx
  .sh("grep -l key {files} > {out}", { files: ctx.glob("docs/**/*.md"), out: ctx.out("notes/mentions-keys.txt") })
  .run({ check: true });
console.log("notes/mentions-keys.txt:", (await ctx.readText("notes/mentions-keys.txt")).trim().split(/\s+/));
try {
  await ctx.write("docs/onboarding.md", "rewritten");
} catch (e) {
  if (!(e instanceof archil.ValidationError)) throw e;
  console.log(`refused: ${e.code}: ${e.suggestion}\n`);
}

// 5. A turn's changes land together, or not at all.
await ctx.transaction(async (turn) => {
  await turn.write("notes/todo.md", "- read the security policies\n");
  await turn.sh`date -u +%F > ${turn.out("notes/started.txt")}`.run({ check: true });
  console.log("inside the turn, the main line still has:", (await ctx.ls("notes")).map((f) => f.path));
});
console.log("after the commit:", (await ctx.ls("notes")).map((f) => f.path), "\n");

// 6. Hand a helper less than you have. Same path names, smaller reach.
const helper = ctx.narrow(["docs/security"], { readOnly: true });
console.log(helper.describe().split("\n")[1]);
console.log((await helper.sh`find -L . -type f`).text);

// 7. The context kept count.
console.log(String(ctx.spend));
