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

Restrict access to the app. If users need different permissions or row ownership
checks, disable the relevant generated routes and implement authorization in
custom server routes. App admission alone does not provide row-level isolation.
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
`config/database/schema.ts` in the Postgres schema `app`, and set
`APPKIT_DB_MIGRATE_ON_START=true` in `app.yaml` so the deployed app applies its
migrations on start. Run `npx appkit db init` once to point `.env` at a branch of
your own, declare your tables, then run `npx appkit db migrate` to create them there
(see [Development workflow](#development-workflow)).

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

Tables live in the Postgres schema `app` unless the second argument of
`defineSchema()` names another one, for example `{ schemaName: "public" }`. The
default is not `public` because the deployed app's service principal creates and
owns `app`, but has no `CREATE` privilege on `public`.

Give each app its own schema. Two apps on one database and one schema share the
migration history, and the second app's service principal cannot change the
tables the first one owns.

### Apps with tables in `public`

Earlier releases put tables in `public` by default. An app that created its
tables there fails setup after the upgrade, and the error says the tables are in
`public`. Keep them there with:

```ts
export const schema = defineSchema(
  ({ table }) => ({
    notes: table("notes", { id: id(), body: text().notNull() }),
  }),
  { schemaName: "public" },
);
```

Migrations applied on start into `public` also need
`GRANT CREATE ON SCHEMA public` to the app's service principal, because it does
not own `public`.

## Development workflow

:::note
`appkit db` is hidden from `appkit --help` while the database development flow is
in beta. Its logic ships in `@databricks/appkit/beta/database-tooling`, which
only the AppKit CLI of the same release imports. It has no semver guarantee.
:::

You develop against a Lakebase branch of your own, never the deployed one. Tables
are created and changed through migrations: generated locally from `schema.ts`,
committed with your code, and applied by the deployed app when it starts.

### Set up your branch

Run `npx appkit db init` once after scaffolding, and again after cloning. Until
`databricks apps init` runs it for you, the scaffolded `.env` points at the branch
you picked in its prompts, usually the branch the app deploys to, and
`npx appkit db verify` warns about that.

`db init` asks nothing:

1. It keeps this checkout's session branch when `.env` points at one, and
   otherwise uses your dev branch, `dev-<you>-<hash>`. It creates the branch when
   it does not exist yet. `--session` uses a branch for this checkout that expires
   after 7 days (`--ttl` changes that), and `--dev` goes back to your dev branch.
2. It makes sure the branch has an endpoint and your Postgres role, points `.env`
   at the branch, and hands you the app schema the fork copied (see
   [One owner per branch](#one-owner-per-branch)).
3. It sets up the schema. With `schema.ts` it runs `migrate`: it writes a
   migration when `schema.ts` changed since the last one, then applies the
   committed migrations. Without `schema.ts`, it writes `schema.ts` from the
   branch's tables (`introspect`).
   `--schema clean` drops the app schema first. Without a terminal,
   `--schema clean` needs `--yes`. `--schema none` only sets up the branch and
   `.env`: it reads no `schema.ts`, hands over no schema, and leaves the schema
   and its owner as the fork copied them.
4. When that needs drizzle-kit and the app does not have it, it installs the
   version AppKit pins as a dev dependency. `migrate` and `introspect` generate
   migrations with it.

`db init` never changes the project's default branch, a protected branch or a
branch `databricks.yml` deploys to, and never edits `databricks.yml`.

:::caution[A new branch copies the default branch]
New branches fork the project's default branch, so they start with a copy of its
rows, production data included. Your role there is a member of
`DATABRICKS_SUPERUSER`, which reads and writes every table on the branch and
bypasses row-level security. Creating a branch needs CAN MANAGE on the Lakebase
project, which also allows deleting any branch, the deploy branch included. Use a
project whose default branch holds only data every developer may see.
:::

### Commands

| Command | What it does |
| --- | --- |
| `npx appkit db init` | Points `.env` at your dev branch, or with `--session` at a branch for this checkout that expires, then sets up the schema. |
| `npx appkit db migrate` | Writes `config/database/migrations/NNNN_migration.sql` when `schema.ts` changed, regenerates `shared/appkit-types/database.d.ts` from `schema.ts`, and applies pending migrations to your branch. |
| `npx appkit db introspect` | Writes `schema.ts` from tables that already exist, and a `0000_baseline` migration (or `NNNN_introspect` when migrations already exist). |
| `npx appkit db clean` | Drops the app schema on your branch; `migrate` then rebuilds it from the migrations. `--delete-branch` deletes your session branch instead. |
| `npx appkit db seed` | Runs `config/database/seed.sql` on your branch in one transaction. |
| `npx appkit db verify` | Read-only check of your branch: missing tables or columns, pending migrations, migrations that will never run there, and migrations it ran that this checkout does not commit. `--deployed` checks a target's deployed app instead. |
| `npx appkit db check` | Offline check of the committed migrations, for CI: their order and files, and no `schema.ts` change without a migration. |

`migrate`, `clean` and `seed` change only branches `db init` created for you (your
dev branch, or this checkout's session branch). A session branch name includes a
hash of the user who created it, so a `.env` copied from another developer does
not make their session branch yours. On any other branch, including the
project's default branch, a protected branch, or a branch `databricks.yml`
deploys to, `clean` and `seed` refuse, and `migrate` only writes the migration
files and `shared/appkit-types/database.d.ts`.

A typical change:

```bash
# edit config/database/schema.ts
npx appkit db migrate            # writes and applies NNNN_migration.sql on your branch
git add config/database          # commit schema.ts with its migrations
databricks apps deploy           # the deployed app applies it on start
npx appkit db verify --deployed  # the app runs, with every committed migration
```

### Branches `databricks.yml` deploys to

`migrate` never applies migrations to a branch that `databricks.yml` deploys to.
It reads every target, every `postgres` resource of every app, the
`postgres_branch` variable, and the files that `include:` names. It also reads
the variable values `databricks bundle` keeps for a target in
`.databricks/bundle/<target>/variable-overrides.json`. A branch named there
counts as well as the one `databricks.yml` names, because a deploy from this
checkout uses the file's value.

If a branch or database reference has no value in those files, `migrate` cannot
tell which branch the reference names. Examples are a target that leaves
`postgres_branch` unset and `${workspace.current_user.short_name}`. While any such
reference exists, `migrate` applies migrations to no branch, and `init`,
`introspect`, `clean` and `seed` refuse every branch. The message names the
target and where the reference is. To continue, give the reference a value in
`databricks.yml`, or in the `variable-overrides.json` the message names. A
`variable-overrides.json` that is not a JSON object stops these commands too.

The check reads only this checkout's files. It does not see values passed at
deploy time with `--var` or `BUNDLE_VAR_*`, or resources defined in Python. It
protects branches from the CLI, and does not replace Lakebase permissions or
protected branches.

### One command at a time

While `migrate`, `introspect`, `clean` or `init` runs, it holds
`config/database/.appkit-db.lock`. Another of these commands in the same
checkout fails and names the process that holds the lock. `seed`, `verify`,
`check` and `clean --delete-branch` change no migration history and take no
lock. The lock goes when the command finishes or exits. `init` holds it for its
whole run, including the clean and migrate it starts. `init --schema none`
changes no migration history, so it takes no lock.

A command stopped by a signal, such as SIGKILL, can leave the file behind. The
next command then names the holder. When that process no longer runs, the
message says the holder stopped. When its pid runs on this machine, the message
says to wait for it. A pid can also belong to an unrelated process, for example
after a reboot reused it. In either case, if no `appkit db` command runs in the
checkout, delete `config/database/.appkit-db.lock` and run the command again.
AppKit never deletes a lock it does not hold. Scaffolded apps list the file in
`.gitignore`.

### Changing tables in use

While a new release migrates on start, instances of the previous release keep
serving, so every migration must work with the code that is still running. A
change that drops or renames a table or column, changes a column's type, or makes
a column required breaks them, and `db migrate` warns when it writes one. Split such a
change over two deploys. First deploy code that works with both the old and the
new schema, with a migration that only adds. Then, in a later deploy, drop what
the old code used.

### Migrations on deploy

When the deployed app starts with `APPKIT_DB_MIGRATE_ON_START=true` in `app.yaml`,
`database()` applies the committed migrations the deploy branch has not recorded
yet, before it checks the tables and serves requests. Apps scaffolded with the
plugin set it; add it to the `env` of an app that predates it:

```yaml
env:
  - name: APPKIT_DB_MIGRATE_ON_START
    value: "true"
```

Migrations run as the app's service principal, one instance at a time, each in
its own transaction. If one fails, it is rolled back, the ones before it stay
applied, and the app does not start. The server log names the migration and the
SQLSTATE, or the missing migration file. An instance waits up to 5 minutes for
another one to finish migrating. A migration that waits more than 5 seconds for a
table lock, for example behind a long transaction of the running app, is rolled
back and retried twice, then fails instead of blocking that table.

`.env` never sets the flag, so a local start (`npm run dev`, `npm start`) never
migrates: use `npx appkit db migrate`. An app pointed at a dev or session branch
does not migrate it on start either.

A `0000_baseline` from `introspect` is recorded without running when its tables
already exist on the deploy branch and no migration was ever applied there. If
only some of them exist, the app does not start, and nothing is changed.

### Existing apps

- **Tables created by hand or by earlier code.** Without `schema.ts`,
  `npx appkit db init` creates your dev branch from the project's default branch and
  introspects it: it writes `schema.ts` from the tables there and a `0000_baseline`
  migration. With a `schema.ts` already, run `npx appkit db introspect` on your
  branch. Commit both files: the deployed app records the baseline without running
  it, because the tables already exist on the deploy branch.
- **Tables in `public`.** Earlier releases used `public` by default. Keep them there
  with `schemaName: "public"`, as [Apps with tables in `public`](#apps-with-tables-in-public)
  shows.
- **No migrate-on-start flag.** Add `APPKIT_DB_MIGRATE_ON_START=true` to `app.yaml`,
  as [Migrations on deploy](#migrations-on-deploy) shows. Without it, the app checks
  its tables on start but creates none.

### Rolling back

Migrations only go forward. There are no down migrations, and the app never undoes
one. Redeploying an older commit leaves the newer tables and their recorded
migrations in place: the app logs that the branch recorded migrations the older
code does not have, applies nothing, and starts. The older code must work with the
newer schema, which [two-step changes](#changing-tables-in-use) guarantee. To undo
a schema change, commit a new migration that reverses it, and deploy it.

### One owner per branch

Each branch has one owner of the app schema, and only the owner can change its
tables:

- On the deploy branch, the app's service principal creates schema `app` on its
  first start and owns everything in it. The `postgres` resource's
  `CAN_CONNECT_AND_CREATE` permission is all it needs; no grants are required.
- On your dev or session branch, you own it. A fork copies its parent's objects
  with their owners, so `db init` hands the app schema to you: it deletes the
  branch's copy of the role that owns it, with its objects reassigned to you.
  `db init --schema none` hands over nothing. Schema `public` is never handed
  over, because it belongs to the database rather than to an app.

Do not apply migrations to the deploy branch yourself: you would own those objects,
and the app could no longer change them. If schema `app` on the deploy branch
already belongs to another role, the app cannot migrate it, and the server log
names both roles. Use another `schemaName` in `defineSchema()`, or have the owner
transfer the schema.

An app that was deleted and created again has a new service principal, and the old
one still owns the schema. Someone with CAN MANAGE on the Lakebase project moves
the objects to the new one, which deletes the old role:

```bash
# Both service principals' roles, by their client IDs
databricks postgres list-roles projects/<project>/branches/<branch>
databricks postgres delete-role projects/<project>/branches/<branch>/roles/<old-role> \
  --reassign-owned-to projects/<project>/branches/<branch>/roles/<new-role>
```

### Verify the deployed app

`npx appkit db verify --deployed` checks a `databricks.yml` target's app through
the Databricks API: the app exists, its `postgres` resource names the target's
branch and database with `CAN_CONNECT_AND_CREATE`, its service principal has a role
on the branch, and the app is running. When the checkout has
`.databricks/bundle/<target>/variable-overrides.json`, the branch and database
come from it, as a deploy from this checkout uses them. It also reads the source
the app's active deployment runs: every committed migration must be there with
the same journal entry and SQL, and the deployment must have no migration this
checkout does not commit. When verify cannot read that source, it fails and
says why.
`-t, --target` picks the target; without it, verify uses the bundle's default
target. When the target's `workspace.host` is not the workspace your shell is
authenticated against, verify refuses and names the profile to set. It needs no
access to the deploy branch's database and changes nothing. A failed check names
`databricks apps logs`, `start` or `deploy`.

### CI

`appkit db init` sets up branches for developers, and CI does not need one. On
every pull request, run the offline check after installing the app's
dependencies:

```bash
npx appkit db check
```

It reads only the checkout, so it needs no Databricks or Lakebase credentials. It
exits 1 when:

- `schema.ts` changed and no committed migration has the change;
- a migration is listed after one generated later, which a branch that ran the
  later one never runs;
- two migrations were generated from the same snapshot on parallel git branches;
- an entry's `idx` is not its position in the journal;
- a migration's `.sql` or snapshot is not committed, a snapshot is not a
  drizzle-kit snapshot, or a `.sql` is not in the journal.

Two pull requests that each add a migration conflict in
`config/database/migrations` once one of them is merged, and keeping both sides
fails the check. Resolve the conflict with the base branch's migrations instead:
merge the base branch, reset `config/database/migrations` to the base branch's,
then run `npx appkit db clean` and `npx appkit db migrate`. `migrate` writes your
change again after the base branch's migrations.

After a deploy, check the deployed app with workspace credentials:

```bash
databricks apps deploy -t prod
npx appkit db verify --deployed -t prod
```

It exits 1 when the app is not running or is bound to another branch, when
verify cannot confirm that its deployment has every committed migration with the
same SQL, and when the deployment has a migration this checkout does not commit.

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

If a server-side read serializer changes a list or detail row, the schema-based
return type cannot describe that custom response. Validate or narrow custom
read results in the caller; the client does not infer serializer output.

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

Skip an update when a form has no changes. If an update remains empty after
`beforeUpdate`, the server returns `INVALID_REQUEST` with a `body` detail
explaining that at least one field is required. An initially empty patch is
still allowed when `beforeUpdate` supplies its values.

The answered row is the public row the database holds after any `before*` hook
ran. A read serializer never reshapes a write's response.

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

### Serializer-shaped reads

A read serializer can change the rows a list or detail route returns. The
`shape` option types the result, and can check it. The entity, id, and
parameters are still checked against the generated registry either way.

To check each row at runtime, pass a function that takes one decoded row and
returns it typed, such as a zod schema's `parse`. It runs once per response, on
each list item or on the record, and its return value becomes the row. If it
throws, the read fails with `INTERNAL`; the thrown error is in `error.cause`,
not in the message, since it may quote row values.

```tsx
import { useDatabaseList } from "@databricks/appkit-ui/react/beta";
import { z } from "zod";

// server: serialize: (row) => ({ id: row.id, excerpt: String(row.body).slice(0, 80) })
const NoteCard = z.object({ id: z.number(), excerpt: z.string() });

const notes = useDatabaseList(
  "notes",
  { limit: 20 },
  { shape: NoteCard.parse },
);
notes.data?.items[0]?.excerpt;
```

Zod 4's `parse` works unbound. For a library whose parse method needs its
schema as `this`, pass an arrow: `shape: (row) => schema.parse(row)`.

To only declare the type, pass `serialized<T>()`. Nothing checks it at runtime,
so keep `T` in step with the serializer.

```tsx
import { serialized, useDatabaseList } from "@databricks/appkit-ui/react/beta";

interface NoteCard {
  id: number;
  excerpt: string;
}

const notes = useDatabaseList(
  "notes",
  { limit: 20 },
  { shape: serialized<NoteCard>() },
);
```

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

The default restarts every read because a [mutation hook](#mutation-hooks) on
the server may write other tables in the same transaction, and the browser
cannot see that. When a page mounts many reads, pass `invalidate` to restart
only the reads that show the tables you name, or none:

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
- [`EntityHooks`](../api/appkit/TypeAlias.EntityHooks.md)
