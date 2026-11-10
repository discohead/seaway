/**
 * Prepared statements for bash.
 *
 * A command is a template with named parameters. A parameter is either a value
 * (quoted so it can never be interpreted by the shell) or a path in the context
 * (which also tells the planner what the command reads and writes).
 *
 * Only `{name}` tokens whose name was passed as a parameter are substituted, so
 * ordinary shell braces (`awk '{print $1}'`, `${HOME}`, `{a,b}`) pass through
 * untouched.
 */

import { numberText, repr, sorted, str } from "./compat.ts";
import type { Context } from "./context.ts";
import { ValidationError } from "./errors.ts";

const PLACEHOLDER = /(?<![$\\])\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WILDCARD = /[*?[]/;

/** Normalise a context path: no leading slash, no empty, `.` or `..` segments. */
export function norm(path: string): string {
  const parts = String(path).replaceAll("\\", "/").split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) {
    throw new ValidationError("paths may not contain '..'", {
      path: String(path),
      code: "bad_path",
      suggestion: "address files from the top of the context: <mount>/<path>",
    });
  }
  return parts.join("/");
}

export function splitMount(path: string): [mount: string, rel: string] {
  const p = norm(path);
  const cut = p.indexOf("/");
  return cut < 0 ? [p, ""] : [p.slice(0, cut), p.slice(cut + 1)];
}

/** The directory part of a path: everything before the last `/`. */
export function parent(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/** Deepest directory that contains every given relative path. */
export function commonDir(rels: Iterable<string>): string {
  const split = Array.from(rels, (r) => (r ? r.split("/") : []));
  if (!split.length) return "";
  const out: string[] = [];
  const shortest = Math.min(...split.map((s) => s.length));
  for (let i = 0; i < shortest; i++) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

/** A path in the context. `write` declares that the command changes it. */
export class Ref {
  readonly mount: string;
  readonly rel: string;
  readonly write: boolean;

  constructor(mount: string, rel = "", write = false) {
    this.mount = mount;
    this.rel = rel;
    this.write = write;
  }

  get path(): string {
    return this.rel ? `${this.mount}/${this.rel}` : this.mount;
  }

  /** A path below this one (Python spells it `ref / "name"`). */
  join(other: string): Ref {
    return new Ref(this.mount, norm(`${this.rel}/${other}`), this.write);
  }

  toString(): string {
    return this.path;
  }
}

/** Files in the context matching a pattern. `**` crosses directories, `*` does not. */
export class Glob {
  readonly mount: string;
  readonly pattern: string;

  constructor(mount: string, pattern: string) {
    this.mount = mount;
    this.pattern = pattern;
  }

  get path(): string {
    return `${this.mount}/${this.pattern}`;
  }

  /** The directory part before the first wildcard: where listing can start. */
  staticPrefix(): string {
    const segments = this.pattern.split("/");
    const head: string[] = [];
    for (const seg of segments) {
      if (WILDCARD.test(seg)) return head.join("/");
      head.push(seg);
    }
    return head.slice(0, -1).join("/"); // no wildcard at all: the last segment is a file name
  }

  regex(): RegExp {
    const p = this.pattern;
    let out = "";
    let i = 0;
    while (i < p.length) {
      if (p.startsWith("**/", i)) {
        out += "(?:[^\\n]*/)?";
        i += 3;
      } else if (p.startsWith("**", i)) {
        out += "[^\\n]*";
        i += 2;
      } else if (p[i] === "*") {
        out += "[^/]*";
        i += 1;
      } else if (p[i] === "?") {
        out += "[^/]";
        i += 1;
      } else {
        out += "^$\\.+()[]{}|".includes(p[i]) ? "\\" + p[i] : p[i];
        i += 1;
      }
    }
    // Python's `.` stops only at a newline and its `$` also matches just before a final one.
    // Both are written out so the two SDKs match the same names, however odd.
    return new RegExp("^" + out + "\\n?$", "u");
  }

  toString(): string {
    return this.path;
  }
}

/** Text inserted into a command exactly as written. Use only for trusted fragments. */
export class Raw {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

export function raw(text: string): Raw {
  return new Raw(text);
}

export class FileStat {
  /** context path: `<mount>/<rel>` */
  readonly path: string;
  readonly size: number;
  /** seconds since the epoch */
  readonly modified: number;
  /** changes when the content changes */
  readonly version: string;

  constructor(path: string, size: number, modified = 0, version = "") {
    this.path = path;
    this.size = size;
    this.modified = modified;
    this.version = version;
  }
}

/**
 * Anything that can stand where a glob can: it resolves to files and says which
 * directories it reads. A log `Selection` is one.
 */
export interface Selectable {
  resolve(ctx: Context): Promise<FileStat[]> | FileStat[];
  roots(): Promise<[mount: string, dir: string][]> | [mount: string, dir: string][];
  /** every file in a selected directory belongs to the selection */
  dirComplete?: boolean;
  /** a SQL condition that narrows the files to exactly the selection, or null */
  predicate?(): string | null;
  toString(): string;
}

/** One shell word, whatever the value contains. `null` and `undefined` are the empty string. */
export function quote(value: unknown): string {
  if (value === null || value === undefined) return "''";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = str(value);
  if (!text) return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(text)) return text;
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "bigint") return value.toString();
  return "'" + str(value).replaceAll("'", "''") + "'";
}

export function placeholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (m) => m[1]);
}

