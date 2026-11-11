# The seaway docs

The source of <https://discohead.github.io/seaway/>. [Astro](https://astro.build) with
[Starlight](https://starlight.astro.build); every page is a Markdown file under `src/content/docs/`.

```bash
npm install
npm run dev               # http://localhost:4321/seaway/
npm run check             # everything CI runs: the four checks below, in order
```

| Command | What it does |
|---|---|
| `npm run check:examples` | runs every example on the site against the SDKs in this repository, in Python and in TypeScript, on a local backend; type-checks the TypeScript; compares what the Python printed with the output the page shows; and fails a line of code wider than 88 columns, which would not fit its block |
| `npm run check:api` | checks every API name the prose and the tables mention against both SDKs, and the reference's lists of exports, types and error codes against the source |
| `npm run check:types` | type-checks the site's own components and endpoints (`astro check`) |
| `npm run build` | builds the site into `dist/`, then checks every link, anchor, Markdown twin and `llms.txt` entry in it |

The site needs Node 22.23.4 or later, which is what Astro asks for. The checks also need Python 3.10
or later (name one with `SEAWAY_PYTHON` if `python3` is older), `npm ci` run once in `../typescript`,
and `duckdb`, `sqlite3` and `jq` on the PATH (`pip install -e '../python[dev]'` brings the `duckdb`
CLI). Nothing here can reach an Archil account: the checks remove `ARCHIL_API_KEY` from their
environment and force the local backend.

## Writing a page

- Give it a `title` and a `description`, and add it to `src/sidebar.mjs`. The build fails for a page that is not there.
- A fenced block marked `python` or `ts` is run. One marked `py` or `typescript` is only shown.
  A block that does not import seaway runs pasted after the setup on the page "The example context",
  so it cannot declare a name that setup already has.
  A Python block followed directly by its TypeScript twin becomes one block with two tabs.
- A block of output marked `output` (` ```text output `) is checked against what the Python example before it printed. `…` stands for anything.
- Keep code to 88 columns. That is what a block shows without scrolling, and the check enforces it. Output, plans and file contents are shown as they are, and wrap.
- Write links from the root, as `/guides/contexts/`. The base path is added for you.

The rest is in [Contributing](https://discohead.github.io/seaway/project/contributing/#these-docs).

## How it is put together

| Path | What is there |
|---|---|
| `src/content/docs/` | the pages |
| `src/sidebar.mjs` | the navigation, and the order of `llms.txt` |
| `src/site.mjs` | the site's address, base path and names |
| `src/markdown/` | the Markdown plugins: language tabs, the card grid, the example-context note |
| `src/lib/markdown.ts` | turns a page's source into the plain Markdown served beside it |
| `src/lib/llms.ts`, `src/pages/` | `llms.txt`, `llms-full.txt`, and `index.md` for every page |
| `src/components/` | the page title and its menu, the footer, the home page, the diagrams |
| `src/styles/` | the theme |
| `scripts/` | the checks, and `make-og.mjs`, which draws the social card |

## Publishing

`.github/workflows/docs.yml` runs the checks and the build on every push, and deploys `main` to
GitHub Pages. To move the site, change `ORIGIN` and `BASE` in `src/site.mjs`.
