/** Turns as transactions: snapshot isolation over files, first committer wins. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import * as archil from "../src/index.ts";
import { newBackend, thrown, tmp } from "./helpers.ts";

async function workspace(): Promise<{ work: archil.Context; backend: archil.LocalBackend }> {
  const backend = newBackend();
  const work = await archil.context(
    { work: archil.disk("workspace", "owned", { create: true }), ref: archil.disk("reference", "read", { create: true }) },
    { backend },
  );
  await work.write("work/plan.md", "v1\n");
  await work.write("work/notes/a.md", "a\n");
  return { work, backend };
}

/** An explicit transaction, begun: what Python's `ctx.transaction(...).begin()` returns. */
function begin(ctx: archil.Context, options: archil.TransactionOptions): Promise<archil.Transaction> {
  return new archil.Transaction(ctx, options).begin();
}

test("commit applies everything the turn did", async () => {
  const { work } = await workspace();
  const commit = await work.transaction(
    async (turn) => {
      await turn.write("work/plan.md", "v2\n");
      await turn.sh("echo generated > {f}", { f: turn.out("work/out/report.md") }).run({ check: true });
      await turn.rm("work/notes/a.md");
      assert.equal(await work.readText("work/plan.md"), "v1\n"); // nobody else sees the turn until it commits
      assert.ok(!(await work.exists("work/out/report.md")));
      assert.equal(await turn.readText("work/plan.md"), "v2\n"); // the turn reads its own writes
    },
    { writes: ["work"] },
  );
  assert.equal(await work.readText("work/plan.md"), "v2\n");
  assert.equal(await work.readText("work/out/report.md"), "generated\n");
  assert.ok(!(await work.exists("work/notes/a.md")));
  // Python reads tx.state == "committed" from the object `with` yields. Here the turn resolves
  // to its Commit, which says the same thing and what was applied.
  assert.ok(commit instanceof archil.Commit);
  assert.deepEqual(commit.applied, ["work/out/report.md", "work/plan.md"]);
  assert.deepEqual(commit.deleted, ["work/notes/a.md"]);
});

test("a failed turn leaves no trace", async () => {
  const { work, backend } = await workspace();
  const gaveUp = new Error("the model gave up");
  const error = await thrown(
    work.transaction(
      async (turn) => {
        await turn.write("work/plan.md", "half-finished\n");
        await turn.write("work/junk.txt", "x");
        throw gaveUp;
      },
      { writes: ["work"] },
    ),
  );
  assert.equal(error, gaveUp); // the turn's own error comes back, not a wrapper
  assert.equal(await work.readText("work/plan.md"), "v1\n");
  assert.ok(!(await work.exists("work/junk.txt")));
  // Python reads tx.state == "rolled_back"; here the rejection is that fact. Nothing was copied back:
  assert.deepEqual(backend.execLog, []);
});

test("the steps of a turn report their state", async () => {
  // what the two tests above cannot see through the callback form: the states of an explicit transaction
  const { work } = await workspace();
  const tx = new archil.Transaction(work, { writes: ["work"] });
  assert.equal(tx.state, "new");
  assert.throws(() => tx.ctx, (e: archil.ArchilError) => e.code === "bad_state");
  await tx.begin();
  assert.equal(tx.state, "open");
  await tx.ctx.write("work/plan.md", "v2\n");
  assert.deepEqual(await tx.changes(), new Map([["work", { written: ["plan.md"], deleted: [] }]]));
  assert.equal((await tx.commit()).id, tx.id);
  assert.equal(tx.state, "committed");
  assert.equal((await thrown(tx.commit())).code, "bad_state");

  const abandoned = await begin(work, { writes: ["work"], name: "tx-by-name" });
  assert.equal(abandoned.id, "tx-by-name");
  await abandoned.ctx.write("work/junk.txt", "x");
  await abandoned.rollback();
  assert.equal(abandoned.state, "rolled_back");
  assert.ok(!(await work.exists("work/junk.txt")));
});

test("first committer wins and the loser is told which paths", async () => {
  const { work } = await workspace();
  const a = await begin(work, { writes: ["work"] });
  const b = await begin(work, { writes: ["work"] });
  await a.ctx.write("work/plan.md", "from a\n");
  await b.ctx.write("work/plan.md", "from b\n");
  await b.ctx.write("work/b-only.md", "b\n");
  await a.commit();
  const error = await thrown(b.commit());
  assert.ok(error instanceof archil.Conflict);
  assert.deepEqual(error.paths, ["work/plan.md"]);
  assert.equal(b.state, "aborted");
  assert.equal(await work.readText("work/plan.md"), "from a\n");
  assert.ok(!(await work.exists("work/b-only.md"))); // all or nothing: b's other write was not applied either
});

test("turns that touch different paths both commit", async () => {
  const { work } = await workspace();
  const a = await begin(work, { writes: ["work"] });
  const b = await begin(work, { writes: ["work"] });
  await a.ctx.write("work/a.md", "a\n");
  await b.ctx.write("work/b.md", "b\n");
  assert.deepEqual((await a.commit()).applied, ["work/a.md"]);
  assert.deepEqual((await b.commit()).applied, ["work/b.md"]);
  assert.equal(await work.readText("work/a.md"), "a\n");
  assert.equal(await work.readText("work/b.md"), "b\n");
});

test("a change made outside any transaction also conflicts", async () => {
  const { work } = await workspace();
  const tx = await begin(work, { writes: ["work"] });
  await tx.ctx.write("work/plan.md", "turn\n");
  await work.write("work/plan.md", "someone edited this directly\n");
  await assert.rejects(tx.commit(), archil.Conflict);
  assert.equal(await work.readText("work/plan.md"), "someone edited this directly\n");
});

