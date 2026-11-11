#!/usr/bin/env node
/**
 * The built site holds together.
 *
 *     node scripts/check-site.mjs          # after `astro build`; `npm run build` runs both
 *
 * Reads `dist/` and checks what a reader, a crawler or a model would trip over:
 *
 *   - every link inside the site leads to a file that was built, and its `#fragment` to an id
 *     on that page;
 *   - no link was written from the root without the base in front of it;
 *   - every page has a title, a description, a Markdown twin (`index.md`, and `<page>.md`), and
 *     says where the twin is in its <head>;
 *   - every link in a Markdown twin, in `llms.txt` and in `llms-full.txt` leads somewhere;
 *   - `llms.txt` lists every page, and nothing that is not one.
 *
 * Links that leave the site are not fetched.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE, SITE_URL } from '../src/site.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(DOCS, 'dist');

if (!existsSync(path.join(DIST, 'index.html'))) {
	console.error('check-site: there is no dist/index.html; run `astro build` first');
	process.exit(2);
}

const problems = [];
const problem = (where, what) => problems.push(`${where}: ${what}`);

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'pagefind' && entry.name !== '_astro') yield* walk(full);
		} else yield full;
	}
}

const files = [...walk(DIST)];
const rel = (file) => path.relative(DIST, file).split(path.sep).join('/');
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const markdownFiles = files.filter((f) => f.endsWith('.md'));

/** The ids of each built page, for checking fragments. */
const ids = new Map();
const html = new Map();
for (const file of htmlFiles) {
	const text = readFileSync(file, 'utf8');
	html.set(rel(file), text);
	ids.set(rel(file), new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]))));
}

function decode(value) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&#39;|&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

/** A site path (`/guides/x/`, with the base already taken off) to the file it is served from, or null. */
function served(sitePath) {
	const clean = decodeURIComponent(sitePath.replace(/^\/+/, ''));
	const candidates = clean === '' || clean.endsWith('/') ? [`${clean}index.html`] : [clean, `${clean}/index.html`];
	for (const candidate of candidates) {
		const full = path.join(DIST, candidate);
		if (existsSync(full) && statSync(full).isFile()) return candidate;
	}
	return null;
}

/** Check one link found in `where`. `from` is the site path of the page it is on, for relative links. */
function check(where, href, from) {
	if (!href || /^(https?:|mailto:|tel:|data:|javascript:|claude-cli:|codex:|cursor:)/i.test(href)) {
		if (href?.startsWith(SITE_URL)) return check(where, BASE + href.slice(SITE_URL.length) || '/', from);
		return;
	}
	let [target, fragment = ''] = href.split('#');
	target = target.split('?')[0];
	let sitePath;
	if (target === '' && where.endsWith('.txt')) {
		// in the one-file docs, a heading of any page is a heading of the file
		if (fragment && ![...ids.values()].some((set) => set.has(decodeURIComponent(fragment)))) problem(where, `the link ${href} names a heading no page has`);
		return;
	}
	if (target === '' && where.endsWith('.md')) {
		// in a Markdown twin, a heading of the page it mirrors
		const page = where.endsWith('index.md') ? where.replace(/index\.md$/, 'index.html') : where.replace(/\.md$/, '/index.html');
		if (fragment && !ids.get(page)?.has(decodeURIComponent(fragment))) problem(where, `the link ${href} names #${fragment}, and ${page} has no such id`);
		return;
	}
	if (target === '') sitePath = from;
	else if (target.startsWith('/')) {
		if (BASE && target !== BASE && !target.startsWith(`${BASE}/`)) return problem(where, `the link ${href} is written from the root without the base ${BASE}`);
		sitePath = target.slice(BASE.length) || '/';
	} else sitePath = new URL(target, `http://x${from}`).pathname;

	const file = served(sitePath);
	if (!file) return problem(where, `the link ${href} leads nowhere`);
	if (fragment && file.endsWith('.html') && !ids.get(file)?.has(decodeURIComponent(fragment))) {
		problem(where, `the link ${href} names #${fragment}, and ${file} has no such id`);
	}
	// a fragment on a Markdown twin is a heading of the page it mirrors
	if (fragment && file.endsWith('/index.md')) {
		const page = file.replace(/index\.md$/, 'index.html');
		if (ids.has(page) && !ids.get(page).has(decodeURIComponent(fragment))) problem(where, `the link ${href} names #${fragment}, and ${page} has no such id`);
	}
}

