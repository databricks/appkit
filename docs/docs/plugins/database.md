---
sidebar_position: 5
---

# Database plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

Declare a schema and use `database({ schema })` to get generated HTTP CRUD and a
server-side database client. CRUD is enabled for every declared table by default.
Use `api` to restrict the generated routes without disabling server-side access.

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
checks connectivity during setup; it does not create or migrate tables.

```ts
import { createApp, server } from "@databricks/appkit";
import { database, defineSchema, id, text } from "@databricks/appkit/beta";

const schema = defineSchema((builder) => ({
  notes: builder.table("notes", {
    id: id(),
    body: text().notNull(),
  }),
}));

const AppKit = await createApp({
  plugins: [server(), database({ schema })],
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

## Restrict the generated API

Omitting `api`, or setting it to `true` or `{}`, enables full CRUD. Restrictions
are optional. There is no separate write opt-in.

```ts
// No generated HTTP routes. The server-side client still works.
database({ schema, api: false });

// Read-only routes for every table.
database({ schema, api: { writes: false } });

// Full CRUD for selected tables only.
database({ schema, api: { tables: ["notes"] } });

// Allow reads, create, and update, but not delete.
database({
  schema,
  api: { writes: { operations: ["create", "update"] } },
});

// Read every table, but allow writes only to notes.
database({
  schema,
  api: { writes: { tables: ["notes"] } },
});
```

| Option | Default | Effect |
| --- | --- | --- |
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
  schema,
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

## API reference

- [`database`](../api/appkit/Function.database.md)
- [`IDatabaseConfig`](../api/appkit/TypeAlias.IDatabaseConfig.md)
- [`DatabaseApiConfig`](../api/appkit/TypeAlias.DatabaseApiConfig.md)
- [`EntityHooks`](../api/appkit/TypeAlias.EntityHooks.md)
