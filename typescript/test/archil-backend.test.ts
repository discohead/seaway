/**
 * The Archil backend, checked against a stand-in for the official client.
 *
 * These tests do not reach Archil. They pin down the exact calls the backend makes
 * through the official `disk` package, so that what a plan says it will do and what
 * is sent are the same thing. The stand-in behaves the way the live service was
 * seen to behave on 9 November 2026: a listing carries an entry per directory, an
 * ETag does not move when a file is rewritten through a mount, and a path under
 * someone's checkout answers 409.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Archil, ExecMountSpec, ExecOptions } from "disk";

import { wrap } from "../src/archil-backend.ts";
import { clock } from "../src/context.ts";
import * as archil from "../src/index.ts";
import { thrown } from "./helpers.ts";

// The official package is an optional peer dependency: without it there is nothing to check against.
const sdk = await import("disk").catch(() => null);
const needsSdk = { skip: sdk ? false : "the official disk package is not installed" };

type Call = unknown[];
const WHEN = new Date("2026-11-09T00:00:00Z");
const later = (seconds: number): Date => new Date(WHEN.getTime() + seconds * 1000);
const bytes = (text: string): Buffer => Buffer.from(text);
type Meta = { key: string; size: number; etag: string; lastModified: Date };

class FakeDisk implements archil.ArchilDisk {
  readonly id: string;
  readonly name: string;
  readonly calls: Call[];
  readonly objects = new Map<string, Uint8Array>();
  readonly etags = new Map<string, string>();
  readonly modified = new Map<string, Date>();
  /** a client holds a checkout of the whole disk */
  busy = false;
  readonly checkpoints = new Set<string>();
  readonly branches = new Map<string, string>();

  constructor(id: string, name: string, calls: Call[]) {
    this.id = id;
    this.name = name;
    this.calls = calls;
  }

  /** How the service stamps a file: an ETag from the content when it comes through the object API. */
  stamp(key: string, body: Uint8Array, at: Date = WHEN): void {
    this.objects.set(key, body);
    this.etags.set(key, `"etag-${body.length}-${Buffer.from(body).toString("hex").slice(0, 6)}"`);
    this.modified.set(key, at);
  }

  /** A command rewrites the file in place through a mount: new bytes and time, the same ETag. */
  mountWrite(key: string, body: Uint8Array, at: Date): void {
    this.objects.set(key, body);
    this.modified.set(key, at);
  }

  #refuseIfBusy(operation: string): void {
    if (!this.busy) return;
    throw new sdk!.ArchilS3Error({
      operation,
      statusCode: 409,
      code: "OperationAborted",
      message: "The destination path has a conflicting write delegation held by another client.",
      raw: "",
    });
  }

  #meta(key: string): Meta {
    return { key, size: this.objects.get(key)!.length, etag: this.etags.get(key)!, lastModified: this.modified.get(key)! };
  }

  async getObject(key: string): Promise<Uint8Array> {
    this.calls.push(["getObject", this.id, key]);
    const body = this.objects.get(key);
    if (!body) throw new sdk!.ArchilS3Error({ operation: "GetObject", statusCode: 404, code: "NoSuchKey", raw: "" });
    return body;
  }

  async putObject(key: string, body: Uint8Array): Promise<object> {
    this.calls.push(["putObject", this.id, key]);
    this.#refuseIfBusy("PutObject");
    this.stamp(key, body);
    return {};
  }

  async appendObject(key: string, body: Uint8Array): Promise<object> {
    this.calls.push(["appendObject", this.id, key, body.length]);
    this.#refuseIfBusy("AppendObject");
    this.stamp(key, Buffer.concat([this.objects.get(key) ?? Buffer.alloc(0), body]));
    return {};
  }

  async deleteObject(key: string): Promise<void> {
    this.calls.push(["deleteObject", this.id, key]);
    this.#refuseIfBusy("DeleteObject");
    this.objects.delete(key);
  }

  async deleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: { key: string; code?: string; message?: string }[] }> {
    this.calls.push(["deleteObjects", this.id, [...keys]]);
    for (const key of keys) this.objects.delete(key);
    return { deleted: [...keys], errors: [] };
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async headObject(key: string): Promise<Meta | null> {
    return this.objects.has(key) ? this.#meta(key) : null;
  }

  #directories(): string[] {
    const out = new Set<string>();
    for (const key of this.objects.keys()) {
      const parts = key.split("/").slice(0, -1);
      parts.forEach((_, i) => out.add(parts.slice(0, i + 1).join("/") + "/"));
    }
    return [...out].sort();
  }

  async listObjects(prefix?: string, options: { recursive?: boolean } = {}) {
    this.calls.push(["listObjects", this.id, prefix, options.recursive ?? false]);
    const under = prefix ?? "";
    const files = [...this.objects.keys()].filter((key) => key.startsWith(under)).sort();
    if (options.recursive) {
      const markers: Meta[] = this.#directories()
        .filter((d) => d.startsWith(under))
        .map((key) => ({ key, size: 0, etag: '"d41d8"', lastModified: WHEN }));
      const objects = [...files.map((key) => this.#meta(key)), ...markers].sort((a, b) => (a.key < b.key ? -1 : 1));
      return { objects, commonPrefixes: [] as string[] };
    }
    const here = files.filter((key) => !key.slice(under.length).includes("/"));
    const below = new Set(
      files.filter((key) => key.slice(under.length).includes("/")).map((key) => under + key.slice(under.length).split("/")[0] + "/"),
    );
    return { objects: here.map((key) => this.#meta(key)), commonPrefixes: [...below].sort() };
  }

  async grep(options: object) {
    this.calls.push(["grep", this.id, options]);
    return { matches: [{ file: "api/x.log", line: 7, text: "ERROR boom" }], stoppedReason: "completed" };
  }

  async share(key: string, options: { expiresIn?: number } = {}) {
    return { url: `https://share.example/${key}?e=${options.expiresIn}` };
  }

  async createBranch(options: { name: string; fromCheckpoint: string }) {
    this.calls.push(["createBranch", this.id, options.name, options.fromCheckpoint]);
    if (!this.checkpoints.has(options.fromCheckpoint)) {
      throw new sdk!.ArchilApiError(`Checkpoint "${options.fromCheckpoint}" not found`, 404, "not_found");
    }
    if (this.branches.has(options.name)) throw new sdk!.ArchilApiError(`Branch "${options.name}" already exists`, 409, "conflict");
    this.branches.set(options.name, `dsk-branch-${options.name}`);
    return { filesystem_id: `dsk-branch-${options.name}` };
  }

  async getBranch(name: string) {
    this.calls.push(["getBranch", this.id, name]);
    return { filesystem_id: this.branches.get(name)! };
  }
}

class FakeClient implements archil.ArchilClient {
  readonly calls: Call[] = [];
  readonly store = new Map<string, FakeDisk>([
    ["dsk-logs", new FakeDisk("dsk-logs", "app-logs", this.calls)],
    ["dsk-work", new FakeDisk("dsk-work", "workspace", this.calls)],
  ]);
  answer = { exitCode: 0, stdout: "ok\n", stderr: "" };
  /** an error the next exec throws instead of answering */
  refuse: Error | null = null;

  readonly disks = {
    list: async (options: { name?: string } = {}) => [...this.store.values()].filter((d) => d.name === options.name),
    get: async (id: string) => {
      if (!this.store.has(id)) this.store.set(id, new FakeDisk(id, id, this.calls));
      return this.store.get(id)!;
    },
    create: async (request: { name: string }) => {
      const disk = new FakeDisk(`dsk-new-${request.name}`, request.name, this.calls);
      this.store.set(disk.id, disk);
      return { disk, token: "adt_once" };
    },
  };

  async exec(options: ExecOptions) {
    const { disks, command, ...vm } = options;
    this.calls.push(["exec", disks, command, vm]);
    if (this.refuse) throw this.refuse;
    const named = /archil checkpoints create disk (.+)\n/.exec(command);
    if (named) {
      const disk = this.store.get((disks.disk as ExecMountSpec).disk as string)!;
      if (disk.checkpoints.has(named[1])) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'Failed to create checkpoint: ServerError("Failed to create checkpoint: InvalidArguments")\n',
          timing: { queueMs: 1, executeMs: 1, totalMs: 2 },
        };
      }
      disk.checkpoints.add(named[1]);
    }
    return { ...this.answer, timing: { queueMs: 37, executeMs: 45, totalMs: 82 } };
  }

  /** The recorded execs, as [mount map, command, VM options]. */
  execs(): [Record<string, ExecMountSpec>, string, Record<string, unknown>][] {
    return this.calls
      .filter((c) => c[0] === "exec")
      .map((c) => [c[1], c[2], c[3]] as [Record<string, ExecMountSpec>, string, Record<string, unknown>]);
  }
}

async function setup(options: { limits?: archil.Limits; journal?: string } = {}): Promise<{ client: FakeClient; ctx: archil.Context }> {
  const client = new FakeClient();
  const backend = new archil.ArchilBackend({ client, limits: options.limits });
  const ctx = await archil.context(
    {
      logs: archil.disk("app-logs", "append"),
      work: archil.disk("workspace", "owned"),
      team: archil.disk("team-notes", "shared", { create: true }),
    },
    { backend, journal: options.journal },
  );
  return { client, ctx };
}

test("the official client satisfies the part of it this backend calls", () => {
  // compile-time checks: they fail in `npm run typecheck`, not here
  const client: archil.ArchilClient | null = null as Archil | null;
  const fake: archil.ArchilClient = new FakeClient();
  assert.ok(client === null && fake);
});

test("disks resolve by name and are created only on request", needsSdk, async () => {
  const { client, ctx } = await setup();
  assert.equal(ctx.mounts.get("logs")!.handle, "dsk-logs");
  assert.equal(ctx.mounts.get("team")!.handle, "dsk-new-team-notes");
  const error = await thrown(archil.context({ x: archil.disk("missing") }, { backend: new archil.ArchilBackend({ client }) }));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "unknown_disk");
});

