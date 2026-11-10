/**
 * An agent's context, composed: several disks, each under its own rules.
 *
 * The four ingredients from "Who will build Vercel for agents?" (an organisation's
 * skills, reference data from a system of record, agent-owned memory and shared
 * memory), plus an audit log. Then what a context being a value buys: a manifest,
 * pinning, turns that commit or don't, forks, locks, and handing a helper less.
 *
 *     node examples/agent-context.ts
 *
 *     node examples/agent-context.ts             # on the local backend: no account needed
 *     node examples/agent-context.ts --archil    # the same code on Archil; see _where.ts
 */

import * as archil from "seaway";

import * as where from "./_where.ts";

const backend = where.backend("context");

// -- what would already exist in a real organisation ---------------------------

// Skills are published by a platform team, which checkpoints each release.
const platform = await archil.context({ skills: where.disk("org-skills", "owned", { create: true }) }, { backend });
await platform.sync(
  new archil.Static(
    { "triage.md": "# Triage\nReproduce first. Then bisect.\n", "writing.md": "# Writing\nLead with the answer.\n" },
    { name: "skills", layout: "One Markdown file per skill." },
  ),
  "skills",
);
await platform.checkpoint("2026-11-01");

// Reference data comes from a system of record through a recipe: an adapter with the shape of
// an object store (list the keys, get one) and a note describing the layout it writes.
const ISSUES = [
  { id: "ENG-1", title: "Checkout fails with an expired coupon", status: "open", updated: "2026-11-08T09:00:00Z",
    description: "Steps: add a coupon that expired yesterday, then pay." },
  { id: "ENG-2", title: "Add dark mode", status: "open", updated: "2026-11-07T15:30:00Z", description: "" },
  { id: "ENG-3", title: "Rotate the signing key", status: "done", updated: "2026-11-01T11:00:00Z", description: "" },
];
const issues = new archil.Records(
  "issues",
  () => ISSUES, // stands in for a call to the tracker's API
  {
    key: "id",
    version: "updated",
    body: "description",
    layout: "One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.",
  },
);
const mirror = await archil.context({ tracker: where.disk("tracker-mirror", "owned", { create: true }) }, { backend });
console.log("first sync: ", await mirror.sync(issues, "tracker/issues"));
Object.assign(ISSUES[0], { status: "done", updated: "2026-11-09T10:00:00Z" });
console.log("second sync:", await mirror.sync(issues, "tracker/issues"), "\n"); // only the issue that changed is written

// -- the agent's context -------------------------------------------------------

const ctx = await archil.context(
  {
    skills: where.disk("org-skills", "frozen", { at: "2026-11-01", description: "how we work, pinned to a release" }),
    tracker: where.disk("tracker-mirror", "read", { description: "issues, mirrored from the tracker" }),
    memory: where.disk("agent-7-memory", "owned", { create: true, description: "this agent's own notes" }),
    team: where.disk("team-notes", "shared", { create: true, description: "notes the whole team writes" }),
    audit: where.disk("audit-log", "append", { create: true, description: "what was done, and by whom" }),
  },
  { backend, name: "agent-7", journal: "audit/agent-7" },
);
console.log(ctx.describe(), "\n");
console.log(JSON.stringify(ctx.manifest(), null, 2), "\n");

// A statement sees the paths it is given and nothing else: here one directory of one disk, read-only.
const openIssues = ctx.sh`grep -l 'status: open' ${ctx.glob("tracker/issues/*.md")} | wc -l`;
console.log(String(await openIssues.explain()));
console.log("open issues:", (await openIssues).text.trim(), "\n");

// Pinned means pinned: the platform team publishes a new version, and this context still reads the old one.
await platform.write("skills/triage.md", "# Triage\nAsk the customer first.\n");
console.log("skills/triage.md says:", (await ctx.readText("skills/triage.md")).split("\n")[1], "\n");

// -- turns ----------------------------------------------------------------------

// Two agents start from the same state and both change the same shared note. The first to
// commit wins. The second is told which path, and none of its turn is applied.
await ctx.write("team/standup.md", "- nothing yet\n");
const other = await archil.context({ team: where.disk("team-notes", "shared") }, { backend, name: "agent-8" });
const mine = await new archil.Transaction(ctx, { writes: ["team", "memory"] }).begin();
const theirs = await new archil.Transaction(other).begin();
await mine.ctx.sh`echo '- agent-7: ENG-1 is done' >> ${mine.ctx.out("team/standup.md")}`.run({ check: true });
await mine.ctx.write("memory/eng-1.md", "Closed after the coupon fix.\n");
await theirs.ctx.write("team/standup.md", "- agent-8: rewrote the file\n");
console.log("agent-8 commits:", (await theirs.commit()).applied);
try {
  await mine.commit();
} catch (conflict) {
  if (!(conflict instanceof archil.Conflict)) throw conflict;
  console.log("agent-7 conflicts on:", conflict.paths, "and its memory is untouched:", !(await ctx.exists("memory/eng-1.md")));
}

// The loser runs its turn again from the new state. An agent can do that, which is why
// optimistic control suits a turn.
await ctx.transaction(
  async (turn) => {
    await turn.sh`echo '- agent-7: ENG-1 is done' >> ${turn.out("team/standup.md")}`.run({ check: true });
    await turn.write("memory/eng-1.md", "Closed after the coupon fix.\n");
  },
  { writes: ["team", "memory"] },
);
console.log("after the retry:", (await ctx.readText("team/standup.md")).trim().split("\n"), "\n");

// -- forks, locks, and less -----------------------------------------------------

// Three attempts at one task, each on its own copy-on-write fork of the writable disks.
const attempts = [];
for (let i = 0; i < 3; i++) {
  const attempt = await ctx.fork(`attempt-${i}`);
  await attempt.write("memory/plan.md", `plan ${i}\n`);
  attempts.push(attempt);
}
const plans = await Promise.all(attempts.map(async (a) => (await a.readText("memory/plan.md")).trim()));
console.log("attempts:", plans, "| main line has a plan:", await ctx.exists("memory/plan.md"));

// A lock is a manifest with every mount frozen at a checkpoint: the input to a replay or an eval.
const lock = await ctx.lock("eval-2026-11-09");
await ctx.write("memory/eng-1.md", "Edited after the lock.\n");
const replay = await archil.fromManifest(lock, { backend });
const modes = [...new Set([...replay.mounts.values()].map((m) => m.mode))].sort();
console.log("replay reads:", (await replay.readText("memory/eng-1.md")).trim(), "| modes:", modes);

// A helper gets less than you have: the same path names, a smaller reach, and no writes.
const reviewer = ctx.narrow(["tracker/issues", "memory"], { readOnly: true });
console.log(reviewer.describe().split("\n").slice(1, 3));
console.log("the helper's bash sees:", (await reviewer.sh`ls`).text.trim().split(/\s+/));
console.log("the tools a model would be given:", reviewer.tools().map((tool) => tool.name), "\n");

// The audit disk is append-only, and the journal on it is a log like any other.
console.log(String(ctx.spend));
console.log((await ctx.ls("audit/agent-7", { recursive: true })).map((f) => f.path));
