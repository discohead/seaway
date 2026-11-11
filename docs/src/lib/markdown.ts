/**
 * Every page as Markdown: the text a model reads.
 *
 * A page's source is already Markdown, so most of it passes through untouched. What changes is
 * what only the site can draw:
 *
 * - an aside (`:::note`) becomes a quotation that starts with its label;
 * - `::example-context` becomes the sentence it stands for, and `:::cards` the list it holds;
 * - a link from the root (`/guides/contexts/`) becomes the absolute URL of that page's own
 *   Markdown twin, so a reader that follows links stays in Markdown;
 * - a fence marked `plan` becomes `text`, and a fence keeps only its language and its title;
 * - in an `.mdx` page, imports go and each component is replaced by the Markdown inside it;
 * - a diagram becomes a quotation that says what it shows, in the words a screen reader is given.
 *
 * A component with no rule here is an error, not a gap: the build stops and names it.
 */
import type { CollectionEntry } from 'astro:content';
import type { Blockquote, Code, Link, Nodes, Paragraph, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

import { DIAGRAMS } from '../components/diagrams/descriptions.mjs';
import { exampleContextNote } from '../markdown/directives.mjs';
import { ORIGIN, SITE_URL, TITLE, absolute, markdownPath, pagePath, withBase } from '../site.mjs';

type Doc = CollectionEntry<'docs'>;
type Jsx = Parent & { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement'; name: string | null; attributes: JsxAttribute[] };
type JsxAttribute = { type: string; name?: string; value?: unknown };
type Directive = Parent & { name: string; attributes?: Record<string, string | null | undefined> | null };

const ASIDES: Record<string, string> = { note: 'Note', tip: 'Tip', caution: 'Caution', danger: 'Danger' };

/** A link as a model should follow it: absolute, and to the Markdown twin when it is a page. */
export function resolveLink(url: string): string {
	if (!url.startsWith('/') || url.startsWith('//')) return url;
	const [, path = '', tail = ''] = /^([^?#]*)(.*)$/.exec(url) ?? [];
	if (path.endsWith('/')) return SITE_URL + (path === '/' ? '/index.md' : `${path}index.md`) + tail;
	return ORIGIN + withBase(path) + tail;
}

function attribute(node: Jsx, name: string): string | undefined {
	const found = node.attributes.find((a) => a.type === 'mdxJsxAttribute' && a.name === name);
	return typeof found?.value === 'string' ? found.value : undefined;
}

const text = (value: string): PhrasingContent => ({ type: 'text', value });
const strong = (value: string): PhrasingContent => ({ type: 'strong', children: [text(value)] });
const paragraph = (children: PhrasingContent[]): Paragraph => ({ type: 'paragraph', children });

/** A quotation that opens with a label: how an aside reads without a box around it. */
function labelled(label: string, children: RootContent[]): Blockquote {
	const [first, ...rest] = children;
	if (first?.type === 'paragraph') {
		const lead = paragraph([strong(`${label}:`), text(' '), ...first.children]);
		return { type: 'blockquote', children: [lead, ...rest] as Blockquote['children'] };
	}
	return { type: 'blockquote', children: [paragraph([strong(`${label}:`)]), ...children] as Blockquote['children'] };
}

/** What each component an `.mdx` page may use becomes. Children have already been rewritten. */
const COMPONENTS: Record<string, (node: Jsx, children: RootContent[]) => RootContent[]> = {
	// A figure's children are its description in words: what the drawing shows.
	Figure: (node, children) => {
		const caption = attribute(node, 'caption');
		return [...children, ...(caption ? [paragraph([{ type: 'emphasis', children: [text(caption)] }])] : [])];
	},
	// The home page's example: the fences inside it. Its words are the page's own front matter.
	HomeHero: (_node, children) => children,
	// The home page's sections: a heading, then what is inside.
	Section: (node, children) => {
		const title = attribute(node, 'title');
		const lede = attribute(node, 'lede');
		return [
			...(title ? [{ type: 'heading', depth: 2, children: [text(title)] } as RootContent] : []),
			...(lede ? [paragraph([text(lede)])] : []),
			...children,
		];
	},
	Meter: (node, children) => {
		const head = [attribute(node, 'name'), attribute(node, 'rate')].filter(Boolean).join(': ');
		const body = children[0]?.type === 'paragraph' ? [text(' '), ...children[0].children] : [];
		return [{ type: 'list', ordered: false, spread: false, children: [{ type: 'listItem', spread: false, children: [paragraph([strong(head), ...body])] }] }];
	},
	Meters: (_node, children) => mergeLists(children),
};

/** Adjacent one-item lists, as one list. */
function mergeLists(children: RootContent[]): RootContent[] {
	const items = children.flatMap((child) => (child.type === 'list' ? child.children : []));
	const others = children.filter((child) => child.type !== 'list');
	return items.length ? [{ type: 'list', ordered: false, spread: false, children: items }, ...others] : others;
}

/** A grid of cards is a list of links, each with a line on where it leads: `- [Title](url): what is there`. */
function cardList(node: RootContent): RootContent {
	if (node.type !== 'list') return node;
	for (const item of node.children) {
		const first = item.children[0];
		if (first?.type !== 'paragraph') continue;
		const [link, after] = first.children;
		if (link?.type === 'link' && after?.type === 'text' && /^\s+\S/.test(after.value)) after.value = `: ${after.value.trimStart()}`;
	}
	return node;
}

/** A drawing, as the words a screen reader is given for it: `> Diagram: <title>. <what it shows>`. */
function diagram(name: keyof typeof DIAGRAMS): RootContent[] {
	const { title, description } = DIAGRAMS[name];
	return [{ type: 'blockquote', children: [paragraph([strong(`Diagram: ${title}.`), text(` ${description}`)])] }];
}

function rewrite(node: Nodes, file: string): RootContent[] {
	if ('children' in node) {
		(node as Parent).children = (node as Parent).children.flatMap((child) => rewrite(child as Nodes, file)) as never;
	}
	switch (node.type) {
		case 'link':
		case 'definition':
		case 'image':
			(node as Link).url = resolveLink((node as Link).url);
			return [node as RootContent];
		case 'code': {
			const code = node as Code;
			if (code.lang === 'plan') code.lang = 'text';
			const title = /\btitle=("[^"]*"|'[^']*')/.exec(code.meta ?? '');
			code.meta = title ? title[0] : null;
			return [code];
		}
		case 'html':
			return /^<!--[\s\S]*-->$/.test(node.value.trim()) ? [] : [node];
		case 'containerDirective': {
			const directive = node as unknown as Directive;
			const children = directive.children as RootContent[];
			if (directive.name === 'cards') return children.map(cardList);
			const label = ASIDES[directive.name];
			if (!label) throw new Error(`${file}: no Markdown rule for the directive :::${directive.name}`);
			const [first, ...rest] = children;
			const custom = first?.type === 'paragraph' && (first.data as { directiveLabel?: boolean } | undefined)?.directiveLabel;
			if (custom) return [labelled(toText(first as Paragraph), rest)];
			return [labelled(label, children)];
		}
		case 'leafDirective': {
			const directive = node as unknown as Directive;
			if (directive.name !== 'example-context') throw new Error(`${file}: no Markdown rule for the directive ::${directive.name}`);
			const note = exampleContextNote() as PhrasingContent[];
			for (const part of note) if (part.type === 'link') part.url = resolveLink(part.url);
			return [{ type: 'blockquote', children: [paragraph(note)] }];
		}
		case 'mdxjsEsm' as string:
			return [];
		case 'mdxFlowExpression' as string:
		case 'mdxTextExpression' as string: {
			const value = (node as unknown as { value: string }).value.trim();
			if (/^\/\*[\s\S]*\*\/$/.test(value) || value === '') return [];
			throw new Error(`${file}: an expression has no Markdown form: {${value}}`);
		}
		case 'mdxJsxFlowElement' as string:
		case 'mdxJsxTextElement' as string: {
			const jsx = node as unknown as Jsx;
			const name = jsx.name ?? '';
			if (name in DIAGRAMS) return diagram(name as keyof typeof DIAGRAMS);
			const rule = COMPONENTS[name];
			if (!rule) throw new Error(`${file}: no Markdown rule for the component <${name}>; add one in src/lib/markdown.ts`);
			return rule(jsx, jsx.children as RootContent[]);
		}
		default:
			return [node as RootContent];
	}
}

function toText(node: Parent): string {
	return node.children.map((child) => ('value' in child ? String(child.value) : 'children' in child ? toText(child as Parent) : '')).join('');
}

function processor(mdx: boolean) {
	const pipeline = unified().use(remarkParse).use(remarkGfm, { tablePipeAlign: false }).use(remarkDirective);
	if (mdx) pipeline.use(remarkMdx);
	return pipeline.use(remarkStringify, {
		bullet: '-',
		emphasis: '_',
		fences: true,
		incrementListMarker: true,
		listItemIndent: 'one',
		resourceLink: false,
		rule: '-',
	});
}

/** A page's body, rewritten. */
export function bodyMarkdown(entry: Doc): string {
	const file = entry.filePath ?? entry.id;
	const pipeline = processor(file.endsWith('.mdx'));
	const tree = pipeline.parse(entry.body ?? '') as Root;
	tree.children = tree.children.flatMap((child) => rewrite(child, file));
	return (pipeline.stringify(tree) as string).trim();
}

/** The page's address, and its Markdown twin's. */
export const pageUrl = (entry: Doc) => absolute(pagePath(entry.id));
export const markdownUrl = (entry: Doc) => absolute(markdownPath(entry.id));

/** A whole page: its title, what it is for, its body, and where it came from. */
export function pageMarkdown(entry: Doc, options: { footer?: boolean } = {}): string {
	const { title, description, hero } = entry.data;
	const plain = (html: string) => html.replace(/<code>(.*?)<\/code>/g, '`$1`').replace(/<[^>]+>/g, '');
	const parts = [`# ${hero?.title ? `${TITLE}: ${plain(hero.title)}` : title}`];
	const lede = hero?.tagline ?? description;
	if (lede) parts.push(`> ${plain(lede)}`);
	if (hero?.actions?.length) {
		parts.push(hero.actions.map((action) => `- [${action.text}](${resolveLink(action.link)})`).join('\n'));
	}
	const body = bodyMarkdown(entry);
	if (body) parts.push(body);
	if (options.footer !== false) {
		parts.push(`---\n\nThis page: ${pageUrl(entry)}\nEvery page, as Markdown: ${absolute('/llms.txt')}`);
	}
	return parts.join('\n\n') + '\n';
}
