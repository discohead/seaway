#!/usr/bin/env node
/**
 * Every example in the docs is run.
 *
 *     node scripts/check-examples.mjs                  # both languages, then type-check the TypeScript
 *     node scripts/check-examples.mjs --show           # also print what each example printed
 *     node scripts/check-examples.mjs --only turns     # only examples whose file name has "turns" in it
 *     node scripts/check-examples.mjs --lang ts        # one language
 *
 * A fenced block marked `python` or `ts` in a page is an example: it has to run as written, on a
 * local backend, against the SDKs in this repository. A block marked `py` or `typescript` is there
 * to be read (a signature, something that needs an account, something not to do) and is not run.
 * This is the rule the Claude Code plugin's skills follow too.
 *
 * An example that imports seaway is a whole program and runs as it is. Any other is a few lines
 * that use `archil`, `backend` and `ctx`, and runs after the setup on the page "The example
 * context" (the two blocks titled setup.py and setup.ts), exactly as that page tells a reader to:
 * pasted at the end of it.
 * A block marked `continues` (```python continues) is the next part of the program its page is
 * building, and runs joined to the example before it.
 *
 * A block of output marked `output` (```text output) is checked too: each of its lines has to be
 * a line the Python example before it printed. `…` in a line stands for anything.
 *
 * Code also has to fit the page. A line of Python, TypeScript or shell wider than 88 columns is
 * cut off at the edge of its block until the reader scrolls, so it is a failure here (84 on the
 * first line of a block, where the copy button is). That goes for the blocks that are only shown,
 * too. Output, plans and file contents are shown as they are, and wrap.
 *
 * Nothing here can reach an account: ARCHIL_API_KEY is removed from every child's environment and
 * ARCHIL_BACKEND is set to local.
 *
 * Needs: Node 22.19+, a Python 3.10+ (SEAWAY_PYTHON, or python3 / python on the PATH), and duckdb
 * and jq on the PATH. The type-check needs `npm ci` to have been run in ../typescript.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DOCS, '..');
const CONTENT = path.join(DOCS, 'src', 'content', 'docs');
const SDK_TS = path.join(REPO, 'typescript');
const SDK_PY = path.join(REPO, 'python', 'src');
const SETUP_PAGE = path.join('guides', 'example-context.md');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SHOW = flag('--show');
const ONLY = option('--only');
const LANG = option('--lang');

// -- the examples -----------------------------------------------------------------------------

function* markdown(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* markdown(full);
		else if (/\.mdx?$/.test(entry.name)) yield full;
	}
}

/** The fenced blocks of a file: the language each names, the rest of its first line, and where it starts. */
export function blocks(file) {
	const found = [];
	let open = null;
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			const fence = /^(\s*)(`{3,})\s*([\w-]*)\s*(.*)$/.exec(line);
			if (!open) {
				if (fence) open = { lang: fence[3], meta: fence[4].trim(), indent: fence[1].length, ticks: fence[2].length, line: i + 2, body: [] };
				return;
			}
			if (fence && !fence[3] && !fence[4].trim() && fence[2].length >= open.ticks) {
				found.push({ lang: open.lang, meta: open.meta, line: open.line, code: open.body.map((l) => l.slice(open.indent)).join('\n') });
				open = null;
			} else {
				open.body.push(line);
			}
		});
	// A fence that never closes would hide every example after it.
	if (open) fail(`${path.relative(CONTENT, file)}:${open.line - 1} opens a fence that is never closed`);
	return found;
}

const IMPORTS_SEAWAY = {
	python: /^\s*(?:import\s+seaway\b|from\s+seaway\b)/m,
	ts: /\bfrom\s+["']seaway["']/,
};

/**
 * The widest a line of code may be: what a block shows, beside both sidebars, without scrolling.
 * The first line of a block has less room: the copy button sits over its end.
 */
const WIDTH = 88;
const FIRST_LINE_WIDTH = 84;
const MEASURED = new Set(['python', 'py', 'ts', 'typescript', 'js', 'bash', 'sh']);

const examples = [];
const setup = {};
const widths = [];
for (const file of markdown(CONTENT)) {
	const relative = path.relative(CONTENT, file);
	for (const block of blocks(file)) {
		if (MEASURED.has(block.lang)) {
			const wide = block.code
				.split('\n')
				.map((text, i) => ({ text, line: block.line + i, fit: i === 0 && !/\btitle=/.test(block.meta) ? FIRST_LINE_WIDTH : WIDTH }))
				.filter(({ text, fit }) => [...text.replace(/\t/g, '    ')].length > fit);
			widths.push({ id: `${relative}:${block.line}`, wide });
		}
		// What an example prints, when the page shows it: a block marked `output` after the example
		// is checked, line by line, against what the Python example printed. `…` stands for anything.
		if (/\boutput\b/.test(block.meta) && block.lang !== 'python' && block.lang !== 'ts') {
			const before = examples.findLast((e) => e.file === relative && e.lang === 'python');
			if (!before) fail(`${relative}:${block.line} shows output, and there is no Python example before it`);
			before.expect.push({ line: block.line, text: block.code });
			continue;
		}
		if (block.lang !== 'python' && block.lang !== 'ts') continue;
		const title = /\btitle=["']([^"']+)["']/.exec(block.meta)?.[1];
		if (relative === SETUP_PAGE && /^setup\.(py|ts)$/.test(title ?? '')) setup[block.lang] = block.code;
		// A block marked `continues` is the next part of the program the page is building: it is
		// added to the example before it, in the same language, and the whole runs as one.
		if (/\bcontinues\b/.test(block.meta)) {
			const before = examples.findLast((e) => e.file === relative && e.lang === block.lang);
			if (!before) fail(`${relative}:${block.line} continues an example, and there is none before it`);
			before.code += `\n\n${block.code}`;
			continue;
		}
		examples.push({
			...block,
			id: `${relative}:${block.line}`,
			file: relative,
			complete: IMPORTS_SEAWAY[block.lang].test(block.code),
			expect: [],
		});
	}
}

for (const lang of ['python', 'ts']) {
	if (!setup[lang]) fail(`${SETUP_PAGE} has no ${lang} block titled setup.${lang === 'python' ? 'py' : 'ts'}`);
}

const wanted = examples.filter((e) => (!ONLY || e.id.includes(ONLY)) && (!LANG || e.lang === LANG));

// -- where they run ---------------------------------------------------------------------------

function fail(message) {
	console.error(`check-examples: ${message}`);
	process.exit(2);
}

function has(command) {
	return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function python() {
	const named = process.env.SEAWAY_PYTHON;
	for (const candidate of named ? [named] : ['python3', 'python']) {
		const out = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
		const m = /Python (\d+)\.(\d+)/.exec(`${out.stdout ?? ''}${out.stderr ?? ''}`);
		if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return candidate;
	}
	return null;
}

/** An environment that cannot reach an account, whatever this shell holds. */
function environment(extra = {}) {
	const env = { ...process.env, ARCHIL_BACKEND: 'local', PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1', ...extra };
	for (const name of ['ARCHIL_API_KEY', 'ARCHIL_REGION', 'ARCHIL_LOCAL_ROOT', 'AI_AGENT']) delete env[name];
	return env;
}

for (const tool of ['duckdb', 'jq']) {
	if (!has(tool)) fail(`the examples need ${tool} on the PATH`);
}
if (!existsSync(path.join(SDK_TS, 'src', 'index.ts'))) fail(`the TypeScript SDK is expected at ${SDK_TS}`);
if (!existsSync(path.join(SDK_PY, 'seaway'))) fail(`the Python SDK is expected at ${SDK_PY}`);

const scratch = mkdtempSync(path.join(tmpdir(), 'seaway-docs-'));
const results = [];

// -- python -----------------------------------------------------------------------------------

function runPython(list) {
	const interpreter = python();
	if (!interpreter) fail('no Python 3.10 or later; name one with SEAWAY_PYTHON');
	const job = { sdk: SDK_PY, setup: setup.python, scratch, blocks: list.map(({ id, code, complete }) => ({ id, code, complete })) };
	const out = spawnSync(interpreter, [path.join(DOCS, 'scripts', 'run_python_examples.py')], {
		input: JSON.stringify(job),
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		env: environment(),
	});
	if (out.status !== 0) fail(`the Python runner failed:\n${out.stderr}`);
	for (const result of JSON.parse(out.stdout)) results.push({ lang: 'python', ...result });
}

// -- typescript -------------------------------------------------------------------------------

/**
 * A snippet after the setup, as one module: its imports at the top, and its body at the end of
 * the setup, which is where the page tells a reader to paste it. So a snippet that declares a name
 * the setup already has does not run here either. The one exception is the one the page gives: a
 * snippet that opens a context of its own and calls it `ctx` goes in braces.
 */
function withSetup(code) {
	const imports = [];
	const body = [];
	let pending = null;
	for (const line of code.split('\n')) {
		if (pending !== null) {
			pending += `\n${line}`;
			if (/\bfrom\s+["'][^"']+["'];?\s*$/.test(line)) {
				imports.push(pending);
				pending = null;
			}
		} else if (/^import\s[^;]*\bfrom\s+["'][^"']+["'];?\s*$/.test(line) || /^import\s+["'][^"']+["'];?\s*$/.test(line)) {
			imports.push(line);
		} else if (/^import\s/.test(line)) {
			pending = line;
		} else {
			body.push(line);
		}
	}
	const text = body.join('\n');
	const ownContext = /^(?:const|let|var)\s+ctx\b/m.test(text);
	return `${imports.join('\n')}\n${setup.ts}\n\n${ownContext ? `{\n${text}\n}` : text}\n`;
}

async function runTypeScript(list) {
	const project = path.join(scratch, 'ts');
	mkdirSync(path.join(project, 'node_modules'), { recursive: true });
	// As a link, which is how the SDK is installed: Node will not run TypeScript from a copy under node_modules.
	symlinkSync(SDK_TS, path.join(project, 'node_modules', 'seaway'), 'dir');
	writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'seaway-docs-examples', private: true, type: 'module' }));

	const files = new Map();
	list.forEach((example, i) => {
		const name = `example-${String(i).padStart(3, '0')}.ts`;
		writeFileSync(path.join(project, name), example.complete ? `${example.code}\n` : withSetup(example.code));
		files.set(name, example);
	});

	const queue = [...files.entries()];
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const [name, example] = next;
			const cwd = mkdtempSync(path.join(scratch, 'cwd-'));
			results.push({ lang: 'ts', id: example.id, ...(await node(path.join(project, name), cwd)) });
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));

	// Type-check them all in one program, with the compiler and the options the SDK itself uses.
	const tsc = path.join(SDK_TS, 'node_modules', '.bin', 'tsc');
	if (flag('--no-typecheck')) return;
	if (!existsSync(tsc)) {
		console.warn(`check-examples: skipping the type-check; run \`npm ci\` in ${path.relative(process.cwd(), SDK_TS)} to enable it`);
		return;
	}
	writeFileSync(
		path.join(project, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2023',
				lib: ['ES2023'],
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				strict: true,
				noEmit: true,
				allowImportingTsExtensions: true,
				verbatimModuleSyntax: true,
				erasableSyntaxOnly: true,
				skipLibCheck: true,
				types: ['node'],
				typeRoots: [path.join(SDK_TS, 'node_modules', '@types')],
			},
			include: ['*.ts'],
		}),
	);
	const checked = spawnSync(tsc, ['-p', project, '--pretty', 'false'], { encoding: 'utf8', env: environment() });
	const problems = new Map();
	for (const line of `${checked.stdout}${checked.stderr}`.split('\n')) {
		const m = /(?:^|[\\/])(example-\d+\.ts)\((\d+),\d+\): (error .*)$/.exec(line.trim());
		if (m) problems.set(m[1], [...(problems.get(m[1]) ?? []), `line ${m[2]}: ${m[3]}`]);
		else if (line.trim() && checked.status !== 0) problems.set('', [...(problems.get('') ?? []), line.trim()]);
	}
	for (const [name, example] of files) {
		const errors = problems.get(name);
		results.push({ lang: 'types', id: example.id, ok: !errors, error: (errors ?? []).join('\n'), stdout: '' });
	}
	if (problems.has('')) results.push({ lang: 'types', id: '(the SDK itself)', ok: false, error: problems.get('').join('\n'), stdout: '' });
}

