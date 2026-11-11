#!/usr/bin/env node
/**
 * Every API name the docs mention exists.
 *
 *     node scripts/check-api.mjs
 *
 * The examples are run (check-examples.mjs), so they cannot name something that is not there. The
 * prose and the reference tables can. This reads every page for inline code that names a member
 * of a known object (`ctx.read_text`, `result.meta.callUnits`, `archil.Budget`) and asks both SDKs
 * whether it exists, on real objects built on a local backend.
 *
 * Which SDK a name is checked against:
 *   - in a table with a "Python" and a "TypeScript" column, the column says;
 *   - otherwise a name with an underscore is Python's, and one with a capital inside it is
 *     TypeScript's;
 *   - any other name has to exist in both, unless LANGUAGE_ONLY below says it is one language's.
 *
 * It also checks that the reference's table of error codes and the SDKs' sources name the same
 * codes, that the reference lists exactly what the two packages export, and that its table of
 * TypeScript types is the types the package exports.
 *
 * Needs a Python 3.10+ (SEAWAY_PYTHON, or python3 / python) and Node 22.19+. Nothing here can
 * reach an account.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DOCS, '..');
const CONTENT = path.join(DOCS, 'src', 'content', 'docs');
const SDK_TS = path.join(REPO, 'typescript');
const SDK_PY = path.join(REPO, 'python', 'src');

/** The names the docs use for an object, and the object each stands for. Longest first. */
const RECEIVERS = {
	'result.meta': 'meta',
	'plan.estimate': 'estimate',
	'ctx.spend': 'ledger',
	archil: 'archil',
	ctx: 'ctx',
	stmt: 'stmt',
	statement: 'stmt',
	result: 'result',
	meta: 'meta',
	plan: 'plan',
	estimate: 'estimate',
	task: 'task',
	tx: 'tx',
	turn: 'turn',
	commit: 'commit',
	conflict: 'conflict',
	log: 'log',
	selection: 'selection',
	view: 'view',
	feed: 'feed',
	changes: 'changes',
	prices: 'prices',
	budget: 'budget',
	ledger: 'ledger',
	tool: 'tool',
	backend: 'backend',
	local: 'backend',
	mount: 'mount',
	ref: 'ref',
	glob: 'glob',
	file: 'file',
	error: 'error',
};

/** Single-word members that only one SDK has, on purpose. `receiver.member` → the language. */
const LANGUAGE_ONLY = {
	'tx.ctx': 'ts',
	'tx.view': 'python',
	'turn.view': 'python',
	'changes.empty': 'ts',
	'tool.call': 'ts',
	'ref.join': 'ts',
	'a.plus': 'ts',
	'tx.write': 'python', // a Python Transaction passes a context's verbs on
	'tx.sh': 'python',
	'archil.Error': 'python',
	'archil.ArchilError': 'ts',
	'archil.Backend': 'python', // a class in Python; a type in TypeScript
	'archil.Recipe': 'python',
	'archil.Entry': 'python',
	'archil.Issue': 'python',
	'archil.VERSION': 'ts',
	'archil.DUCKDB_VERSION': 'ts',
	'archil.DUCKDB_SHA256': 'ts',
	'archil.estimate': 'ts',
};

/** Not members of the object at all: file names, words that happen to follow a receiver name. */
const IGNORE = new Set(['archil.com']);

/** A receiver's name followed by one of these is a file's name (`plan.py`, `task.md`), not a member. */
const EXTENSIONS = new Set(['py', 'ts', 'md', 'mdx', 'mjs', 'js', 'json', 'ndjson', 'txt', 'csv', 'db', 'sh', 'yml']);

// -- reading the pages --------------------------------------------------------------------------

function* markdown(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* markdown(full);
		else if (/\.mdx?$/.test(entry.name)) yield full;
	}
}

/** The inline code spans of one line, with the column each starts at. */
function spans(line) {
	const out = [];
	const re = /(`+)(.+?)\1(?!`)/g;
	for (let m = re.exec(line); m; m = re.exec(line)) out.push({ text: m[2], at: m.index });
	return out;
}

/** A table row as cells, each with where it starts. A pipe inside a code span or escaped does not split. */
function cells(line) {
	const out = [];
	let start = line.indexOf('|') + 1;
	let ticks = 0;
	for (let i = start; i < line.length; i++) {
		const ch = line[i];
		if (ch === '\\') i++;
		else if (ch === '`') ticks ^= 1;
		else if (ch === '|' && !ticks) {
			out.push({ text: line.slice(start, i), from: start, to: i });
			start = i + 1;
		}
	}
	return out;
}

