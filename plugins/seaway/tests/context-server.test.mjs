/**
 * The context server, driven over stdio the way Claude Code drives it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { NO_SDK, SDK, closeAll, connect, has, scratch } from "./helpers.mjs";

after(closeAll);

const OPEN = {
  name: "tests",
  create: true,
  mounts: {
    docs: { disk: "handbook", mode: "owned", description: "policies" },
    notes: { disk: "my-notes", mode: "owned" },
    team: { disk: "team-notes", mode: "shared" },
    logs: { disk: "app-logs", mode: "append" },
  },
};

/** A client with a context open on a local root of its own. */
async function opened(overrides = {}, options = {}) {
  const client = await connect(options);
  const root = scratch("root");
  const first = await client.call("open_context", { ...OPEN, local_root: root, ...overrides });
  assert.equal(first.isError, false, first.text);
  return { client, root, first };
}

// -- the protocol ----------------------------------------------------------------

test("the newer revision: discover, then requests that carry their version", async () => {
  const client = await connect();
  const discover = await client.request("server/discover");
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discover.result.capabilities, { tools: {} });
  assert.equal(typeof discover.result.ttlMs, "number");
  assert.ok(["public", "private"].includes(discover.result.cacheScope));
  assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].name, "seaway-context");
  assert.match(discover.result.instructions, /explain_statement before run_statement/);

  const list = await client.request("tools/list");
  assert.equal(list.result.resultType, "complete");
  assert.equal(typeof list.result.ttlMs, "number");
  assert.equal(list.result.tools.length, 16);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 40, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
  }
  const called = await client.request("tools/call", { name: "describe_context", arguments: {} });
  assert.equal(called.result.resultType, "complete");
  await client.close();
  assert.equal(client.stderr(), "");
});

