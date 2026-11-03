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
get a typed database client for server code. To reach the database from the
browser, write named operations. Each operation declares its input, its output,
and who may call it, and the plugin serves it at
`/api/database/operations/<name>`. Without operations, the plugin serves no HTTP
endpoint.

:::caution[The service principal runs every query]
In a deployed Databricks App, the plugin connects to Lakebase as the app's service
principal for every caller. PostgreSQL sees one role, so it cannot tell users
apart and row-level security does not separate them. An operation's `authorize`
is the only check between a signed-in user and the rows its `execute` reads or
writes. Grant the service principal only the database permissions the app needs.
:::

## Basic usage

Configure a Lakebase `postgres` resource and its connection environment variables
as described in [Lakebase configuration](./lakebase.md#environment-variables).

Apps scaffolded with the Database plugin selected include an empty
`config/database/schema.ts`, so `database()` can start without requiring sample
tables. Replace the empty declaration with your tables once they exist in
PostgreSQL. The plugin never creates or migrates tables. At startup, it checks
that every declared table and column exists and fails setup if one is missing.

For local development, the PostgreSQL username is resolved from your Databricks
credentials when `PGUSER` and `DATABRICKS_CLIENT_ID` are absent. An explicitly
configured username takes precedence.

```ts
// config/database/schema.ts
import { defineSchema, fk, id, text, timestamp } from "@databricks/appkit/beta";

export const schema = defineSchema(({ table }) => {
  const notes = table("notes", {
    id: id(),
    author: text().notNull(),
    body: text().notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  });
  const note_events = table("note_events", {
    id: id(),
    note_id: fk(() => notes.id).notNull().onDelete("cascade"),
    action: text().notNull(),
  });
  return { notes, note_events };
});
```

```ts
// server/index.ts
import { createApp, server } from "@databricks/appkit";
import { database } from "@databricks/appkit/beta";

const appkit = await createApp({
  plugins: [server(), database()],
});

const latest = await appkit.database.notes
  .order({ created_at: "desc" })
  .limit(20)
  .toArray();
```

`appkit.database` has one client per declared table, plus `sql` and
`transaction`. Its reads and writes are typed from the generated
`shared/appkit-types/database.d.ts`. It runs as the service principal and checks
no authorization of its own.

When a query fails at runtime, a caller receives only a stable message such as
`Database operation failed`. The server log records the SQLSTATE and only
identifier-only messages for known missing-column or missing-table errors (for
example, `column notes.board_id does not exist`). Other driver messages, details,
and hints are omitted because they may contain row values.

## Schema discovery and overrides

During setup, `database()` loads the discovered routes registry's schema. Without
a registry, it loads the named `schema` export from `config/database/schema.ts`,
relative to the application's working directory.
The file must export a finalized `defineSchema()` result. Missing files, import
failures, and invalid exports fail setup before the plugin creates a connection
pool; they never fall back to an empty schema.

Without a compiled routes registry or an explicit schema, keep
`config/database/schema.ts` and its local imports in your deployment. The
plugin loads TypeScript through Jiti, so a plain Node production process does not
need a separate TypeScript loader. The schema module should only declare tables,
not connect to the database or start the app.

For a different layout, or a deployment that contains only a server bundle,
import the schema and pass it to the plugin:

```ts
import { schema } from "../config/database/schema";

database({ schema });
```

An explicit schema skips schema file discovery. Operations in the conventional
directory still load unless `routes: false` disables them. With an explicit
[`routes` registry](#serve-the-operations), a `schema` passed beside it must be
the same object the registry loads, or setup fails.

## Connection pool

The plugin keeps one pool of up to 105 connections, the whole direct-connection
budget of a 0.5 CU compute, the smallest size. Other pools on the same compute,
such as `lakebase()`, every replica of the app, and any other client share that
budget, so lower `max` until the sum fits. Larger computes allow more. Check
**Max Connections** in the compute's *Edit compute* drawer.

```ts
database({ pool: { max: 20, connectionTimeoutMillis: 5000 } });
```

Only `max`, `idleTimeoutMillis`, and `connectionTimeoutMillis` can be set.
When callers queue because every connection is in use, the plugin logs a
warning at most once a minute.

## Operations

An operation is one named database action that the browser may call. It
declares the entity it works on, its HTTP method, its input and output, an
`authorize` rule, and an `execute` function.

### Define an operation

Write operations in modules under `server/database/routes/`. Each exported
`defineOperation()` result is an operation, and other exports are ignored.

```ts
// server/database/routes/notes.ts
import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { noteAuthor, signedIn } from "../policies";

export const listNotes = defineOperation({
  name: "notes.list",
  entity: "notes",
  method: "GET",
  input: z.object({ limit: z.number().int().max(100) }),
  output: z.array(
    z.object({ id: z.number(), author: z.string(), body: z.string() }),
  ),
  authorize: signedIn,
  execute: ({ db, input }) =>
    db.notes.order({ created_at: "desc" }).limit(input.limit).toArray(),
});

export const createNote = defineOperation({
  name: "notes.create",
  entity: "notes",
  method: "POST",
  input: z.object({ body: z.string().trim().min(1) }),
  authorize: signedIn,
  execute: ({ actor, db, input }) =>
    db.transaction(async (tx) => {
      const note = await tx.notes.create({ author: actor.id, body: input.body });
      await tx.note_events.create({ note_id: note.id, action: "created" });
      return note;
    }),
});

export const updateNote = defineOperation({
  name: "notes.update",
  entity: "notes",
  method: "PATCH",
  input: z.object({ id: z.number().int(), body: z.string().trim().min(1) }),
  authorize: noteAuthor,
  execute: ({ db, input }) => db.notes.update(input.id, { body: input.body }),
});
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The name the browser calls, one URL segment. Parts of letters, digits, `_`, and `-`, each starting with a letter, joined by dots. At most 64 characters per part and 255 in total. `constructor` and `prototype` are reserved |
| `entity` | Yes | The declared table the operation works on. It types the default output |
| `method` | Yes | `GET`, `POST`, `PATCH`, `PUT`, or `DELETE`. The operation answers only this method |
| `input` | No | A Zod schema for accepted parameters. Omit it for no parameters; callbacks receive `undefined` |
| `output` | No | A Zod schema for the answer. The plugin parses what `execute` returns and sends only that |
| `authorize` | Yes | A function or a [policy](#authorize-an-operation) that admits the caller |
| `execute` | Yes | Does the work and returns the answer |

Omitting `input` means the operation accepts no parameters. Declare a schema
whenever it needs an ID, filters, or write values. There is no input inferred
from the entity or HTTP method, and no need for `input: z.object({})` on lists.
Unexpected parameters are rejected before authorization; an empty object is
also accepted and normalized to `undefined`.

```ts
export const countNotes = defineOperation({
  name: "notes.count",
  entity: "notes",
  method: "GET",
  output: z.number(),
  authorize: signedIn,
  execute: ({ db }) => db.notes.count(),
});
```

Without `output`, the entity and method determine the response:

| Method | Default output |
| --- | --- |
| `GET` | The public row, or 404 when `execute` returns `null` |
| `POST` | The created public row, with status 201 |
| `PATCH` | The updated public row, or 404 for `null` |
| `PUT` | The updated public row, or 404 for `null` |
| `DELETE` | No body, status 204. `false` from `execute` answers 404 |

A default output carries a `bigint` as a decimal string and a timestamp as
RFC 3339 text, such as `2024-01-01T10:00:00+00:00`. Explicit input schemas
control how incoming values are validated and converted. Keep server-owned
values, such as the caller's identity, out of those schemas.

`execute` and `authorize` receive one context:

| Field | Meaning |
| --- | --- |
| `actor` | The verified caller, `{ id, email? }`. See [Caller identity](#caller-identity) |
| `input` | The parsed input, or `undefined` when there is no input schema |
| `db` | The same client as `appkit.database` |
| `appkit` | Every plugin's exports, as `createApp` returns them |
| `resource` | The value a resource policy loaded, otherwise `undefined` |

The context carries no request, headers, or user token. Use an explicit nullable
`output`, such as `z.object({ ... }).nullable()`, for a `GET` that may answer
`null` with status 200.

When a custom `output` declares literal values, such as `z.literal("ok")` or
`z.enum(["open", "closed"])`, a hand-written literal that `execute` returns
needs `as const`. Without it, TypeScript widens `"ok"` to `string`, and the
operation does not compile:

```ts
execute: async () => ({ status: "ok" }) as const,
```

### Authorize an operation

`authorize` runs after the plugin has verified the caller, and before `execute`.
A function receives the context without a resource:

```ts
authorize: ({ actor, input }) => input.owner === actor.id,
```

To share a rule between operations, define it once with `definePolicy`. A
policy with a `resource` function loads one value, such as the row the input
names. `allow` then decides with that value, and `execute` receives it as
`resource`:

```ts
// server/database/policies.ts
import { definePolicy, type PolicyContext } from "@databricks/appkit/beta";

/** Any signed-in user. Without one, the plugin has already answered 401. */
export const signedIn = definePolicy({ allow: () => true });

/** The note `input.id` names, for its author only. */
export const noteAuthor = definePolicy({
  resource: ({ db, input }: PolicyContext<{ readonly id: number }>) =>
    db.notes.find(input.id),
  allow: ({ actor, resource }) =>
    resource.author === actor.id ? true : { deny: "forbidden" },
});
```

Annotate the `resource` context with the input fields the policy reads. Any
operation whose input has those fields can use the policy, and one that lacks
them is a type error.

A policy's resource is a snapshot loaded before `execute`; it does not lock
the row or make a later write atomic. Enforce conditions that can change during
a write, such as a case remaining open or an account retaining its balance,
inside the write transaction using a locked read, a conditional write, or a
database constraint. Related writes and their audit record belong in the same
transaction. Use database-generated identifiers instead of `count() + 1` when
multiple callers can create records concurrently.

| The rule | The plugin answers |
| --- | --- |
| Returns `true` | Runs `execute`. Only the literal `true` admits |
| Returns `false` | 403, or 404 for a resource policy |
| Returns `{ deny: "forbidden" }` | 403 |
| Returns `{ deny: "not-found" }` | 404 |
| `resource` returns `null` or `undefined` | 404, and `allow` does not run |
| Throws | 403, or 404 for a resource policy |

A denial may carry a `reason` for your own tests. The plugin never sends it or
logs it. `execute` runs at most once, and only after `authorize` admitted.

### Serve the operations

The AppKit Vite plugin and `appkit generate-types` find the modules directly in
`server/database/routes/`, except `*.test.ts`, `*.d.ts`, and `*.gen.ts` files.
The Vite plugin runs when the dev server starts, and whenever a file in
`config/database/` or `server/database/routes/` changes. Both write two files:

- `server/database/routes.gen.ts`, the registry: the schema and each routes
  module, loaded lazily.
- `shared/appkit-types/database-operations.d.ts`, the browser contract: each
  operation's method and the JSON types of its input and output.

Commit both. The plugin discovers the registry automatically:

```ts
// server/index.ts
import { createApp, server } from "@databricks/appkit";
import { database } from "@databricks/appkit/beta";

await createApp({
  plugins: [server(), database()],
});
```

There are three ways to configure operation discovery:

```ts
database(); // discover server/database/routes/ through routes.gen.ts
database({ routes: false }); // server-side database access only
database({ routes: customRoutes }); // use an explicit registry instead
```

Without any routes, the plugin serves no HTTP endpoint. Outside development,
if the directory exists but its generated registry is missing, setup fails with instructions to run
`appkit generate-types`.

An app with a declared database schema gets an empty registry and empty operation
contracts before its first operation. In the standard `pnpm dev` workflow, setup
regenerates the source registry before loading it, and `tsx watch` tracks its
imports. Saving an operation, policy, schema, or shared DTO under
`server/database/` or `config/database/` updates the generated contracts and
reloads the backend. Adding or removing the first or last operation works the
same way. Generated files do not trigger their own type-generation pass.
Production startup never runs generation.

The standard `appkitServerConfig()` server build includes the generated
registry, schema, and operation modules automatically. Plain Node loads the
compiled registry beside the server entry, such as `dist/database/routes.gen.js`,
without TypeScript sources. A custom server build must include the registry as
an entry beside its server, using the same file extension, or import it and pass
it explicitly with `database({ routes: databaseRoutes })`.

Setup loads every listed module and validates each operation before the plugin
opens a connection. A malformed declaration or a repeated name fails setup. An
operation without `authorize` is not served; setup logs a warning that names
its file and export, and a production build (`NODE_ENV=production`) fails
generation instead. With `routes: false`, the plugin registers no HTTP endpoint.

An explicit schema must have an exact JSON type. Strings, numbers, booleans,
`null`, literals, enums, arrays, objects, records with string keys, unions, and
`z.unknown()` qualify, including their optional, nullable, and default forms. A
schema without one, such as `z.date()`, `z.tuple()`, `z.json()`, a transform, or
an input that coerces or preprocesses its value, fails generation with a message
that names the operation.

### Endpoints

Each operation answers one method at `/api/database/operations/<name>`:

- A `GET` carries its input as one URL-encoded JSON parameter:
  `/api/database/operations/notes.list?input=%7B%22limit%22%3A20%7D`. The query
  string is limited to 8 KiB.
- Other methods take a JSON body of at most 1 MiB, and no query parameters.
- A success answers 200, or 201 for `POST`, or 204 with no body.
- An unknown name, or a method the operation does not declare, answers 404.
- Without a verified caller, every request answers 401, before the plugin reads
  its input.
- A browser request from another origin answers 403.
- Every response carries `Cache-Control: no-store`.

A failure answers `{ "error": "<stable message>" }`. An input that fails its
schema also carries `details`, a list of `{ path, message }` pairs that name the
input field without its value. Paths include declared property names and array
indices; dictionary keys and unknown fields are not echoed. Messages use stable
descriptions such as `Must not be empty` or `Invalid format`, rather than raw
Zod or custom refinement messages. A form can associate these details with its
fields without displaying submitted values from an error.

### Caller identity

The plugin verifies the caller on every request, and selects how once, from the
deployment:

- In Databricks Apps (`DATABRICKS_APP_NAME` is set and `NODE_ENV` is not
  `development`), the user token the Apps proxy forwards is checked with the
  workspace. A rejected token, an inactive user, or a service principal answers
  401. The forwarded user and email headers are not trusted.
- In local development (`NODE_ENV=development`, with `DATABRICKS_TOKEN` or
  `DATABRICKS_CONFIG_PROFILE`), the caller is the developer those credentials
  sign in. Only same-origin requests to a loopback address are accepted. Set
  `APPKIT_DEV_OBO=false` to turn this off.
- Anywhere else, every operation answers 401, and setup logs a warning.

`actor.id` is the workspace user ID, and `actor.email` is the user name when the
workspace reports one. The user's token is never used for the database
connection.

## Transactions

A root write outside `database.transaction()` uses the connection pool directly.
Related writes belong in one explicit transaction. The callback receives a
transaction client with the same entity methods and `sql` tag. A later
`transaction()` call inside that callback joins the open transaction instead of
opening another one. A root write made while the callback is running also joins
it, and keeps the predicate from the query that issued the write. A read or an
`sql` call made on the root client does not join.

The `notes.create` operation above writes a note and its event this way. If the
event cannot be written, the note is not written either, and the caller
receives the failure.

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

## Private columns

A column declared with `.private()` stays on the server. Server code, including
`execute`, can read and write it, but a default output never includes it. An
explicit `output` answers only the fields its schema names, so list the public
fields you mean to send. For example, `execute` can store the caller's email
from `actor.email` in a private column that no input accepts and no output
returns.

## Browser client (beta)

`@databricks/appkit-ui/js/beta` provides `databaseApi`, which calls an
operation by name:

```ts
import { databaseApi } from "@databricks/appkit-ui/js/beta";

const count = await databaseApi.execute("notes.count");
const notes = await databaseApi.execute("notes.list", { limit: 20 });
await databaseApi.execute("notes.update", { id: 7, body: "Shipped" });
```

Names, inputs, and outputs are typed from
`shared/appkit-types/database-operations.d.ts`, so include it in the client's
TypeScript project. The URL and method come from what the server published in
the page, so a name the server does not serve fails with `NOT_EXPOSED` and
sends no request. A failed call rejects with a [`DatabaseApiError`](#errors).
An optional third argument, `{ signal }`, cancels the request, and the promise
then rejects with the abort reason. Cancelling a write does not undo it if the
server already committed it. For an operation without parameters, call
`execute(name)` or `useDatabaseQuery(name)`, and `mutate()` for a mutation.
Pass `undefined` in the input position when supplying request or query options.

## React hooks (beta)

`@databricks/appkit-ui/react/beta` provides one hook for `GET` operations and
one for every other method. Both take an operation name and are typed from the
same generated file as `databaseApi`.

### Read

```tsx
import { useDatabaseQuery } from "@databricks/appkit-ui/react/beta";

function Notes() {
  const notes = useDatabaseQuery("notes.list", { limit: 20 });

  if (notes.error) return <p>{notes.error.message}</p>;
  return (
    <ul>
      {notes.data?.map((note) => (
        <li key={note.id}>{note.body}</li>
      ))}
    </ul>
  );
}
```

`useDatabaseQuery(name, input, options?)` returns `data`, `isLoading`, `error`,
and `refetch()`. `data` is `undefined` until the first answer arrives. Pass
`{ enabled: false }` to hold the request, for example until a value the input
needs has loaded.

For dependent queries, pass `skipToken` until the complete typed input exists:

```tsx
import { skipToken, useDatabaseQuery } from "@databricks/appkit-ui/react/beta";

const alert = useDatabaseQuery(
  "alerts.get",
  selectedId === null ? skipToken : { id: selectedId },
);
```

A skipped query has no data or error, is not loading, and `refetch()` does
nothing. Switching to `skipToken` aborts an in-flight read and ignores its late
answer. `skipToken` is accepted only by the query hook; client calls and
mutations still require their declared payloads.

- An equal input on a later render keeps the request in flight. A new input
  aborts it and clears `data` and `error`.
- `refetch()` sends the request again and keeps `data` visible while it loads.
- Each hook sends its own request. Nothing is shared or cached between hooks,
  and unmounting aborts the request.

### Write

```tsx
import { useState } from "react";
import { useDatabaseMutation } from "@databricks/appkit-ui/react/beta";

function AddNote() {
  const createNote = useDatabaseMutation("notes.create");
  const [body, setBody] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const { error } = await createNote.mutate({ body });
    if (error === null) setBody("");
  }

  return (
    <form onSubmit={submit}>
      <input value={body} onChange={(event) => setBody(event.target.value)} />
      <button disabled={createNote.isLoading}>Add</button>
      {createNote.error && <p>{createNote.error.message}</p>}
    </form>
  );
}
```

`useDatabaseMutation(name)` sends nothing until you call `mutate(input)`. It
returns `mutate`, `data`, `isLoading`, `error`, and `reset()`.

- `mutate` resolves `{ data, error }`, where `error` is `null` exactly when the
  write succeeded. It never rejects, so a handler needs no `try/catch`.
- A write is never retried and never aborted, even when its component
  unmounts, because the server may have committed it.
- A successful write restarts every mounted `useDatabaseQuery`, which keeps its
  `data` visible while it reloads. An operation can change any row, so every
  query restarts.
- Only the latest call updates `data`, `isLoading`, and `error`. `reset()`
  returns the hook to idle.
- Changing the operation name returns the hook to idle too. Earlier writes
  finish and refresh queries, but their results never populate the newly
  selected operation, including when switching back to the original name.
- Writes are not queued or deduplicated. Disable the submit control while
  `isLoading`.

Use the query and mutation hooks for database state rendered by React. They
handle input changes, session changes, cancellation of reads, and refresh after
writes. Use `databaseApi.execute()` for imperative callers; a response stored
in your own component state needs its own request-identity and refresh handling.

### Session changes

Every answer names its caller. When an answer shows that a different user is
signed in, or a 401 shows that the session ended, every query drops its data
and asks again, and every mutation returns to idle. An answer that arrives
afterwards for the earlier caller fails with `SESSION_CHANGED` instead of
showing that caller's data.

## Errors

A `DatabaseApiError` has a stable `code`, the HTTP `status`, a `message`, and
`details`. Branch on `code` rather than `message`.

| `code` | `status` | Meaning |
| --- | --- | --- |
| `NOT_EXPOSED` | `null` | The server does not serve this operation, or the hook takes another kind. Nothing was sent |
| `UNAUTHENTICATED` | 401 | No verified caller |
| `INVALID_REQUEST` | 400 or `null` | The input failed its schema. `null` when the client could not encode it and sent nothing |
| `FORBIDDEN` | 403 | `authorize` refused, the request came from another origin, or the database refused |
| `NOT_FOUND` | 404 | No such operation for this method, a resource policy found nothing, or `execute` answered `null` |
| `CONFLICT` | 409 | A constraint rejected the change |
| `PAYLOAD_TOO_LARGE` | 413 | The request body exceeded its limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request body was not JSON |
| `VALIDATION_FAILED` | 422 | A value failed the schema's validation |
| `TRANSIENT` | 503 or `null` | Temporarily unavailable, or a read received no response |
| `SESSION_CHANGED` | `null` | The answer belongs to an earlier session. A write may have completed |
| `OUTCOME_UNKNOWN` | 500, `null`, or a successful status | A write may have committed without a usable answer, for example when it failed after `execute` ran. Check before retrying |
| `INTERNAL` | 500 or other | Any other failure |

## API reference

- [`database`](../api/appkit/Function.database.md)
- [`IDatabaseConfig`](../api/appkit/TypeAlias.IDatabaseConfig.md)
