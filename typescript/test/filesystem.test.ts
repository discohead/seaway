/** A context in the shape of the official `disk` package's FileSystem, for the official tools. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileSystem } from "disk";

import * as archil from "../src/index.ts";
import { seeded, thrown } from "./helpers.ts";

const text = (data: Uint8Array): string => Buffer.from(data).toString();

test("a context satisfies the official FileSystem interface", async () => {
  const { ctx, backend } = await seeded();
  // The assignment is the test: `npm run typecheck` fails if the adapter drifts from the interface.
  const fs: FileSystem = archil.asFileSystem(ctx);

  // objects are addressed by context path, and go through the context's rules
  assert.equal(text(await fs.getObject("ref/docs/b.md")), "beta\n");
  assert.deepEqual(await fs.putObject("work/notes/a.md", "mine"), {});
  await fs.putObject("/work/notes/b.bin", new Uint8Array([1, 2, 3]).buffer);
  assert.equal(await ctx.readText("work/notes/a.md"), "mine");
  assert.deepEqual([...(await ctx.read("work/notes/b.bin"))], [1, 2, 3]);
  await fs.deleteObject("work/notes/b.bin");
  await fs.deleteObject("work/notes/b.bin"); // deleting twice is fine, as on a disk
  assert.equal((await thrown(fs.putObject("ref/docs/b.md", "x"))).code, "read_only");
  // a missing object carries the status the official tools look for
  const missing = await thrown(fs.getObject("work/nope.txt"));
  assert.equal(missing.code, "not_found");
  assert.equal((missing as unknown as { status: number }).status, 404);

  // the root lists the mounts as directories; a prefix lists a directory
  const root = await fs.listObjects();
  assert.deepEqual(root.commonPrefixes, ["logs/", "ref/", "team/", "work/"]);
  assert.deepEqual(root.objects, []);
  const docs = await fs.listObjects("ref/docs/");
  assert.deepEqual(docs.objects.map((o) => [o.key, o.size]), [["ref/docs/a.md", 17], ["ref/docs/b.md", 5]]);
  assert.ok(docs.objects[0].lastModified instanceof Date && docs.objects[0].etag);
  const top = await fs.listObjects("ref");
  assert.deepEqual(top.commonPrefixes, ["ref/data/", "ref/docs/"]);
  const everything = await fs.listObjects(undefined, { recursive: true });
  assert.deepEqual(
    everything.objects.map((o) => o.key),
    ["ref/data/deep/n3.txt", "ref/data/n1.txt", "ref/data/n2.txt", "ref/docs/a.md", "ref/docs/b.md", "work/notes/a.md"],
  );
  const capped = await fs.listObjects("ref", { recursive: true, limit: 2 });
  assert.deepEqual([capped.keyCount, capped.isTruncated], [2, true]);

  // grep and exec are statements: planned, scoped and counted like any other
  const found = await fs.grep({ directory: "ref", pattern: "NEEDLE", recursive: true, ignoreCase: true });
  assert.deepEqual(found.matches, [{ file: "ref/docs/a.md", line: 2, text: "needle one" }]);
  assert.deepEqual([found.stoppedReason, found.filesScanned, found.containersDispatched], ["completed", 5, 1]);
  assert.deepEqual((await fs.grep({ directory: "ref", pattern: "needle" })).matches, []); // not recursive unless asked, as on a disk
  const ran = await fs.exec("cat ref/docs/b.md && echo hi > work/notes/c.md");
  assert.deepEqual([ran.exitCode, ran.stdout, ran.stderr], [0, "beta\n", ""]);
  assert.ok(ran.timing.totalMs >= 0);
  assert.equal(await ctx.readText("work/notes/c.md"), "hi\n");
  assert.equal(backend.execLog.length, 1);
  assert.equal(ctx.spend.statements, 3);
});

test("the adapter names its mounts, so the official tools treat it as a workspace", async () => {
  const { ctx } = await seeded();
  const narrowed = ctx.narrow(["ref/docs", "work"], { readOnly: true });
  const fs = archil.asFileSystem(narrowed);
  assert.deepEqual(fs.diskNames(), ["ref", "work"]);
  // narrowing carries over: the sibling directory is out of reach, and nothing can be written
  assert.equal((await thrown(fs.getObject("ref/data/n1.txt"))).code, "out_of_scope");
  assert.equal((await thrown(fs.putObject("work/x.txt", "x"))).code, "read_only");
  assert.deepEqual((await fs.listObjects("ref/docs")).objects.map((o) => o.key), ["ref/docs/a.md", "ref/docs/b.md"]);
});

test("the official tool layer runs over a context", async (t) => {
  // "disk/internal/tools" needs zod, which the official package leaves optional. Skip without it.
  const tools = await import("disk/internal/tools").catch(() => null);
  if (!tools) return t.skip("disk/internal/tools is not loadable here (it needs zod)");
  const { ctx } = await seeded();
  const bound = new Map(tools.bindSpecs(archil.asFileSystem(ctx)).map((spec) => [spec.name as string, spec]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = (name: string, args: object): Promise<any> => (bound.get(name)!.invoke as (a: object) => Promise<any>)(args);
  assert.ok(bound.get("read_file")!.description.includes("/logs/…, /ref/…, /work/…, /team/…")); // the workspace hint
  assert.deepEqual(await invoke("read_file", { path: "/ref/docs/b.md" }), { content: "beta\n", bytes: 5 });
  assert.deepEqual(await invoke("write_file", { path: "/work/a.md", content: "mine" }), { bytes: 4 });
  assert.deepEqual(await invoke("read_file", { path: "/work/nope.md" }), {
    error: { message: "file not found", status: 404, path: "/work/nope.md" },
  });
  assert.deepEqual((await invoke("list_files", {})).entries.map((e: { path: string }) => e.path), ["/logs/", "/ref/", "/team/", "/work/"]);
  assert.deepEqual((await invoke("glob", { pattern: "**/*.md", path: "/ref" })).content, "/ref/docs/a.md\n/ref/docs/b.md");
  assert.deepEqual((await invoke("grep", { pattern: "needle", path: "/ref" })).matches, [
    { path: "/ref/docs/a.md", line: 2, text: "needle one" },
  ]);
});
