/**
 * What the plugin's tests share: where things are, and a client for the context server.
 *
 *     node --test plugins/seaway/tests/
 *
 * The tests that need the seaway SDK look for it beside the plugin (this repository's
 * typescript/ directory) or at SEAWAY_SDK, and are skipped when it is not there.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = path.join(PLUGIN, "servers", "context-server.mjs");
export const HOOK = path.join(PLUGIN, "scripts", "hook.mjs");
export const LINT = path.join(PLUGIN, "scripts", "lint.mjs");
export const DOCTOR = path.join(PLUGIN, "scripts", "doctor.mjs");

const beside = path.resolve(PLUGIN, "..", "..", "typescript");
export const SDK = process.env.SEAWAY_SDK || (existsSync(path.join(beside, "src", "index.ts")) ? beside : "");
export const NO_SDK = SDK ? false : "the seaway SDK is not beside the plugin; set SEAWAY_SDK to a checkout";

export function has(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

export function scratch(tag) {
  return mkdtempSync(path.join(tmpdir(), `seaway-plugin-${tag}-`));
}

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** Every server a test started. A test that fails before it closes its client must not leave one running. */
const started = new Set();

export function closeAll() {
  for (const child of started) child.kill();
  started.clear();
}

/**
 * Start the context server and talk to it.
 *
 * `era` is "modern" (no handshake; every request carries its version) or "legacy" (it begins with
 * `initialize`). `env` is added to a clean environment, so nothing from the caller's shell leaks in.
 */
export async function connect({ era = "modern", env = {}, cwd = scratch("cwd"), version = "2026-07-28" } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "", SEAWAY_SDK: SDK, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.add(child);
  child.on("exit", () => started.delete(child));
  const waiting = new Map();
  let stderr = "";
  let next = 1;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line); // anything on stdout that is not a message is a bug, and throws here
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const client = {
    cwd,
    stderr: () => stderr,
    /** Send one request as written and return the whole response message. */
    raw(method, params, id = next++) {
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
      });
    },
    /** Send one request in this client's era. */
    request(method, params = {}) {
      return client.raw(method, era === "modern" ? { ...params, _meta: { [VERSION_KEY]: version } } : params);
    },
    line(text) {
      return new Promise((resolve) => {
        waiting.set(null, resolve);
        child.stdin.write(text + "\n");
      });
    },
    /** Call a tool; returns { text, isError }. */
    async call(name, args = {}) {
      const message = await client.request("tools/call", { name, arguments: args });
      if (message.error) throw new Error(`tools/call ${name}: ${JSON.stringify(message.error)}`);
      return { text: message.result.content.map((c) => c.text).join(""), isError: message.result.isError === true, result: message.result };
    },
    async close() {
      child.stdin.end();
      await exited;
    },
  };
  if (era === "legacy") {
    const hello = await client.raw("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "plugin-tests", version: "0" },
    });
    client.hello = hello;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  return client;
}
