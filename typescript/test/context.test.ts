/** Defining context: composition, modes, narrowing, manifests, locks. */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as archil from "../src/index.ts";
import { norm, render } from "../src/shell.ts";
import { fixture, seeded, thrown } from "./helpers.ts";

test("paths start with a mount and errors say which", async () => {
  const { ctx } = await fixture();
  const error = await thrown(ctx.read("nope/file.txt"));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "unknown_mount");
  assert.ok(error.suggestion!.includes("logs/…"));
});

test("dotdot is rejected before anything runs", () => {
  assert.throws(() => norm("logs/../secrets"), archil.ValidationError);
});

test("modes decide what can be written", async () => {
  const { ctx } = await fixture();
  await ctx.write("work/notes.md", "mine");
  await ctx.write("team/ana/notes.md", "ours");
  assert.equal(await ctx.readText("work/notes.md"), "mine");
  let error = await thrown(ctx.write("ref/docs/a.md", "x"));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "read_only");
  error = await thrown(ctx.write("logs/api/x.ndjson", "x"));
  assert.ok(error instanceof archil.ValidationError);
  assert.ok(error.suggestion!.includes("append"));
  await ctx.append("logs/raw.txt", "line\n"); // append-only mounts take appends
  await ctx.append("logs/raw.txt", "line\n");
  assert.equal(await ctx.readText("logs/raw.txt"), "line\nline\n");
});

test("scope with nothing declared mounts every disk in its own mode", async () => {
  const { ctx } = await fixture();
  const scope = ctx.scope([], []);
  assert.deepEqual(new Set(Object.keys(scope)), new Set(["logs", "ref", "work", "team"]));
  assert.ok(scope.logs.readOnly && scope.ref.readOnly);
  assert.ok(scope.work.queueMs && !scope.work.conditional); // owned: takes a checkout
  assert.ok(scope.team.conditional && scope.team.queueMs === null); // shared: conditional, no checkout
});

test("scope with declared paths is the smallest mount map", async () => {
  const { ctx } = await seeded();
  let scope = ctx.scope([["ref", "data/deep"]], []);
  assert.deepEqual(Object.keys(scope), ["ref/data/deep"]); // one disk, narrowed, at the same path the context uses
  const spec = scope["ref/data/deep"];
  assert.ok(spec.readOnly);
  assert.equal(spec.subdirectory, "data/deep");

  scope = ctx.scope([["ref", "data"]], [["work", "out/report.md"]]);
  assert.deepEqual(new Set(Object.keys(scope)), new Set(["ref/data", "work"]));
  assert.ok(!scope.work.readOnly);
});

test("narrow keeps path names and only removes access", async () => {
  const { ctx } = await seeded();
  await ctx.write("work/a/one.txt", "1");
  await ctx.write("work/b/two.txt", "2");
  const sub = ctx.narrow(["work/a", "ref/docs"]);
  assert.deepEqual(new Set(sub.mounts.keys()), new Set(["work", "ref"]));
  assert.equal(await sub.readText("work/a/one.txt"), "1"); // same path as in the parent
  const error = await thrown(sub.read("work/b/two.txt"));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "out_of_scope");
  // a command run in the narrowed context cannot see the sibling directory either
  const listing = (await sub.sh("find -L . -type f | sort").run()).text;
  assert.ok(listing.includes("work/a/one.txt") && !listing.includes("two.txt") && !listing.includes("data"));

  const ro = ctx.narrow(["work/a"], { readOnly: true });
  await assert.rejects(ro.write("work/a/one.txt", "changed"), archil.ValidationError);
});

test("manifest round trip", async () => {
  const { ctx, backend } = await seeded();
  const narrowed = ctx.narrow(["work/a", "ref/docs"], { readOnly: true });
  const again = await archil.fromManifest(narrowed.manifest(), { backend });
  assert.deepEqual(again.manifest(), narrowed.manifest());
  assert.equal(again.mounts.get("work")!.allow, "a");
  assert.equal(again.mounts.get("work")!.mode, "read");
});

test("lock freezes every mount at a checkpoint", async () => {
  const { ctx, backend } = await seeded();
  await ctx.write("work/model.txt", "v1");
  const manifest = await ctx.lock("eval-1");
  await ctx.write("work/model.txt", "v2");
  await backend.put("reference", "docs/a.md", Buffer.from("changed after the lock\n"));

  const frozen = await archil.fromManifest(manifest, { backend });
  assert.ok([...frozen.mounts.values()].every((m) => m.mode === "frozen"));
  assert.equal(await frozen.readText("work/model.txt"), "v1");
  assert.ok((await frozen.readText("ref/docs/a.md")).startsWith("alpha"));
  assert.equal((await frozen.sh("cat {f}", { f: frozen.path("work/model.txt") }).run()).text, "v1");
  await assert.rejects(frozen.write("work/model.txt", "v3"), archil.ValidationError);
  // opening the same lock twice is fine: the frozen branches are reused
  assert.equal(await (await archil.fromManifest(manifest, { backend })).readText("work/model.txt"), "v1");
});

