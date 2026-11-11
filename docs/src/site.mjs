/**
 * Where the site lives. Change these two lines to move it; nothing else names the host or the path.
 *
 * Content links are written from the root (`/guides/contexts/`) and get the base put in front
 * when the site is built, so a move to a domain of its own is `BASE = ''`.
 */
export const ORIGIN = 'https://discohead.github.io';
export const BASE = '/seaway';

export const SITE_URL = ORIGIN + BASE;
export const REPO_URL = 'https://github.com/discohead/seaway';
export const VERSION = '0.1.0';

export const TITLE = 'seaway';
export const TAGLINE = 'The layer in front of exec: a framework for Archil.';
export const DESCRIPTION =
	'seaway is a framework for Archil. Define the context an agent needs, then run statements against it that say what they touch, explain themselves before they run, and carry a price. Two SDKs, Python and TypeScript, with one API.';

/** A root-relative path with the base in front: `/guides/contexts/` → `/seaway/guides/contexts/`. */
export function withBase(path) {
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path;
	if (BASE && (path === BASE || path.startsWith(BASE + '/'))) return path;
	return BASE + path;
}

/** The absolute URL of a root-relative path. */
export function absolute(path) {
	return ORIGIN + withBase(path);
}

/** The path of a page's Markdown twin: `guides/contexts` → `/guides/contexts/index.md`; the home page → `/index.md`. */
export function markdownPath(id) {
	return id === 'index' || id === '' ? '/index.md' : `/${id}/index.md`;
}

/** The path of a page: `guides/contexts` → `/guides/contexts/`; the home page → `/`. */
export function pagePath(id) {
	return id === 'index' || id === '' ? '/' : `/${id}/`;
}
