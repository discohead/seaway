/**
 * What Python does for the reference SDK without being asked.
 *
 * The Python SDK is the reference, and some of what it writes into plans, error
 * messages and files on a disk comes straight from built-ins: how strings sort,
 * how a float is printed, where a line ends, what `json.dumps` looks like.
 * JavaScript's defaults differ in each of these, so the ones the two SDKs have
 * to agree on are written out here, and nowhere else.
 */

// -- order --------------------------------------------------------------------

/**
 * Compare as Python compares strings: by code point, which is the order of the
 * UTF-8 bytes. JavaScript's `<` compares UTF-16 units, and the two disagree above U+FFFF.
 */
export function cmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** `sorted(items, key=...)`: stable, by code point. Each key is encoded once. */
export function sorted<T>(items: Iterable<T>, key: (item: T) => string = String): T[] {
  return Array.from(items, (item) => [Buffer.from(key(item)), item] as const)
    .sort((a, b) => Buffer.compare(a[0], b[0]))
    .map(([, item]) => item);
}

// -- text ---------------------------------------------------------------------

/** `len(text)`: code points, not UTF-16 units. */
export function len(text: string): number {
  const pairs = text.match(/[\ud800-\udbff][\udc00-\udfff]/g);
  return text.length - (pairs ? pairs.length : 0);
}

/** `text[:n]`, counted in code points. */
export function head(text: string, n: number): string {
  return text.length <= n ? text : Array.from(text).slice(0, n).join("");
}

/** `text[-n:]`, counted in code points. */
export function tail(text: string, n: number): string {
  return text.length <= n ? text : Array.from(text).slice(-n).join("");
}

// What str.strip() removes. JavaScript's trim() also takes U+FEFF and leaves U+001C..U+001F and U+0085.
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEFT = new RegExp(`^[${SPACE}]+`);
const RIGHT = new RegExp(`[${SPACE}]+$`);

export function rstrip(text: string): string {
  return text.replace(RIGHT, "");
}

export function strip(text: string): string {
  return text.replace(LEFT, "").replace(RIGHT, "");
}

const LINE_END = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]");

/** `text.splitlines()`: every line boundary Python knows, and no empty last line. */
export function splitlines(text: string): string[] {
  const lines = text.split(LINE_END);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `data.decode("utf-8", errors="replace")`: bad bytes become U+FFFD, and a leading BOM stays. */
export function decode(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
}

/** `text.ljust(width)`. */
export function ljust(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - len(text)));
}

// -- numbers ------------------------------------------------------------------

/**
 * `f"{x:.{digits}f}"`. toFixed() is correctly rounded except on an exact tie,
 * which it sends away from zero and Python sends to the even digit: 1280 bytes
 * is "1.2 KiB" in a plan, not "1.3 KiB".
 */
export function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return numberText(x);
  const rounded = x.toFixed(digits);
  const exact = x.toFixed(100);
  const cut = exact.indexOf(".") + 1 + digits;
  if (!/^50*$/.test(exact.slice(cut))) return rounded;
  const below = exact.slice(0, digits ? cut : cut - 1); // the neighbour nearer zero
  return Number(below[below.length - 1]) % 2 === 0 ? below : rounded;
}

/** `round(x, digits)`. */
export function round(x: number, digits: number): number {
  return Number.isFinite(x) ? Number(fixed(x, digits)) : x;
}

function exponent(x: number): string {
  const [digits, power] = x.toExponential().split("e");
  const n = Number(power);
  return `${digits}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
}

/**
 * A number as Python writes it with `str()` or `repr()`. The digits are the same
 * in both languages; Python switches to exponent form below 1e-4 where
 * JavaScript waits until 1e-7. JavaScript cannot tell 1.0 from 1, so a whole
 * number is written as an integer.
 */
export function numberText(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Number.isInteger(x) || Math.abs(x) >= 1e-4) return String(x);
  return exponent(x);
}

/** A whole number with every digit, as `str(int(x))` prints it. */
export function intText(x: number): string {
  return Math.abs(x) < 1e21 ? String(x === 0 ? 0 : x) : BigInt(x).toString();
}

/** `repr(x)` for a value Python holds as a float, so a whole number keeps its ".0". */
export function floatRepr(x: number): string {
  if (!Number.isInteger(x)) return numberText(x);
  if (Math.abs(x) >= 1e16) return exponent(x);
  return `${Object.is(x, -0) ? "-0" : String(x)}.0`;
}

// -- str() and repr() ---------------------------------------------------------

const UNPRINTABLE = /[\p{C}\p{Z}]/u;

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp === 0x20 || (cp < 0x7f && cp > 0x20)) out += ch;
    else if (cp < 0x100 && (cp < 0xa0 || UNPRINTABLE.test(ch))) out += "\\x" + hex(cp, 2);
    else if (!UNPRINTABLE.test(ch)) out += ch;
    else out += cp < 0x10000 ? "\\u" + hex(cp, 4) : "\\U" + hex(cp, 8);
  }
  return quote + out + quote;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `str(value)` for the values that reach a command, a file or a message. */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return numberText(value);
  if (Array.isArray(value)) return "[" + value.map(repr).join(", ") + "]";
  if (isPlainObject(value)) {
    return "{" + Object.entries(value).map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ") + "}";
  }
  return String(value);
}

/** `repr(value)`: a string in quotes with Python's escapes, anything else as `str()` writes it. */
export function repr(value: unknown): string {
  return typeof value === "string" ? reprString(value) : str(value);
}

// -- json.dumps ---------------------------------------------------------------

export interface DumpOptions {
  /** `sort_keys=True`: object keys in code-point order. */
  sortKeys?: boolean;
  /** `separators=(",", ":")` instead of Python's default `", "` and `": "`. */
  compact?: boolean;
  /** `ensure_ascii`: write non-ASCII characters as `\uXXXX`. Python's default. */
  ascii?: boolean;
}

const NON_ASCII = new RegExp("[\\u007f-\\uffff]", "g");

function dumpString(text: string, ascii: boolean): string {
  const out = JSON.stringify(text);
  return ascii ? out.replace(NON_ASCII, (c) => "\\u" + hex(c.charCodeAt(0), 4)) : out;
}

function dumpNumber(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  return numberText(x);
}

function skipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * `json.dumps(value, ...)` with Python's defaults. JSON.stringify cannot write
 * Python's separators or its number forms, and it would list keys that look like
 * integers first even in an object built in sorted order.
 */
export function dumps(value: unknown, options: DumpOptions = {}): string {
  const { sortKeys = false, compact = false, ascii = true } = options;
  const comma = compact ? "," : ", ";
  const colon = compact ? ":" : ": ";

  const write = (v: unknown): string => {
    if (v === null || skipped(v)) return "null";
    if (typeof v === "string") return dumpString(v, ascii);
    if (typeof v === "number") return dumpNumber(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    const json = (v as { toJSON?: unknown }).toJSON;
    if (typeof json === "function") return write(json.call(v));
    if (Array.isArray(v)) return "[" + v.map(write).join(comma) + "]";
    const entries: [string, unknown][] =
      v instanceof Map ? Array.from(v, ([k, item]) => [String(k), item]) : Object.entries(v as object);
    const kept = entries.filter(([, item]) => !skipped(item));
    const ordered = sortKeys ? sorted(kept, ([k]) => k) : kept;
    return "{" + ordered.map(([k, item]) => dumpString(k, ascii) + colon + write(item)).join(comma) + "}";
  };

  return write(value);
}
