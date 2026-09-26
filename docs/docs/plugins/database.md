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
The database tables must already exist and match the declared schema. This plugin
does not create or migrate tables. During setup it checks connectivity and that
every declared table and column exists, and it fails with the missing names
(for example `table public.notes is missing columns board_id, body`) instead of
publishing routes that would fail on every request.

When a query fails at runtime, the client receives only a stable message such as
`Database operation failed`. The server log adds the Postgres text for errors
that name connections, credentials, or schema objects (for example
`column notes.board_id does not exist`), and never for errors that can echo row
values.

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

A table without a public primary key supports list and create only. `upsert` is
available to server code but has no generated HTTP route.

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
configuration without an explicit schema still infers table names and hook payloads.
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
These restrictions apply to HTTP only, not to the server-side client or hooks.

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

## Mutation hooks

A table can declare `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`,
`beforeUpsert`, `afterUpsert`, `beforeDelete`, and `afterDelete`. Hooks and the
mutation run in one database transaction. Related writes through
`ctx.app.database` join that same transaction. This does not make writes through
other plugins or external services transactional.

```ts
import { DatabaseValidationError } from "@databricks/appkit";

database({
  hooks: {
    notes: {
      beforeCreate(values) {
        if (typeof values.body === "string" && values.body.length > 5_000) {
          throw new DatabaseValidationError("Note too long", [
            { path: ["body"], message: "Must be at most 5000 characters" },
          ]);
        }
      },
    },
  },
});
```

A `before*` hook can return replacement values, which are validated again before
persistence. `DatabaseValidationError` produces HTTP 422 with issues limited to
public columns. Other hook failures return an opaque server error.

Keep hooks short and await all database work. A transaction has a 30-second
callback deadline, a shared budget of 100 database operations, and a maximum
mutation nesting depth of 8. Repeating the same entity and mutation operation in
a nested hook chain is rejected. PostgreSQL also enforces a 30-second
`statement_timeout` and a 30-second `idle_in_transaction_session_timeout`.

The callback deadline does not cancel arbitrary JavaScript, HTTP requests, or
other external side effects. Avoid putting external side effects in hooks that
need database rollback semantics.

## Frontend hooks (beta)

`@databricks/appkit-ui/react/beta` provides React hooks that call the generated
routes, and `@databricks/appkit-ui/js/beta` provides the client they use. Entity
names, parameters, and rows are typed from the same generated registry as the
server-side client, restricted to what the generated routes accept. The hooks
add no authorization. Anyone who can load the page can call the same routes.

### Setup

Run `appkit generate-types` or use the AppKit Vite plugin to write
`shared/appkit-types/database.d.ts`, and include it in the client's TypeScript
project. The file binds one set of table entries to both `@databricks/appkit`
and `@databricks/appkit-ui/js/beta`. Until it exists, every entity name is a
type error.

The hooks find routes in the endpoint map the server embeds in the page. When
the `api` configuration does not expose an operation, a call to it fails with
`NOT_EXPOSED` and sends no request.

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
first response arrives. Pass `{ enabled: false }` as the third argument to hold
the request, for example until a value it depends on is known.

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
holds the hook without a request. A missing row reports `NOT_FOUND`.

### Parameters