// -- the pages -----------------------------------------------------------------------------------

let links = 0;
for (const [file, text] of html) {
	const from = `/${file.replace(/index\.html$/, '')}`;
	for (const m of text.matchAll(/<(?:a|link|script|img|source)\b[^>]*?\s(?:href|src)="([^"]*)"/g)) {
		if (file === '404.html' && /rel="canonical"/.test(m[0])) continue; // the 404 page has no address of its own
		links++;
		check(file, decode(m[1]), from);
	}
	if (file === '404.html') continue;
	if (!/<title>[^<]+<\/title>/.test(text)) problem(file, 'no <title>');
	if (!/<meta name="description" content="[^"]{20,}"/.test(text)) problem(file, 'no description, or one too short to be of use');
	if (!/<link rel="alternate" type="text\/markdown"/.test(text)) problem(file, 'does not name its Markdown twin in <head>');
	const twin = file.replace(/index\.html$/, 'index.md');
	if (!existsSync(path.join(DIST, twin))) problem(file, `has no Markdown twin at ${twin}`);
	if (file !== 'index.html' && !existsSync(path.join(DIST, file.replace(/\/index\.html$/, '.md')))) {
		problem(file, `has no Markdown twin at ${file.replace(/\/index\.html$/, '.md')}`);
	}
	if (/\bStub\b|TODO|FIXME/.test(text.replace(/<script[\s\S]*?<\/script>/g, ''))) problem(file, 'has unfinished text in it (Stub, TODO or FIXME)');
}

// -- the Markdown ------------------------------------------------------------------------------

/** The links of a Markdown text: [text](url), and bare absolute URLs of this site. */
function markdownLinks(text) {
	const found = new Set();
	const prose = text.replace(/^(`{3,})[\s\S]*?^\1\s*$/gm, ''); // not the links inside code blocks
	for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) found.add(m[1]);
	for (const m of prose.matchAll(new RegExp(`${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s)>\`"']*`, 'g'))) found.add(m[0].replace(/[.,;:]+$/, ''));
	return found;
}

let markdownLinkCount = 0;
for (const file of [...markdownFiles, path.join(DIST, 'llms.txt'), path.join(DIST, 'llms-full.txt')]) {
	if (!existsSync(file)) {
		problem(rel(file), 'was not built');
		continue;
	}
	const text = readFileSync(file, 'utf8');
	if (!text.trim().startsWith('# ')) problem(rel(file), 'does not start with a title');
	const prose = text.replace(/^(`{3,})[\s\S]*?^\1\s*$/gm, '').replace(/(`+)[^\n]+?\1/g, '');
	if (/^import .* from |<[A-Z][A-Za-z]+[\s/>]|^:::/m.test(prose)) {
		problem(rel(file), 'has component syntax left in it: an import, a <Component> or a ::: directive');
	}
	for (const href of markdownLinks(text)) {
		markdownLinkCount++;
		check(rel(file), href, `/${rel(file).replace(/[^/]*$/, '')}`);
	}
}

// -- llms.txt lists every page, and only pages ---------------------------------------------------

const llms = existsSync(path.join(DIST, 'llms.txt')) ? readFileSync(path.join(DIST, 'llms.txt'), 'utf8') : '';
const listed = new Set([...llms.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]));
for (const file of html.keys()) {
	if (file === '404.html' || file === 'index.html') continue;
	const twin = `${SITE_URL}/${file.replace(/index\.html$/, 'index.md')}`;
	if (!listed.has(twin)) problem('llms.txt', `does not list ${twin}`);
}
if (!/^> .{40,}/m.test(llms)) problem('llms.txt', 'has no summary line');

for (const p of problems) console.error(`✗ ${p}`);
console.log(
	`${problems.length ? '✗' : '✓'} ${html.size} pages, ${links} links in them, ${markdownFiles.length} Markdown twins and llms.txt with ${markdownLinkCount} links` +
		(problems.length ? `: ${problems.length} problem(s)` : ': all hold'),
);
process.exit(problems.length ? 1 : 0);