test("the newer revision refuses a request with no version, or one it does not speak", async () => {
  const client = await connect();
  const bare = await client.raw("tools/list", {});
  assert.equal(bare.error.code, -32602);
  const future = await client.raw("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } });
  assert.equal(future.error.code, -32022);
  assert.deepEqual(future.error.data, { supported: ["2026-07-28"], requested: "2099-01-01" });
  await client.close();
});

test("the older revision: initialize selects it for the life of the process", async () => {
  const client = await connect({ era: "legacy" });
  assert.equal(client.hello.result.protocolVersion, "2025-06-18");
  assert.deepEqual(client.hello.result.capabilities, { tools: {} });
  assert.equal(client.hello.result.serverInfo.name, "seaway-context");
  assert.match(client.hello.result.instructions, /seaway context/);
  const list = await client.request("tools/list");
  assert.equal(list.result.tools.length, 16);
  assert.equal("resultType" in list.result, false);
  assert.equal("ttlMs" in list.result, false);
  assert.deepEqual((await client.request("ping")).result, {});
  const called = await client.request("tools/call", { name: "describe_context", arguments: {} });
  assert.equal("resultType" in called.result, false);
  await client.close();
});

test("an older client that asks for a revision nobody knows is offered one", async () => {
  const client = await connect();
  const hello = await client.raw("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(hello.result.protocolVersion, "2025-11-25");
  await client.close();
});

test("what is not a tool call is answered as the protocol says", async () => {
  const client = await connect();
  assert.equal((await client.request("resources/list")).error.code, -32601);
  assert.equal((await client.request("tools/call", { name: "no_such_tool", arguments: {} })).error.code, -32602);
  assert.equal((await client.line("{not json")).error.code, -32700);
  await client.close();
});

// -- without an SDK, or without a context ----------------------------------------------

test("with no SDK to load the server still answers, and says how to point it at one", async () => {
  const client = await connect({ env: { SEAWAY_SDK: path.join(scratch("nowhere"), "missing") } });
  assert.equal((await client.request("tools/list")).result.tools.length, 16);
  const out = await client.call("open_context", { mounts: { a: "a" } });
  assert.equal(out.isError, true);
  assert.match(out.text, /the seaway SDK was not found/);
  assert.match(out.text, /seaway checkout/);
  await client.close();
});

test("before a context is open, tools say how to open one", { skip: NO_SDK }, async () => {
  const client = await connect();
  const info = await client.call("describe_context");
  assert.equal(info.isError, false);
  assert.match(info.text, /No context is open/);
  assert.match(info.text, /seaway 0\.\d+\.\d+ from /);
  const read = await client.call("read_file", { path: "docs/a.md" });
  assert.equal(read.isError, true);
  assert.match(read.text, /no context is open\. Call open_context/);
  await client.close();
});

test("the live backend is never the default, and needs a key", { skip: NO_SDK }, async () => {
  const client = await connect();
  const out = await client.call("open_context", { mounts: { a: "a" }, backend: "archil" });
  assert.equal(out.isError, true);
  assert.match(out.text, /needs ARCHIL_API_KEY/);
  await client.close();
});

// -- a context -----------------------------------------------------------------------

test("open_context composes mounts, denies the network and sets a budget", { skip: NO_SDK }, async () => {
  const { client, root, first } = await opened();
  assert.match(first.text, /context "tests" on local/);
  assert.match(first.text, /docs\/ +owned +handbook +policies/);
  assert.match(first.text, /logs\/ +append +app-logs/);
  assert.match(first.text, /Commands run with egress denied\./);
  assert.ok(first.text.includes(`backend: local, under ${root}`) || first.text.includes("backend: local, under /private" + root));
  assert.match(first.text, /bash on this machine/);
  assert.match(first.text, /writable: docs \(owned\), notes \(owned\), team \(shared\)/);
  assert.match(first.text, /budget: \$0\.25 for this session/);
  const info = await client.call("describe_context");
  assert.match(info.text, /manifest: \{"archilContext":0,"name":"tests"/);
  assert.match(info.text, /"egress":"deny"/);
  await client.close();
});

test("the file tools are the SDK's own, errors and all", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  assert.match((await client.call("write_file", { path: "docs/a.md", content: "alpha\nneedle one\n" })).text, /wrote docs\/a\.md \(17 bytes\)/);
  await client.call("write_file", { path: "docs/security/keys.md", content: "Rotate keys.\n" });
  assert.equal((await client.call("list_files", { path: "docs", recursive: true })).text, "docs/a.md\t17\ndocs/security/keys.md\t13");
  assert.equal((await client.call("list_files")).text, "docs/\nnotes/\nteam/\nlogs/");
  assert.equal((await client.call("read_file", { path: "docs/a.md" })).text, "alpha\nneedle one\n");
  const refused = await client.call("write_file", { path: "logs/x.txt", content: "no" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /read_only \[logs\/x\.txt\]: 'logs' is append/);
  const lost = await client.call("read_file", { path: "nowhere/a.md" });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /unknown_mount/);
  assert.match((await client.call("delete_file", { path: "docs/a.md" })).text, /deleted docs\/a\.md/);
  assert.equal((await client.call("list_files", { path: "docs" })).text, "docs/security/");
  await client.close();
});

test("a statement that declares its paths is mounted and priced by them", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  await client.call("write_file", { path: "docs/a.md", content: "alpha\nbeta\n" });
  await client.call("write_file", { path: "docs/deep/b.md", content: "gamma\n" });
  const spec = {
    kind: "sh",
    template: "cat {files} | wc -l > {out}",
    params: { files: { glob: "docs/**/*.md" }, out: { out: "notes/lines.txt" } },
  };
  const plan = await client.call("explain_statement", spec);
  assert.equal(plan.isError, false, plan.text);
  assert.match(plan.text, /^plan [0-9a-f]{12}  sh · 2 file\(s\), 17 B · 1 call/);
  assert.match(plan.text, /route   exec · 2 vCPU \/ 4 GiB · egress denied/);
  assert.match(plan.text, /scope   docs → handbook \(read-only\)/);
  assert.match(plan.text, /notes → my-notes \(read-write, checkout \/\)/);
  assert.match(plan.text, /not mounted: team, logs/);
  assert.match(plan.text, /writes  notes\/lines\.txt/);
  assert.equal((await client.call("list_files", { path: "notes" })).text, "(empty)"); // explaining ran nothing

  const json = JSON.parse((await client.call("explain_statement", { ...spec, format: "json" })).text);
  assert.equal(json.plan, 0);
  assert.equal(json.tasks.length, 1);
  assert.deepEqual(json.effects, { reads: ["docs/**/*.md"], writes: ["notes/lines.txt"] });

  const run = await client.call("run_statement", spec);
  assert.equal(run.isError, false, run.text);
  assert.match(run.text, /^exit 0 · sh · 1 call · ≈ \$0\.00005 · \d+ ms · plan [0-9a-f]{12}/);
  assert.equal((await client.call("read_file", { path: "notes/lines.txt" })).text.trim(), "3");
  await client.close();
});

test("a statement that declares nothing sees everything, and its plan says so", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const plan = await client.call("explain_statement", { kind: "sh", template: "ls" });
  assert.match(plan.text, /reads   — \(not declared\)/);
  assert.match(plan.text, /no paths declared, so all 4 mount\(s\) are attached/);
  const run = await client.call("run_statement", { kind: "sh", template: "ls" });
  assert.deepEqual(run.text.split("\n").slice(1, 5), ["docs", "logs", "notes", "team"]);
  assert.match(run.text, /note: no paths declared/);
  await client.close();
});

