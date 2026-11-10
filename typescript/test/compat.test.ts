/**
 * The places where Python's built-ins decide a format both SDKs write.
 *
 * Every expected value here was printed by Python 3.13; none is a guess at what
 * Python does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as py from "../src/compat.ts";
import { canonical } from "../src/plan.ts";

const FFFF = String.fromCodePoint(0xffff);
const SMILE = String.fromCodePoint(0x1f600);
const LS = String.fromCodePoint(0x2028);
const NEL = String.fromCodePoint(0x85);
const BOM = String.fromCodePoint(0xfeff);
const REPLACEMENT = String.fromCodePoint(0xfffd);

test("strings sort by code point, as Python sorts them", () => {
  // UTF-16 order would put the astral character before U+FFFF
  const items = [SMILE, FFFF, "b", "B", "a/", "a.", "a-", "é", "a", ""];
  const want = ["", "B", "a", "a-", "a.", "a/", "b", "é", FFFF, SMILE];
  assert.deepEqual(py.sorted(items), want);
  assert.deepEqual([...items].sort(py.cmp), want);
  assert.notDeepEqual([...items].sort(), want);
  assert.deepEqual(py.sorted([{ k: "b" }, { k: "a" }, { k: "b", first: false }], (o) => o.k), [
    { k: "a" },
    { k: "b" },
    { k: "b", first: false }, // stable
  ]);
});

test("lines, whitespace and length follow str", () => {
  assert.deepEqual(py.splitlines("a\nb\r\nc\rd\n"), ["a", "b", "c", "d"]);
  assert.deepEqual(py.splitlines("a\n\nb\n"), ["a", "", "b"]);
  assert.deepEqual(py.splitlines(""), []);
  assert.deepEqual(py.splitlines("\n"), [""]);
  assert.deepEqual(py.splitlines(`a\vb\fc\x1cd\x1ee${NEL}f${LS}g`), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(py.splitlines("a\x1fb"), ["a\x1fb"]); // the unit separator is not a line boundary
  assert.equal(py.strip(`\x1f \t${NEL}x y\n\x1c`), "x y");
  assert.equal(py.strip(`${BOM}x`), `${BOM}x`); // trim() would take the BOM; str.strip() does not
  assert.equal(py.rstrip(" x \n"), " x");
  assert.equal(py.len(`a${SMILE}é`), 3);
  assert.equal(py.head(`${SMILE}${SMILE}abc`, 3), `${SMILE}${SMILE}a`);
  assert.equal(py.tail(`abc${SMILE}${SMILE}`, 3), `c${SMILE}${SMILE}`);
  assert.equal(py.ljust(`${SMILE}`, 3) + "|", `${SMILE}  |`);
  assert.equal(py.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff])), `${BOM}a${REPLACEMENT}`);
});

test("numbers are written as Python writes them", () => {
  const text: [number, string][] = [
    [0, "0"],
    [-7, "-7"],
    [1.5, "1.5"],
    [0.1 + 0.2, "0.30000000000000004"],
    [0.0001, "0.0001"],
    [0.00009999999999999999, "9.999999999999999e-05"],
    [0.00001, "1e-05"], // JavaScript would write 0.00001
    [1.5e-7, "1.5e-07"], // and 1.5e-7
    [5e-5, "5e-05"],
    [1e-100, "1e-100"],
    [123456.789, "123456.789"],
    [1e21, "1e+21"],
    [NaN, "nan"],
    [-Infinity, "-inf"],
  ];
  for (const [x, want] of text) assert.equal(py.numberText(x), want);
  const float: [number, string][] = [
    [0, "0.0"],
    [1794182400, "1794182400.0"],
    [1794182400.123, "1794182400.123"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1.2345678901234568e20, "1.2345678901234568e+20"],
    [5e-5, "5e-05"],
  ];
  for (const [x, want] of float) assert.equal(py.floatRepr(x), want);
  assert.equal(py.intText(1e21), "1000000000000000000000");
  assert.equal(py.intText(-0), "0");
});

test("rounding goes to the even digit on an exact tie", () => {
  const cases: [number, number, string][] = [
    [0.5, 0, "0"],
    [1.5, 0, "2"],
    [2.5, 0, "2"],
    [-0.5, 0, "-0"],
    [0.125, 2, "0.12"],
    [0.375, 2, "0.38"],
    [1.25, 1, "1.2"],
    [1.75, 1, "1.8"],
    [2.25, 1, "2.2"],
    [1.05, 1, "1.1"], // not a tie: 1.05 is a little above
    [1.15, 1, "1.1"], // not a tie: 1.15 is a little below
    [0.045, 2, "0.04"],
    [5e-5, 5, "0.00005"],
    [0.000005, 5, "0.00001"],
    [999.95, 1, "1000.0"],
    [0.99995, 4, "1.0000"], // a little above, so it carries
    [1280 / 1024, 1, "1.2"],
  ];
  for (const [x, digits, want] of cases) assert.equal(py.fixed(x, digits), want, `${x} to ${digits}`);
  assert.equal(py.round(0.125, 2), 0.12);
  assert.equal(py.round(2.5, 0), 2);
  assert.equal(py.round(0.00015000104, 8), 0.00015);
  assert.equal(py.round(12.34, 1), 12.3);
});

test("str and repr write values the way a Python message does", () => {
  const reprs: [unknown, string][] = [
    ["plain", "'plain'"],
    ["it's", `"it's"`],
    [`both ' and "`, `'both \\' and "'`],
    ["tab\there\n", "'tab\\there\\n'"],
    ["back\\slash", "'back\\\\slash'"],
    ["\x00\x1b\x7f", "'\\x00\\x1b\\x7f'"],
    [`${NEL}\xa0\xad`, "'\\x85\\xa0\\xad'"],
    [`é${LS}${SMILE}`, `'é\\u2028${SMILE}'`],
    [String.fromCodePoint(0x10ffff), "'\\U0010ffff'"],
    [["a", 1, null, true, 2.5], "['a', 1, None, True, 2.5]"],
    [{ k: "v", n: [1, "two"] }, "{'k': 'v', 'n': [1, 'two']}"],
    [null, "None"],
    [false, "False"],
  ];
  for (const [value, want] of reprs) assert.equal(py.repr(value), want);
  assert.equal(py.str("it's"), "it's");
  assert.equal(py.str(undefined), "None");
  assert.equal(py.str(3), "3");
});

test("json is written as json.dumps writes it", () => {
  const value = { b: 1, a: [true, null, "é", "\n"], usd: 5e-5, "10": "ten", "9": SMILE, tiny: 1.5e-7 };
  // Python's defaults: ", " and ": ", and nothing outside ASCII
  assert.equal(
    py.dumps({ b: 1, a: [true, null, "é", "\n"], usd: 5e-5, s: `${SMILE}\x7f${LS}` }),
    '{"b": 1, "a": [true, null, "\\u00e9", "\\n"], "usd": 5e-05, "s": "\\ud83d\\ude00\\u007f\\u2028"}',
  );
  assert.equal(
    py.dumps(value, { sortKeys: true }),
    '{"10": "ten", "9": "\\ud83d\\ude00", "a": [true, null, "\\u00e9", "\\n"], "b": 1, "tiny": 1.5e-07, "usd": 5e-05}',
  );
  // sorted keys, no spaces, non-ASCII as it is: the form both SDKs hash
  assert.equal(canonical(value), `{"10":"ten","9":"${SMILE}","a":[true,null,"é","\\n"],"b":1,"tiny":1.5e-07,"usd":5e-05}`);
  assert.equal(canonical({ [FFFF]: 1, [SMILE]: 2, z: 3 }), `{"z":3,"${FFFF}":1,"${SMILE}":2}`); // keys by code point
  assert.equal(py.dumps([]), "[]");
  assert.equal(py.dumps({}), "{}");
  assert.equal(py.dumps(new Map([["k", new Map([["n", 1]])]]), { compact: true }), '{"k":{"n":1}}');
  assert.equal(py.dumps({ at: new Date(0), skipped: undefined, big: 10n ** 20n }), '{"at": "1970-01-01T00:00:00.000Z", "big": 100000000000000000000}');
});