test("a statement becomes one exec with the planned mount map", needsSdk, async () => {
  const { client, ctx } = await setup();
  client.store.get("dsk-logs")!.stamp("api/2026-11-09/14/web-1.ndjson", bytes("{}\n"));
  const result = await ctx.sh("wc -l {f}", { f: ctx.path("logs/api/2026-11-09/14/web-1.ndjson") }).run();
  assert.equal(client.execs().length, 1);
  const [disks, command, vm] = client.execs()[0];
  assert.equal(command, wrap("wc -l logs/api/2026-11-09/14/web-1.ndjson"));
  assert.deepEqual(vm, {});
  const spec: ExecMountSpec = disks["logs/api/2026-11-09/14"]; // the official mount spec, field for field
  assert.deepEqual(spec, { disk: "dsk-logs", subdirectory: "api/2026-11-09/14", readOnly: true, conditional: false });
  assert.equal(result.text, "ok\n");
  assert.equal(result.meta.queueMs, 37);
  assert.equal(result.meta.executeMs, 45);
});

test("the command starts where the disks are and is run by bash", () => {
  const sent = wrap("set -o pipefail; diff <(echo a) <(echo a)");
  assert.equal(sent.split("\n")[0], "cd /mnt/archil || exit 1");
  assert.ok(sent.includes("px_script=$(cat <<'PX_EOF'\nset -o pipefail; diff <(echo a) <(echo a)\nPX_EOF\n)"));
  assert.ok(sent.endsWith('then exec bash -c "$px_script"; else exec sh -c "$px_script"; fi'));
  // the command is not quoted, so it does not grow; and a line that is the marker moves the marker
  assert.ok(wrap("x".repeat(90_000)).length < 90_000 + 200);
  assert.ok(wrap("cat <<PX_EOF\nhi\nPX_EOF").includes("<<'PX_EOF_'\ncat <<PX_EOF\nhi\nPX_EOF\nPX_EOF_\n"));
});

