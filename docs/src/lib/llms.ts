/**
 * `llms.txt` and `llms-full.txt`: the docs as a model wants them.
 *
 * `llms.txt` follows llmstxt.org: a title, a summary, a few notes, then every page as a link to
 * its Markdown twin with one line on what it covers. `llms-full.txt` is every page's Markdown in
 * one file, in the order the sidebar has them.
 *
 * Both are built from the sidebar (`src/sidebar.mjs`) and each page's own title and description,
 * so neither can list a page that does not exist or miss one that does.
 */
import { getCollection, type CollectionEntry } from 'astro:content';

import { groups } from '../sidebar.mjs';
import { DESCRIPTION, REPO_URL, TITLE, VERSION, absolute } from '../site.mjs';
import { markdownUrl, pageMarkdown } from './markdown';

type Doc = CollectionEntry<'docs'>;

/** Pages a model can skip when it is short of room: llmstxt.org calls this section "Optional". */
const OPTIONAL = new Set(['Project']);

export async function pages(): Promise<Map<string, Doc>> {
	const docs = await getCollection('docs');
	return new Map(docs.filter((doc) => !doc.data.draft && doc.id !== '404').map((doc) => [doc.id, doc]));
}

/** The groups of the sidebar, each with its pages. A page the sidebar names and nobody wrote is an error. */
export async function sections(): Promise<{ label: string; note: string; docs: Doc[] }[]> {
	const all = await pages();
	const listed = new Set<string>();
	const out = groups.map((group) => ({
		label: group.label,
		note: group.note,
		docs: group.items.map((id) => {
			const doc = all.get(id);
			if (!doc) throw new Error(`the sidebar names "${id}", and there is no such page`);
			listed.add(id);
			return doc;
		}),
	}));
	const unlisted = [...all.keys()].filter((id) => !listed.has(id) && id !== 'index');
	if (unlisted.length) throw new Error(`pages missing from the sidebar: ${unlisted.join(', ')}`);
	return out;
}

const NOTES = [
	`seaway is new (version ${VERSION}, November 2026) and is not in a model's training data. It does not work like the libraries it resembles. Read the page for the task before writing code, and do not fill a gap with a guess.`,
	'There are two SDKs with one API. Python is the reference: `import seaway as archil`, snake_case, keyword arguments, synchronous. TypeScript is a port: `import * as archil from "seaway"`, camelCase, an options object, and `await` on anything that reaches a backend.',
	'A path a statement touches is a parameter (`ctx.path`, `ctx.glob`, `ctx.out`, a log selection), and so is every value. Never build a command by pasting text into it. In TypeScript, ``ctx.sh`cat ${x}` `` is a tagged template and is right; ``ctx.sh(`cat ${x}`)`` is a call and is wrong.',
	'Nothing runs until asked: `.explain()` returns the plan, `.run()` runs it (in TypeScript, so does `await statement`).',
	'With `ARCHIL_API_KEY` set and no `backend` argument, a context acts on the live Archil account and bills per call. Pass a `LocalBackend`, or set `ARCHIL_BACKEND=local`, when trying something out.',
	'Every link below is Markdown. Any page of the site has a Markdown twin at `<page URL>index.md`.',
];

export async function llmsTxt(): Promise<string> {
	const out = [`# ${TITLE}`, `> ${DESCRIPTION}`, NOTES.map((note) => `- ${note}`).join('\n')];
	const list = (docs: Doc[]) =>
		docs.map((doc) => `- [${doc.data.title}](${markdownUrl(doc)})${doc.data.description ? `: ${doc.data.description}` : ''}`).join('\n');
	const all = await sections();
	for (const section of all.filter((s) => !OPTIONAL.has(s.label))) {
		out.push(`## ${section.label}`, section.note, list(section.docs));
	}
	const optional = all.filter((s) => OPTIONAL.has(s.label)).flatMap((s) => s.docs);
	out.push(
		'## Optional',
		[
			list(optional),
			`- [The whole documentation in one file](${absolute('/llms-full.txt')}): every page above, as one Markdown document.`,
			`- [Source on GitHub](${REPO_URL}): both SDKs, their tests, the examples and the Claude Code plugin.`,
		]
			.filter(Boolean)
			.join('\n'),
	);
	return out.join('\n\n') + '\n';
}

export async function llmsFullTxt(): Promise<string> {
	const all = await pages();
	const home = all.get('index');
	const out = [
		`# ${TITLE}: the complete documentation`,
		`> ${DESCRIPTION}`,
		`This is every page of ${absolute('/')} as one Markdown document, in reading order. The index of the pages, with one line on each, is ${absolute('/llms.txt')}.`,
		NOTES.slice(0, 5)
			.map((note) => `- ${note}`)
			.join('\n'),
	];
	if (home) out.push('---', pageMarkdown(home, { footer: false }).trim());
	for (const section of await sections()) {
		for (const doc of section.docs) {
			out.push('---', `<!-- ${section.label} · ${markdownUrl(doc)} -->`, pageMarkdown(doc, { footer: false }).trim());
		}
	}
	return out.join('\n\n') + '\n';
}
