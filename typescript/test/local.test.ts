/**
 * The local backend: the layout on disk, the two ways of mounting, and the limits.
 *
 * The Python suite reaches these only through the framework. They are pinned here
 * because both SDKs have to be able to work on one root.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as archil from "../src/index.ts";
import { newBackend, thrown, tmp } from "./helpers.ts";

const bytes = (text: string): Uint8Array => Buffer.from(text);
const vm = new archil.Vm();
const ro = (disk: string, subdirectory?: string): archil.MountSpec => new archil.MountSpec(disk, { subdirectory, readOnly: true });
const rw = (disk: string): archil.MountSpec => new archil.MountSpec(disk, { queueMs: 5000 });

test("disks, branches and checkpoints are directories under the root", async () => {
  const backend = newBackend();
  assert.equal(await backend.resolveDisk("work", { create: true }), "work");
  assert.equal((await thrown(backend.resolveDisk("missing"))).code, "unknown_disk");
  await backend.put("work", "a/b.txt", bytes("one"));
  assert.ok(existsSync(join(backend.root, "disks/work/a/b.txt")));

  assert.equal(await backend.checkpoint("work", "cp1"), "cp1");
  assert.ok(existsSync(join(backend.root, "checkpoints/work/cp1/a/b.txt")));
  assert.equal((await thrown(backend.checkpoint("work", "cp1"))).code, "exists");
  assert.equal(await backend.branch("work", "try", "cp1"), "work@try");
  assert.ok(existsSync(join(backend.root, "disks/work@try/a/b.txt")));
  assert.equal((await thrown(backend.branch("work", "try", "cp1"))).code, "exists");
  assert.equal(await backend.branch("work", "try", "cp1", { existOk: true }), "work@try");
  assert.equal((await thrown(backend.branch("work", "other", "no-such"))).code, "not_found");

  // a copy keeps the file's timestamp, so its version is the same on the branch as on the disk
  const [main] = await backend.list("work");
  const [copy] = await backend.list("work@try");
  assert.deepEqual([copy.key, copy.size, copy.version, copy.modified], [main.key, main.size, main.version, main.modified]);
  // and a write to the branch leaves the disk alone
  await backend.put("work@try", "a/b.txt", bytes("changed"));
  assert.equal(Buffer.from(await backend.get("work", "a/b.txt")).toString(), "one");
});

test("a version is the modification time in nanoseconds and the size, in hex", async () => {
  const backend = newBackend();
  await backend.resolveDisk("d", { create: true });
  await backend.put("d", "f.txt", bytes("hello"));
  const st = statSync(join(backend.root, "disks/d/f.txt"), { bigint: true });
  const head = (await backend.head("d", "f.txt"))!;
  assert.equal(head.version, `${st.mtimeNs.toString(16)}-5`);
  assert.equal(head.etag, head.version);
  assert.ok(Math.abs(head.modified - Number(st.mtimeNs) / 1e9) < 1e-6);
  assert.equal(await backend.head("d", "nope"), null);
  assert.equal(await backend.head("d", ""), null); // a directory is not an object
  // without an etag, the version is the modification time as Python prints a float
  assert.equal(new archil.ObjectInfo("k", 1, 1794182400).version, "1794182400.0");
  assert.equal(new archil.ObjectInfo("k", 1, 1794182400.5, "tag").version, "tag");
  assert.equal(new archil.ObjectInfo("dir/", 0).version, "0.0");
});

test("objects: get, put, append and delete", async () => {
  const backend = newBackend({ limits: new archil.Limits({ appendMaxBytes: 8 }) });
  await backend.resolveDisk("d", { create: true });
  const missing = await thrown(backend.get("d", "nope.txt"));
  assert.deepEqual([missing.code, missing.path, missing.message], ["not_found", "nope.txt", "no such file: nope.txt"]);
  assert.equal((await thrown(backend.get("d", ""))).code, "not_found"); // a directory

  await backend.put("d", "x/y.txt", bytes("1"), { ifAbsent: true });
  const exists = await thrown(backend.put("d", "x/y.txt", bytes("2"), { ifAbsent: true }));
  assert.deepEqual([exists.code, exists.message], ["exists", "already exists: x/y.txt"]);
  await backend.put("d", "x/y.txt", bytes("3"));
  assert.equal(Buffer.from(await backend.get("d", "x/y.txt")).toString(), "3");
  assert.deepEqual(readdirSync(join(backend.root, "disks/d/x")), ["y.txt"]); // the temporary file is gone

  await backend.append("d", "log/a.txt", bytes("12345678"));
  await backend.append("d", "log/a.txt", bytes("9"));
  assert.equal(Buffer.from(await backend.get("d", "log/a.txt")).toString(), "123456789");
  const tooBig = await thrown(backend.append("d", "log/a.txt", bytes("123456789")));
  assert.deepEqual([tooBig.code, tooBig.message], ["invalid", "append larger than 8 bytes"]);

  await backend.delete("d", "x/y.txt");
  await backend.delete("d", "x/y.txt"); // deleting what is not there is not an error
  await backend.delete("d", "log"); // a directory goes with everything in it
  assert.deepEqual(await backend.list("d"), []);
});

test("a listing is each directory's files, then its sub-directories, in code-point order", async () => {
  const backend = newBackend();
  await backend.resolveDisk("d", { create: true });
  const astral = String.fromCodePoint(0x1f600);
  const high = String.fromCodePoint(0xffff);
  // Not every file system can hold the whole fixture: macOS's default one folds case and refuses
  // U+FFFF in a name. There the test runs without those two entries.
  const probe = tmp();
  mkdirSync(join(probe, "sub"));
  const caseSensitive = !existsSync(join(probe, "Sub"));
  let nonCharacters = true;
  try {
    writeFileSync(join(probe, `${high}.txt`), "x");
  } catch {
    nonCharacters = false;
  }
  const holds = (path: string): boolean => (nonCharacters || !path.includes(high)) && (caseSensitive || !path.includes("Sub/"));
  const expected = (paths: string[]): string[] => paths.filter(holds);
  for (const key of ["z.txt", "B.txt", "a.txt", `${astral}.txt`, `${high}.txt`, "sub/b.txt", "sub/a.txt", "Sub/x.txt", ".archil/meta", "sub/.archil/x", ".px/state"].filter(holds)) {
    await backend.put("d", key, bytes("x"));
  }
  const keys = async (prefix: string, recursive: boolean): Promise<string[]> =>
    (await backend.list("d", prefix, { recursive })).map((o) => o.key);
  assert.deepEqual(await keys("", true), expected([
    "B.txt",
    "a.txt",
    "z.txt",
    `${high}.txt`, // U+FFFF before the astral character: code-point order, not UTF-16
    `${astral}.txt`,
    ".px/state",
    "Sub/x.txt",
    "sub/a.txt",
    "sub/b.txt",
  ]));
  // not recursive: sub-directories first, as keys ending in "/", then the files
  assert.deepEqual(await keys("", false), expected([".px/", "Sub/", "sub/", "B.txt", "a.txt", "z.txt", `${high}.txt`, `${astral}.txt`]));
  assert.deepEqual(await keys("sub", false), ["sub/a.txt", "sub/b.txt"]);
  assert.deepEqual(await keys("sub/a.txt", true), ["sub/a.txt"]); // a file lists as itself
  assert.deepEqual(await keys("nope", true), []);
  // a context hides its own bookkeeping, and expands in the same order
  const ctx = await archil.context({ d: archil.disk("d", "owned") }, { backend });
  assert.deepEqual((await ctx.ls("d")).map((f) => f.path), expected(["d/Sub/", "d/sub/", "d/B.txt", "d/a.txt", "d/z.txt", `d/${high}.txt`, `d/${astral}.txt`]));
  assert.deepEqual((await ctx.expand("d")).map((f) => f.path), expected([
    "d/B.txt",
    "d/Sub/x.txt",
    "d/a.txt",
    "d/sub/a.txt",
    "d/sub/b.txt",
    "d/z.txt",
    `d/${high}.txt`,
    `d/${astral}.txt`,
  ]));
});

test("a symlinked directory is listed but not followed", async () => {
  const backend = newBackend();
  await backend.resolveDisk("d", { create: true });
  await backend.put("d", "real/f.txt", bytes("x"));
  const outside = join(tmp(), "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(backend.root, "disks/d/link"));
  symlinkSync(join(outside, "secret.txt"), join(backend.root, "disks/d/file-link"));
  symlinkSync(join(outside, "gone"), join(backend.root, "disks/d/broken"));
  assert.deepEqual((await backend.list("d", "", { recursive: true })).map((o) => o.key), ["file-link", "real/f.txt"]);
  assert.deepEqual((await backend.list("d", "", { recursive: false })).map((o) => o.key), ["link/", "real/", "file-link"]);
});

test("a call sees its mounts at the planned paths, and nothing else survives it", async () => {
  const backend = newBackend();
  for (const disk of ["ref", "work"]) await backend.resolveDisk(disk, { create: true });
  await backend.put("ref", "docs/a.md", bytes("alpha\n"));
  const out = await backend.exec(
    { "ref/docs": ro("ref", "docs"), work: rw("work") },
    'cat ref/docs/a.md; echo "$ARCHIL_ROOT" > work/root.txt; echo scratch > left-behind.txt; pwd',
    vm,
  );
  assert.deepEqual([out.exitCode, out.stderr, out.truncated, out.queueMs], [0, "", false, 0]);
  assert.ok(out.executeMs > 0 && out.totalMs === out.executeMs);
  const [first, cwd] = out.stdout.split("\n");
  assert.equal(first, "alpha");
  assert.ok(cwd.startsWith(join(backend.root, "calls")) && cwd.endsWith("/mnt"));
  assert.equal(Buffer.from(await backend.get("work", "root.txt")).toString().trim(), cwd); // ARCHIL_ROOT is the working directory
  assert.deepEqual(readdirSync(join(backend.root, "calls")), []); // the call's directory is gone
  assert.deepEqual(backend.execLog, [
    {
      mounts: {
        "ref/docs": { disk: "ref", readOnly: true, conditional: false, subdirectory: "docs" },
        work: { disk: "work", readOnly: false, conditional: false, queueMs: 5000 },
      },
      command: 'cat ref/docs/a.md; echo "$ARCHIL_ROOT" > work/root.txt; echo scratch > left-behind.txt; pwd',
    },
  ]);

  // a writable mount of a directory that is not there yet creates it; a read-only one fails the call
  assert.equal((await backend.exec({ w: new archil.MountSpec("work", { subdirectory: "new/dir" }) }, "echo x > w/f", vm)).exitCode, 0);
  assert.ok(existsSync(join(backend.root, "disks/work/new/dir/f")));
  const failed = await backend.exec({ r: ro("ref", "nope") }, "true", vm);
  assert.deepEqual([failed.exitCode, failed.stdout, failed.stderr], [1, "", "mount failed: r: no such directory on ref"]);
  assert.equal(backend.execLog.length, 2); // a call that never started is not logged
});

test("output is cut after its first bytes, and commands have a size and a time limit", async () => {
  const backend = newBackend({ limits: new archil.Limits({ maxOutputBytes: 40, maxCommandBytes: 64, execTimeoutS: 0.4 }) });
  await backend.resolveDisk("d", { create: true });
  const mounts = { d: rw("d") };
  let out = await backend.exec(mounts, "printf %040d 7", vm);
  assert.deepEqual([out.stdout.length, out.truncated], [40, false]); // it fits: nothing is cut
  // as Archil cuts a stream: its first bytes, then a marker, and no more than the limit in all
  out = await backend.exec(mounts, "printf START; printf %0100d 7; printf END; printf xyz >&2", vm);
  assert.deepEqual([out.stdout, out.stderr, out.truncated], ["START" + "0".repeat(16) + "\n[output truncated]", "xyz", true]);
  assert.equal(archil.TRUNCATED_MARK, "\n[output truncated]");
  out = await backend.exec(mounts, "exit 7", vm);
  assert.equal(out.exitCode, 7);
  out = await backend.exec(mounts, "kill -TERM $$", vm);
  assert.equal(out.exitCode, -15); // ended by a signal: the negative signal number
  out = await backend.exec(mounts, "cat; echo done", vm);
  assert.equal(out.stdout, "done\n"); // no stdin, as on Archil: nothing to wait for

  out = await backend.exec(mounts, "echo started; printf %0100d 7 >&2; sleep 5", vm);
  assert.equal(out.exitCode, 124);
  assert.equal(out.stdout, "started\n");
  assert.ok(out.stderr.endsWith("\n[output truncated]\nExec timed out"), out.stderr); // the backend's note is never cut
  assert.ok(out.executeMs < 3000);

  const before = backend.execLog.length;
  out = await backend.exec(mounts, "echo " + "x".repeat(64), vm);
  assert.deepEqual([out.exitCode, out.stdout, out.stderr], [1, "", "command exceeds 64 bytes"]);
  assert.equal(backend.execLog.length, before);
});

for (const isolation of ["namespace", "symlink"]) {
  test(`a read-only mount is read-only (${isolation})`, async (t) => {
    const backend = newBackend({ isolation });
    if (backend.isolation !== isolation) return t.skip(`ARCHIL_LOCAL_ISOLATION forces ${backend.isolation}`);
    if (isolation === "namespace" && !newBackend().isolation.startsWith("namespace")) {
      return t.skip("this host has no unprivileged mount namespaces");
    }
    for (const disk of ["ref", "work"]) await backend.resolveDisk(disk, { create: true });
    await backend.put("ref", "docs/a.md", bytes("alpha\n"));
    const mounts = { "ref/docs": ro("ref", "docs"), work: rw("work") };

    const ok = await backend.exec(mounts, "cat ref/docs/a.md > work/copy.md && find -L . -type f | sort", vm);
    assert.deepEqual([ok.exitCode, ok.stdout], [0, "./ref/docs/a.md\n./work/copy.md\n"]);

    const out = await backend.exec(mounts, "echo tamper >> ref/docs/a.md", vm);
    assert.notEqual(out.exitCode, 0);
    assert.ok(out.stderr.includes("Read-only file system"), out.stderr);
    const after = Buffer.from(await backend.get("ref", "docs/a.md")).toString();
    if (isolation === "namespace") {
      assert.equal(after, "alpha\n"); // the write was refused
    } else {
      // without namespaces the write lands and is reported after the command, as EROFS
      assert.equal(after, "alpha\ntamper\n");
      assert.equal(out.exitCode, 30);
      assert.ok(out.stderr.endsWith(
        "\nRead-only file system: ref/docs/a.md was modified. (Without mount namespaces the local backend " +
          "detects this after the command; Archil refuses the write.)",
      ));
      const unchecked = newBackend({ isolation, verifyReadOnly: false });
      await unchecked.resolveDisk("ref", { create: true });
      assert.equal((await unchecked.exec({ ref: ro("ref") }, "echo x > ref/new.txt", vm)).exitCode, 0);
    }
  });
}

test("the isolation mode can be forced from the environment", () => {
  const saved = process.env.ARCHIL_LOCAL_ISOLATION;
  try {
    process.env.ARCHIL_LOCAL_ISOLATION = "symlink";
    assert.equal(newBackend({ isolation: "namespace" }).isolation, "symlink"); // the environment wins
    delete process.env.ARCHIL_LOCAL_ISOLATION;
    assert.equal(newBackend({ isolation: "symlink" }).isolation, "symlink");
    assert.ok(["namespace", "symlink"].includes(newBackend().isolation)); // "auto" settles on one
  } finally {
    if (saved === undefined) delete process.env.ARCHIL_LOCAL_ISOLATION;
    else process.env.ARCHIL_LOCAL_ISOLATION = saved;
  }
});

test("grep on the local backend", async () => {
  const backend = newBackend({ limits: new archil.Limits({ grepMaxResults: 3 }) });
  await backend.resolveDisk("d", { create: true });
  const separator = String.fromCodePoint(0x2028);
  await backend.put("d", "a.txt", bytes(`one\nNeedle two\nneedle${separator}three\n`));
  await backend.put("d", "sub/b.md", bytes("needle in b\n"));
  await backend.put("d", ".archil/x.txt", bytes("needle in the reserved directory\n"));
  const sortHits = (hits: archil.GrepHit[]): archil.GrepHit[] => [...hits].sort((a, b) => (a.file + a.line < b.file + b.line ? -1 : 1));

  let [hits, reason] = await backend.grep("d", "", "needle");
  assert.equal(reason, "completed");
  // a line separator inside a matched line does not break the search (it does in the Python backend)
  assert.deepEqual(sortHits(hits), [
    { file: "a.txt", line: 3, text: `needle${separator}three` },
    { file: "sub/b.md", line: 1, text: "needle in b" },
  ]);
  [hits] = await backend.grep("d", "", "needle", { ignoreCase: true, recursive: false });
  assert.deepEqual(hits.map((h) => h.line), [2, 3]);
  [hits] = await backend.grep("d", "", "needle", { globs: ["*.md"] });
  assert.deepEqual(hits.map((h) => h.file), ["sub/b.md"]);
  [hits] = await backend.grep("d", "sub", "needle");
  assert.deepEqual(hits, [{ file: "sub/b.md", line: 1, text: "needle in b" }]);
  assert.deepEqual(await backend.grep("d", "nope", "needle"), [[], "completed"]);

  [hits, reason] = await backend.grep("d", "", "e", { maxResults: 2 });
  assert.deepEqual([hits.length, reason], [2, "max_results"]);
  [hits, reason] = await backend.grep("d", "", "e");
  assert.deepEqual([hits.length, reason], [3, "max_results"]); // the backend's own limit
});

test("commits to one disk wait for each other", async () => {
  const backend = newBackend();
  const order: string[] = [];
  const hold = async (disk: string, name: string, ms: number): Promise<void> => {
    const release = await backend.commitLock(disk);
    order.push(`${name} in`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name} out`);
    release();
  };
  // a branch shares its disk's lock; another disk does not wait
  await Promise.all([hold("work", "a", 30), hold("work@tx-1", "b", 1), hold("other", "c", 1)]);
  assert.deepEqual(order.filter((e) => !e.startsWith("c")), ["a in", "a out", "b in", "b out"]);
  assert.ok(order.indexOf("c out") < order.indexOf("a out"));
});

test("a share link on the local backend is a file URL", async () => {
  const backend = newBackend();
  await backend.resolveDisk("d", { create: true });
  await backend.put("d", "it's here @ (1).txt", bytes("x"));
  const ctx = await archil.context({ d: archil.disk("d") }, { backend });
  // percent-encoded as Python's Path.as_uri() encodes it
  assert.equal(await ctx.share("d/it's here @ (1).txt"), `file://${backend.root}/disks/d/it%27s%20here%20%40%20%281%29.txt`);
});