test("mount modes map to archil mount modes", needsSdk, async () => {
  const { client, ctx } = await setup();
  await ctx.sh("echo hi > {f}", { f: ctx.out("team/ana/hi.txt") }).run();
  await ctx.sh("echo hi > {f}", { f: ctx.out("work/hi.txt") }).run();
  const [shared, owned] = client.execs();
  assert.equal(shared[0].team.conditional, true); // shared: conditional, no checkout
  assert.ok(!("queueMs" in shared[0].team));
  assert.ok(!shared[1].includes("archil checkout"));
  // owned: a checkout, asked for with the mount spec's own field, which waits in line for it. The
  // Python client has no such field, so that backend takes the checkout at the start of the command.
  assert.deepEqual(owned[0].work, { disk: "dsk-work", readOnly: false, conditional: false, queueMs: 5000 });
  assert.equal(owned[1], wrap("echo hi > work/hi.txt"));
});

test("vm size and image are passed through", needsSdk, async () => {
  const { client, ctx } = await setup();
  await ctx.sh("true").sized({ vcpu: 8, memMib: 16384, image: "python:3.13" }).run();
  assert.deepEqual(client.execs()[0][2], { vcpuCount: 8, memSizeMib: 16384, baseImage: "python:3.13" });
});

test("an egress policy becomes the network of the call", needsSdk, async () => {
  const { client, ctx } = await setup();
  await ctx.sh("true").run();
  await ctx.sh("true").egress("deny").run();
  await ctx.sh("pip install x").egress(["pypi.org", "files.pythonhosted.org"]).run();
  await ctx.withEgress("deny").sh("true").run();
  await ctx.withEgress("deny").sh("true").egress("allow").run();
  const nets = client.execs().map(([, , vm]) => vm.network);
  assert.equal(nets[0], undefined); // open: nothing is sent, which is Archil's default
  assert.equal(nets[4], undefined);
  assert.deepEqual(nets[1], { egress: { default: "deny" } });
  assert.deepEqual(nets[2], { egress: { default: "deny", allow: ["pypi.org", "files.pythonhosted.org"] } });
  assert.deepEqual(nets[3], nets[1]);
});