test("serializable also protects what the turn read", async () => {
  const { work, backend } = await workspace();
  await backend.put("reference", "prices.json", Buffer.from('{"usd": 10}'));
  const snapshot = await begin(work, { writes: ["work"] });
  const strict = await begin(work, { writes: ["work"], reads: ["ref/prices.json"], isolation: "serializable" });
  for (const tx of [snapshot, strict]) {
    const price = await tx.ctx.readText("ref/prices.json");
    await tx.ctx.write(`work/quote-${tx.isolation}.md`, `quoted from ${price}\n`);
  }
  await backend.put("reference", "prices.json", Buffer.from('{"usd": 12}')); // the input changes under both turns
  await snapshot.commit(); // snapshot isolation only checks what was written
  const error = await thrown(strict.commit());
  assert.ok(error instanceof archil.Conflict);
  assert.deepEqual(error.paths, ["ref/prices.json"]);
});

test("commit is one call per disk and reports what it applied", async () => {
  const { work, backend } = await workspace();
  const tx = await begin(work, { writes: ["work/out"] });
  for (let i = 0; i < 5; i++) await tx.ctx.write(`work/out/${i}.txt`, String(i));
  const before = backend.execLog.length;
  const commit = await tx.commit();
  assert.equal(commit.calls, 1);
  assert.equal(backend.execLog.length - before, 1);
  assert.deepEqual([...commit.applied].sort(), [0, 1, 2, 3, 4].map((i) => `work/out/${i}.txt`));
  const apply = backend.execLog.at(-1)!;
  assert.equal(apply.mounts.src.readOnly, true); // the turn's branch is read-only during the copy
  assert.ok("queueMs" in apply.mounts.dst); // an owned mount commits under its checkout
});

test("an empty turn commits without a call", async () => {
  const { work, backend } = await workspace();
  const tx = await begin(work, { writes: ["work"] });
  await tx.ctx.sh("cat {f}", { f: tx.ctx.path("work/plan.md") }).run();
  const before = backend.execLog.length;
  assert.ok((await tx.commit()).empty);
  assert.equal(backend.execLog.length, before);
});

test("backends that cannot branch say so", async () => {
  class NoBranches extends archil.LocalBackend {}

  const backend = new NoBranches({ root: join(tmp(), "x"), capabilities: ["grep"] });
  const ctx = await archil.context({ work: archil.disk("w", "owned", { create: true }) }, { backend });
  const error = await thrown(ctx.transaction(async () => {}));
  assert.ok(error instanceof archil.NotSupported);
  assert.ok(String(error).includes("checkpoint"));
  assert.throws(() => new archil.Transaction(ctx), archil.NotSupported);
});

// -- what async adds: turns that overlap in time, not only in what they touch

test("turns that commit at the same moment are still serialised", async () => {
  const { work } = await workspace();
  const turns = await Promise.all([1, 2, 3, 4].map(() => begin(work, { writes: ["work"] })));
  await Promise.all(turns.map((tx, i) => tx.ctx.write("work/plan.md", `from ${i}\n`)));
  const outcomes = await Promise.allSettled(turns.map((tx) => tx.commit()));
  const won = outcomes.filter((o) => o.status === "fulfilled");
  assert.equal(won.length, 1); // exactly one writer of plan.md gets in; the rest are told
  for (const o of outcomes) if (o.status === "rejected") assert.ok(o.reason instanceof archil.Conflict);
  const winner = outcomes.findIndex((o) => o.status === "fulfilled");
  assert.equal(await work.readText("work/plan.md"), `from ${winner}\n`);
});

test("the change manifest a commit leaves on the branch", async () => {
  const { work, backend } = await workspace();
  const tx = await begin(work, { writes: ["work"], name: "tx-manifest" });
  await tx.ctx.write("work/new file.md", "n\n");
  await tx.ctx.rm("work/notes/a.md");
  await tx.commit();
  // tab-separated W and D lines, under .px/ on the turn's branch: the format the Python SDK writes
  const manifest = Buffer.from(await backend.get("workspace@tx-manifest", ".px/tx/tx-manifest.changes")).toString();
  assert.equal(manifest, "W\tnew file.md\nD\tnotes/a.md\n");
  assert.equal(await work.readText("work/new file.md"), "n\n");
  assert.deepEqual((await work.ls("work", { recursive: true })).map((f) => f.path), ["work/new file.md", "work/plan.md"]);
});

test("a turn cannot write outside what it declared", async () => {
  const { work } = await workspace();
  const tx = await begin(work, { writes: ["work/notes"] });
  await tx.ctx.write("work/notes/b.md", "declared");
  await tx.ctx.write("work/elsewhere.md", "not declared");
  // the turn sees everything it did
  assert.deepEqual(await tx.changes(), new Map([["work", { written: ["elsewhere.md", "notes/b.md"], deleted: [] }]]));
  const error = await thrown(tx.commit());
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "undeclared_write");
  assert.ok(error.message.includes("work/elsewhere.md"));
  assert.equal(tx.state, "aborted");
  assert.equal(await work.exists("work/notes/b.md"), false); // refused whole, not applied in part
});

test("budget limits can be given as a plain object", async () => {
  const { work, backend } = await workspace();
  const capped = work.withBudget({ maxCalls: 1 });
  await capped.sh("true").run();
  await assert.rejects(capped.sh("true").run(), archil.BudgetExceeded);
  const born = await archil.context({ work: archil.disk("workspace", "owned") }, { backend, budget: { maxCalls: 0 } });
  await assert.rejects(born.sh("true").run(), archil.BudgetExceeded);
});
