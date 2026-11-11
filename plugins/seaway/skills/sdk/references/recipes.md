# Recipes

A recipe is how a system of record becomes files. It is two things: an adapter with the shape of an object store (`list` the keys, `get` one), and a short description of the layout it writes, which becomes the directory's README. `ctx.sync(recipe, into)` materialises it, incrementally.

## Contents

- [Records from an API](#records-from-an-api)
- [Fixed files](#fixed-files)
- [A recipe of your own](#a-recipe-of-your-own)
- [What sync does](#what-sync-does)
- [Recipes that are statements: git and duckdb](#recipes-that-are-statements-git-and-duckdb)

## Records from an API

```python
def fetch_issues():
    # call the tracker's API however you like; return the records
    return [
        {"id": "ENG-1", "title": "Checkout fails with an expired coupon", "status": "open",
         "updated": "2026-11-08T09:00:00Z", "description": "Steps: add a coupon that expired yesterday, then pay."},
        {"id": "ENG-2", "title": "Add dark mode", "status": "open", "updated": "2026-11-07T15:30:00Z", "description": ""},
    ]

issues = archil.Records(
    "issues", fetch_issues,
    key="id", version="updated", body="description",
    layout="One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.",
)
print(ctx.sync(issues, into="memory/tracker/issues"))   # {'written': 2, 'unchanged': 0, 'deleted': 0, 'into': 'memory/tracker/issues'}
print(ctx.sync(issues, into="memory/tracker/issues"))   # {'written': 0, 'unchanged': 2, 'deleted': 0, ...}
print(ctx.read_text("memory/tracker/issues/ENG-1.md"))
```

```ts
const fetchIssues = async () => [
  { id: "ENG-1", title: "Checkout fails with an expired coupon", status: "open",
    updated: "2026-11-08T09:00:00Z", description: "Steps: add a coupon that expired yesterday, then pay." },
  { id: "ENG-2", title: "Add dark mode", status: "open", updated: "2026-11-07T15:30:00Z", description: "" },
];

const issues = new archil.Records("issues", fetchIssues, {
  key: "id", version: "updated", body: "description",
  layout: "One Markdown file per issue, named <ID>.md. The fields are front matter; the description is the body.",
});
console.log(await ctx.sync(issues, "memory/tracker/issues"));
console.log(await ctx.sync(issues, "memory/tracker/issues"));
console.log(await ctx.readText("memory/tracker/issues/ENG-1.md"));
```

```text
---
id: ENG-1
title: Checkout fails with an expired coupon
status: open
updated: "2026-11-08T09:00:00Z"
---
Steps: add a coupon that expired yesterday, then pay.
```

`Records(name, fetch, ...)` turns records from any source into one Markdown file each.

| Option | Meaning |
|---|---|
| `fetch` | a function that returns the records. It is called on every sync |
| `key` | the field that identifies a record, and names its file: `<key>.md`. Characters other than letters, digits, `-`, `_` and `.` become `-`. The default is `id` |
| `version` | the field that changes when the record does, such as an updated-at time. Left out, a hash of the whole record |
| `body` | the field that becomes the text of the file. The other fields are front matter |
| `layout` | the note that becomes `README.md` in the directory |

A front-matter value that could be misread (one with a colon, a quote, a bracket, a `#` or surrounding spaces, and anything that is not a string) is written as JSON.

**The README matters more than it looks.** It is the schema, written for a reader that has only `ls` and `cat`. It is what lets an agent that has never seen this tracker find the open issues on its first try. Say what one file is, how files are named, and where the fields are.

## Fixed files

```python
skills = archil.Static(
    {"triage.md": "# Triage\nReproduce first. Then bisect.\n", "writing.md": "# Writing\nLead with the answer.\n"},
    name="skills", layout="One Markdown file per skill.",
)
ctx.sync(skills, into="memory/skills")
print([f.path for f in ctx.ls("memory/skills")])     # ['memory/skills/README.md', 'memory/skills/triage.md', 'memory/skills/writing.md']
```

```ts
const skills = new archil.Static(
  { "triage.md": "# Triage\nReproduce first. Then bisect.\n", "writing.md": "# Writing\nLead with the answer.\n" },
  { name: "skills", layout: "One Markdown file per skill." },
);
await ctx.sync(skills, "memory/skills");
console.log((await ctx.ls("memory/skills")).map((f) => f.path));
```

`Static` is for skills, prompts and fixtures: files whose content is in the program. A file's version is a hash of its content.

## A recipe of your own

In TypeScript anything with `list` and `get` is a recipe. In Python subclass `archil.Recipe`: `sync` also reads a `name` and a `layout`, which the class supplies. `list` returns entries, each a key (the path the file will have under the target directory) and a version (anything that changes when the content does: an ETag, an updated-at time, a hash). `get` returns one entry's bytes.

```python
class Orders(archil.Recipe):
    name = "orders"
    layout = "One JSON file per day, orders/<date>.json: a list of that day's orders."

    def __init__(self, days):
        self.days = days                               # {"2026-11-09": [...], ...}; stands in for a billing API

    def list(self):
        return [archil.Entry(f"{day}.json", version=str(len(orders))) for day, orders in self.days.items()]

    def get(self, key):
        import json
        return json.dumps(self.days[key.removesuffix(".json")]).encode()

print(ctx.sync(Orders({"2026-11-09": [{"id": 1}], "2026-11-10": []}), into="memory/orders"))
```

```ts
const days = { "2026-11-09": [{ id: 1 }], "2026-11-10": [] };       // stands in for a billing API
const orders = {
  name: "orders",
  layout: "One JSON file per day, orders/<date>.json: a list of that day's orders.",
  list: () => Object.entries(days).map(([day, list]) => ({ key: `${day}.json`, version: String(list.length) })),
  get: (key) => JSON.stringify(days[key.replace(/\.json$/, "")]),   // a string or bytes; both may be async
};
console.log(await ctx.sync(orders, "memory/orders"));
```

The adapter is shaped like an object store on purpose. `sync` runs it eagerly and writes files today. The same two functions could be served lazily by the file system itself, and nothing that reads the files would have to change.

Design the layout for the questions that will be asked of it. One file per record suits records that are read and edited one at a time, and it means two writers conflict only when they change the same record. One file per day suits records that are scanned.

## What sync does

`ctx.sync(recipe, into)` returns `{"written", "unchanged", "deleted", "into"}`.

- It lists the recipe, and fetches only the entries whose version differs from the one recorded at the last sync. An entry with no version is written every time.
- It removes the files of entries that are no longer listed.
- It writes `README.md` from `layout` when there is one and the file differs.
- It records the versions in `<mount>/.px/recipes/<id>.json`, and writes a line in the journal.
- The writes are direct: no compute. The target has to be on an `owned` or `shared` mount.
- A key may not be empty or start with `.px` (`bad_key`), and like any path it may not contain `..`.
- Syncing inside a turn (`turn.sync(...)`) lands the whole refresh at once, at a price: a commit does not carry over the framework's bookkeeping under `.px/`, so the main line does not learn which versions it now holds, and the next sync outside the turn writes every file once more.

## Recipes that are statements: git and duckdb

Two recipes run next to the data instead of through the caller. Each returns a statement, so it can be explained before it runs.

```python
clone = archil.git(ctx, "https://github.com/duckdb/duckdb-web", into="memory/src/duckdb-web", depth=1)
print(clone.explain())              # one call, memory mounted read-write; run it with clone.run(check=True)

install = archil.duckdb(ctx, "memory/bin")
print(install.explain())            # downloads the CLI, checks its SHA-256, installs memory/bin/duckdb
```

```ts
const clone = archil.git(ctx, "https://github.com/duckdb/duckdb-web", "memory/src/duckdb-web", { depth: 1 });
console.log(String(await clone.explain()));

const install = archil.duckdb(ctx, "memory/bin");
console.log(String(await install.explain()));
```

- **`archil.git(ctx, url, into, depth=1)`** clones a repository into a directory. The clone happens in a call with the target disk mounted, and nothing passes through the caller. It replaces what was at `into`.
- **`archil.duckdb(ctx, into, version=, url=, sha256=)`** puts the DuckDB command line at `<into>/duckdb`, so that `ctx.sql` has an engine on Archil, whose exec image has none. Run it once per disk: the file stays. Then open the context with `tools={"duckdb": "<into>/duckdb"}`.
  - The archive is checked against a SHA-256 before it is unpacked, and one that does not match installs nothing. The hash of the default version is pinned in the SDK. Another `version`, or an archive at a `url` of your own, has to come with its `sha256` (`unpinned_download`, `bad_sha256`).
  - It is the Linux x86-64 build, which is what Archil's exec VMs are. On the local backend SQL uses the `duckdb` on the PATH and none of this is needed.
- Both need the network. On a context whose egress is denied, allow it for that one statement: `install.egress("allow")`, or a list of the hosts the download uses.

```py
ctx = archil.context({"obs": archil.disk("obs-agent", "owned")}, tools={"duckdb": "obs/bin/duckdb"})
if not ctx.exists("obs/bin/duckdb"):
    archil.duckdb(ctx, "obs/bin").run(check=True)     # one call, once per disk
```
