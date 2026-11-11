// @ts-check
import { readFileSync } from 'node:fs';

import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

import { codeTabs } from './src/markdown/code-tabs.mjs';
import { directives } from './src/markdown/directives.mjs';
import { tableNames } from './src/markdown/table-names.mjs';
import { sidebar } from './src/sidebar.mjs';
import { BASE, DESCRIPTION, ORIGIN, REPO_URL, SITE_URL, TITLE, withBase } from './src/site.mjs';

/** A grammar for printed plans, so a fence marked `plan` reads as one: labels, scope, price. */
const planGrammar = JSON.parse(readFileSync(new URL('./src/plan.tmLanguage.json', import.meta.url), 'utf8'));

/**
 * Content links are written from the root (`/guides/contexts/`). This puts the base in front of
 * them, so the same pages work under `/seaway` and under a domain of their own.
 */
const baseLinks = {
	name: 'seaway-base-links',
	element: {
		filter: ['a'],
		/**
		 * @param {{ properties?: Record<string, unknown> }} node
		 * @param {{ setProperty(node: unknown, key: string, value: unknown): void }} ctx
		 */
		visit(node, ctx) {
			const href = node.properties?.href;
			if (typeof href !== 'string') return;
			const based = withBase(href);
			if (based !== href) ctx.setProperty(node, 'href', based);
		},
	},
};

export default defineConfig({
	site: ORIGIN,
	base: BASE || undefined,
	trailingSlash: 'always',
	markdown: {
		processor: satteri({
			// Written in plain JavaScript, so the nodes they return carry no types to check here.
			mdastPlugins: /** @type {any[]} */ ([codeTabs, directives]),
			hastPlugins: [baseLinks, tableNames],
		}),
	},
	integrations: [
		starlight({
			title: TITLE,
			description: DESCRIPTION,
			logo: {
				light: './src/assets/logo-light.svg',
				dark: './src/assets/logo-dark.svg',
				alt: '',
			},
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'seaway on GitHub', href: REPO_URL }],
			editLink: { baseUrl: `${REPO_URL}/edit/main/docs/` },
			lastUpdated: true,
			credits: false,
			titleDelimiter: '·',
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			customCss: [
				'@fontsource-variable/geist/wght.css',
				'@fontsource-variable/geist-mono/wght.css',
				'./src/styles/theme.css',
				'./src/styles/content.css',
				'./src/styles/home.css',
			],
			routeMiddleware: './src/route-data.ts',
			components: {
				Footer: './src/components/Footer.astro',
				Hero: './src/components/Hero.astro',
				PageTitle: './src/components/PageTitle.astro',
			},
			head: [
				// Python or TypeScript: the reader's choice, set before the first paint so nothing jumps.
				{
					tag: 'script',
					content:
						"try{document.documentElement.dataset.lang=localStorage.getItem('seaway:lang')==='ts'?'ts':'python'}catch{document.documentElement.dataset.lang='python'}",
				},
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#0a0f12', media: '(prefers-color-scheme: dark)' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#fcfdfc', media: '(prefers-color-scheme: light)' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: `${SITE_URL}/og.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE_URL}/og.png` } },
				// Where a model should start: the index of every page, as Markdown.
				{
					tag: 'link',
					attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: withBase('/llms.txt') },
				},
			],
			sidebar,
			expressiveCode: {
				themes: ['vitesse-dark', 'vitesse-light'],
				useStarlightUiThemeColors: true,
				shiki: { langs: [planGrammar] },
				// Code keeps its shape, and check-examples keeps it to 88 columns, which fit. Output,
				// plans and file contents are shown as they are, however wide, so those wrap instead
				// of running off the edge of the block.
				defaultProps: {
					overridesByLang: {
						'text,plan,json,markdown': { wrap: true },
					},
				},
				styleOverrides: {
					borderRadius: '0.5rem',
					borderColor: 'var(--sl-color-hairline-light)',
					codeFontFamily: 'var(--__sl-font-mono)',
					codeFontSize: '0.8125rem',
					codeLineHeight: '1.7',
					codePaddingBlock: '0.9rem',
					codePaddingInline: '1.1rem',
					uiFontFamily: 'var(--__sl-font)',
					uiFontSize: '0.75rem',
					frames: {
						shadowColor: 'transparent',
						frameBoxShadowCssValue: 'none',
					},
				},
			},
		}),
	],
});
