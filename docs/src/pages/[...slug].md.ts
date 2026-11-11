/**
 * `<page>.md`: the same Markdown twin under the other common address, for a reader that tries
 * `/guides/contexts.md` before `/guides/contexts/index.md`.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import type { CollectionEntry } from 'astro:content';

import { pages } from '../lib/llms';
import { pageMarkdown } from '../lib/markdown';

export const getStaticPaths: GetStaticPaths = async () =>
	[...(await pages()).values()]
		.filter((entry) => entry.id !== 'index')
		.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));

export const GET: APIRoute = ({ props }) =>
	new Response(pageMarkdown(props.entry as CollectionEntry<'docs'>), {
		headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
	});