const receiverNames = Object.keys(RECEIVERS).sort((a, b) => b.length - a.length);
const mention = new RegExp(`(?<![\\w.$/-])(${receiverNames.map((n) => n.replace('.', '\\.')).join('|')})\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');

const mentions = [];
const errorCodesInDocs = new Set();
const exportedInDocs = [];
const typesInDocs = [];

for (const file of markdown(CONTENT)) {
	const relative = path.relative(CONTENT, file);
	const lines = readFileSync(file, 'utf8').split('\n');
	let fence = null;
	let columns = null; // for the table being read: which column is which language
	let section = '';
	lines.forEach((line, i) => {
		const opening = /^\s*(`{3,})/.exec(line);
		if (fence) {
			if (opening && opening[1].length >= fence && line.trim() === opening[1]) fence = null;
			return;
		}
		if (opening) {
			fence = opening[1].length;
			return;
		}
		const heading = /^#{2,4}\s+(.*)$/.exec(line);
		if (heading) section = heading[1].trim();

		const isRow = /^\s*\|/.test(line);
		if (!isRow) columns = null;
		const row = isRow ? cells(line) : null;
		if (row && columns === null) {
			columns = row.map((cell) => {
				const head = cell.text.trim();
				return head === 'Python' ? 'python' : head === 'TypeScript' ? 'ts' : null;
			});
			return; // the header row itself
		}

		for (const span of spans(line)) {
			let lang = null;
			// the reference's own lists: the names exported, in the table and in the sentence under it
			if (relative === 'reference/index.md' && section === 'What is exported') exportedInDocs.push({ name: span.text, line: i + 1 });
			if (row) {
				const index = row.findIndex((cell) => span.at >= cell.from && span.at < cell.to);
				lang = columns?.[index] ?? null;
				if (relative === 'reference/errors.md' && section === 'Every code' && index === 0) errorCodesInDocs.add(span.text);
				if (relative === 'reference/python-and-typescript.md' && section === 'Types' && index === 1) typesInDocs.push({ name: span.text, line: i + 1 });
			}
			for (const m of span.text.matchAll(mention)) {
				const name = `${m[1]}.${m[2]}`;
				if (IGNORE.has(name) || EXTENSIONS.has(m[2])) continue;
				mentions.push({ receiver: RECEIVERS[m[1]], written: name, member: m[2], lang, where: `${relative}:${i + 1}` });
			}
		}
	});
}

// -- deciding which SDK each name belongs to ----------------------------------------------------

function languageOf(mention) {
	if (mention.lang) return mention.lang;
	const only = LANGUAGE_ONLY[mention.written];
	if (only) return only;
	if (/^[A-Z][A-Z0-9_]*$/.test(mention.member)) return 'both'; // a constant: MODES, REDUCERS
	if (mention.member.includes('_')) return 'python';
	if (/[a-z][A-Z]/.test(mention.member)) return 'ts';
	return 'both';
}

const wanted = { python: new Map(), ts: new Map() };
const need = (lang, mention) => {
	const key = `${mention.receiver}.${mention.member}`;
	if (!wanted[lang].has(key)) wanted[lang].set(key, { receiver: mention.receiver, member: mention.member, where: [] });
	wanted[lang].get(key).where.push(mention.where);
};
const either = [];
for (const m of mentions) {
	const lang = languageOf(m);
	if (lang === 'python' || lang === 'both') need('python', m);
	if (lang === 'ts' || lang === 'both') need('ts', m);
	if (lang === 'either') either.push(m);
}
for (const m of either) {
	need('python', { ...m, where: `${m.where} (either)` });
	need('ts', { ...m, where: `${m.where} (either)` });
}

// -- asking the SDKs ----------------------------------------------------------------------------

function python() {
	const named = process.env.SEAWAY_PYTHON;
	for (const candidate of named ? [named] : ['python3', 'python']) {
		const out = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
		const m = /Python (\d+)\.(\d+)/.exec(`${out.stdout ?? ''}${out.stderr ?? ''}`);
		if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return candidate;
	}
	console.error('check-api: no Python 3.10 or later; name one with SEAWAY_PYTHON');
	process.exit(2);
}

function environment() {
	const env = { ...process.env, ARCHIL_BACKEND: 'local', PYTHONDONTWRITEBYTECODE: '1' };
	for (const name of ['ARCHIL_API_KEY', 'ARCHIL_REGION', 'ARCHIL_LOCAL_ROOT', 'AI_AGENT']) delete env[name];
	return env;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'seaway-docs-api-'));