test("values are quoted whatever they hold", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const hostile = "x'; touch notes/owned; echo '";
  for (const value of [hostile, { value: hostile }]) {
    const run = await client.call("run_statement", { kind: "sh", template: "printf '%s' {v}", params: { v: value } });
    assert.equal(run.isError, false, run.text);
    assert.equal(run.text.split("\n")[1], hostile);
  }
  assert.equal((await client.call("list_files", { path: "notes" })).text, "(empty)");
  await client.close();
});

test("a failing command is an error result that keeps its output", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const run = await client.call("run_statement", { kind: "sh", template: "echo before; echo oops >&2; exit 3" });
  assert.equal(run.isError, true);
  assert.match(run.text, /^exit 3 · sh/);
  assert.match(run.text, /before/);
  assert.match(run.text, /\[stderr\]\noops/);
  await client.close();
});

test("grep, into, map and batch", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  await client.call("write_file", { path: "docs/a.md", content: "alpha\nNeedle one\n" });
  await client.call("write_file", { path: "docs/b.md", content: "needle two\nbeta\n" });
  await client.call("write_file", { path: "docs/c.txt", content: "needle three\n" });

  const grep = { kind: "grep", pattern: "needle", over: "docs", options: { ignoreCase: true, globs: ["*.md"] } };
  assert.match((await client.call("explain_statement", grep)).text, /route   grep · one call per disk/);
  const hits = await client.call("run_statement", grep);
  assert.match(hits.text, /matches: 2\ndocs\/a\.md:2:Needle one\ndocs\/b\.md:1:needle two/);

  const into = await client.call("run_statement", { kind: "sh", template: "sort {f}", params: { f: { glob: "docs/*.md" } }, into: "notes/sorted.txt" });
  assert.match(into.text, /written: notes\/sorted\.txt/);
  assert.equal((await client.call("read_file", { path: "notes/sorted.txt" })).text, "Needle one\nalpha\nbeta\nneedle two\n");

  const mapped = { kind: "sh", template: "cat {f} | wc -l", params: { f: { glob: "docs/*" } }, map: { reduce: "sum", shards: 3 } };
  assert.match((await client.call("explain_statement", mapped)).text, /3 calls, combined by sum/);
  const sum = await client.call("run_statement", mapped);
  assert.match(sum.text, /^exit 0 · sh · 3 calls · ≈ \$0\.00015/);
  assert.equal(sum.text.split("\n")[1], "5");

  const batch = await client.call("run_statement", {
    kind: "batch",
    children: [
      { kind: "sh", template: "wc -l < {f}", params: { f: { path: "docs/a.md" } } },
      { kind: "sh", template: "echo {v}", params: { v: 7 } },
    ],
  });
  assert.match(batch.text, /^exit 0 · batch · 1 call /);
  assert.match(batch.text, /--- \[0\] sh · exit 0\n\s*2\n--- \[1\] sh · exit 0\n7/);
  assert.match(batch.text, /note: 2 statements in one call instead of 2/);
  await client.close();
});

