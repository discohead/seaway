---
title: Recipes
description: Reference for Recipe, Entry, Static, Records and sync, and for the two recipes that are statements, git and duckdb, in Python and TypeScript.
---

A recipe turns a system of record into files. The guide is [Recipes](/guides/recipes/).

## sync

Materialises a recipe under a directory. Incremental.

```py
ctx.sync(recipe, into) -> dict            # also archil.sync(ctx, recipe, into)
```

```typescript
// also archil.sync(ctx, recipe, into)
ctx.sync(recipe: Recipe, into: string): Promise<SyncStats>
```

Returns `{"written", "unchanged", "deleted", "into"}`.

| Field | Is |
|---|---|
| `written` | entries fetched and written: new, or with a version that changed |
| `unchanged` | entries whose version matched the last sync. Not fetched |
| `deleted` | files of entries that are no longer listed |
| `into` | the target directory |

The target has to be on an `owned` or `shared` mount. Raises `ValidationError` with `bad_key` for an entry whose key is empty or starts with `.px`.

## Recipe

An adapter with the shape of an object store.

| Member | Python | TypeScript |
|---|---|---|
| a name | `name`, a class attribute | `name` |
| a layout note | `layout`, a class attribute | `layout`, optional |
| the entries | `list(self)` returns an iterable of `Entry` | `list()` returns an iterable of entries. May be `async` |
| one entry's content | `get(self, key)` returns bytes | `get(key)` returns bytes or a string. May be `async` |

In Python, subclass `archil.Recipe`. In TypeScript, `Recipe` is an interface: any object with those members is one.

`layout` becomes `README.md` in the target directory.

## Entry

| Python | TypeScript | Is |
|---|---|---|
| `archil.Entry(key, version="")` | `{ key, version? }` | one file the recipe produces |

- `key` is the file's path under the target directory.
- `version` is anything that changes when the content does: an ETag, an updated-at time, a hash. An entry with no version is written on every sync.

## Static

Fixed files, whose content is in the program.

```py
archil.Static(files, *, name="static", layout="")
```

```typescript
new archil.Static(
  files: Record<string, string | Uint8Array>,
  options?: { name?, layout? },
)
```

`files` maps a key to its content. A file's version is a hash of its content.

## Records

Records from any source, one Markdown file each, with the fields as front matter.

```py
archil.Records(name, fetch, *, key="id", version=None, body=None, layout="")
```

```typescript
new archil.Records(
  name: string,
  fetch: () => Iterable<object> | Promise<Iterable<object>>,
  options?: { key?, version?, body?, layout? },
)
```

| Parameter | Default | Meaning |
|---|---|---|
| `name` | | the recipe's name, as the journal records it |
| `fetch` | | a function that returns the records. Called on every sync |
| `key` | `"id"` | the field that identifies a record, and names its file: `<key>.md` |
| `version` | a hash of the record | the field that changes when the record does |
| `body` | none | the field that becomes the text of the file |
| `layout` | `""` | the note that becomes `README.md` |

## git

A repository as a directory. Returns a statement.

```py
archil.git(ctx, url, into, *, depth=1) -> Statement
```

```typescript
archil.git(ctx: Context, url: string, into: string, options?: { depth? }): Statement
```

The clone happens in a call, with the target disk mounted. It replaces what was at `into`. It needs the network.

## duckdb

The DuckDB command line on a disk, so that `ctx.sql` has an engine on Archil. Returns a statement.

```py
archil.duckdb(ctx, into, *, version="2.0.0", url=None, sha256=None) -> Statement
```

```typescript
archil.duckdb(
  ctx: Context,
  into: string,
  options?: { version?, url?, sha256? },
): Statement
```

| Parameter | Default | Meaning |
|---|---|---|
| `into` | | the directory. The binary is installed at `<into>/duckdb` |
| `version` | `"2.0.0"` | the release to download |
| `url` | DuckDB's release archive on GitHub | an archive of your own |
| `sha256` | pinned for the default version | the archive's SHA-256, as 64 hex characters. Required with another `version` or a `url` |

Raises `ValidationError` with `unpinned_download` when no hash is known for the download, and `bad_sha256` for one that is not 64 hex characters.

The archive is checked against the hash before it is unpacked. It is the Linux x86-64 build. TypeScript exports the pinned values as `archil.DUCKDB_VERSION` and `archil.DUCKDB_SHA256`.