/** A parameter that never appears in the template is almost always a typo. Say so before running. */
export function checkParams(template: string, params: Record<string, unknown>): void {
  const used = new Set(placeholders(template));
  const unused = Object.keys(params).filter((name) => !used.has(name));
  if (unused.length) {
    const found = used.size ? repr(sorted(used)) : "none";
    throw new ValidationError(
      unused.map((name) => ({
        code: "unused_parameter",
        message: `parameter '${name}' does not appear in the command as {${name}}`,
        suggestion: `placeholders found: ${found}`,
      })),
    );
  }
}

const GENERATED = /(?<![$\\])\{p(\d+)\}/g;

/**
 * A tagged template as a template with named parameters: each `${...}` becomes
 * `{p0}`, `{p1}`, … and from there it is the same statement as the named form.
 *
 * The text between the values is taken as written (the raw template), so a
 * backslash reaches bash as a backslash: `\n` in a printf format, `\.` in a regex.
 */
export function tagged(strings: TemplateStringsArray, values: unknown[]): [template: string, params: [string, unknown][]] {
  const parts = strings.raw;
  parts.forEach((part, i) => {
    for (const match of part.matchAll(GENERATED)) {
      if (Number(match[1]) < values.length) {
        throw new ValidationError(`the text contains ${match[0]}, which is also the name given to an interpolated value`, {
          code: "bad_template",
          suggestion: "write this statement as a template with named parameters: sh(template, params)",
        });
      }
    }
    if (i < values.length && /[$\\]$/.test(part)) {
      throw new ValidationError("a value interpolated straight after '$' or a backslash cannot be told apart from shell syntax", {
        code: "bad_template",
        suggestion: "write this statement as a template with named parameters: sh(template, params)",
      });
    }
  });
  let template = parts[0];
  const params: [string, unknown][] = [];
  values.forEach((value, i) => {
    template += `{p${i}}` + parts[i + 1];
    params.push([`p${i}`, value]);
  });
  return [template, params];
}

/** Substitute every `{name}` that names a parameter. Everything else is left alone. */
export function render(
  template: string,
  params: Record<string, unknown>,
  renderParam: (name: string, value: unknown) => string | null | undefined,
): string {
  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (!Object.hasOwn(params, name)) return whole;
    const text = renderParam(name, params[name]);
    return text === null || text === undefined ? whole : text;
  });
}