| Parameter | List | Record | Accepts |
| --- | --- | --- | --- |
| `where` | Yes | No | Public, queryable columns. A value, or an operator object (`eq`, `neq`, `in`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte` by column kind, `is: null` for nullable columns), combined with `and` and `or` |
| `order` | Yes | No | Public, queryable columns mapped to `"asc"` or `"desc"` |
| `select` | Yes | Yes | Public columns. The row type narrows to them |
| `include` | Yes | Yes | Exposed relations, `true` or options, at most two edges deep. Only a to-many relation takes a `limit` |
| `limit`, `offset` | Yes | No | Integers, 0 to 500 and 0 to 10,000 |

Private columns, JSON columns in `where` or `order`, and unknown parameters are
compile errors. A to-many include adds an array to each row and a to-one include
adds a row or `null`. JSON carries bigint columns as decimal strings, so rows
type them as `string`, and filters accept a string or a safe integer.

### Request lifecycle

- Hooks that request the same entity with parameters that encode to the same
  query share one request while any of them is mounted. An inline parameter
  object does not refetch on every render.
- New parameters start a new request, and `data` is `null` until it answers.
- `refetch()` aborts the in-flight request and sends it again. The last `data`
  stays visible while it loads and if it fails.
- The request is aborted once the last hook using it unmounts. Nothing is cached
  after that. A React Strict Mode remount reuses the in-flight request.
- A successful write through a write hook restarts mounted reads. See
  [Refresh reads after a write](#refresh-reads-after-a-write).

### Serializer-shaped reads

A read serializer can change the rows a list or detail route returns. Pass
`shape: serialized<T>()` to type the result as `T`. The entity, id, and
parameters are still checked against the generated registry.

```tsx
import { serialized, useDatabaseList } from "@databricks/appkit-ui/react/beta";

// server: serialize: (row) => ({ ...row, excerpt: String(row.body).slice(0, 80) })
interface NoteView {
  id: number;
  author: string;
  excerpt: string;
}

const notes = useDatabaseList(
  "notes",
  { limit: 20 },
  { shape: serialized<NoteView>() },
);
```

`serialized<T>()` is not checked at runtime. Keep `T` in step with the
serializer.

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

Values accept only the fields the generated route accepts. Private columns,
server-generated columns such as `id()`, and unknown fields are compile errors,
including fields that a spread carries in. Every update field is optional, and
primary keys and `defaultNow()` or `defaultRandom()` columns cannot be updated.
Update and delete need a public primary key, like record reads. Bigint columns
accept a decimal string or a safe integer.

The answered row is the public row the database holds after any `before*` hook
ran. A read serializer never reshapes a write's response.

### Refresh reads after a write

When a write succeeds, every mounted database read restarts, so lists and
includes that show the changed row refresh without a manual `refetch()`. Each
read keeps its last `data` while it reloads. A failed write restarts nothing.

Relations exist only in the generated types, so at runtime the hooks cannot
tell that a `boards` read includes `notes`. That is why the default restarts
every mounted read, not only reads of the written table. To restart only reads
of named tables, or none, pass `invalidate`:

```ts
// Restart only the reads of notes and boards.
useDatabaseCreate("notes", { invalidate: ["notes", "boards"] });

// Restart nothing. Call refetch() on the reads that need it.
useDatabaseCreate("notes", { invalidate: false });
```

A read of `boards` that includes `notes` belongs to `boards`, so
`invalidate: ["notes"]` does not restart it.

A write the hooks did not make, such as a `databaseApi` call or one of your own
routes that changes rows, does not restart reads by itself. Call
`invalidateDatabaseReads` from `@databricks/appkit-ui/react/beta` afterwards. It
takes the same scope as `invalidate` and defaults to every mounted read:

```ts
import { invalidateDatabaseReads } from "@databricks/appkit-ui/react/beta";

await fetch(`/api/cases/${caseId}/sar`, { method: "POST" });
invalidateDatabaseReads(["str_reports", "activity_log"]);
```

### Write lifecycle

- A write is never aborted, even when its component unmounts. Aborting the
  request would not undo a transaction the server already committed.
- A write that succeeds after its component unmounts still restarts reads,
  because the rows did change.
- Only the latest call updates `data`, `loading`, and `error`. An earlier call
  still resolves for the code that awaits it, with `null` if it failed.
- `reset()` returns the hook to idle. A call in flight keeps running, but no
  longer updates the hook.
- Writes are not queued or deduplicated. Each call sends its own request.

### Errors

`error` is a `DatabaseApiError` with a stable `code`, the HTTP `status`, a
`message`, and `details`. Each detail is a `{ path, message }` pair that names a
public request field. Branch on `code` rather than `message`.

| `code` | `status` | Meaning |
| --- | --- | --- |
| `NOT_EXPOSED` | `null` | No published route for the operation. Nothing was sent |
| `INVALID_REQUEST` | 400 | Malformed or unsupported parameters |
| `FORBIDDEN` | 403 | The database refused the operation |
| `NOT_FOUND` | 404 | No row has this id |
| `CONFLICT` | 409 | A constraint rejected the change |
| `PAYLOAD_TOO_LARGE` | 413 | The response exceeded the size limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request body was not JSON |
| `VALIDATION_FAILED` | 422 | A value failed validation |
| `TRANSIENT` | 503 or `null` | Temporarily unavailable, or the request did not reach the server |
| `INTERNAL` | 500 or other | Any other failure |

### Without React

`databaseApi.list`, `get`, `create`, `update`, and `remove` in
`@databricks/appkit-ui/js/beta` take the same entity, id, parameters, and
values as the hooks and return a promise. An optional last argument,
`{ signal }`, cancels the request. Cancelling a write does not undo it if the
server already committed it. Unlike the hooks, they reject with
`DatabaseApiError`, or with the abort reason after a cancel. A write through
`databaseApi` does not restart hook reads; call `invalidateDatabaseReads` when
the screen should refresh.

```ts
import { databaseApi } from "@databricks/appkit-ui/js/beta";

const board = await databaseApi.get("boards", 7, { select: ["id", "title"] });
const note = await databaseApi.create("notes", {
  board_id: board.id,
  author: "ada",
  body: "Ship it",
});
await databaseApi.update("notes", note.id, { body: "Shipped" });
await databaseApi.remove("notes", note.id);
```

A write through `databaseApi` does not restart hook reads. Call `refetch()` on
the reads that show the changed rows.

## API reference

- [`database`](../api/appkit/Function.database.md)
- [`IDatabaseConfig`](../api/appkit/TypeAlias.IDatabaseConfig.md)
- [`DatabaseApiConfig`](../api/appkit/TypeAlias.DatabaseApiConfig.md)
- [`EntityHooks`](../api/appkit/TypeAlias.EntityHooks.md)