test("a mistake in a statement is explained, and nothing runs", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const cases = [
    [{ kind: "bash", template: "ls" }, /kind has to be "sh", "sql", "grep" or "batch"/],
    [{ kind: "sh" }, /an sh statement needs a template/],
    [{ kind: "sh", template: "cat {f}", params: { f: { file: "docs/a.md" } } }, /params\.f: a parameter is/],
    [{ kind: "sh", template: "ls", params: { f: { path: "docs" } } }, /unused_parameter/],
    [{ kind: "sh", template: "cat {f}", params: { f: { path: "elsewhere/a" } } }, /unknown_mount/],
    [{ kind: "sh", template: "echo hi > {f}", params: { f: { out: "logs/x" } } }, /read_only/],
    [{ kind: "sh", template: "cat {f}", params: { f: { path: "docs/../x" } } }, /bad_path/],
    [{ kind: "sql", template: "select 1", map: { reduce: "sum" } }, /only sh statements can be mapped/],
    [{ kind: "sh", template: "cat {l}", params: { l: { log: "logs", between: ["nonsense", "2026-11-09T00:00:00Z"] } } }, /cannot read "nonsense" as a time/],
  ];
  for (const [spec, expected] of cases) {
    for (const tool of ["explain_statement", "run_statement"]) {
      const out = await client.call(tool, spec);
      assert.equal(out.isError, true, JSON.stringify(spec));
      assert.match(out.text, expected, JSON.stringify(spec));
    }
  }
  await client.close();
});

test("the budget refuses a statement before it runs", { skip: NO_SDK }, async () => {
  const { client, first } = await opened({ max_usd: 0.0001 });
  assert.match(first.text, /budget: \$0\.0001 for this session/);
  assert.equal((await client.call("run_statement", { kind: "sh", template: "echo one" })).isError, false);
  assert.equal((await client.call("run_statement", { kind: "sh", template: "echo two" })).isError, false);
  const third = await client.call("run_statement", { kind: "sh", template: "echo three > {f}", params: { f: { out: "notes/three.txt" } } });
  assert.equal(third.isError, true);
  assert.match(third.text, /budget_exceeded: plan exceeds budget/);
  assert.equal((await client.call("list_files", { path: "notes" })).text, "(empty)");
  // a plan can still be read
  assert.equal((await client.call("explain_statement", { kind: "sh", template: "echo three" })).isError, false);
  // and one statement can carry a tighter ceiling of its own
  const within = await client.call("run_statement", { kind: "sh", template: "true", within: { maxCalls: 0 } });
  assert.match(within.text, /budget_exceeded/);
  await client.close();
});

test("a budget of zero lets plans be read and nothing run; none lifts it", { skip: NO_SDK }, async () => {
  const zero = await opened({ max_usd: 0 });
  assert.match(zero.first.text, /budget: \$0 for this session/);
  assert.equal((await zero.client.call("explain_statement", { kind: "sh", template: "ls" })).isError, false);
  assert.match((await zero.client.call("run_statement", { kind: "sh", template: "ls" })).text, /budget_exceeded/);
  await zero.client.close();
  const none = await opened({ max_usd: "none" });
  assert.match(none.first.text, /budget: none/);
  await none.client.close();
  const bad = await connect();
  const out = await bad.call("open_context", { ...OPEN, local_root: scratch("root"), max_usd: "lots" });
  assert.match(out.text, /max_usd has to be a number of dollars/);
  await bad.close();
});

