/**
 * `<page>/index.md`: every page's Markdown twin, beside its HTML.
 *
 *     /guides/contexts/           the page
 *     /guides/contexts/index.md   the same page as Markdown
 *     /index.md                   the home page
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import type { CollectionEntry } from 'astro:content';

import { pages } from '../../lib/llms';
import { pageMarkdown } from '../../lib/markdown';

export const getStaticPaths: GetStaticPaths = async () =>
	[...(await pages()).values()].map((entry) => ({
		params: { slug: entry.id === 'index' ? undefined : entry.id },
		props: { entry },
	}));

export const GET: APIRoute = ({ props }) =>
	new Response(pageMarkdown(props.entry as CollectionEntry<'docs'>), {
		headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
	});