let answers;
try {
	const ask = (command, args, queries) => {
		const out = spawnSync(command, args, {
			input: JSON.stringify({ sdk: command === process.execPath ? SDK_TS : SDK_PY, root: scratch, queries }),
			encoding: 'utf8',
			env: environment(),
			maxBuffer: 64 * 1024 * 1024,
		});
		if (out.status !== 0) {
			console.error(`check-api: ${path.basename(args[0])} failed:\n${out.stderr}`);
			process.exit(2);
		}
		return JSON.parse(out.stdout);
	};
	const queries = (lang) => [...wanted[lang].values()].map(({ receiver, member }) => ({ receiver, member }));
	answers = {
		python: ask(python(), [path.join(DOCS, 'scripts', 'api_names.py')], queries('python')),
		ts: ask(process.execPath, [path.join(DOCS, 'scripts', 'api-names.ts')], queries('ts')),
	};
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// -- the verdict --------------------------------------------------------------------------------

const problems = [];
const missing = { python: new Set(answers.python.missing), ts: new Set(answers.ts.missing) };

for (const lang of ['python', 'ts']) {
	for (const [key, entry] of wanted[lang]) {
		if (!missing[lang].has(key)) continue;
		const strict = entry.where.filter((w) => !w.endsWith('(either)'));
		const loose = entry.where.filter((w) => w.endsWith('(either)'));
		if (strict.length) problems.push(`${key} is not in the ${lang === 'ts' ? 'TypeScript' : 'Python'} SDK (${strict.slice(0, 3).join(', ')})`);
		// a name allowed in either SDK is a problem only when neither has it
		const other = lang === 'python' ? 'ts' : 'python';
		if (loose.length && lang === 'python' && missing[other].has(key)) problems.push(`${key} is in neither SDK (${loose[0].replace(' (either)', '')})`);
	}
}

// the reference's table of error codes, against the codes in the sources
const codesInSource = new Set([...answers.python.codes, ...answers.ts.codes]);
if (!errorCodesInDocs.size) problems.push('reference/errors.md has no table under "Every code"');
for (const code of errorCodesInDocs) if (!codesInSource.has(code)) problems.push(`reference/errors.md lists the code ${code}, and neither SDK raises it`);
for (const code of codesInSource) if (!errorCodesInDocs.has(code)) problems.push(`the SDKs raise the code ${code}, and reference/errors.md does not list it`);

// the reference's list of exports, against what is exported: each way, for each SDK
const exported = { python: new Set(answers.python.exports), ts: new Set(answers.ts.exports) };
const listed = new Set(exportedInDocs.map((e) => e.name));
for (const { name, line } of exportedInDocs) {
	if (!exported.python.has(name) && !exported.ts.has(name)) problems.push(`reference/index.md:${line} lists ${name} as exported, and neither SDK exports it`);
}
for (const name of exported.python) if (!listed.has(name)) problems.push(`the Python SDK exports ${name}, and reference/index.md does not list it`);
for (const name of exported.ts) if (!listed.has(name)) problems.push(`the TypeScript SDK exports ${name}, and reference/index.md does not list it`);

// the table of TypeScript types, against the types the package exports
const types = new Set(answers.ts.types);
const typesListed = new Set(typesInDocs.map((t) => t.name));
if (!typesInDocs.length) problems.push('reference/python-and-typescript.md has no table under "Types"');
for (const { name, line } of typesInDocs) {
	if (!types.has(name)) problems.push(`reference/python-and-typescript.md:${line} lists the type ${name}, and the TypeScript SDK does not export it`);
}
for (const name of types) if (!typesListed.has(name)) problems.push(`the TypeScript SDK exports the type ${name}, and reference/python-and-typescript.md does not list it`);

if (!existsSync(path.join(SDK_TS, 'src', 'index.ts'))) problems.push(`the TypeScript SDK is expected at ${SDK_TS}`);

for (const problem of problems) console.error(`✗ ${problem}`);
console.log(
	`${problems.length ? '✗' : '✓'} ${mentions.length} mentions of ${wanted.python.size + wanted.ts.size} API names, ` +
		`${errorCodesInDocs.size} error codes, ${listed.size} exports, ${typesListed.size} types` +
		(problems.length ? `: ${problems.length} problem(s)` : ': all there'),
);
process.exit(problems.length ? 1 : 0);