test("the data plane uses the object api and no compute", needsSdk, async () => {
  const { client, ctx } = await setup();
  await ctx.write("work/a.txt", "one");
  assert.equal(await ctx.readText("work/a.txt"), "one");
  await ctx.append("logs/raw.ndjson", "{}\n");
  assert.deepEqual((await ctx.ls("work")).map((f) => f.path), ["work/a.txt"]);
  assert.deepEqual(client.execs(), []);
  assert.ok(client.calls.some((c) => JSON.stringify(c) === JSON.stringify(["appendObject", "dsk-logs", "raw.ndjson", 3])));
  const error = await thrown(ctx.read("work/missing.txt"));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "not_found");
  assert.equal(ctx.spend.snapshot().egressBytes, 3); // outside Archil by default, so reads are counted as egress
});

test("a version changes when a file is rewritten in place through a mount", needsSdk, async () => {
  const { client, ctx } = await setup();
  const disk = client.store.get("dsk-work")!;
  await ctx.write("work/status.txt", "state=OPEN\n");
  const [before] = await ctx.expand("work/status.txt");
  const listed = new Map((await ctx.expand("work")).map((f) => [f.path, f.version]));
  assert.equal(listed.get("work/status.txt"), before.version); // a file reads the same through HEAD and through a listing
  disk.mountWrite("status.txt", bytes("state=DONE\n"), later(5)); // same size, same ETag, a later time
  const [after] = await ctx.expand("work/status.txt");
  assert.deepEqual([after.size, disk.etags.get("status.txt")], [before.size, before.version.split("@")[0]]);
  assert.notEqual(after.version, before.version);
  assert.equal(after.version, `${disk.etags.get("status.txt")}@${later(5).getTime() / 1000}`); // the form the Python SDK writes

  // so the structures built on versions see it: a view goes stale, a feed reports it
  const view = ctx.view("work/report.txt", () => ctx.sh("cat {f}", { f: ctx.path("work/status.txt") }));
  await view.refresh();
  disk.stamp("report.txt", bytes("x")); // the stand-in's exec does not run the command; say the build wrote its file
  assert.equal(await view.fresh(), true);
  const feed = ctx.feed("work", { cursor: "work/cursor.json" });
  await (await feed.poll()).ack();
  disk.mountWrite("status.txt", bytes("state=OPEN\n"), later(9));
  assert.equal(await view.fresh(), false);
  assert.deepEqual((await feed.poll()).modified.map((f) => f.path), ["work/status.txt"]);
});

