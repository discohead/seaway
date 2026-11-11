/**
 * The two directives the docs add to Markdown, so a page can stay plain Markdown.
 *
 *     ::example-context          a note saying what `archil` and `ctx` are in the page's examples
 *
 *     :::cards                   a list of links, drawn as a grid of cards
 *     - [Title](/path/) One line about it.
 *     :::
 *
 * This file is the site's half. `src/lib/markdown.ts` has the other half: what each becomes in a
 * page's Markdown twin (the note as a quotation, the cards as the list they already are).
 */

/** What the examples on a guide page assume, as the children of one paragraph. */
export function exampleContextNote() {
	const code = (value) => ({ type: 'inlineCode', value });
	const text = (value) => ({ type: 'text', value });
	return [
		text('The examples here use '),
		code('archil'),
		text(' for the import and '),
		code('ctx'),
		text(' for '),
		{ type: 'link', url: '/guides/example-context/', title: null, children: [text('the example context')] },
		text(': '),
		code('docs'),
		text(' (read), '),
		code('logs'),
		text(' (append), '),
		code('memory'),
		text(' (owned) and '),
		code('team'),
		text(' (shared), on a local backend. Paste its setup first and any example runs.'),
	];
}

function element(tag, properties, children) {
	return { type: 'paragraph', data: { hName: tag, hProperties: properties }, children };
}

/** A Sätteri mdast plugin. */
export const directives = {
	name: 'seaway-directives',
	leafDirective(node) {
		if (node.name !== 'example-context') return;
		return element('div', { class: 'sw-note' }, [{ type: 'paragraph', children: exampleContextNote() }]);
	},
	containerDirective(node) {
		if (node.name !== 'cards') return;
		return element('div', { class: 'sw-cards' }, [...node.children]);
	},
};