test("read-only, and a network policy of the caller's choosing", { skip: NO_SDK }, async () => {
  const { client, first } = await opened({ read_only: true, egress: ["pypi.org"] });
  assert.match(first.text, /writable: nothing/);
  assert.match(first.text, /egress only to pypi\.org/);
  const write = await client.call("write_file", { path: "notes/a.md", content: "x" });
  assert.equal(write.isError, true);
  assert.match(write.text, /'notes' is read; it cannot be written/);
  const allow = await opened({ egress: "allow" });
  assert.doesNotMatch(allow.first.text, /egress/);
  await client.close();
  await allow.client.close();
});

// -- turns ------------------------------------------------------------------------------

test("a turn's changes land together", { skip: NO_SDK }, async () => {
  const { client, root } = await opened();
  assert.match((await client.call("turn_changes")).text, /no turn is open/);
  const begun = await client.call("begin_turn", { writes: ["notes", "team"], name: "turn-one" });
  assert.match(begun.text, /turn turn-one is open \(snapshot isolation\)\. It may write: notes, team\./);
  assert.match((await client.call("begin_turn")).text, /already open/);
  assert.match((await client.call("open_context", { ...OPEN, local_root: root })).text, /turn turn-one is open/);

  await client.call("write_file", { path: "notes/todo.md", content: "- one\n" });
  await client.call("run_statement", { kind: "sh", template: "echo standup >> {f}", params: { f: { out: "team/standup.md" } } });
  assert.equal((await client.call("turn_changes")).text, "turn turn-one has changed:\n  W notes/todo.md\n  W team/standup.md");
  assert.equal(existsSync(path.join(root, "disks", "my-notes", "todo.md")), false); // not on the main line yet
  assert.match((await client.call("describe_context")).text, /turn turn-one is open/);

  const commit = await client.call("commit_turn");
  assert.equal(commit.text, "turn turn-one committed in 2 calls:\n  W notes/todo.md\n  W team/standup.md");
  assert.equal(readFileSync(path.join(root, "disks", "my-notes", "todo.md"), "utf8"), "- one\n");
  assert.match((await client.call("commit_turn")).text, /no turn is open/);
  await client.close();
});

test("a conflict applies nothing, and a rollback leaves no trace", { skip: NO_SDK }, async () => {
  const { client, root } = await opened();
  await client.call("write_file", { path: "team/standup.md", content: "- nothing yet\n" });
  await client.call("begin_turn", { writes: ["team", "notes"] });
  await client.call("write_file", { path: "team/standup.md", content: "- mine\n" });
  await client.call("write_file", { path: "notes/mine.md", content: "kept with the turn\n" });
  // someone else writes the same path on the main line
  writeFileSync(path.join(root, "disks", "team-notes", "standup.md"), "- theirs, and longer\n");
  const commit = await client.call("commit_turn");
  assert.equal(commit.isError, true);
  assert.match(commit.text, /conflict: turn tx-[0-9a-f]+ was not applied, none of it\..*team\/standup\.md/);
  assert.equal(readFileSync(path.join(root, "disks", "team-notes", "standup.md"), "utf8"), "- theirs, and longer\n");
  assert.equal(existsSync(path.join(root, "disks", "my-notes", "mine.md")), false);

  await client.call("begin_turn");
  await client.call("write_file", { path: "notes/scratch.md", content: "x" });
  assert.match((await client.call("rollback_turn")).text, /was rolled back/);
  assert.equal((await client.call("list_files", { path: "notes" })).text, "(empty)");
  await client.close();
});

test("a turn cannot write what it did not declare", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  await client.call("begin_turn", { writes: ["notes/a"] });
  await client.call("write_file", { path: "notes/b/x.md", content: "x" });
  const commit = await client.call("commit_turn");
  assert.equal(commit.isError, true);
  assert.match(commit.text, /undeclared_write/);
  assert.match((await client.call("turn_changes")).text, /no turn is open/);
  await client.close();
});

