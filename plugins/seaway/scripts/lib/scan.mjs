/**
 * Just enough lexing to lint by pattern without being fooled by strings and comments.
 *
 * `scan(text, lang)` returns the source with every string's contents and every comment blanked
 * (same length, same line breaks, quotes kept), plus the strings it found. Structure is then
 * matched on the blanked text, and what a string says is read from the original.
 *
 * It returns two blanked views. In `masked`, a JavaScript template literal is one opaque token:
 * whatever its `${ }` hold is blanked too, so brackets inside it cannot upset the matching of
 * brackets outside. In `code`, the text of a template is blanked and the code inside its `${ }`
 * is kept, for the rules that have to see a call made there. In Python the two are the same.
 * `strings` holds the outermost strings, and `nested` every string, those inside a `${ }` included.
 */

/**
 * @typedef {{ start: number, open: number, end: number, prefix: string, template: boolean,
 *             interpolated: boolean }} Str
 * `start` is where the token begins (its prefix, in Python), `open` where its quote is, `end` one
 * past its closing quote.
 */

const blank = (ch) => (ch === "\n" || ch === "\r" ? ch : " ");

function scanPython(text) {
  const out = text.split("");
  /** @type {Str[]} */
  const strings = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") out[i] = blank(text[i++]);
      continue;
    }
    if (ch === '"' || ch === "'") {
      // letters straight before the quote are its prefix (r, b, f, u, in any case and order)
      let start = i;
      while (start > 0 && /[rbfuRBFU]/.test(text[start - 1]) && i - start < 3) start--;
      if (start > 0 && /[\w)\]]/.test(text[start - 1])) start = i; // part of a name, not a prefix
      const prefix = text.slice(start, i).toLowerCase();
      const triple = text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      const open = i;
      i += quote.length;
      let interpolated = false;
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === "\\" && i + 1 < text.length) {
          out[i] = blank(text[i]);
          out[i + 1] = blank(text[i + 1]);
          i += 2;
          continue;
        }
        if (!triple && text[i] === "\n") break; // an unterminated string ends with its line
        if (prefix.includes("f") && text[i] === "{") {
          if (text[i + 1] === "{") {
            out[i] = out[i + 1] = " ";
            i += 2;
            continue;
          }
          interpolated = true;
        }
        out[i] = blank(text[i]);
        i++;
      }
      i = Math.min(text.length, i + quote.length);
      strings.push({ start, open, end: i, prefix, template: false, interpolated });
      continue;
    }
    i++;
  }
  const masked = out.join("");
  return { masked, code: masked, strings, nested: strings };
}

const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^"]);

function scanJs(text) {
  const out = text.split("");
  const code = text.split(""); // as `out`, except that what a template's ${ } holds is kept
  /** @type {Str[]} */
  const strings = [];
  // a stack of what encloses the cursor: a template's text, or code inside its ${ } at some brace depth
  /** @type {{ str: Str, depth: number }[]} */
  const templates = [];
  let i = 0;
  let last = ""; // the last character of code that was not white space

  const template = (str) => {
    // the cursor is just inside the template: consume its text up to ${ or the closing quote
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        out[i] = code[i] = blank(ch);
        out[i + 1] = code[i + 1] = blank(text[i + 1]);
        i += 2;
      } else if (ch === "`") {
        i++;
        str.end = i;
        // The outermost template is one opaque token: blank whatever its ${ } held as well,
        // quotes and nested templates included.
        if (!templates.length) for (let k = str.open + 1; k < str.end - 1; k++) out[k] = blank(text[k]);
        return;
      } else if (ch === "$" && text[i + 1] === "{") {
        str.interpolated = true;
        out[i] = out[i + 1] = code[i] = code[i + 1] = " ";
        i += 2;
        templates.push({ str, depth: 0 });
        return;
      } else {
        out[i] = code[i] = blank(ch);
        i++;
      }
    }
    str.end = i;
  };

  while (i < text.length) {
    const ch = text[i];
    const inside = templates.length ? templates[templates.length - 1] : null;
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = code[i] = blank(text[i]);
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      while (i < end) {
        out[i] = code[i] = blank(text[i]);
        i++;
      }
      continue;
    }
    if (ch === "/" && (last === "" || BEFORE_REGEX.has(last))) {
      // a regular expression literal: skip it whole, so a quote inside it does not open a string
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        for (let k = i + 1; k < j; k++) out[k] = code[k] = blank(text[k]);
        i = j + 1;
        last = "/";
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const open = i++;
      while (i < text.length && text[i] !== ch && text[i] !== "\n") {
        if (text[i] === "\\" && i + 1 < text.length) {
          out[i] = code[i] = blank(text[i]);
          i++;
        }
        out[i] = code[i] = blank(text[i]);
        i++;
      }
      i = Math.min(text.length, i + 1);
      strings.push({ start: open, open, end: i, prefix: "", template: false, interpolated: false });
      last = ch;
      continue;
    }
    if (ch === "`") {
      const str = { start: i, open: i, end: i + 1, prefix: "", template: true, interpolated: false };
      strings.push(str);
      i++;
      template(str);
      last = "`";
      continue;
    }
    if (inside) {
      // code inside ${ }: blank it too, so the whole template reads as one opaque token
      if (ch === "{") inside.depth++;
      if (ch === "}") {
        if (inside.depth === 0) {
          out[i] = code[i] = " ";
          i++;
          templates.pop();
          template(inside.str);
          continue;
        }
        inside.depth--;
      }
      if (!/\s/.test(ch)) last = ch;
      out[i] = blank(ch);
      i++;
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  // a template nested inside another's ${ } was recorded on its own; keep only the outermost ones
  strings.sort((a, b) => a.start - b.start);
  const top = [];
  for (const s of strings) {
    const outer = top[top.length - 1];
    if (outer && s.start < outer.end) continue;
    top.push(s);
  }
  return { masked: out.join(""), code: code.join(""), strings: top, nested: strings };
}

/** @returns {{ masked: string, code: string, strings: Str[], nested: Str[] }} */
export function scan(text, lang) {
  return lang === "python" ? scanPython(text) : scanJs(text);
}

/** The index one past the bracket that closes the one at `open`, on blanked text; -1 if it never closes. */
export function closing(masked, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const want = pairs[masked[open]];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === masked[open]) depth++;
    else if (masked[i] === want && --depth === 0) return i + 1;
  }
  return -1;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

export function lineText(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? text.length : end);
}

export function skipSpace(masked, i) {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}
