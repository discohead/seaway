/**
 * A name in a table is kept on one line.
 *
 * A browser may break `interpolated-command` after its hyphen, which a reader then takes for two
 * names. So inline code in a table cell that is one word (no spaces, and not long) is marked, and
 * the stylesheet keeps it whole. A signature, which has spaces, still wraps at them.
 */
const LONGEST = 40;

export const tableNames = {
	name: 'seaway-table-names',
	element: {
		filter: ['code'],
		/**
		 * @param {any} node an inline `code` element
		 * @param {any} ctx the visitor's context: `parent`, `textContent`, `setProperty`
		 */
		visit(node, ctx) {
			let above = ctx.parent(node);
			if (above?.tagName === 'a' || above?.tagName === 'strong') above = ctx.parent(above);
			if (above?.tagName !== 'td') return;
			const text = ctx.textContent(node);
			if (text.length <= LONGEST && !/\s/.test(text)) ctx.setProperty(node, 'className', ['sw-keep']);
		},
	},
};
