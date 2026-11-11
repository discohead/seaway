/**
 * What kind of project this is, and what the environment would do with seaway.
 *
 * Everything here reads the file system and the environment only. Nothing is run, so it is safe
 * and quick enough for a hook that fires at the start of every session.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function read(file, limit = 256 * 1024) {
  try {
    if (statSync(file).size > limit) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Is `dir` a checkout of seaway itself: both SDKs and the fixture that keeps them in step? */
export function isCheckout(dir) {
  return (
    isFile(path.join(dir, "python", "src", "seaway", "__init__.py")) &&
    isFile(path.join(dir, "typescript", "src", "index.ts")) &&
    isFile(path.join(dir, "conformance", "generate.py"))
  );
}

/** The checkout that holds `file`, or null. */
export function checkoutOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 12; depth++) {
    if (isCheckout(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * What a project has to do with seaway.
 * @returns {{ kind: "checkout" | "uses" | "none", signs: string[] }}
 */
export function project(dir) {
  if (isCheckout(dir)) return { kind: "checkout", signs: ["python/src/seaway and typescript/src"] };
  const signs = [];
  const pkg = read(path.join(dir, "package.json"));
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        if (json[key] && Object.hasOwn(json[key], "seaway")) signs.push(`package.json ${key}`);
      }
    } catch {
      // not JSON: not a sign either way
    }
  }
  for (const name of ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.cfg", "setup.py", "Pipfile", "uv.lock"]) {
    if (/(^|[\s"'=\[,/@-])seaway\b/m.test(read(path.join(dir, name)))) signs.push(name);
  }
  if (isDir(path.join(dir, ".archil-local"))) signs.push(".archil-local/");
  // a context manifest at the top of the project
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("package") && n !== "tsconfig.json").slice(0, 40);
  } catch {
    // unreadable: no signs
  }
  for (const name of names) {
    if (/"archilContext"\s*:\s*0/.test(read(path.join(dir, name), 64 * 1024))) signs.push(`${name} (a context manifest)`);
  }
  return { kind: signs.length ? "uses" : "none", signs };
}

/** The full path of a program on the PATH, or null. Nothing is run. */
export function which(name, env = process.env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Where a context opened without a backend would act.
 * @returns {{ live: boolean, forcedLocal: boolean, key: boolean, region: string }}
 */
export function backend(env = process.env) {
  const key = Boolean(env.ARCHIL_API_KEY);
  const forcedLocal = (env.ARCHIL_BACKEND ?? "").toLowerCase() === "local";
  return { live: key && !forcedLocal, forcedLocal, key, region: env.ARCHIL_REGION ?? "" };
}

/** A Node version as numbers, and whether it can run the TypeScript SDK from source. */
export function node(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return { version, ok: major > 22 || (major === 22 && minor >= 19) };
}

/** The file in typescript/src that a file in python/src/seaway corresponds to, and back. */
export function twin(file) {
  const base = path.basename(file);
  const dir = path.dirname(file).split(path.sep).join("/");
  if (dir.endsWith("python/src/seaway") && base.endsWith(".py")) {
    const stem = base.slice(0, -3);
    const name = stem === "__init__" ? "index" : stem.replaceAll("_", "-");
    return { side: "python", other: `typescript/src/${name}.ts` };
  }
  if (dir.endsWith("typescript/src") && base.endsWith(".ts")) {
    const stem = base.slice(0, -3);
    if (stem === "compat") return { side: "typescript", other: null };
    const name = stem === "index" ? "__init__" : stem.replaceAll("-", "_");
    return { side: "typescript", other: `python/src/seaway/${name}.py` };
  }
  return null;
}

export { isFile, isDir, read, existsSync };