test("listings hide archil's own directory and directory entries", needsSdk, async () => {
  const { client, ctx } = await setup();
  const disk = client.store.get("dsk-work")!;
  for (const key of ["a.txt", "dir/b.txt", ".archil/client-1/x"]) disk.stamp(key, bytes("x"));
  assert.deepEqual((await ctx.ls("work")).map((f) => f.path), ["work/dir/", "work/a.txt"]);
  assert.deepEqual((await ctx.ls("work", { recursive: true })).map((f) => f.path), ["work/a.txt", "work/dir/b.txt"]);
  assert.deepEqual((await ctx.expand("work")).map((f) => f.path), ["work/a.txt", "work/dir/b.txt"]);
});

test("rm removes a directory and everything under it", needsSdk, async () => {
  const { client, ctx } = await setup();
  const disk = client.store.get("dsk-work")!;
  for (const key of ["tree/a.txt", "tree/deep/er/b.txt", "tree-sibling/c.txt", "keep.txt"]) disk.stamp(key, bytes("x"));
  await ctx.rm("work/tree");
  assert.deepEqual([...disk.objects.keys()].sort(), ["keep.txt", "tree-sibling/c.txt"]);
  assert.deepEqual(
    client.calls.filter((c) => String(c[0]).startsWith("deleteObject")),
    [
      ["deleteObject", "dsk-work", "tree"], // a file of that name, if there is one
      ["deleteObjects", "dsk-work", ["tree/a.txt", "tree/deep/er/b.txt"]],
      ["deleteObject", "dsk-work", "tree/deep/er/"], // then the directories, deepest first
      ["deleteObject", "dsk-work", "tree/deep/"],
      ["deleteObject", "dsk-work", "tree/"],
    ],
  );
  await ctx.rm("work/keep.txt");
  await ctx.rm("work/never-there");
  assert.deepEqual([...disk.objects.keys()], ["tree-sibling/c.txt"]);
  assert.equal((await thrown(ctx.rm("work"))).code, "bad_path");
});

test("a write under someone's checkout is busy, and the journal keeps what it could not write", needsSdk, async () => {
  const client = new FakeClient();
  const backend = new archil.ArchilBackend({ client });
  const ctx = await archil.context({ work: archil.disk("workspace", "owned") }, { backend, journal: "work/journal" });
  const disk = client.store.get("dsk-work")!;
  disk.busy = true; // a statement is running with the disk checked out
  for (const attempt of [() => ctx.write("work/a.txt", "x"), () => ctx.append("work/a.log", "x"), () => ctx.rm("work/a.txt")]) {
    const error = await thrown(attempt());
    assert.ok(error instanceof archil.Busy);
    assert.equal(error.code, "busy");
    assert.ok(error.suggestion!.includes("retry"));
  }
  await ctx.sh("true").run();
  await ctx.sh("true").run();
  assert.equal(ctx.journalPending, 2); // not lost, not written yet
  assert.equal(disk.objects.size, 0);
  disk.busy = false;
  await ctx.sh("true").run();
  assert.equal(ctx.journalPending, 0);
  const [journal] = [...disk.objects.keys()].filter((key) => key.startsWith("journal/"));
  assert.equal(Buffer.from(disk.objects.get(journal)!).toString().split('"kind":"sh"').length - 1, 3);
});

