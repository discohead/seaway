/**
 * What each diagram shows, in words.
 *
 * A screen reader reads these out as the drawing's title and description, and a page's Markdown
 * twin has them where the drawing was, so nobody who cannot see the picture misses what it says.
 */
export const DIAGRAMS = {
	Layers: {
		title: 'The layers of seaway',
		description:
			'Your code calls seaway. seaway is contexts, statements, plans and turns, with logs, views, feeds, recipes, ' +
			'tools, the journal and the ledger built on them. It compiles to a small backend interface, which the local ' +
			'backend and the Archil backend both provide.',
	},
	StatementFlow: {
		title: 'From a statement to calls',
		description:
			'Compiling a statement gathers its paths from a listing, works out the mount map, splits the input into ' +
			'shards if the statement is mapped, and prices the result. That is the plan, and it is all that explain does. ' +
			'Running compiles again, checks the budget, sends one call per task, reduces the outputs into a result, and ' +
			'records the cost in the ledger and the journal.',
	},
	TurnTimeline: {
		title: 'A turn, in time',
		description:
			'When a turn begins, each disk it may write is checkpointed and branched. The turn writes to the branch while ' +
			'the main line moves on. At commit, if none of the paths the turn changed has changed on the main line, the ' +
			'changes are copied across in one call per disk. If any has, the commit raises a conflict and nothing is applied.',
	},
};
