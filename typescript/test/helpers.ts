/** What the Python suite gets from conftest.py: a backend on a temporary root, and contexts over it. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import * as archil from "../src/index.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh temporary directory, removed when the test file is done. */
export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "px-test-"));
  roots.push(dir);
  return dir;
}

export function newBackend(options: archil.LocalBackendOptions = {}): archil.LocalBackend {
  return new archil.LocalBackend({ root: join(tmp(), "archil"), ...options });
}

/** A context with one mount of each kind a test is likely to need. */
export function newContext(backend: archil.LocalBackend): Promise<archil.Context> {
  return archil.context(
    {
      logs: archil.disk("app-logs", "append", { create: true, description: "service logs" }),
      ref: archil.disk("reference", "read", { create: true }),
      work: archil.disk("workspace", "owned", { create: true }),
      team: archil.disk("team-shared", "shared", { create: true }),
    },
    { backend, name: "test" },
  );
}

/** Reference data is read-only to the context, so tests seed it through the backend. */
export async function seed(backend: archil.LocalBackend): Promise<void> {
  await backend.put("reference", "docs/a.md", Buffer.from("alpha\nneedle one\n"));
  await backend.put("reference", "docs/b.md", Buffer.from("beta\n"));
  await backend.put("reference", "data/n1.txt", Buffer.from("1\n2\n3\n"));
  await backend.put("reference", "data/n2.txt", Buffer.from("10\n20\n"));
  await backend.put("reference", "data/deep/n3.txt", Buffer.from("100\n"));
}

export interface Fixture {
  backend: archil.LocalBackend;
  ctx: archil.Context;
}

export async function fixture(): Promise<Fixture> {
  const backend = newBackend();
  return { backend, ctx: await newContext(backend) };
}

/** The same, with the reference disk seeded. */
export async function seeded(): Promise<Fixture> {
  const f = await fixture();
  await seed(f.backend);
  return f;
}

function has(binary: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" }).status === 0;
}

/** Options for a test that needs a binary: skipped, with the reason, when it is not installed. */
export const needsDuckdb = { skip: has("duckdb") ? false : "duckdb CLI not installed" };
export const needsGit = { skip: has("git") ? false : "git not installed" };
export const needsCurl = { skip: has("curl") ? false : "curl not installed" };

/** The error a promise rejects with (or a function throws), for assertions on its fields. */
export async function thrown(run: (() => unknown) | Promise<unknown>): Promise<archil.ArchilError> {
  try {
    await (typeof run === "function" ? run() : run);
  } catch (error) {
    return error as archil.ArchilError;
  }
  throw new Error("expected an error, and nothing was thrown");
}