test("failures that are not the command's come back as results", needsSdk, async () => {
  const { client, ctx } = await setup();
  const statement = ctx.sh("true");
  client.refuse = new sdk!.ArchilApiError("API request failed with status 504", 504);
  let out = await statement.run();
  assert.deepEqual([out.exitCode, out.stderr], [124, "Exec timed out"]); // what the local backend reports for a timeout
  // the official client stops waiting at the same five minutes, and usually reports that first
  const gaveUp = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  client.refuse = Object.assign(new TypeError("fetch failed"), { cause: gaveUp });
  out = await statement.run();
  assert.deepEqual([out.exitCode, out.stderr], [124, "Exec timed out"]);
  client.refuse = new sdk!.ArchilApiError("Exec failed: disk dsk-1: the configured subdirectory does not exist", 400, "invalid_request");
  out = await statement.run();
  assert.equal(out.exitCode, 1);
  assert.ok(out.stderr.startsWith("mount failed: "));
  client.refuse = new sdk!.ArchilApiError(
    "Exec failed: Unable to mount Archil disk because the client queued for the root delegation for 5s and failed to acquire it in time.",
    400,
    "invalid_request",
  );
  out = await statement.run();
  assert.equal(out.exitCode, 30); // the same exit, and the same first words, as the Python backend's own wait
  assert.ok(out.stderr.startsWith("archil: could not take checkout: "));
  client.refuse = new sdk!.ArchilApiError("allowance exhausted", 403, "allowance_exhausted");
  assert.ok((await thrown(statement.run())) instanceof sdk!.ArchilApiError); // anything else is still the caller's to see
  assert.ok((await ctx.tools(["run_bash"])[0].call({ command: "true" })).startsWith("error: ArchilApiError")); // but a tool never throws
});

test("output that was cut is reported", needsSdk, async () => {
  const { client, ctx } = await setup({ limits: new archil.Limits({ maxOutputBytes: 1000 }) });
  client.answer.stdout = "a".repeat(400);
  assert.equal((await ctx.sh("true").run()).truncated, false);
  client.answer.stdout = "a".repeat(982) + "\n[output truncated]"; // the first bytes, then the marker: 1000 in all
  assert.equal((await ctx.sh("true").run()).truncated, true);
  client.answer.stdout = "short\n[output truncated]"; // a command may print those words itself
  assert.equal((await ctx.sh("true").run()).truncated, false);
});

test("a command too large once wrapped is not sent", needsSdk, async () => {
  const { client, ctx } = await setup({ limits: new archil.Limits({ maxCommandBytes: 400 }) });
  const out = await ctx.sh("echo " + "x".repeat(300)).run(); // fits the limit on its own, not with what is sent around it
  assert.equal(out.exitCode, 1);
  assert.ok(out.stderr.includes("command exceeds 400 bytes"));
  assert.deepEqual(client.execs(), []);
});

test("grep is the native parallel grep", needsSdk, async () => {
  const { client, ctx } = await setup();
  const rows = (await ctx.grep("ERROR", "logs/api", { ignoreCase: true }).run()).rows;
  assert.deepEqual(rows, [{ file: "logs/api/x.log", line: 7, text: "ERROR boom" }]);
  const call = client.calls.find((c) => c[0] === "grep")!;
  assert.deepEqual(call[2], { directory: "api", pattern: "ERROR", recursive: true, ignoreCase: true });
  assert.deepEqual(client.execs(), []);
});

test("grep over one file searches its directory for that name", needsSdk, async () => {
  const { client, ctx } = await setup();
  client.store.get("dsk-logs")!.stamp("api/we*ird[1].log", bytes("ERROR boom\n"));
  await ctx.grep("ERROR", "logs/api/we*ird[1].log").run();
  const call = client.calls.find((c) => c[0] === "grep")!;
  // Archil's search takes a directory: asked for a file, it finds nothing and says it finished
  assert.deepEqual(call[2], { directory: "api", pattern: "ERROR", recursive: false, globs: ["we\\*ird\\[1\\].log"] });
});

test("checkpoint and branch calls", needsSdk, async () => {
  const { client, ctx } = await setup();
  const backend = ctx.backend;
  await backend.checkpoint("dsk-work", "turn-1");
  assert.equal(client.execs().length, 1);
  const [disks, command] = client.execs()[0];
  assert.equal(command, wrap("archil checkpoints create disk turn-1"));
  assert.deepEqual(disks.disk, { disk: "dsk-work", readOnly: false, conditional: true }); // a read-only mount cannot checkpoint
  assert.equal(await backend.branch("dsk-work", "tx-1", "turn-1"), "dsk-branch-tx-1");
  assert.ok(client.calls.some((c) => JSON.stringify(c) === JSON.stringify(["createBranch", "dsk-work", "tx-1", "turn-1"])));
});

