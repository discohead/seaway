# State in SQLite

`ctx.sql` is DuckDB over files, which suits logs and exports: data that is appended and scanned. State that is looked up by key and updated in place suits SQLite better, and it needs no verb of its own. `sqlite3` is in Archil's exec image, so a database is a file that a `sh` statement reads or writes. On the local backend it is the `sqlite3` on the PATH.

## Reading and writing

```python
db = "memory/state.db"
ctx.sh(
    "sqlite3 {db} {q}", db=ctx.out(db),
    q="create table if not exists seen(id text primary key, note text); "
      "insert or replace into seen values ('ENG-1', 'closed after the coupon fix')",
).run(check=True)

rows = ctx.sh("sqlite3 -readonly -json {db} {q}", db=ctx.out(db), q="select * from seen").run(check=True).json()
print(rows)                                   # [{'id': 'ENG-1', 'note': 'closed after the coupon fix'}]
```

```ts
const db = "memory/state.db";
const insert =
  "create table if not exists seen(id text primary key, note text); " +
  "insert or replace into seen values ('ENG-1', 'closed after the coupon fix')";
await ctx.sh`sqlite3 ${ctx.out(db)} ${insert}`.run({ check: true });

const rows = (await ctx.sh`sqlite3 -readonly -json ${ctx.out(db)} ${"select * from seen"}`.run({ check: true })).json();
console.log(rows);
```

- **Name the database with `ctx.out`.** On an `owned` disk that is what makes the call take the checkout, so a second writer waits its turn. Each statement is one call, and its plan says so before it runs.
- **The query is a value,** so it is one quoted word whatever it contains. A value inside the query is still text inside SQL, though: build the query with care, or pass data through a file and `.import`, or use `sqlite3`'s own `.param set`.
- `-json` makes the output parse with `result.json()`. A query that returns no rows prints nothing, so guard the parse: `result.json() if result.text.strip() else []`.
- Put the database on an `owned` mount. SQLite is for state with one owner.

## Four things to know

All four were seen on Archil on 9 November 2026.

**1. A database is one file, so it is one unit of conflict.** Two turns that change different rows of one database conflict, and the second is refused. Records that several agents edit side by side are better as a file each.

**2. A read is not isolated from a write made by another call.** SQLite keeps readers and writers apart with file locks, and a lock taken in one call is invisible to another. So a read on a read-only mount can go wrong in two ways:

- A read that starts during a write finds the writer's journal and fails with `attempt to write a readonly database`. With a writer busy on a large table, 49 of 81 such reads failed, nearly all that way.
- A read that is still open when a write commits can see both sides of it. One read transaction, held open across an update of every row, got back a minimum from before the update and a maximum from after.

Where a read has to be right, name the database with `ctx.out` in the read as well, as the example above does, so that it takes the checkout as a writer would. All 23 reads made that way succeeded, and a transaction held open that way saw one state throughout. The price is that such reads are serial: they queue behind each other and behind writes.

A read that names the database with `ctx.path` takes no checkout, so it does not queue and runs alongside others. It is the same one call. It is fine for state nobody is writing at the time, and for answers that may be retried.

**3. A write that arrives while another call holds the checkout waits five seconds and then comes back with exit 30.** It goes through when it is run again, so retry a write on exit 30. If a write is ever killed midway, reads fail in the way described above until the next write, which repairs the database as it opens it.

**4. The image's `sqlite3` is 3.37.2, from 2022.** It has `json_extract` and not `->>`, and no `percentile`. The Node in the same image carries a current SQLite as `node:sqlite`. The local `sqlite3` is probably newer, so a query that works locally can fail on Archil: keep to what 3.37 has.

## Retrying a write

```python
import time

def write_state(ctx, db, query, attempts=4):
    for attempt in range(attempts):
        result = ctx.sh("sqlite3 {db} {q}", db=ctx.out(db), q=query).run()
        if result.exit_code != 30:            # 30: the checkout was not granted in time
            return result.check()
        time.sleep(0.5 * (attempt + 1))
    return result.check()

write_state(ctx, "memory/state.db", "create table if not exists kv(k text primary key, v text); "
                                    "insert or replace into kv values ('cursor', '42')")
```

## SQLite or DuckDB

| | SQLite, through `sh` | DuckDB, through `ctx.sql` |
|---|---|---|
| Suits | state looked up by key and updated in place | logs, exports, anything appended and scanned |
| Storage | one database file on an `owned` mount | plain files: JSON lines, CSV, Parquet |
| Writers | one at a time, under the checkout | many, each appending to its own file |
| Conflicts in a turn | the whole database is one path | one path per file |
| On Archil | in the exec image (3.37.2) | on a disk you put it on; see [backends.md](backends.md#sql-on-archil-duckdb-on-a-disk) |
| Over raw logs | loads the lines before it can query them | queries the files where they lie |

From TypeScript there is also Archil's own `@archildata/sqlite`. It works the same way underneath: each query is one exec call, with a read-only mount for a read and a checkout for a write. Its reads take no checkout, so point 2 applies to them as well.
