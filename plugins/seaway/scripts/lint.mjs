#!/usr/bin/env node
/**
 * seaway-lint: the mistakes that are easy to make with seaway and cheap to find by reading.
 *
 *     seaway-lint [--json] [--all] <file or directory>...
 *
 * It reads Python and TypeScript/JavaScript that imports seaway (`--all` reads every file it is
 * given) and reports, with a line number and what to write instead:
 *
 *   warn  interpolated-command   a value pasted into a command's text (Python: f-string, format, %, +)
 *   warn  untagged-template      ctx.sh(`…${x}…`): a call, not a tagged template, so nothing is quoted
 *   warn  never-run              a statement built and dropped: it does nothing until it is run
 *   warn  turn-bypass            a write through the outer context inside a turn
 *   warn  turn-undeclared-mount  a write inside a turn to a mount its `writes` does not name
 *   warn  sql-out-parameter      ctx.out(…) as a parameter of a sql statement, which cannot be compiled
 *   warn  glob-in-list           a glob inside a list parameter, where it is not expanded
 *   note  sql-literal-path       a path written into SQL text, which declares nothing
 *   note  raw-fragment           raw() given something other than a constant
 *   note  returned-statement     a statement returned from an async function (awaiting it runs it)
 *   note  tools-without-egress   tools turned into a model's schema with no network policy in sight
 *   note  sqlite-unlocked-read   a sqlite3 -readonly read that takes no checkout
 *   note  absolute-mount-path    /mnt/archil written into a command
 *
 * A line that says `seaway-lint: ignore` is skipped, or `seaway-lint: ignore <rule>` for one rule.
 * It exits 1 when there is a warn, so it can stand in a check. It is a reader, not a parser: it
 * prefers saying nothing to saying something wrong.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closing, lineOf, lineText, scan, skipSpace } from "./lib/scan.mjs";

const PY = new Set([".py"]);
const JS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".archil-local", ".pytest_cache"]);

export function language(file) {
  const ext = path.extname(file).toLowerCase();
  return PY.has(ext) ? "python" : JS.has(ext) ? "js" : null;
}

export function usesSeaway(text, lang) {
  if (lang === "python") return /^[ \t]*(?:import[ \t]+seaway\b|from[ \t]+seaway(?:\.\w+)*[ \t]+import\b)/m.test(text);
  return /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["']seaway(?:\/[^"']*)?["']/.test(text);
}

const MESSAGES = {
  "interpolated-command":
    "the command's text is built from values, so they are not quoted and declare nothing. Write {name} in the template and pass the value as a parameter (a path as ctx.path, ctx.glob or ctx.out).",
  "untagged-template":
    "this is a call with a template literal, so JavaScript puts the values into the text before seaway sees them: nothing is quoted and no path is declared. Drop the parentheses to make it a tagged template, or use named parameters: ctx.sh(\"… {name} …\", { name }).",
  "never-run": "this statement is built and dropped. A statement does nothing until it is run: call .run() or .explain()",
  "turn-bypass":
    "inside this turn, a write through the outer context goes to the main line at once and is not part of the turn. Use the turn's own context",
  "turn-undeclared-mount":
    "this turn's `writes` does not name the mount this path is on, so that mount is not part of the turn: the write lands on the main line at once, and stays if the turn fails. Add the mount to `writes`, or leave `writes` out to cover every writable mount",
  "sql-out-parameter":
    "a sql statement cannot take ctx.out(…) as a parameter: it fails when it is compiled, with an error that does not say why. Write the query's result with .into(path), and leave the path out of the SQL.",
  "glob-in-list":
    "a glob inside a list is not expanded: the command is handed the pattern itself as one quoted word, which matches no file. Pass the glob as a parameter of its own.",
  "sql-literal-path":
    "a path written into the SQL declares nothing, so the call mounts every disk and has no price. Pass it as a parameter: {events}, with events = ctx.path(…), ctx.glob(…) or a log selection.",
  "raw-fragment": "raw() puts text into the command as written. Keep it for constants; anything else belongs in a {name} parameter, which is quoted.",
  "returned-statement":
    "a statement returned from an async function is awaited by its caller, which runs it: the caller gets a Result. If the statement itself is wanted, return it from a plain function or inside an object; if the result is, say so with .run().",
  "tools-without-egress":
    "commands run by these tools have the whole internet unless the context has a network policy. Hand a model ctx.with_egress(\"deny\").tools() (withEgress in TypeScript) unless its commands need the network.",
  "sqlite-unlocked-read":
    "a read on a read-only mount is not isolated from a write made by another call. Where the read has to be right, name the database with ctx.out(…) so that it takes the checkout.",
  "absolute-mount-path":
    "a command starts where the disks are mounted on both backends, so write paths as the context has them (logs/…). /mnt/archil exists only inside an Archil call.",
};

const LEVELS = {
  "interpolated-command": "warn",
  "untagged-template": "warn",
  "never-run": "warn",
  "turn-bypass": "warn",
  "turn-undeclared-mount": "warn",
  "sql-out-parameter": "warn",
  "glob-in-list": "warn",
  "sql-literal-path": "note",
  "raw-fragment": "note",
  "returned-statement": "note",
  "tools-without-egress": "note",
  "sqlite-unlocked-read": "note",
  "absolute-mount-path": "note",
};

const IDENT = "[A-Za-z_$][\\w$]*";

/** Every `.sh(`, `.sql(`, `.grep(`, `.batch(` and tagged `.sh\`` in the blanked source. */
function calls(src, names) {
  const found = [];
  const re = new RegExp(`\\.(${names.join("|")})\\s*(\\(|\`)`, "g");
  for (const m of src.masked.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const tagged = m[2] === "`";
    const end = tagged ? (src.byStart.get(open)?.end ?? -1) : closing(src.masked, open);
    if (end < 0) continue;
    found.push({ name: m[1], at: m.index, open, end, tagged });
  }
  return found;
}