test("lock keeps existing pins and narrowing", async () => {
  const { ctx, backend } = await seeded();
  await ctx.write("work/a/model.txt", "v1");
  await ctx.lock("r1");
  const pinned = await archil.context(
    { ref: archil.disk("reference", "frozen", { at: "r1" }), work: archil.disk("workspace", "owned") },
    { backend },
  );
  const second = await pinned.narrow(["work/a", "ref"]).lock("r2");
  assert.deepEqual(second.mounts.ref, { disk: "reference", mode: "frozen", at: "r1" }); // already pinned
  assert.deepEqual(second.mounts.work, { disk: "workspace", mode: "frozen", at: "r2", allow: "a" });
  await pinned.write("work/a/model.txt", "v2");
  const again = await archil.fromManifest(second, { backend });
  assert.equal(await again.readText("work/a/model.txt"), "v1");
  assert.equal(again.mounts.get("work")!.allow, "a");
});

test("a fork's manifest opens the fork", async () => {
  const { ctx, backend } = await seeded();
  const fork = await ctx.fork("try-1");
  await fork.write("work/idea.md", "from the fork");
  const reopened = await archil.fromManifest(fork.manifest(), { backend });
  assert.equal(await reopened.readText("work/idea.md"), "from the fork");
  assert.equal(await ctx.exists("work/idea.md"), false);
  const locked = await archil.fromManifest(await fork.lock("keep"), { backend }); // a lock of a fork pins the fork
  await fork.write("work/idea.md", "changed later");
  assert.equal(await locked.readText("work/idea.md"), "from the fork");
});

test("fork gives each attempt its own writes", async () => {
  const { ctx } = await seeded();
  await ctx.write("work/plan.md", "start");
  const a = await ctx.fork("attempt-a");
  const b = await ctx.fork("attempt-b");
  await a.write("work/plan.md", "a's idea");
  await b.sh('echo "b\'s idea" > {f}', { f: b.out("work/plan.md") }).run({ check: true });
  assert.equal(await ctx.readText("work/plan.md"), "start");
  assert.equal(await a.readText("work/plan.md"), "a's idea");
  assert.equal((await b.readText("work/plan.md")).trim(), "b's idea");
});

test("describe fits in a prompt", async () => {
  const { ctx } = await fixture();
  const text = ctx.describe();
  assert.ok(text.includes("logs/") && text.includes("append") && text.includes("service logs"));
  assert.ok(text.length < 800);
});

test("templates leave ordinary shell braces alone", () => {
  const out = render(
    "awk '{print $1}' {file} | head -n {n}; echo ${HOME} {a,b}",
    { file: "f", n: 3 },
    (_name, value) => `<${value}>`,
  );
  assert.equal(out, "awk '{print $1}' <f> | head -n <3>; echo ${HOME} {a,b}");
});

test("rm takes a file or a directory but never a whole disk", async () => {
  const { ctx } = await fixture();
  await ctx.write("work/tree/a.txt", "a");
  await ctx.write("work/tree/deep/b.txt", "b");
  await ctx.write("work/keep.txt", "k");
  await ctx.rm("work/tree");
  await ctx.rm("work/never-there");
  assert.deepEqual((await ctx.ls("work", { recursive: true })).map((f) => f.path), ["work/keep.txt"]);
  for (const whole of ["work", "work/"]) assert.equal((await thrown(ctx.rm(whole))).code, "bad_path");
  assert.ok(await ctx.exists("work/keep.txt"));
});

test("turns, locks and forks count their checkpoints", async () => {
  const { ctx } = await seeded();
  const before = ctx.spend.snapshot().callUnits;
  const spent = (): number => ctx.spend.snapshot().callUnits - before;
  await ctx.transaction(async (turn) => void (await turn.write("work/a.txt", "x")), { writes: ["work"] });
  assert.equal(spent(), 2); // the checkpoint the turn starts from, and the apply
  await ctx.lock("eval-1"); // four mounts
  await ctx.fork("attempt-1"); // two writable mounts
  assert.equal(spent(), 2 + 4 + 2);
  assert.ok((await thrown(ctx.lock("eval-1"))) instanceof archil.ValidationError); // the name is taken
  assert.equal(spent(), 2 + 4 + 2 + 1); // the first refusal still cost a call
});

test("the journal stamps each entry when it happened", async () => {
  const { backend } = await fixture();
  const ctx = await archil.context({ work: archil.disk("w", "owned", { create: true }) }, { backend, journal: "work/journal" });
  await ctx.sh("true").run();
  assert.equal(ctx.journalPending, 0);
  const lines: string[] = [];
  for (const f of await ctx.ls("work/journal", { recursive: true })) lines.push(...(await ctx.readText(f.path)).split("\n").filter(Boolean));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).slice(0, 3), ["ts", "id", "kind"]);
  assert.ok(entry.ts.endsWith("Z") && entry.id.length === 12);
});