test("a turn that names its writes still commits when the journal is on a disk it writes", { skip: NO_SDK }, async () => {
  const { client, root, first } = await opened({ journal: "notes/journal" });
  assert.match(first.text, /^journal: notes\/journal$/m);
  // the journal's own lines are changes on that disk: without its directory among the writes the commit is refused
  const begun = await client.call("begin_turn", { writes: ["notes/drafts"], name: "turn-j" });
  assert.match(begun.text, /It may write: notes\/drafts, notes\/journal\./);
  assert.match(begun.text, /^notes\/journal was added to what it may write/m);
  const ran = await client.call("run_statement", { kind: "sh", template: "echo draft > {f}", params: { f: { out: "notes/drafts/a.md" } } });
  assert.equal(ran.isError, false, ran.text);
  const commit = await client.call("commit_turn");
  assert.equal(commit.isError, false, commit.text);
  assert.equal(readFileSync(path.join(root, "disks", "my-notes", "drafts", "a.md"), "utf8"), "draft\n");
  const listed = await client.call("list_files", { path: "notes/journal", recursive: true });
  assert.match(listed.text, /notes\/journal\/\d{4}-\d\d-\d\d\/[0-9a-f]+\.ndjson/);

  // a turn that does not write the journal's disk needs nothing added, and one that covers it already is left alone
  const other = await client.call("begin_turn", { writes: ["team"] });
  assert.match(other.text, /It may write: team\.$/m);
  assert.doesNotMatch(other.text, /was added/);
  await client.call("rollback_turn");
  const whole = await client.call("begin_turn", { writes: ["notes"] });
  assert.match(whole.text, /It may write: notes\.$/m);
  assert.doesNotMatch(whole.text, /was added/);
  await client.call("rollback_turn");
  await client.close();
});

test("a read-only open says that it keeps no journal", { skip: NO_SDK }, async () => {
  const { client, root, first } = await opened({ journal: "notes/journal", read_only: true });
  assert.match(first.text, /^journal: none while the context is read-only \(notes\/journal is not written: a journal is a write\)$/m);
  const ran = await client.call("run_statement", { kind: "sh", template: "echo hello" });
  assert.equal(ran.isError, false, ran.text);
  assert.equal(existsSync(path.join(root, "disks", "my-notes", "journal")), false);
  const plain = await opened();
  assert.doesNotMatch(plain.first.text, /^journal:/m);
  await client.close();
  await plain.client.close();
});

// -- logs, feeds and views -----------------------------------------------------------------

test("a log is appended to, and its selections are statement parameters", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const records = [{ level: "ERROR", msg: "boom" }, { level: "INFO", msg: "ok" }];
  const appended = await client.call("append_log", { log: "logs/api", records, writer: "web 1", at: "2026-11-09T14:10:00Z" });
  assert.equal(appended.text, "appended 2 records to logs/api/2026-11-09/14/web-1.ndjson");
  const lines = (await client.call("read_file", { path: "logs/api/2026-11-09/14/web-1.ndjson" })).text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.ts, l.level]), [["2026-11-09T14:10:00.000Z", "ERROR"], ["2026-11-09T14:10:00.000Z", "INFO"]]);
  assert.match(lines[0].id, /^[0-9a-f]{12}$/);

  const selection = { log: "logs/api", last: "15m", now: "2026-11-09T14:20:00Z" };
  const plan = await client.call("explain_statement", { kind: "sh", template: "cat {recent} | wc -l", params: { recent: selection } });
  assert.match(plan.text, /scope   logs\/api\/2026-11-09\/14 → app-logs:\/api\/2026-11-09\/14 \(read-only\)/);
  assert.match(plan.text, /reads   logs\/api\[last 15m\]/);
  const earlier = { log: "logs/api", between: ["2026-11-09T10:00:00Z", "2026-11-09T11:00:00Z"] };
  const none = await client.call("explain_statement", { kind: "sql", template: "select count(*) as n from {t}", params: { t: earlier } });
  assert.match(none.text, /nothing mounted: nothing to run/);

  assert.match((await client.call("append_log", { log: "logs/api", records: [] })).text, /needs records/);
  assert.match((await client.call("append_log", { log: "docs/x", records: [{ a: 1 }], at: "soon" })).text, /cannot read "soon" as a time/);
  await client.close();
});