/** The string literals that make up a call's first argument: one, or several written side by side (Python). */
function firstStrings(src, call) {
  if (call.tagged) {
    const token = src.byStart.get(call.open);
    return token ? [token] : [];
  }
  const tokens = [];
  let at = skipSpace(src.masked, call.open + 1);
  for (;;) {
    const token = src.byStart.get(at);
    if (!token) break;
    tokens.push(token);
    if (src.lang !== "python") break;
    at = skipSpace(src.masked, token.end);
  }
  return tokens;
}

function said(src, tokens) {
  return tokens.map((t) => src.text.slice(t.open, t.end)).join("");
}

/**
 * Follow `.name(…)` and `.name` after a call. Returns what was called, what was read, and where the
 * chain stopped. In Python a chain stays on its line; in JavaScript it may continue on the next.
 */
function chain(src, from) {
  const methods = [];
  const props = [];
  let i = from;
  for (;;) {
    let j = i;
    if (src.lang === "python") while (src.masked[j] === " " || src.masked[j] === "\t") j++;
    else j = skipSpace(src.masked, j);
    if (src.masked[j] === "?" && src.masked[j + 1] === ".") j++;
    if (src.masked[j] !== "." || src.masked[j + 1] === ".") break;
    const m = new RegExp(`^\\.\\s*(${IDENT})`).exec(src.masked.slice(j, j + 80));
    if (!m) break;
    let k = j + m[0].length;
    const after = skipInline(src.masked, k);
    if (src.masked[after] === "(") {
      const end = closing(src.masked, after);
      if (end < 0) break;
      methods.push(m[1]);
      k = end;
    } else {
      props.push(m[1]);
    }
    i = k;
  }
  return { methods, props, end: i };
}

function skipInline(masked, i) {
  while (masked[i] === " " || masked[i] === "\t") i++;
  return i;
}

function lineStart(text, index) {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/** How deep in ( and [ each position is, on the blanked text. */
function depths(masked) {
  const out = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    out[i] = depth;
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
  }
  out[masked.length] = depth;
  return out;
}

/** The last thing written before `index` that is not white space. */
function before(masked, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  return i < 0 ? "" : masked[i];
}

const RUNS = new Set(["run", "explain", "then", "catch", "finally"]);