function node(file, cwd) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file], { cwd, env: environment() });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
		child.on('close', (code) => {
			clearTimeout(timer);
			const warnings = stderr
				.split('\n')
				.filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line))
				.join('\n')
				.trim();
			resolve({ ok: code === 0, error: code === 0 ? '' : warnings || `exit ${code}`, stdout });
		});
	});
}

// -- go ---------------------------------------------------------------------------------------

const started = Date.now();
try {
	const py = wanted.filter((e) => e.lang === 'python');
	const ts = wanted.filter((e) => e.lang === 'ts');
	if (py.length) runPython(py);
	if (ts.length) await runTypeScript(ts);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// -- what the page says an example prints -------------------------------------------------------

/** One expected line as a pattern: the text as written, with `…` standing for anything. */
function pattern(line) {
	const escaped = line
		.trim()
		.split('…')
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${escaped}$`);
}

for (const example of wanted.filter((e) => e.lang === 'python' && e.expect.length)) {
	const ran = results.find((r) => r.lang === 'python' && r.id === example.id);
	if (!ran?.ok) continue;
	const printed = ran.stdout.split('\n').map((line) => line.trim());
	for (const expected of example.expect) {
		const missing = expected.text.split('\n').filter((line) => line.trim() && !printed.some((p) => pattern(line).test(p)));
		results.push({
			lang: 'output',
			id: `${example.file}:${expected.line}`,
			ok: missing.length === 0,
			error: missing.length ? `the page shows these lines, and the example did not print them:\n${missing.join('\n')}` : '',
			stdout: missing.length ? ran.stdout : '',
		});
	}
}

// -- code that fits the page ----------------------------------------------------------------------

for (const block of widths.filter((w) => !ONLY || w.id.includes(ONLY))) {
	results.push({
		lang: 'width',
		id: block.id,
		ok: block.wide.length === 0,
		error: block.wide.map(({ text, line, fit }) => `line ${line} is ${[...text].length} columns wide, and ${fit} fit${fit < WIDTH ? ' on the first line of a block' : ''}: ${text.trim().slice(0, 60)}…`).join('\n'),
		stdout: '',
	});
}

const order = new Map(wanted.map((e, i) => [e.id, i]));
results.sort((a, b) => a.lang.localeCompare(b.lang) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

if (SHOW) {
	for (const result of results.filter((r) => r.lang === 'python' || r.lang === 'ts')) {
		console.log(`\n--- ${result.lang} ${result.id}\n${result.stdout.trimEnd()}`);
	}
	console.log();
}

const failed = results.filter((r) => !r.ok);
for (const result of failed) {
	console.error(`\n✗ ${result.lang}  ${result.id}\n${indent(result.error)}${result.stdout.trim() ? `\n  printed:\n${indent(result.stdout.trimEnd(), 4)}` : ''}`);
}

function indent(text, by = 2) {
	return text
		.split('\n')
		.map((line) => ' '.repeat(by) + line)
		.join('\n');
}

const count = (lang) => results.filter((r) => r.lang === lang);
const line = (label, lang) => {
	const all = count(lang);
	if (!all.length) return null;
	const bad = all.filter((r) => !r.ok).length;
	return `${bad ? '✗' : '✓'} ${label.padEnd(22)} ${all.length - bad}/${all.length}`;
};
console.log(
	[
		line('python examples run', 'python'),
		line('typescript examples run', 'ts'),
		line('typescript type-checks', 'types'),
		line('outputs match the page', 'output'),
		line('code fits the page', 'width'),
	]
		.filter(Boolean)
		.join('\n'),
);
console.log(`${failed.length ? `${failed.length} failed` : 'every example runs, and fits'} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(failed.length ? 1 : 0);