test("sql reads a log selection as a table of exactly those records", { skip: NO_SDK || (has("duckdb") ? false : "duckdb is not on the PATH") }, async () => {
  const { client } = await opened();
  await client.call("append_log", { log: "logs", writer: "a", records: [{ ts: "2026-11-09T14:01:00Z", level: "ERROR" }, { ts: "2026-11-09T14:29:00Z", level: "ERROR" }, { ts: "2026-11-09T14:29:30Z", level: "INFO" }] });
  const run = await client.call("run_statement", {
    kind: "sql",
    template: "select level, count(*)::int as n from {recent} where level <> {skip} group by 1",
    params: { recent: { log: "logs", last: "15m", now: "2026-11-09T14:30:00Z" }, skip: "DEBUG" },
  });
  assert.equal(run.isError, false, run.text);
  assert.match(run.text, /rows: 2/);
  const rows = JSON.parse(run.text.split("\n").slice(2).join("\n")); // DuckDB writes a row to a line
  assert.deepEqual(rows.sort((a, b) => a.level.localeCompare(b.level)), [{ level: "ERROR", n: 1 }, { level: "INFO", n: 1 }]);
  await client.close();
});

test("a feed hands changes over until they are acknowledged", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  await client.call("write_file", { path: "docs/a.md", content: "alpha\n" });
  const feed = { path: "docs", cursor: "notes/cursors/docs.json" };
  const first = await client.call("poll_feed", feed);
  assert.match(first.text, /added \(1\):\n  docs\/a\.md\t6/);
  assert.match((await client.call("poll_feed", feed)).text, /added \(1\)/); // not acknowledged: handed over again
  assert.equal((await client.call("ack_feed", { cursor: feed.cursor })).text, "cursor notes/cursors/docs.json now stands after 1 change(s)");
  assert.match((await client.call("poll_feed", feed)).text, /nothing has changed under docs/);
  assert.match((await client.call("ack_feed", { cursor: feed.cursor })).text, /nothing polled with cursor/);

  await client.call("write_file", { path: "docs/a.md", content: "alpha\nbeta\n" });
  await client.call("write_file", { path: "docs/b.md", content: "new\n" });
  const second = await client.call("poll_feed", feed);
  assert.match(second.text, /added \(1\):\n  docs\/b\.md\t4/);
  assert.match(second.text, /modified \(1\), with the size each had before:\n  docs\/a\.md\t11\twas 6/);
  await client.call("ack_feed", { cursor: feed.cursor });
  await client.call("delete_file", { path: "docs/b.md" });
  assert.match((await client.call("poll_feed", feed)).text, /removed \(1\):\n  docs\/b\.md/);
  await client.close();
});

test("a view rebuilds when its inputs or its statement change, and not otherwise", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  await client.call("write_file", { path: "docs/a.md", content: "alpha\nbeta\n" });
  const view = { path: "notes/reports/lines.txt", statement: { kind: "sh", template: "cat {f} | wc -l", params: { f: { glob: "docs/*.md" } } } };
  const built = await client.call("refresh_view", { ...view, read: true });
  assert.equal(built.isError, false, built.text);
  assert.match(built.text, /^notes\/reports\/lines\.txt was rebuilt\nexit 0 · sh · 1 call/);
  assert.equal(built.text.trim().split("\n").at(-1).trim(), "2");
  assert.match((await client.call("refresh_view", view)).text, /is fresh: its inputs and its statement are unchanged, so nothing ran/);
  await client.call("write_file", { path: "docs/b.md", content: "gamma\n" });
  assert.match((await client.call("refresh_view", view)).text, /was rebuilt/);
  const changed = { ...view, statement: { ...view.statement, template: "cat {f} | wc -c" } };
  assert.match((await client.call("refresh_view", changed)).text, /was rebuilt/);
  assert.match((await client.call("refresh_view", { ...changed, force: true })).text, /was rebuilt/);
  const broken = await client.call("refresh_view", { path: "notes/reports/bad.txt", statement: { kind: "sh", template: "exit 9" } });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /could not be rebuilt\nexit 9/);
  await client.close();
});

