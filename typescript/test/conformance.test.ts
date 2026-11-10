/** Replay conformance.json. The Python SDK replays the same file, so the two agree on what a statement means. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";

import * as archil from "../src/index.ts";
import { canonical } from "../src/plan.ts";
import { Glob, quote, render, sqlLiteral } from "../src/shell.ts";
import { REDUCERS, describeParam } from "../src/statement.ts";
import { build, param, statement } from "./harness.ts";
import { newBackend } from "./helpers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SPEC: Json = JSON.parse(readFileSync(new URL("../../conformance/conformance.json", import.meta.url), "utf8"));

/** Equal, except that numbers named usd* may differ by rounding. */
function same(got: Json, want: Json, where = ""): void {
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got) && got.length === want.length, where);
    want.forEach((w, i) => same(got[i], w, `${where}[${i}]`));
  } else if (want !== null && typeof want === "object") {
    assert.ok(got !== null && typeof got === "object" && !Array.isArray(got), where);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), where);
    for (const key of Object.keys(want)) {
      if (key.startsWith("usd")) assert.ok(Math.abs(got[key] - want[key]) <= 1e-9, `${where}.${key}`);
      else same(got[key], want[key], `${where}.${key}`);
    }
  } else {
    assert.strictEqual(got, want, where);
  }
}

function close(got: number, want: number): void {
  assert.ok(Math.abs(got - want) <= 1e-12 + 1e-9 * Math.abs(want), `${got} is not ${want}`);
}

let ctx: archil.Context;
before(async () => {
  ctx = await build(newBackend(), SPEC.disks, SPEC.context);
});

describe("plans", () => {
  for (const c of SPEC.cases) {
    test(c.name, async () => {
      const plan = await statement(ctx, c).explain();
      same(JSON.parse(JSON.stringify(plan)), c.plan, c.name); // JSON.stringify(plan) is the IR
      assert.equal(plan.hash, c.plan.hash);
      assert.equal(String(plan), c.text);
    });
  }
});

test("manifest and describe", async () => {
  assert.deepEqual(ctx.manifest(), SPEC.manifest);
  assert.equal(ctx.describe(), SPEC.describe);
  const n = SPEC.narrowed;
  const narrowed = ctx.narrow(n.paths, { readOnly: n.readOnly });
  assert.deepEqual(narrowed.manifest(), n.manifest);
  assert.deepEqual(Object.keys(narrowed.manifest().mounts), Object.keys(n.manifest.mounts)); // the order too
  assert.equal(narrowed.describe(), n.describe);
  const again = await archil.fromManifest(n.manifest, { backend: ctx.backend });
  assert.deepEqual(again.manifest(), n.manifest);
  const fromText = await archil.fromManifest(JSON.stringify(n.manifest), { backend: ctx.backend });
  assert.deepEqual(fromText.manifest(), n.manifest);
});

test("quoting and templates", () => {
  for (const q of SPEC.quote) assert.equal(quote(q.value), q.shell);
  for (const q of SPEC.sqlLiteral) assert.equal(sqlLiteral(q.value), q.sql);
  for (const r of SPEC.render) {
    assert.equal(render(r.template, r.params, (_name, value) => `<${value}>`), r.out);
  }
  for (const c of SPEC.canonical) assert.equal(canonical(c.value), c.json);
});

test("globs", () => {
  for (const g of SPEC.globs) {
    const glob = new Glob("m", g.pattern.slice(2));
    assert.equal(glob.staticPrefix(), g.prefix);
    assert.deepEqual(g.paths.filter((p: string) => glob.regex().test(p)), g.matches);
  }
});

test("reducers", () => {
  for (const r of SPEC.reducers) {
    const reducer = REDUCERS[r.reduce as archil.ReducerName];
    if ("error" in r) {
      assert.throws(
        () => reducer(r.outputs),
        (error: unknown) => error instanceof archil.ArchilError && error.code === r.error,
      );
      continue;
    }
    const [value, stdout] = reducer(r.outputs);
    assert.equal(stdout, r.stdout);
    if (value instanceof Map) {
      assert.deepEqual(Object.fromEntries(value), r.value);
      assert.deepEqual([...value.keys()], Object.keys(r.value)); // key order is part of the result
    } else {
      assert.deepEqual(value, r.value);
    }
  }
});

test("parameters as text", () => {
  for (const d of SPEC.describeParam) assert.equal(describeParam(param(ctx, d.param)), d.text);
});

test("pricing", () => {
  const prices = new archil.PriceSheet();
  const want = SPEC.pricing;
  assert.equal(prices.asOf, want.asOf);
  close(prices.callUsd, want.callUsd);
  for (const c of want.callUnits) assert.equal(prices.callUnits(c.vcpu, c.memMib), c.units);
  close(prices.activeUsd(1024 ** 3), want.activeUsd1GiB);
  close(prices.egressUsd(1000 ** 3), want.egressUsd1GB);
  close(prices.sandboxHourUsd(2, 4096), want.sandboxHourUsd);
  assert.equal(prices.breakevenCallsPerHour(), want.breakevenCallsPerHour);
});