/** Does the line above open a block that expects what follows to raise (`with pytest.raises(…):`)? */
function expectsAnError(masked, start) {
  let end = start - 1;
  while (end > 0 && /\s/.test(masked[end - 1])) end--;
  const line = masked.slice(lineStart(masked, end), end);
  return /^\s*with\b.*\b(?:raises|assertRaises\w*)\s*\(/.test(line);
}

// -- the rules ------------------------------------------------------------------

function interpolatedCommand(src, report) {
  if (src.lang !== "python") return;
  for (const call of calls(src, ["sh", "sql"])) {
    const tokens = firstStrings(src, call);
    if (!tokens.length) continue;
    if (tokens.some((t) => t.prefix.includes("f") && t.interpolated)) {
      report("interpolated-command", call.at);
      continue;
    }
    const next = skipSpace(src.masked, tokens[tokens.length - 1].end);
    if (src.masked.startsWith(".format(", next) || src.masked[next] === "%" || joinsAValue(src, next)) {
      report("interpolated-command", call.at);
    }
  }
}

/** Is there a `+` at `at` that joins on something other than another string constant? */
function joinsAValue(src, at) {
  if (src.masked[at] !== "+") return false;
  const token = src.byStart.get(skipSpace(src.masked, at + 1));
  return !token || token.interpolated;
}

function untaggedTemplate(src, report) {
  if (src.lang !== "js") return;
  for (const call of calls(src, ["sh", "sql"])) {
    if (call.tagged) continue;
    const [token] = firstStrings(src, call);
    if (!token) continue;
    if (token.template && token.interpolated) report("untagged-template", call.at);
    else if (joinsAValue(src, skipSpace(src.masked, token.end))) report("untagged-template", call.at);
  }
}

function neverRun(src, report) {
  const depth = depths(src.masked);
  const receiver = new RegExp(`^[ \\t]*${IDENT}(?:\\.${IDENT})*$`);
  for (const call of calls(src, ["sh", "sql", "grep", "batch"])) {
    const start = lineStart(src.masked, call.at);
    if (depth[start] !== 0) continue; // inside someone's arguments
    if (!receiver.test(src.masked.slice(start, call.at))) continue; // assigned, returned, awaited, passed on
    const prev = before(src.masked, start);
    if (src.lang === "python" ? prev === "\\" : prev !== "" && !";{})".includes(prev)) continue; // a continuation
    if (src.lang === "python" && expectsAnError(src.masked, start)) continue; // built to see it refused
    const { methods, props, end } = chain(src, call.end);
    if (props.length || methods.some((m) => RUNS.has(m))) continue;
    if (src.lang === "python") {
      const eol = src.masked.indexOf("\n", end);
      if (src.masked.slice(end, eol < 0 ? undefined : eol).trim()) continue;
    } else {
      const next = skipSpace(src.masked, end);
      const sameLine = !src.masked.slice(end, next).includes("\n");
      const ch = src.masked[next] ?? "";
      if (sameLine ? !(ch === ";" || ch === "}" || ch === "") : /[.?:+\-*/%,)\]=&|<>]/.test(ch)) continue;
    }
    report("never-run", call.at, src.lang === "python" ? "." : ", or await it.");
  }
}

/**
 * Every turn written as a block: `with ctx.transaction(…) as turn:` in Python, and
 * `ctx.transaction(async (turn) => { … }, options)` in TypeScript. For each: the names of the outer
 * context and of the turn, where the block is, and the text of the arguments that hold `writes`.
 */
function turns(src) {
  const found = [];
  if (src.lang === "python") {
    const re = new RegExp(`^([ \\t]*)(?:async[ \\t]+)?with[ \\t]+(${IDENT})\\.transaction[ \\t]*\\(`, "gm");
    for (const m of src.masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = closing(src.masked, open);
      if (close < 0) continue;
      const as = /^\s*as\s+([A-Za-z_]\w*)\s*:/.exec(src.masked.slice(close, close + 120));
      if (!as) continue;
      // the block: the lines that follow, for as long as they are indented further than the `with`
      const indent = m[1].length;
      const from = src.masked.indexOf("\n", close);
      if (from < 0) continue;
      let to = from;
      for (;;) {
        const next = src.masked.indexOf("\n", to + 1);
        const line = src.masked.slice(to + 1, next < 0 ? undefined : next);
        if (line.trim() && line.length - line.trimStart().length <= indent) break;
        to = next < 0 ? src.masked.length : next;
        if (next < 0) break;
      }
      found.push({ ctx: m[2], turn: as[1], from, to, options: [open, close] });
    }
  } else {
    const re = new RegExp(`(${IDENT})\\.transaction\\s*\\(\\s*(?:async\\s*)?\\(?\\s*(${IDENT})\\s*(?::[^)=]*)?\\)?\\s*=>\\s*\\{`, "g");
    for (const m of src.masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = closing(src.masked, open);
      if (close < 0) continue;
      const call = closing(src.masked, src.masked.indexOf("(", m.index + m[1].length));
      found.push({ ctx: m[1], turn: m[2], from: open, to: close, options: [close, call < 0 ? close : call] });
    }
  }
  return found;
}

