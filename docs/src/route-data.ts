/**
 * Every page says where its Markdown twin is, in its `<head>`. A crawler or an agent that has
 * the HTML can find the plain text without guessing a URL.
 */
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { markdownPath, withBase } from './site.mjs';

export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	if (route.entry.id === '404') return;
	route.head.push({
		tag: 'link',
		attrs: {
			rel: 'alternate',
			type: 'text/markdown',
			title: `${route.entry.data.title} (Markdown)`,
			href: withBase(markdownPath(route.id || 'index')),
		},
	});
});