test("checkpoint and branch failures say what is wrong", needsSdk, async () => {
  const { ctx } = await setup();
  const backend = ctx.backend;
  await backend.checkpoint("dsk-work", "release-1");
  let error = await thrown(backend.checkpoint("dsk-work", "release-1")); // Archil answers a used name with "InvalidArguments"
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "bad_checkpoint");
  assert.ok(error.suggestion!.includes("new on its disk"));
  error = await thrown(backend.branch("dsk-work", "b", "never-taken"));
  assert.ok(error instanceof archil.ValidationError);
  assert.equal(error.code, "not_found"); // the same error the local backend throws
});

test("checkpoints are counted as the calls they are", needsSdk, async () => {
  const { client, ctx } = await setup();
  const before = ctx.spend.snapshot().callUnits;
  await ctx.transaction(async (turn) => void (await turn.write("work/a.txt", "x")), { writes: ["work"] });
  assert.equal(ctx.spend.snapshot().callUnits - before, 2); // one exec for the turn's checkpoint, one to apply it
  assert.equal(client.execs().length, 2);
  await ctx.lock("eval-1");
  assert.equal(ctx.spend.snapshot().callUnits - before, 5); // three mounts, three checkpoints
  assert.equal(client.execs().length, 5);
});

test("a version too new to trust is not trusted", needsSdk, async () => {
  // A listing carries times in whole seconds, so a file written this very second can be rewritten
  // in place, at the same size, without its version moving. Nothing is concluded from such a version.
  const client = new FakeClient();
  const backend = new archil.ArchilBackend({ client });
  const ctx = await archil.context({ work: archil.disk("workspace", "owned") }, { backend });
  const disk = client.store.get("dsk-work")!;
  const now = new Date();
  const earlier = new Date(now.getTime() - 30_000);
  disk.stamp("fresh.csv", bytes("a,1\n"), now);
  disk.stamp("old.csv", bytes("a,1\n"), earlier);

  // a view built from it is recorded as provisional, so the next refresh builds once more
  const fresh = ctx.view("work/from-fresh.txt", () => ctx.sh("cat {f}", { f: ctx.path("work/fresh.csv") }));
  const old = ctx.view("work/from-old.txt", () => ctx.sh("cat {f}", { f: ctx.path("work/old.csv") }));
  for (const view of [fresh, old]) {
    await view.refresh();
    disk.stamp(view.path.slice("work/".length), bytes("x")); // the stand-in's exec does not run the command
  }
  assert.deepEqual([await old.fresh(), await fresh.fresh()], [true, false]);
  const recorded = [...disk.objects]
    .filter(([key]) => key.startsWith(".px/views/"))
    .map(([, body]) => JSON.parse(Buffer.from(body).toString()).fingerprint as string);
  assert.deepEqual(recorded.map((f) => f.endsWith("~")).sort(), [false, true]);

  // a feed hands it over again on the next poll
  const feed = ctx.feed("work", { cursor: "work/cursor.json" });
  await (await feed.poll()).ack();
  assert.deepEqual((await feed.poll()).modified.map((f) => f.path), ["work/fresh.csv"]);

  // and a turn does not take its snapshot until the file is older than that
  const waits: number[] = [];
  const sleep = clock.sleep;
  clock.sleep = async (seconds) => void waits.push(seconds);
  try {
    await new archil.Transaction(ctx, { writes: ["work"] }).begin();
    assert.ok(waits.length > 0 && waits.every((w) => w > 0 && w <= 1.5), String(waits));
    waits.length = 0;
    disk.stamp("fresh.csv", bytes("a,1\n"), earlier);
    await new archil.Transaction(ctx, { writes: ["work"] }).begin();
    assert.deepEqual(waits, []); // nothing was written recently: no wait
  } finally {
    clock.sleep = sleep;
  }
  // the local backend's versions change on every write, so none of this applies there
  assert.deepEqual([backend.versionGranularityS, new archil.LocalBackend({ root: "/tmp/px-none" }).versionGranularityS], [1, 0]);
});