function turnBypass(src, report) {
  const writes = "write|append|rm|sh|sql|batch|sync";
  for (const t of turns(src)) {
    if (t.ctx === t.turn) continue;
    const re = new RegExp(`(?<![\\w$.])${t.ctx.replace(/\$/g, "\\$")}\\.(${writes})\\s*[(\`]`, "g");
    for (const m of src.code.slice(t.from, t.to).matchAll(re)) {
      report("turn-bypass", t.from + m.index, `: ${t.turn}.${m[1]}(…).`);
    }
  }
}

/** The mounts a literal `writes` list names, or null when there is none to read. */
function declaredMounts(src, [from, to]) {
  const at = /\bwrites\s*[=:]\s*\[/.exec(src.masked.slice(from, to));
  if (!at) return null;
  const open = from + at.index + at[0].length - 1;
  const close = closing(src.masked, open);
  if (close < 0) return null;
  const mounts = new Set();
  for (const s of src.strings) {
    if (s.start <= open || s.end >= close) continue;
    if (s.interpolated) return null; // built from values: not ours to judge
    mounts.add(src.text.slice(s.open + 1, s.end - 1).replace(/^\/+/, "").split("/")[0]);
  }
  // anything in the list that is not a string constant means the list cannot be read here
  const rest = src.masked.slice(open + 1, close - 1).replace(/["'`]\s*["'`]/g, "").replace(/[\s,]/g, "");
  return rest ? null : mounts;
}

function turnUndeclaredMount(src, report) {
  for (const t of turns(src)) {
    const mounts = declaredMounts(src, t.options);
    if (!mounts || !mounts.size) continue;
    const re = new RegExp(`(?<![\\w$.])${t.turn.replace(/\$/g, "\\$")}\\.(?:write|rm|out)\\s*\\(\\s*`, "g");
    for (const m of src.code.slice(t.from, t.to).matchAll(re)) {
      const token = src.anyByStart.get(t.from + m.index + m[0].length);
      if (!token) continue;
      const said = src.text.slice(token.open + 1, token.end - 1);
      const mount = said.replace(/^\/+/, "").split("/")[0];
      if (!mount || /[{}$`]/.test(mount) || mounts.has(mount)) continue; // a name built from a value is not ours to judge
      report("turn-undeclared-mount", t.from + m.index, `. (\`writes\` names ${[...mounts].join(", ")}; this is on ${mount}.)`);
    }
  }
}

/** `ctx.out(…)` among the parameters of a `sql` statement. The SDKs cannot render it: only `.into()` writes from a query. */
function sqlOutParameter(src, report) {
  for (const call of calls(src, ["sql"])) {
    const re = /\.out\s*\(/g;
    re.lastIndex = call.open + 1;
    const found = re.exec(src.code);
    if (found && found.index < call.end) report("sql-out-parameter", found.index);
  }
}

/**
 * `ctx.glob(…)` written straight into a list that is a statement's parameter. A list's items are rendered as
 * single words, so the glob reaches the command as its own text. The bracket that is still open where the glob
 * stands says whether it is in a list: one inside another call's parentheses is that call's argument.
 */
function globInList(src, report) {
  for (const call of calls(src, ["sh", "sql"])) {
    const re = /\.glob\s*\(/g;
    re.lastIndex = call.open + 1;
    for (let found = re.exec(src.code); found && found.index < call.end; found = re.exec(src.code)) {
      let depth = 0;
      let opener = "";
      for (let i = found.index - 1; i > call.open; i--) {
        const ch = src.code[i];
        if (ch === ")" || ch === "]" || ch === "}") depth++;
        else if (ch === "(" || ch === "[" || ch === "{") {
          if (depth === 0) {
            opener = ch;
            break;
          }
          depth--;
        }
      }
      if (opener === "[") report("glob-in-list", found.index);
    }
  }
}

const SQL_PATH = /\bread_(?:json|ndjson|csv|parquet|text|blob)\w*\s*\(\s*\[?\s*['"]|\bfrom\s+'[^'\n]+\.(?:ndjson|jsonl|json|csv|tsv|parquet)'/i;

function sqlLiteralPath(src, report) {
  for (const call of calls(src, ["sql"])) {
    if (SQL_PATH.test(said(src, firstStrings(src, call)))) report("sql-literal-path", call.at);
  }
}

function rawFragment(src, report) {
  const names = new Set();
  if (src.lang === "python") {
    for (const m of src.text.matchAll(/^[ \t]*import[ \t]+seaway(?:[ \t]+as[ \t]+(\w+))?/gm)) names.add(`${m[1] ?? "seaway"}.raw`).add(`${m[1] ?? "seaway"}.Raw`);
    for (const m of src.text.matchAll(/^[ \t]*from[ \t]+seaway(?:\.\w+)*[ \t]+import[ \t]+([^\n]+)/gm)) {
      for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())) if (/^raw$/i.test(name ?? "")) names.add(name);
    }
  } else {
    for (const m of src.text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s*["']seaway["']/g)) names.add(`${m[1]}.raw`);
    for (const m of src.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']seaway["']/g)) {
      for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())) if (/^raw$/i.test(name ?? "")) names.add(name);
    }
  }
  for (const name of names) {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/[.$]/g, "\\$&")}\\s*\\(`, "g");
    for (const m of src.masked.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const token = src.byStart.get(skipSpace(src.masked, open + 1));
      const constant = token && !token.interpolated && src.masked[skipSpace(src.masked, token.end)] === ")";
      if (!constant) report("raw-fragment", m.index);
    }
  }
}

function returnedStatement(src, report) {
  if (src.lang !== "js") return;
  const dropped = (open, tagged) => {
    const end = tagged ? (src.byStart.get(open)?.end ?? -1) : closing(src.masked, open);
    if (end < 0) return false;
    const { methods, props } = chain(src, end);
    return !props.length && !methods.some((m) => RUNS.has(m));
  };
  const returned = new RegExp(`\\breturn\\s+(?:${IDENT}\\.)+(?:sh|sql|grep|batch)\\s*(\\(|\`)`, "g");
  for (const m of src.masked.matchAll(returned)) {
    if (dropped(m.index + m[0].length - 1, m[1] === "`") && insideAsync(src.masked, m.index)) report("returned-statement", m.index);
  }
  const concise = new RegExp(`\\basync\\s*(?:\\([^()]*\\)|${IDENT})\\s*=>\\s*(?:${IDENT}\\.)+(?:sh|sql|grep|batch)\\s*(\\(|\`)`, "g");
  for (const m of src.masked.matchAll(concise)) {
    if (dropped(m.index + m[0].length - 1, m[1] === "`")) report("returned-statement", m.index);
  }
}

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);

/** Is the function whose body holds `pos` an async one? Says no when it cannot tell. */
function insideAsync(masked, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = masked.slice(Math.max(0, i - 400), i).trimEnd();
      if (head.endsWith("=>")) return new RegExp(`\\basync\\s*(?:\\([^()]*\\)|${IDENT})\\s*(?::[^=;{}]+)?=>$`).test(head);
      const fn = new RegExp(`(\\basync\\s+)?(?:function\\b\\s*\\*?\\s*)?(${IDENT})?\\s*\\([^()]*\\)\\s*(?::[^{};]+)?$`).exec(head);
      if (fn && !CONTROL.has(fn[2] ?? "")) return Boolean(fn[1]);
      // a block of some other kind (if, try, a class body): look further out
    }
  }
  return false;
}

/** Tools on their way to a model: built from a context and turned into a provider's schema, or bridged to the official tool layer. */
function toolsWithoutEgress(src, report) {
  if (/egress/i.test(src.text)) return;
  const handed = /\.(?:to_anthropic|to_openai|toAnthropic|toOpenAI)\s*\(|\basFileSystem\s*\(/.exec(src.masked);
  if (!handed) return;
  const built = /\.tools\s*\(/.exec(src.masked);
  if (built || handed[0].startsWith("asFileSystem")) report("tools-without-egress", (built ?? handed).index);
}

function sqliteUnlockedRead(src, report) {
  for (const call of calls(src, ["sh"])) {
    const text = said(src, firstStrings(src, call));
    if (!/\bsqlite3\b/.test(text) || !/-readonly\b/.test(text)) continue;
    const whole = src.text.slice(call.open, call.end);
    if (!/\.out\s*\(/.test(whole)) report("sqlite-unlocked-read", call.at);
  }
}

function absoluteMountPath(src, report) {
  for (const call of calls(src, ["sh", "sql"])) {
    if (said(src, firstStrings(src, call)).includes("/mnt/archil")) report("absolute-mount-path", call.at);
  }
}

const RULES = [
  interpolatedCommand,
  untaggedTemplate,
  neverRun,
  turnBypass,
  turnUndeclaredMount,
  sqlOutParameter,
  globInList,
  sqlLiteralPath,
  rawFragment,
  returnedStatement,
  toolsWithoutEgress,
  sqliteUnlockedRead,
  absoluteMountPath,
];

/**
 * Lint one file's text. Returns findings in the order they appear:
 * { file, line, rule, level, message }.
 */
export function lintText(file, text, options = {}) {
  const lang = language(file);
  if (!lang || (!options.all && !usesSeaway(text, lang))) return [];
  const { masked, code, strings, nested } = scan(text, lang);
  const src = {
    text, masked, code, strings, lang,
    byStart: new Map(strings.map((s) => [s.start, s])),
    anyByStart: new Map(nested.map((s) => [s.start, s])), // strings inside a template's ${ } as well
  };
  const findings = [];
  const seen = new Set();
  const report = (rule, index, tail = "") => {
    const line = lineOf(text, index);
    const ignore = /seaway-lint:\s*ignore\b([^\n]*)/.exec(lineText(text, index));
    if (ignore && (!ignore[1].trim() || ignore[1].includes(rule))) return;
    if (seen.has(`${rule}:${line}`)) return;
    seen.add(`${rule}:${line}`);
    findings.push({ file, line, rule, level: LEVELS[rule], message: MESSAGES[rule] + tail });
  };
  for (const rule of RULES) {
    try {
      rule(src, report);
    } catch {
      // a rule that trips on unusual source says nothing
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function lintFile(file, options = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (text.length > 2_000_000) return [];
  return lintText(file, text, options);
}

function* walk(target) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (language(target)) yield target;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() ? SKIP_DIRS.has(entry.name) : !language(entry.name)) continue;
    yield* walk(path.join(target, entry.name));
  }
}

export function format(finding) {
  return `${finding.file}:${finding.line}  ${finding.level}  ${finding.rule}  ${finding.message}`;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const targets = argv.filter((a) => !a.startsWith("--"));
  if (flags.has("--help") || !targets.length) {
    console.log("usage: seaway-lint [--json] [--all] <file or directory>...\n\n" + Object.entries(LEVELS).map(([rule, level]) => `  ${level}  ${rule}`).join("\n"));
    return targets.length ? 0 : 2;
  }
  const findings = [];
  let files = 0;
  for (const target of targets) {
    for (const file of walk(target)) {
      files++;
      findings.push(...lintFile(file, { all: flags.has("--all") }));
    }
  }
  if (flags.has("--json")) {
    console.log(JSON.stringify({ files, findings }, null, 2));
  } else {
    for (const finding of findings) console.log(format(finding));
    const warns = findings.filter((f) => f.level === "warn").length;
    console.log(`${findings.length ? "\n" : ""}seaway-lint: ${files} file(s) read, ${warns} warn, ${findings.length - warns} note`);
  }
  return findings.some((f) => f.level === "warn") ? 1 : 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));

export { LEVELS, MESSAGES };
