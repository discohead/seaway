/**
 * A Python example followed directly by its TypeScript twin becomes one block with two tabs.
 *
 * Pages are written as plain Markdown: a `python` fence, then a `ts` fence. That is also what a
 * page's Markdown twin shows, so the source and the copy a model reads are the same text. On the
 * site, this plugin wraps the pair in a `<code-tabs>` element, and the reader's choice of language
 * holds across every pair on every page (see `src/components/CodeTabs.astro`).
 *
 * `py` and `typescript` pair the same way. Those are the fences for code that is shown and not
 * run: see `scripts/check-examples.mjs`.
 */

const PYTHON = new Set(['python', 'py']);
const TYPESCRIPT = new Set(['ts', 'typescript']);

/** An element with block children. A paragraph is the node the pipeline lets carry a tag name. */
function element(tag, properties, children) {
	return { type: 'paragraph', data: { hName: tag, hProperties: properties }, children };
}

function copy(node) {
	return { type: 'code', lang: node.lang, meta: node.meta ?? null, value: node.value };
}

/** A Sätteri mdast plugin. */
export const codeTabs = {
	name: 'seaway-code-tabs',
	code(node, ctx) {
		if (!PYTHON.has(node.lang ?? '')) return;
		const parent = ctx.parent(node);
		const index = ctx.indexOf(node);
		if (!parent || index === undefined) return;
		const next = parent.children[index + 1];
		if (!next || next.type !== 'code' || !TYPESCRIPT.has(next.lang ?? '')) return;
		ctx.removeNode(next);
		return element('code-tabs', {}, [
			element('div', { 'data-lang': 'python', 'data-label': 'Python' }, [copy(node)]),
			element('div', { 'data-lang': 'ts', 'data-label': 'TypeScript' }, [copy(next)]),
		]);
	},
};