// -- manifests ------------------------------------------------------------------------------

test("a manifest opens from a file, keeps its own network policy, and can be the default", { skip: NO_SDK }, async () => {
  const project = scratch("project");
  const root = path.join(project, ".archil-local");
  mkdirSync(path.join(root, "disks", "handbook"), { recursive: true });
  writeFileSync(path.join(root, "disks", "handbook", "a.md"), "alpha\n");
  const manifest = {
    archilContext: 0,
    name: "from-a-file",
    mounts: { docs: { disk: "handbook", mode: "read", description: "policies" }, notes: { disk: "fresh-notes", mode: "owned" } },
    egress: ["example.com"],
  };
  writeFileSync(path.join(project, "agent.json"), JSON.stringify(manifest));

  const client = await connect({ cwd: project, env: { CLAUDE_PROJECT_DIR: project } });
  const missing = await client.call("open_context", { manifest: "agent.json" });
  assert.match(missing.text, /unknown_disk: no disk named 'fresh-notes'/);
  const open = await client.call("open_context", { manifest: "agent.json", create: true });
  assert.equal(open.isError, false, open.text);
  assert.match(open.text, /context "from-a-file" on local/);
  assert.match(open.text, /egress only to example\.com/);
  assert.match(open.text, /opened from: .*agent\.json/);
  assert.equal((await client.call("read_file", { path: "docs/a.md" })).text, "alpha\n");
  assert.match((await client.call("open_context", { manifest: "nope.json" })).text, /no manifest at /);
  assert.match((await client.call("open_context", { manifest: { mounts: { a: { disk: "handbook" } } } })).text, /bad_manifest/);
  assert.match((await client.call("open_context", { manifest: "agent.json", mounts: {} })).text, /not both/);
  await client.close();

  const byDefault = await connect({ cwd: project, env: { CLAUDE_PROJECT_DIR: project, SEAWAY_MANIFEST: "agent.json", SEAWAY_MCP_MAX_USD: "none", SEAWAY_MCP_READ_ONLY: "1" } });
  const info = await byDefault.call("describe_context");
  assert.match(info.text, /context "from-a-file" on local/);
  assert.match(info.text, /budget: none/);
  assert.match(info.text, /writable: nothing \(opened read-only\)/);
  assert.equal((await byDefault.call("read_file", { path: "docs/a.md" })).text, "alpha\n");
  await byDefault.close();
});

test("settings a plugin option left unfilled are treated as unset", { skip: NO_SDK }, async () => {
  const client = await connect({
    env: { SEAWAY_MANIFEST: "${user_config.manifest}", SEAWAY_MCP_BACKEND: "${user_config.backend}", SEAWAY_MCP_MAX_USD: "", SEAWAY_SDK: SDK },
  });
  assert.match((await client.call("describe_context")).text, /No context is open\./);
  const open = await client.call("open_context", { ...OPEN, local_root: scratch("root") });
  assert.match(open.text, /budget: \$0\.25 for this session/);
  await client.close();
});

test("long output is cut, and says how to get the rest", { skip: NO_SDK }, async () => {
  const { client } = await opened();
  const run = await client.call("run_statement", { kind: "sh", template: "head -c 40000 /dev/zero | tr '\\0' 'x'" });
  assert.ok(run.text.length < 12_400, String(run.text.length));
  assert.match(run.text, /more characters\. Narrow the request, or send the output to a file with "into"/);
  await client.close();
});
