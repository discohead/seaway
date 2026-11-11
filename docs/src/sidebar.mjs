/**
 * The site's navigation, in one place.
 *
 * `astro.config.mjs` hands this to Starlight as the sidebar. `src/lib/llms.ts` reads the same
 * list to build `llms.txt`, so the two can never disagree about what the docs contain or in
 * what order.
 *
 * `note` is the one line `llms.txt` prints under a group's heading.
 */

/** @type {{ label: string, note: string, collapsed?: boolean, items: string[] }[]} */
export const groups = [
	{
		label: 'Start here',
		note: 'What seaway is, how to install it, and a first program.',
		items: ['start/introduction', 'start/installation', 'start/quickstart', 'start/concepts', 'start/examples'],
	},
	{
		label: 'Contexts',
		note: 'Compose disks into a context, and decide who may change what.',
		items: [
			'guides/contexts',
			'guides/modes',
			'guides/narrowing',
			'guides/manifests',
			'guides/checkpoints',
			'guides/journal',
		],
	},
	{
		label: 'Statements',
		note: 'Work that runs next to the data: what it touches, what it will do, what it costs.',
		items: [
			'guides/statements',
			'guides/sql',
			'guides/grep',
			'guides/batch-and-map',
			'guides/results',
			'guides/plans',
			'guides/prices',
		],
	},
	{
		label: 'Turns and structures',
		note: 'Transactions over files, and the structures built from the same verbs.',
		items: ['guides/turns', 'guides/logs', 'guides/views', 'guides/feeds', 'guides/recipes', 'guides/sqlite'],
	},
	{
		label: 'Agents',
		note: 'Hand a context to a model, and teach a coding agent the real API.',
		items: ['guides/model-tools', 'agents/claude-code', 'agents/mcp-server', 'agents/lint', 'agents/llms'],
	},
	{
		label: 'Run it',
		note: 'Where code runs, what changes on Archil, and what to do when something fails.',
		items: ['guides/backends', 'guides/archil', 'guides/errors', 'guides/troubleshooting', 'guides/example-context'],
	},
	{
		label: 'Blueprints',
		note: 'Worked designs to start from: the context, the layout and the statements that matter.',
		items: [
			'blueprints',
			'blueprints/agent-context',
			'blueprints/observability',
			'blueprints/mirror',
			'blueprints/attempts',
			'blueprints/helper',
			'blueprints/replay',
			'blueprints/shared-records',
			'blueprints/change-driven',
		],
	},
	{
		label: 'Architecture',
		note: 'How the framework is built, and why it is built that way.',
		items: [
			'architecture/overview',
			'architecture/planning',
			'architecture/transactions',
			'architecture/files-on-disk',
			'architecture/versions',
			'architecture/two-sdks',
			'architecture/platform',
			'architecture/status',
		],
	},
	{
		label: 'API reference',
		note: 'Every public name in both SDKs, side by side.',
		items: [
			'reference',
			'reference/context',
			'reference/statement',
			'reference/plan',
			'reference/transaction',
			'reference/structures',
			'reference/recipes',
			'reference/pricing',
			'reference/tools',
			'reference/backends',
			'reference/errors',
			'reference/limits',
			'reference/environment',
			'reference/python-and-typescript',
		],
	},
	{
		label: 'Project',
		note: 'Working on seaway itself.',
		items: ['project/contributing'],
	},
];

/** The sidebar as Starlight takes it. A page's label is its `sidebar.label`, or its title. */
export const sidebar = groups.map(({ label, items, collapsed }) => ({ label, items, collapsed }));