// -- beyond the Python suite: the rest of the mapping, which the fake can also pin down

test("a listing asks for the directory and for the file of that name", needsSdk, async () => {
  const { client, ctx } = await setup();
  const work = client.store.get("dsk-work")!;
  for (const key of ["logs/api/a.txt", "logs/api-old/b.txt", ".archil/meta", "logs/api.txt"]) work.stamp(key, bytes("x"));
  client.calls.length = 0;
  // S3 prefixes match by string; the trailing slash keeps "logs/api-old" out of "logs/api"
  assert.deepEqual((await ctx.expand("work/logs/api")).map((f) => f.path), ["work/logs/api/a.txt"]);
  assert.deepEqual(client.calls, [["listObjects", "dsk-work", "logs/api/", true]]);
  // a path that is a file is answered by a head, with the etag and the time as its version
  const [file] = await ctx.expand("work/logs/api.txt");
  const seconds = WHEN.getTime() / 1000;
  assert.deepEqual([file.path, file.size, file.version, file.modified], ["work/logs/api.txt", 1, `"etag-1-78"@${seconds}`, seconds]);
  // Archil's own directory never shows up
  assert.deepEqual((await ctx.ls("work", { recursive: true })).map((f) => f.path).sort(), [
    "work/logs/api-old/b.txt",
    "work/logs/api.txt",
    "work/logs/api/a.txt",
  ]);
  assert.equal(await ctx.share("work/logs/api.txt", { expiresIn: 60 }), "https://share.example/logs/api.txt?e=60");
});

test("a transaction is checkpoint, branch, and one exec that copies back", needsSdk, async () => {
  const { client, ctx } = await setup();
  const tx = await new archil.Transaction(ctx, { writes: ["work"], name: "tx-1" }).begin();
  // the branch's filesystem id is used like a disk id from here on
  assert.equal(tx.ctx.mounts.get("work")!.handle, "dsk-branch-tx-1");
  await tx.ctx.write("work/plan.md", "v2\n");
  const commit = await tx.commit();
  assert.deepEqual(commit.applied, ["work/plan.md"]);
  const [checkpoint, apply] = client.execs();
  assert.equal(checkpoint[1], wrap("archil checkpoints create disk tx-1-base"));
  assert.deepEqual(apply[0], {
    src: { disk: "dsk-branch-tx-1", readOnly: true, conditional: false },
    dst: { disk: "dsk-work", readOnly: false, conditional: false, queueMs: 5000 },
  });
  assert.ok(apply[1].includes('done < "src/.px/tx/tx-1.changes"\n'));
  assert.deepEqual(
    client.calls.filter((c) => c[0] === "createBranch"),
    [["createBranch", "dsk-work", "tx-1", "tx-1-base"]],
  );
  assert.deepEqual(Buffer.from(client.store.get("dsk-branch-tx-1")!.objects.get(".px/tx/tx-1.changes")!).toString(), "W\tplan.md\n");
});

test("an existing branch is reused only when that was asked for", needsSdk, async () => {
  const { ctx } = await setup();
  const backend = ctx.backend;
  await backend.checkpoint("dsk-work", "eval");
  assert.equal(await backend.branch("dsk-work", "frozen-eval", "eval", { existOk: true }), "dsk-branch-frozen-eval");
  assert.equal(await backend.branch("dsk-work", "frozen-eval", "eval", { existOk: true }), "dsk-branch-frozen-eval");
  const error = await thrown(backend.branch("dsk-work", "frozen-eval", "eval"));
  assert.ok(error instanceof sdk!.ArchilApiError);
});

test("without a client, one is made from the official package on first use", needsSdk, async () => {
  const backend = new archil.ArchilBackend({ apiKey: "key-test", region: "aws-us-east-1" });
  assert.ok((await backend.client()) instanceof sdk!.Archil); // constructing it contacts nothing
  assert.equal(await backend.resolveDisk("dsk-0123456789abcdef"), "dsk-0123456789abcdef"); // an id needs no lookup
  assert.equal(backend.insideArchil, false);
  assert.deepEqual([...backend.capabilities].sort(), ["branch", "checkpoint", "grep", "share"]);
});
