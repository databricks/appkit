---
sidebar_position: 5
---

# Database plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

Declare your tables in `config/database/schema.ts` and register `database()` to
get generated HTTP CRUD and a server-side database client. CRUD is enabled for
every declared table by default. Use `api` to restrict the generated routes
without disabling server-side access.

:::caution[Shared application access]
This plugin uses the app's service principal in deployed Databricks Apps. It does
not support OBO and does not apply per-user or per-row authorization. Every caller
who can reach the generated API can perform every enabled operation on every
exposed row, including delete.

Restrict access to the app and grant its service principal only the database
permissions it needs. If users need different permissions or row ownership checks,
disable the relevant generated routes and implement authorization in custom
server routes. App admission alone does not provide row-level isolation.
:::

## Basic usage

Configure a Lakebase `postgres` resource and its connection environment variables
as described in [Lakebase configuration](./lakebase.md#environment-variables).

When a query fails at runtime, the client receives only a stable message such as
`Database operation failed`. The server log records the SQLSTATE and only
identifier-only messages for known missing-column or missing-table errors
(for example `column notes.board_id does not exist`). Other driver messages,
details, and hints are omitted because they may contain row values.

Apps scaffolded with the Database plugin selected include an empty
`config/database/schema.ts`, so `database()` can start without requiring sample
tables. Replace the empty declaration with your models when their PostgreSQL
tables are ready.

For local development, the PostgreSQL username is resolved from your Databricks
credentials when `PGUSER` and `DATABRICKS_CLIENT_ID` are absent. An explicitly
configured username takes precedence.

```ts
// config/database/schema.ts
import { defineSchema, id, text } from "@databricks/appkit/beta";

export const schema = defineSchema((builder) => ({
  notes: builder.table("notes", {
    id: id(),
    body: text().notNull(),
  }),
}));
```

```ts
// server/index.ts
import { createApp, server } from "@databricks/appkit";
import { database } from "@databricks/appkit/beta";

const AppKit = await createApp({
  plugins: [server(), database()],
});
```

With the server plugin enabled, this registers:

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/database/notes` | List rows |
| GET | `/api/database/notes/:id` | Find one row |
| POST | `/api/database/notes` | Create a row |
| PATCH | `/api/database/notes/:id` | Update a row |
| DELETE | `/api/database/notes/:id` | Delete a row |

A table without a public primary key supports create and, if it has a sortable
public column, list with an explicit non-empty `order`. A keyless table with no
sortable columns has no list route. `upsert` is available to server code but has
no generated HTTP route.

## Schema discovery and overrides

`database()` and `database({})` use the same defaults. During setup, the plugin
loads the named `schema` export from `config/database/schema.ts`, relative to the
application's working directory. The file must export a finalized `defineSchema()`
result. Missing files, import failures, and invalid exports fail setup before the
plugin creates a connection pool; they do not silently create an empty schema.

Keep `config/database/schema.ts` and its local imports in your deployment. The
plugin loads TypeScript through Jiti, so a plain Node production process does not
need a separate TypeScript loader. The schema module should only declare tables,
not connect to the database or start the app.

For a different layout or a deployment that contains only a server bundle, import
the schema explicitly and pass it to the plugin:

```ts
import { schema } from "../config/database/schema";

database({ schema });
```

An explicit schema always takes precedence and skips file discovery. An invalid
explicit schema fails setup instead of falling back to another file.

Run `appkit generate-types` to generate the database registry. With that registry,
configuration without an explicit schema still infers table names.
An explicitly supplied schema also checks configuration keys against its own table
names.

## Restrict the generated API

Omitting `api`, or setting it to `true` or `{}`, enables full CRUD. Restrictions
are optional. There is no separate write opt-in.

```ts
// No generated HTTP routes. The server-side client still works.
database({ api: false });

// Read-only routes for every table.
database({ api: { writes: false } });

// Full CRUD for selected tables only.
database({ api: { tables: ["notes"] } });

// Allow reads, create, and update, but not delete.
database({
  api: { writes: { operations: ["create", "update"] } },
});

// Read every table, but allow writes only to notes.
database({
  api: { writes: { tables: ["notes"] } },
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `schema` | Named export in `config/database/schema.ts` | Overrides automatic schema loading |
| `api` | `true` | `false` disables all generated routes |
| `api.tables` | All declared tables | Limits which tables have routes |
| `api.writes` | `true` | `false` keeps only read routes |
| `api.writes.tables` | All exposed tables | Limits which exposed tables accept writes |
| `api.writes.operations` | `create`, `update`, `delete` | Limits which writes are enabled |

`api.tables: []` disables all generated routes. An empty write-table or
write-operation list keeps reads and disables writes. Tables omitted from
`api.tables` also cannot be included through relations on exposed tables.
These restrictions apply to HTTP only, not to the server-side client.

An omitted restriction uses its default. A malformed restriction fails setup.
For example, `{ api: { write: false } }` is an error, not permission to generate
all writes. Unknown tables, duplicate names, and unsupported operations also
fail setup before the plugin creates a connection pool.

Replace the former `crudRoutes` option with `api`. The old name is rejected at
runtime so an old opt-out cannot silently enable the API. To preserve read-only
behavior, specify `api: { writes: false }`.

### Table names and setup errors

Generated route names must:

- Start with an ASCII letter.
- Contain only ASCII letters, digits, underscores, or hyphens.
- Be at most 64 characters long.
- Be unique without regard to case, because Express routes are case-insensitive.

The default API validates every declared table. A table such as `_events` fails
setup instead of being silently omitted. The error names the table and suggests
renaming it, excluding it with `api.tables`, or disabling routes with `api: false`.
An excluded table remains available to server code.

Configuration errors include actionable details in the server-side error message.
Client-facing messages do not expose those details.

## Validation and private columns

The generated API validates request bodies and rejects unknown or read-only
fields. Columns marked `.private()` are not available through generated routes.
Database-generated primary keys, including `uuid().primaryKey().defaultRandom()`,
cannot be supplied by HTTP callers. A natural primary key may be supplied on
create, but primary keys cannot be updated through HTTP.

Validation is not authorization. A valid request can still read or change any
exposed row. Use custom authorized routes when that is not the desired access
model.

## Transactions

A root write outside `database.transaction()` uses the connection pool directly.
Related writes belong in one explicit transaction. The callback receives a
transaction client with the same entity methods and `sql` tag. A later
`transaction()` call inside that callback joins the open transaction instead of
opening another one. A root write made while the callback is running also joins
it, and keeps the predicate from the query that issued the write. A read or an
`sql` call made on the root client does not join.

```ts
const note = await appkit.database.transaction(async (tx) => {
  const created = await tx.notes.create({ body: "Ship it" });
  await tx.note_events.create({ note_id: created.id, action: "created" });
  return created;
});
```

The callback commits when it returns and rolls back when it throws. A thrown
`DatabaseValidationError` keeps its identity. Any other thrown error becomes an
opaque transaction failure. The transaction does not cover writes through other
plugins or external services.

`update()` returns `null` and `delete()` returns `false` when no row matches.
Those results do not abort the caller's transaction. A later write in the same
callback can still commit.

Await every database call inside the callback. The callback has a 30-second
deadline and one shared budget. That budget counts entity writes and `tx.sql`
statements. It does not count reads. The 101st counted operation rejects the
transaction. PostgreSQL also enforces a 30-second `statement_timeout` and a
30-second `idle_in_transaction_session_timeout`.

The callback deadline does not cancel arbitrary JavaScript, HTTP requests, or
other external side effects. Avoid starting external work that needs the
database rollback to undo it.

## Browser client (beta)

`@databricks/appkit-ui/js/beta` provides `databaseApi`, a typed client for the
generated routes. Entity names, parameters, values, and rows are typed from the
same generated registry as the server-side client, restricted to what the
generated routes accept. The client adds no authorization. Anyone who can load
the page can call the same routes.

### Setup

Run `appkit generate-types` or use the AppKit Vite plugin to write
`shared/appkit-types/database.d.ts`, and include it in the client's TypeScript
project. It binds the server registry and a shared global interface used by
`@databricks/appkit-ui/js/beta`; server-only apps do not need the UI package or
`skipLibCheck`. Until the file exists, every entity name is a type error.

The client finds routes in the endpoint map the server embeds in the page. When
the `api` configuration does not expose an operation, a call to it fails with
`NOT_EXPOSED` and sends no request. The page also carries the relations between
exposed tables, as relation and table names only, so the
[React hooks](#refresh-reads-after-a-write) can tell which reads a write
affects. These are the names `include` already accepts.

### Calls

```ts
import { databaseApi } from "@databricks/appkit-ui/js/beta";

const page = await databaseApi.list("notes", {
  where: { board_id: 7 },
  order: { created_at: "desc" },
  limit: 20,
});
const board = await databaseApi.get("boards", 7, { select: ["id", "title"] });
const note = await databaseApi.create("notes", {
  board_id: board.id,
  author: "ada",
  body: "Ship it",
});
await databaseApi.update("notes", note.id, { body: "Shipped" });
await databaseApi.remove("notes", note.id);
```

| Call | Route | Resolves with |
| --- | --- | --- |
| `list(entity, params?)` | `GET /api/database/<entity>` | The list envelope `{ items, limit, offset }` |
| `get(entity, id, params?)` | `GET /api/database/<entity>/:id` | The row |
| `create(entity, values)` | `POST /api/database/<entity>` | The created row |
| `update(entity, id, values)` | `PATCH /api/database/<entity>/:id` | The updated row |
| `remove(entity, id)` | `DELETE /api/database/<entity>/:id` | Nothing |

A failed call rejects with a [`DatabaseApiError`](#errors). An optional last
argument, `{ signal }`, cancels the request, and the promise then rejects with
the abort reason. Cancelling a write does not undo it if the server already
committed it.

Only tables with a public primary key that the URL path can represent have
`get`, `update`, and `remove`. Boolean and JSONB primary keys, like private or
missing keys, are treated as keyless over HTTP: no keyed routes are published,
although creates and explicitly ordered lists remain available when supported.
Calling a keyed operation on these tables is a type error. A missing row on a
supported keyed route rejects with `NOT_FOUND`.

### Parameters

| Parameter | `list` | `get` | Accepts |
| --- | --- | --- | --- |
| `where` | Yes | No | Public, queryable columns. A value, or an operator object (`eq`, `neq`, `in`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte` by column kind, `is: null` for nullable columns), combined with `and` and `or` |
| `order` | Yes | No | Public, queryable columns mapped to `"asc"` or `"desc"`; required and non-empty for keyless lists |
| `select` | Yes | Yes | Public columns. The row type narrows to them |
| `include` | Yes | Yes | Exposed relations, `true` or options, at most two edges deep. Only a to-many relation takes a `limit` |
| `limit`, `offset` | Yes | No | Integers, 0 to 500 and 0 to 10,000 |

Private columns, JSON columns in `where` or `order`, and unknown parameters are
compile errors. An explicit `where` must not be empty, and an undefined nested
filter value fails rather than broadening the read; omit `where` entirely to
list all rows. A top-level `where: {}` fails locally with guidance to omit the
parameter, without sending a request. For optional search controls, for example:

```typescript
const where = search ? { body: { ilike: `%${search}%` } } : undefined;
await databaseApi.list("notes", { where });
```

A to-many include adds an array to each row and a to-one include adds a row or
`null`. JSON carries bigint columns as decimal strings, so rows type them as
`string`, and filters accept a string or a safe integer. Dynamic `select` arrays
return optional properties for their possible columns; a literal tuple returns
those properties as required. This also applies to detail and included rows.
Params typed broadly with an optional `select` keep row fields optional.

### Values

`create` and `update` accept only the fields the generated route accepts.
Private columns, server-generated columns such as `id()`, and unknown fields are
compile errors, including fields that a spread carries in. Every update field is
optional, and primary keys and `defaultNow()` or `defaultRandom()` columns
cannot be updated. Bigint columns accept a decimal string or a safe integer.
NaN and positive or negative Infinity fail locally before a write is sent,
including inside JSON values. Use an explicit `null` to clear a nullable column;
a non-finite number never implicitly becomes null. Query numbers must also be
finite.

Skip an update when a form has no changes. An empty update returns
`INVALID_REQUEST` with a `body` detail explaining that at least one field is
required, and the stored row does not change.

The answered row is the public row the database holds after the write.

### Errors

A `DatabaseApiError` has a stable `code`, the HTTP `status`, a `message`, and
`details`. Each detail is a `{ path, message }` pair that names a public request
field. Branch on `code` rather than `message`.

| `code` | `status` | Meaning |
| --- | --- | --- |
| `NOT_EXPOSED` | `null` | No published route for the operation. Nothing was sent |
| `INVALID_REQUEST` | 400 or `null` | Malformed or unsupported parameters. `null` when the client refused them before sending: params that cannot be encoded, or an id of `""`, `"."`, or `".."`, which would resolve to another route |
| `FORBIDDEN` | 403 | The database refused the operation |
| `NOT_FOUND` | 404 | No row has this id |
| `CONFLICT` | 409 | A constraint rejected the change |
| `PAYLOAD_TOO_LARGE` | 413 | The response exceeded the size limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request body was not JSON |
| `VALIDATION_FAILED` | 422 | A value failed validation |
| `TRANSIENT` | 503 or `null` | Temporarily unavailable, or a read received no response |
| `OUTCOME_UNKNOWN` | `null` or a successful HTTP status | A write received no usable response; it may have committed. Check before retrying |
| `INTERNAL` | 500 or other | Any other failure |

## React hooks (beta)

`@databricks/appkit-ui/react/beta` provides React hooks over the
[browser client](#browser-client-beta). They take the same entity, id, and
[parameters](#parameters) as `databaseApi`, need the same
[setup](#setup), and report a failure as the same
[`DatabaseApiError`](#errors) in `error`.

### Read a list

```tsx
import { useDatabaseList } from "@databricks/appkit-ui/react/beta";

function Notes({ boardId }: { boardId: number }) {
  const notes = useDatabaseList("notes", {
    where: { board_id: boardId },
    order: { created_at: "desc" },
    limit: 20,
  });

  if (notes.error) return <p>{notes.error.message}</p>;
  return (
    <ul>
      {notes.data?.items.map((note) => (
        <li key={note.id}>{note.body}</li>
      ))}
    </ul>
  );
}
```

`data` is the list envelope `{ items, limit, offset }`, or `null` until the
first response arrives. To wait for a value the params depend on, pass `null`
as the params; the hook stays idle and sends nothing:

```tsx
const notes = useDatabaseList(
  "notes",
  board ? { where: { board_id: board.id }, limit: 20 } : null,
);
```

`{ enabled: false }` in the third argument also holds the request.

### Paginate

New params start a new request, and `data` is `null` until it answers. For a
paginated list, pass `keepPreviousData: true` to keep showing the previous page
while the next one loads. `loading` stays `true` until it arrives, and a failure
for the new page shows no stale rows.

```tsx
const [offset, setOffset] = useState(0);
const notes = useDatabaseList(
  "notes",
  { order: { id: "desc" }, limit: 20, offset },
  { keepPreviousData: true },
);

<button disabled={notes.loading} onClick={() => setOffset(offset + 20)}>
  Next
</button>;
```

### Read one record

```tsx
import { useDatabaseRecord } from "@databricks/appkit-ui/react/beta";

const board = useDatabaseRecord("boards", boardId, {
  include: { notes: { limit: 20, include: { note_events: { limit: 5 } } } },
});
board.data?.notes[0]?.note_events;
```

Only tables with a public primary key have a detail route, so a keyless table or
a table with a private key is a type error here. A `null` or `undefined` id
holds the hook without a request. A missing row reports `NOT_FOUND`, and a
refetch that finds the row deleted clears `data` rather than showing it beside
the error. An id of `""`, `"."`, or `".."` reports `INVALID_REQUEST` without a
request. To pass options without params, use `{}` for the params:
`useDatabaseRecord("boards", boardId, {}, { keepPreviousData: true })`.

### Request lifecycle

- Hooks that request the same entity with parameters that encode to the same
  query share one request while any of them is mounted. An inline parameter
  object does not refetch on every render.
- `refetch()` aborts the in-flight request and sends it again. The last `data`
  stays visible while it loads and if it fails, except for `NOT_FOUND`.
- The request is aborted once the last hook using it unmounts. Nothing is cached
  after that. A React Strict Mode remount reuses the in-flight request.
- `error` keeps its identity across renders until it changes, so an effect that
  depends on it, such as a toast, runs once per failure.
- A successful write through a write hook restarts mounted reads. See
  [Refresh reads after a write](#refresh-reads-after-a-write).

### Write rows

```tsx
import { useState } from "react";
import { useDatabaseCreate } from "@databricks/appkit-ui/react/beta";

function AddNote({ boardId }: { boardId: number }) {
  const notes = useDatabaseCreate("notes");
  const [body, setBody] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const note = await notes.create({ board_id: boardId, author: "ada", body });
    if (note) setBody("");
  }

  return (
    <form onSubmit={submit}>
      <input value={body} onChange={(event) => setBody(event.target.value)} />
      <button disabled={notes.loading}>Add</button>
      {notes.error && (
        <p>{notes.error.details[0]?.message ?? notes.error.message}</p>
      )}
    </form>
  );
}
```

| Hook | Call | Route | Resolves with |
| --- | --- | --- | --- |
| `useDatabaseCreate(entity)` | `create(values)` | `POST /api/database/<entity>` | The created row, or `null` |
| `useDatabaseUpdate(entity)` | `update(id, values)` | `PATCH /api/database/<entity>/:id` | The updated row, or `null` |
| `useDatabaseDelete(entity)` | `remove(id)` | `DELETE /api/database/<entity>/:id` | `true`, or `false` |

Each hook also returns `loading`, `error`, and `reset()`. The create and update
hooks return `data`, the row the latest call answered with. Like
`useServingInvoke`, a call never rejects: a failure resolves `null` (or `false`
for `remove`) and the `DatabaseApiError` is in `error`, so a handler needs no
`try/catch`. To handle failures as exceptions, call `databaseApi` instead.

A successful call resolves once the reads it restarts have reloaded, and
`loading` stays `true` until then. A handler that clears its form after
`await create(...)` therefore sees the new row already in the lists. A read
that fails to reload does not fail the write. If another write or a manual
refetch supersedes a reload, the waiting call follows the current run of each
read rather than resolving on the cancelled run. Reads with no subscribers
stop holding the write open. After teardown, remounting the same URL creates
a new entry, not part of that write's refresh.

Values follow the same [rules](#values) as `databaseApi.create` and `update`.
Update and delete need a public primary key, like record reads.

### Observe every write

`error` only shows the latest call, and only while a component renders it. To
report every outcome, for example to a toast or an error tracker, pass
`onSuccess` and `onError`:

```tsx
const notes = useDatabaseCreate("notes", {
  onSuccess: (note) => toast(`Added note #${note.id}`),
  onError: (error, values) => report(error, { board: values.board_id }),
});
```

| Hook | `onSuccess` | `onError` |
| --- | --- | --- |
| `useDatabaseCreate` | `(row, values)` | `(error, values)` |
| `useDatabaseUpdate` | `(row, id, values)` | `(error, id, values)` |
| `useDatabaseDelete` | `(id)` | `(error, id)` |

The callbacks run for every call, including one a later call superseded and one
that finishes after the component unmounted, once the hook's state has settled.
`onSuccess` runs after the restarted reads reload. A callback that throws does
not change what the call resolves with; its error is reported as uncaught.
Inline callbacks do not change the identity of `create`, `update`, or `remove`.

### Refresh reads after a write

When a write succeeds, every mounted database read restarts, so lists and
includes that show the changed row refresh without a manual `refetch()`. Each
read keeps its last `data` while it reloads. A failed write restarts nothing.

The default restarts every read because a foreign key declared with
`onDelete("cascade")` can change other tables, and the browser cannot see that.
When a page mounts many reads, pass `invalidate` to restart only the reads that
show the tables you name, or none:

```ts
// A board's title changes only boards rows.
useDatabaseUpdate("boards", { invalidate: ["boards"] });

// Restart nothing. Call refetch() on the reads that need it.
useDatabaseCreate("notes", { invalidate: false });
```

A read shows a table when it is rooted at it or when its `include` reaches it.
The server publishes the relations between exposed tables, so
`invalidate: ["notes"]` also restarts a `boards` read that includes `notes`,
and a `boards` read that includes `notes` and then `note_events`. A read whose
include the server did not describe is restarted by any table list.

A write the hooks did not make, such as a `databaseApi` call or one of your own
routes that changes rows, does not restart reads by itself. Call
`invalidateDatabaseReads` from `@databricks/appkit-ui/react/beta` afterwards. It
takes the same scope as `invalidate`, defaults to every mounted read, and
resolves once the restarted reads have reloaded:

```ts
import { invalidateDatabaseReads } from "@databricks/appkit-ui/react/beta";

await fetch(`/api/boards/${boardId}/archive`, { method: "POST" });
await invalidateDatabaseReads(["boards", "notes"]);
```

### Write lifecycle

- A write is never aborted, even when its component unmounts. Aborting the
  request would not undo a transaction the server already committed.
- A write that succeeds after its component unmounts still restarts reads and
  runs `onSuccess`, because the rows did change.
- Only the latest call updates `data`, `loading`, and `error`. An earlier call
  still resolves for the code that awaits it, with `null` if it failed.
- `invalidate`, `onSuccess`, and `onError` are read when a call settles, so the
  options of the latest render apply.
- `reset()` returns the hook to idle. A call in flight keeps running, but no
  longer updates the hook.
- Writes are not queued or deduplicated. Each call sends its own request, so
  disable the submit control while `loading`.

## API reference

- [`database`](../api/appkit/Function.database.md)
- [`IDatabaseConfig`](../api/appkit/TypeAlias.IDatabaseConfig.md)
- [`DatabaseApiConfig`](../api/appkit/TypeAlias.DatabaseApiConfig.md)
