# 001 - Database development flow

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Victor Ditadi |

The [Google Doc](https://docs.google.com/document/d/1bsMsYsTfoFBSYS3YbXn3FvOOUQl21X829Z4u1I-fBzg/edit) is the copy for comments and edits. Changes there are synced to this file.

## Background and Motivation

The DatabasePlugin (`@databricks/appkit/beta`, shipped in v0.87 and v0.88) provides typed server access to Lakebase
Postgres from `config/database/schema.ts`. The earlier beta exposed generated CRUD routes. The operation design in
[#687–#692](https://github.com/databricks/appkit/pull/692) replaces those routes with explicitly authorized, named
operations. Table declarations alone expose no HTTP endpoint.

This design covers branch ownership, migrations and deployment. Its application-facing examples target that operation
design. The migration implementation in #654–#678 and the operation implementation in #687–#692 are separate PR
chains; integrating them is required before both flows ship together. The operation stack alone checks existing tables
at startup and never creates or migrates them. This design adds the opt-in migration step before that check.

The migration problem starts with the manual workflow of the earlier beta:

| Step | Earlier beta workflow |
|---|---|
| Pick a database | `databricks apps init` asks for a Lakebase project, branch and database. The plugin is `hidden: true`, so only apps that add it by hand get this far. |
| Develop locally | `.env` points at the branch the app deploys to. Every developer reads and writes production rows. |
| Create a table | Run DDL by hand, then declare the table in `schema.ts`. The plugin's startup check fails until both match. |
| Permissions | The app's service principal has no `CREATE` on `public`. Someone grants it, or creates the tables as another role and grants access. |
| Change a table | Run `ALTER` by hand on every branch that needs it, in the right order, and remember which branches already have it. |
| Review | Schema changes are not in the pull request. Reviewers see `schema.ts` only. |
| Deploy | Nothing ties a code deploy to the schema it needs. A missing column surfaces as the app failing its startup check. |

Lakebase sets the constraints any design has to live with:

- A branch fork copies its parent's data, its roles, and its objects with their owners. Role state is per branch.
- `GRANT ... TO databricks_superuser` is rejected. A custom `NOLOGIN` role can own app objects, and its members get
  owner rights, but someone with `ADMIN OPTION` on it has to grant it to each new identity.
- On `public`, only `pg_database_owner` and `databricks_superuser` have `CREATE`. A role with `CREATE` on the
  database can create and own a schema of its own.
- A role is created and deleted through the Lakebase role API. Deleting a role can reassign what it owns
  (`reassign_owned_to`).
- A project holds 500 branches, archived ones included, and an internal quota of 25 unarchived branches
  ([LKB-15175](https://databricks.atlassian.net/browse/LKB-15175)). 20 computes run at once outside the default
  branch.
- The pooled endpoint is not available to OAuth roles and runs PgBouncer in transaction mode, which has no advisory
  locks. Apps connect to the direct endpoint.

Apps and Genie App Builder set three more:

- A horizontally scaled app rolls a deploy to one instance first while the others keep serving, up to five instances.
- Removing a database resource from an app hands the service principal's objects to the app manager. Re-adding it
  restores database access but not object ownership, so the next deploy fails with `permission denied for schema`
  ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463)).
- Genie App Builder builds on AppKit. Its apps scale to zero after 30 idle minutes, so start runs on every cold start,
  and they deploy from the UI with no CI step.

The stack below this design was built and verified against a Lakebase project with a throwaway deploy branch and app.
Its PR descriptions record the live results.

## Goals

1. From `databricks apps init` to a deployed app with one table, a developer runs no SQL, grants nothing and opens no
   console. The stack builds this flow and keeps it hidden. The reveal, a later change that offers the plugin in
   `apps init`, meets this goal.
2. Each developer works on a Lakebase branch of their own. Only the deployed app changes the branch it deploys to.
3. Schema changes are committed as SQL migrations and reviewed with the code that needs them.
4. A deploy applies exactly the migrations its commit carries, or fails before serving with a message that names the
   migration and the fix.
5. Every command that writes refuses a branch it was not built for, before it connects.

## Out of Scope

- Down migrations and automatic schema rollback. Fixes go forward.
- Per-user Postgres connections (OBO). Operations verify the caller and authorize access in application code; the
  database connection and migrations still run as the app's service principal.
- Several apps sharing one Postgres schema.
- drizzle-kit v1's migration folder format. This design ships on drizzle-kit 0.31 (journal v7).
- Seeding or copying data into the deploy branch.
- Migrations that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`).

## Product Decisions

### The schema lives in TypeScript, and migrations are committed SQL

`config/database/schema.ts` stays the source of truth. `appkit db migrate` writes drizzle-kit output under
`config/database/migrations/`: one `NNNN_<name>.sql` per change, a `meta/NNNN_snapshot.json` per migration and
`meta/_journal.json`. The SQL is what reviewers read and what the deployed app runs.

### Browser access is an authored operation contract

A table declaration describes storage and typed server access. Each browser capability is a `defineOperation` export
in `server/database/routes/*.ts`, with a name, entity, HTTP method, authorization and an execute callback. The plugin
serves it at `/api/database/operations/<name>`. An operation without authorization is skipped with a warning in
normal generation and fails production generation. Malformed or duplicate operations fail setup.

```ts
// server/database/routes/notes.ts
import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

export const listNotes = defineOperation({
  name: "notes.list",
  entity: "notes",
  method: "GET",
  output: z.array(z.object({ id: z.number(), body: z.string() })),
  authorize: () => true, // Any verified caller; use a policy for narrower access.
  execute: ({ db }) => db.notes.select(["id", "body"]).toArray(),
});

export const getNote = defineOperation({
  name: "notes.get",
  entity: "notes",
  method: "GET",
  input: z.object({ id: z.number().int() }),
  authorize: () => true,
  execute: ({ db, input }) => db.notes.find(input.id),
});
```

Omitting `input` means the operation accepts no parameters and authorization/execute receive `undefined`. The client
calls `useDatabaseQuery("notes.list")`; it needs no empty `z.object({})` or placeholder argument. Explicit input
schemas determine required caller input, such as `useDatabaseQuery("notes.get", { id: 123 })`. No input is inferred
from a method, primary key or table's writable columns.

Output defaults stay independent of input:

| Method | Output when `output` is omitted |
|---|---|
| `GET` | One public row, or 404 when the callback returns `null`. |
| `POST` | The created public row, with status 201. |
| `PATCH`, `PUT` | The updated public row, or 404 for `null`. |
| `DELETE` | Status 204 with no body when the callback returns `true`. |

A list, aggregate, nullable result or joined response declares its output schema. An `{ id }` input does not determine
whether the result is one row or an array. Private columns are omitted by default; explicit outputs project only the
fields they declare, so developers review them as part of the public contract.

### Conventional routes need no server-entry import

The usual setup is `database()`. It discovers the generated registry for `server/database/routes/`; the developer
does not import `routes.gen.ts` in the server entry. Two explicit alternatives cover the other cases:

```ts
database();                        // Conventional schema and operation discovery.
database({ routes: false });       // Server-side database access only.
database({ routes: customRoutes }); // An explicit registry.
```

The app commits these generated files with its declarations:

| File | Purpose |
|---|---|
| `shared/appkit-types/database.d.ts` | Typed server entity access. |
| `server/database/routes.gen.ts` | Lazy schema and operation imports for the server build. |
| `shared/appkit-types/database-operations.d.ts` | Browser-safe operation names, methods, inputs and outputs. |

`appkit generate-types` and the AppKit Vite plugin generate the operation registry and browser contracts. A declared
schema with no operation files gets an empty registry, so adding the first operation and removing the last one remain
part of the same development flow. With neither schema nor routes, no operation files are created.

In development, setup regenerates the source registry before importing it. Vite watches `config/database/` and all of
`server/database/`, including shared row schemas, helpers and policies outside `routes/`. Generated `.gen.ts` and
`.d.ts` files do not trigger generation loops. Native source imports let `tsx watch` reload backend changes and route
additions/deletions. This is code and type generation; it never applies a database migration.

`appkitServerConfig()` includes the registry, schema and operation modules in the server build. Production loads the
compiled registry beside the server entry and generates nothing at runtime. A custom build includes those entries or
imports and passes its own registry. A missing or malformed registry fails setup before the pool opens.

### Policies admit requests; transactions enforce mutable rules

Operations verify the caller before reading input or running authorization. `execute` receives `{ actor, input, db,
appkit, resource }`, without request headers or access tokens. A verified actor is distinct from the service principal
that owns the database connection. The operation's policy is responsible for which rows that caller may use.

A policy resource is a snapshot loaded before `execute`, not a lock or a transaction-scoped guarantee. A business
condition that can change during a write must be checked atomically inside the transaction, through a locked read,
a conditional update, or a database constraint. For example, adding a note to an open case must serialize with case
closure. A uniqueness constraint enforces one open case per subject across every writer, and a sequence or other
database-generated identifier avoids the race in `count() + 1`.

The business write and its audit entry belong in one `db.transaction()` callback. Use the verified actor for audit
attribution, and persist fields the operation accepts, such as a dismissal reason, with the state change. Migration
SQL installs the constraints, sequences or triggers needed for these rules; a policy does not replace them.

### React reads and writes share operation-aware state

Use `useDatabaseQuery` for rendered data and `useDatabaseMutation` for writes. They are exported from
`@databricks/appkit-ui/react/beta` and typed by the generated operation contracts. The imperative
`databaseApi.execute` remains available from `@databricks/appkit-ui/js/beta`; callers that store its result in React
state must handle cancellation, request identity, session changes and refresh themselves.

```tsx
import { skipToken, useDatabaseQuery } from "@databricks/appkit-ui/react/beta";

const notes = useDatabaseQuery("notes.list");
const selectedNote = useDatabaseQuery(
  "notes.get",
  selectedId === null ? skipToken : { id: selectedId },
);
```

`skipToken` holds a dependent query idle until its complete typed input exists. It sends nothing, aborts an old read,
clears its displayed result, and makes `refetch()` a no-op. Only query hooks accept it; imperative calls and mutations
still require their declared input.

Changing a query's name, input or session clears its old result and ignores late answers. Changing a mutation's
operation name or session clears its displayed state, including A → B → A switches. Earlier writes still finish. In
the same session, their success or unknown outcome refreshes queries without populating a renamed hook.

A mutation is sent at most once and is never retried or aborted. Its hook resolves each call with `{ data, error }`.
Mounted queries refresh after success or an unknown write outcome; a hook-based write needs no duplicate manual
refetch. Clear a draft only after success, and keep it visible with field feedback on a validation failure. Invalid explicit inputs return bounded
`details: [{ path, message }]` with schema-declared property names, array indices and standard messages. Raw Zod or
custom refinement text, submitted values and undeclared property names are never exposed.

### Every developer gets a Lakebase branch

`appkit db init` forks the project's default branch into one of two kinds:

- `dev-<user>-<hash6>`, one per developer, no expiry, the same name on every machine.
- `session-<hash6>-<id>`, one per checkout, with a 7-day TTL. The id lives in `.env` as `APPKIT_DB_SESSION`.

The user name is the `userName` that `currentUser.me` returns, an email for a person or the application ID for a
service principal. `<hash6>` is the first six hex characters of the SHA-256 of that name, trimmed and lowercased, so a
branch name says whose it is. `<user>` is the part of the name before `@`, lowercased. Each run of characters other
than `a-z` and `0-9` becomes one `-`, leading and trailing `-` go, and it is cut to 52 characters so the branch id stays
within Lakebase's 63. It is `user` when nothing is left. Init generates `<id>` once per checkout as 8 random characters
from `a-z0-9`. An `APPKIT_DB_SESSION` set by hand must be 1 to 48 lowercase letters or digits.

The developer gets a Postgres role with `DATABRICKS_SUPERUSER` on that branch, and owns the app's objects there.
`.env` then points at the branch. When `databricks.yml` binds a database that the fork does not have, init refuses and
names the database and the branch, instead of pointing `.env` at `databricks_postgres`.

A Lakebase fork copies every row of its parent. A branch that init creates still starts with no copied app rows. In the
run that created it, init drops the fork's app schema and rebuilds it from the committed migrations, which is what
`--schema clean` does. Without a `schema.ts`, it introspects the fork first and rebuilds from the baseline that
introspect writes. Reusing an existing dev or session branch keeps its rows, and init applies only what the branch has
not recorded. Keeping production rows on a new fork is an explicit opt-in, `--schema migrate`. See Security
Considerations for what the rebuild does not remove.

Branches count against the project's limits, so init keeps them cheap. It creates the branch's endpoint with a
5-minute scale to zero, because an idle compute counts against the 20 active ones. When the project is at its branch
limit, init stops before creating anything and lists your other branches with the command that deletes them. With the
quota of 25, a project holds the deploy branch and about 20 developers with one branch each, fewer when they also keep
session branches. The 20 active computes cap how many of them work at the same time.

CI needs no branch, because `appkit db check` runs offline. A CI job that wants a live branch runs
`appkit db init --session --ttl 1h` and deletes it at the end with `appkit db clean --delete-branch`.

### The deployed app applies its migrations when it starts

The app applies the committed migrations its deploy branch has not recorded, as its service principal, before it
serves. Developers never migrate the deploy branch. This is the only option that keeps one owner per branch with no
extra resource to deploy. See the architecture decision below.

### Tables default to the Postgres schema `app`

`defineSchema()` without `schemaName` puts tables in `app`. The service principal creates and owns `app` on its first
start, so the first deploy needs no grant. `{ schemaName: "public" }` keeps working for apps that already use it, but
migrations on start cannot create objects there without a manual `GRANT CREATE ON SCHEMA public`.

### Migration opt-in preserves existing beta startup behavior

An app that upgrades from v0.88 does not start migrating, because the deploy flag below is off unless the app's
`app.yaml` sets it. If the startup check finds every missing table in `public`, its error says the default moved to
`app` and offers `{ schemaName: "public" }`. With migrate on start and no `schemaName`, startup refuses before it
applies anything when some declared tables exist in `public` and none exist in `app`. Otherwise an upgraded app would
create empty tables in `app` and serve them. `appkit db migrate` refuses the same case. Both errors say to set
`{ schemaName: "public" }` or move the tables. The release notes carry an upgrade section.

That compatibility covers migration opt-in and the schema location. The operation stack separately replaces the beta
AutoCRUD HTTP surface and entity hooks. Applications migrate those calls to named operations and regenerate their
contracts; it provides no compatibility layer for the removed HTTP API.

### Seven commands, each with one job

| Command | Job | Needs a database |
|---|---|---|
| `appkit db init` | Point `.env` at your dev or session branch, creating it when missing. | Yes |
| `appkit db migrate` | Write a migration when `schema.ts` changed, then apply pending migrations to your branch. | Yes |
| `appkit db introspect` | Write `schema.ts` and a baseline from tables that already exist on your branch. | Yes |
| `appkit db clean` | Drop the app schema on your branch, or with `--delete-branch` delete this checkout's session branch. | Yes |
| `appkit db seed` | Run `config/database/seed.sql` on your branch. | Yes |
| `appkit db verify` | Read-only check of your branch, or with `--deployed -t <target>` of a target's deployed app. | Yes, or API only |
| `appkit db check` | Offline check of the committed history, for CI. | No |

`appkit db init` asks nothing on its default path. In a terminal and without `--yes`, it asks only to confirm an
explicit `--schema clean` on a branch it reused, and about an ambiguous rename in a migration it writes. The rebuild of
a branch it created in the same run needs no confirmation, because nothing on it is the developer's yet. It keeps
this checkout's session branch when `.env` points at one and otherwise uses your dev branch. `--session` and `--dev`
switch between them.
`appkit db check` is the only command that needs no Databricks or Lakebase access, so CI runs it without credentials.

## Architecture Decisions

### Migrate on start, behind an explicit flag

The plugin applies migrations in `setup()`, after the pool opens and before the schema check and `server.start()`.
It runs only when `APPKIT_DB_MIGRATE_ON_START=true` and the process has service principal credentials
(`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`). The template's `app.yaml.tmpl` writes the flag for apps that
select the plugin, which `apps init` offers only after the reveal. Until then, an app that adds the plugin by hand adds
the flag to `app.yaml` too. `.env` never carries it, so `npm start` on a laptop never migrates.

`databricks apps run-local` reads `app.yaml`, so it sets the flag, but it sets no service principal credentials. It
migrates only when the shell exports them. As a second guard, migrate on start skips migrating, with a warning, when
`LAKEBASE_ENDPOINT` names a `dev-` or `session-` branch, because only a developer migrates those.

Rejected alternatives:

| Option | Why not |
|---|---|
| Infer deployment from the environment | False positive on a local `npm start` with M2M credentials. No way to turn it off. |
| An admin migrates the deploy branch from the CLI | A human step on every schema change, by a person with DDL rights on the production branch. App Builder has nobody to run it. |
| A shared owner role, with CI migrating on merge ([tmm Lakebase Agentic CI](https://github.com/databricks/tmm/tree/main/Lakebase-Agentic-CI)) | Works. It needs a one-time bootstrap on the deploy branch by someone with `ADMIN OPTION`, database credentials in CI, and a grant to every new app service principal. Developers skip the fork hand-off only if they are members on the deploy branch, which gives them DDL rights there. App Builder apps have no CI. |
| A one-shot migration job per deploy | Adds a resource to every app, and still needs a shared owner role and its bootstrap so the app can use what the job created. |
| A bundle script hook | Runs as the person or CI identity that deploys, which then owns the objects. |

The decision costs two rules that the docs and `appkit db migrate` carry:

- **Each migration works with the previous release.** A horizontally scaled rollout updates one instance first while
  the old instances keep serving. A dropped, renamed or retyped column breaks them. Drops go in a later deploy than
  the code that stops using the column (expand, then contract). `appkit db migrate` warns when it writes a drop, a
  rename, a type change or `SET NOT NULL`.
- **A migration fits in the start window.** A migration that runs longer than the platform's start timeout can never
  land. Long backfills run as a separate job against the deploy branch, not as a migration.

### One transaction per migration

Each pending migration commits in its own transaction, in journal order, with the journal row drizzle-orm would
write. A deploy then replays the same commits the developer's branch went through one `appkit db migrate` at a time.

drizzle-orm's migrator runs every pending migration in one transaction. That fails on deploy for changes that applied
cleanly on the dev branch. `ALTER TYPE ... ADD VALUE` in one migration and a use of the new value in the next fails
with SQLSTATE 55P04 when both run together. A failure after some migrations commit leaves the app not started and
the old instances serving. Because every migration works with the previous release, that state is safe, and the next
deploy resumes from it.

The alternative keeps one transaction and refuses, before `begin`, a batch where an enum value is added before the
last migration. It keeps all-or-nothing, but the deploy still differs from what the developer ran.

### When a migration fails on deploy

Some migrations fail on the deploy branch every time, though they passed on the dev branch. For example, a `SET NOT
NULL` fails when rows on the deploy branch gained a `NULL` after the developer forked. The state after the failure:

- The failed migration rolled back and is not recorded.
- The migrations before it in that start stay committed and recorded.
- The new instance does not serve. The old instances keep serving, because each migration works with the previous
  release.

The fix goes forward. The developer changes that unrecorded migration, or adds the data repair to it before the
statement that failed, commits, and redeploys. The deploy branch never recorded it, so it runs the new version. A dev
branch that already ran the old version reports it as `edited`. The developer rebuilds that branch with
`appkit db clean` and `appkit db migrate`.

A data repair run by hand on the deploy branch needs the owner's rights there, which are the app service principal's.
Developers do not have them by design, so the repair belongs in the migration. A contract migration, one that drops or
retypes what older code uses, closes the rollback window. After it lands, an older revision of the app may no longer
start.

### One lock per schema, with a bounded wait

A session advisory lock keyed on the schema name serializes instances that start together. The wait polls
`pg_try_advisory_lock` every second until a 5-minute deadline. It logs the holder from `pg_locks` and
`pg_stat_activity` on the first failed poll, then every 30 seconds. The migrating session sets
`application_name = 'appkit-migrate'` so an operator can find it.

Two limits are different and easy to confuse:

- **Acquiring a table lock.** `lock_timeout` is 5s, with up to three tries per migration. A waiting `ACCESS EXCLUSIVE`
  request queues every later query on its table, so the timeout bounds how long traffic stalls behind the wait, not
  only the migration.
- **Holding a lock.** Nothing bounds it. `statement_timeout` is 0 while migrating, because a migration must fit the
  start window rather than a statement deadline. Once DDL holds its lock, it keeps it until the statement and its
  transaction end.

A killed instance is not cancelled for certain either. The migrating session also sets
`client_connection_check_interval`, so Postgres cancels a statement whose client went away. That is best effort.
Postgres sees a closed connection only when the server's kernel reports it, and a host that vanished without closing
the socket may not be seen until TCP keepalive gives up. When the server rejects the setting, the migrator logs a
warning and goes on. Until Postgres notices, the killed instance's statement keeps running and holds its locks,
the advisory lock included.

For a stuck start, the lock-wait log names the holder's pid. `select pg_cancel_backend(<pid>)` cancels
its statement. `select pg_terminate_backend(<pid>)` ends its session, which releases the advisory lock. Both need a
role that is a member of the service principal's role, or that has `pg_signal_backend`.

Most starts have nothing to apply, and an App Builder app starts on every cold start. The migrator reads the recorded
rows first without the lock. It takes the lock only when an entry is pending, then reads again under it. A current
branch then costs one connection and one read of the journal table on the start path.

A transaction-mode pooler would void a session lock. The pooled Lakebase endpoint is closed to OAuth roles, so the
plugin connects direct. Migrate on start refuses a `-pooler` host, so that stays true.

The CLI has a second lock, on the checkout's migration history. `appkit db migrate`, `introspect`, `clean` and `init`
create `config/database/.appkit-db.lock` exclusively and hold it until they finish or exit. `seed`, `verify`, `check`
and `clean --delete-branch` take none. A second `appkit db` command that needs the lock in the same checkout fails and
says who holds it. `init` holds one lock for its whole run, so no other command that takes the lock runs between its
clean and its migrate. `init --schema none` changes no migration history and takes no lock.

A command killed by a signal leaves the file behind. The next command fails the same way and says whether the
holder's pid still runs on this machine. AppKit never takes over or deletes a lock it does not hold. Once no
`appkit db` command runs in the checkout, the developer deletes the file and reruns the command. The template's
`.gitignore` lists the file.

### Fail closed on a history the migrator would skip

drizzle-orm applies only journal entries newer than the last recorded `created_at`. Two developers who add migrations
on parallel git branches produce, after the merge, an entry older than one the deploy branch already ran. That entry
is skipped for good. The startup schema check catches a skipped `CREATE TABLE` but not a skipped index, constraint,
backfill or `DROP`.

The migrator reconciles the committed history with the recorded rows as a pure function, first without the lock, and
again under it when an entry is pending and none is stranded:

| State | Meaning | On start |
|---|---|---|
| `empty` | No journal table, or no rows. | Apply all, or adopt the baseline. |
| `pending` | Entries newer than the last recorded one. | Apply them. |
| `current` | Every entry recorded with its hash. | Nothing. |
| `stranded` | An entry older than the last recorded one, not recorded. | Fail. Nothing changes. |
| `edited` | A recorded entry whose file hash changed. | Warn. |
| `ahead` | A recorded row with no committed entry, for example after a code rollback. | Warn. |
| `partial-baseline` | `0000_baseline` tables exist only in part. | Fail. Nothing changes. |

Committed entries and recorded rows that share a `when` match one to one, exact hashes first. A committed entry left
with no row is `pending` or `stranded`, never `edited`. So a migration that never ran cannot hide behind an edited
one with the same timestamp.

Before it reads the rows, startup checks the journal relation itself. It refuses a `__drizzle_migrations` in the app
schema that is not an ordinary table owned by the schema's owner. A view or a function another role put there would
otherwise run with the migrator's rights.

`appkit db check` runs in CI and reads only files in the checkout: `meta/_journal.json`, each entry's
`meta/NNNN_snapshot.json`, the list of `.sql` files in `config/database/migrations/`, and `schema.ts`. It takes no
history lock and writes nothing. Because it reads only files, CI runs it without Databricks or Lakebase access. It
needs the app's installed dependencies, because it loads `schema.ts` and diffs it with drizzle-kit. Loading runs the
pull request's `schema.ts` and everything it imports, so reading only files is not a sandbox, and CI runs the check
in a job without secrets. Without a `schema.ts` it fails and says to run `appkit db introspect`. Otherwise it exits 1
on any of these findings:

- An entry's `idx` is not its position in the journal.
- An entry's `when` is not an integer, or is not greater than the `when` of the entry before it.
- A snapshot's `prevId` is not the `id` of the snapshot before it. Two migrations generated from the same snapshot on
  parallel git branches cause this.
- The first snapshot's `prevId` is not drizzle-kit's origin id. A truncated history causes this.
- A listed `.sql` or snapshot is missing, or a `.sql` in the folder is not listed.
- A snapshot file does not have the structure of a drizzle-kit PostgreSQL snapshot.
- `schema.ts` has a change that no committed migration has, so `appkit db migrate` would write one.

The check compares the snapshots with each other and with `schema.ts`. It does not read the SQL, so a hand-edited
`.sql` is not checked against its snapshot.

A journal on `main` that passes the check and only grows can never strand an entry on the deploy branch, because the
deploy branch applies a prefix of it. Two pull requests that both add `0001_migration` conflict in git first, and the
check catches a resolution that keeps both.

Each finding names its fix. For a missing file, or a snapshot file that is not a drizzle-kit snapshot, the developer
restores it from version control. For a `schema.ts` change, they run `appkit db migrate` and commit the migration it
writes. For any other finding, they first save any SQL they wrote by hand in their migration, such as a backfill.
Then they merge `main`, reset `config/database/migrations` to `main`'s, and run `appkit db clean` and
`appkit db migrate`. Migrate writes their change again after `main`'s migrations. They add the saved SQL back to the
migration it writes and review that migration before they commit. The clean is there because their branch already ran
the old migration.

Two other fixes lose. Applying by hash instead of by `when` runs DDL in an order nobody reviewed. A custom journal
forks drizzle-kit's format, and drizzle-kit v1 already replaces the journal.

### One owner per branch

The identity that runs a branch's migrations owns the app's objects there. On the deploy branch that is the app's
service principal. On a dev or session branch it is the developer. There is no shared owner role and no `SET ROLE`,
because Lakebase rejects `GRANT ... TO databricks_superuser`.

The app's service principal owns the deploy branch's objects, as decided in review. A shared owner role is rejected
for now. Someone with `ADMIN OPTION` on it would have to grant it to every new identity, and a zero-touch flow has no
one who holds that option. Recovery after the principal changes is manual, as the end of this section describes.

A fork copies objects with their owners, so `appkit db init` hands the fork's app objects to the developer. It deletes
the fork's copy of the role that owns schema `app` and reassigns its objects (`reassign_owned_to`). It touches only
that role, on the fork, and says so before it does. The reassign covers everything the role owns on the fork. So when
the role also owns objects outside the app schema, init refuses before the delete, lists those objects and prints the
manual command.

`appkit db init --schema none` hands off nothing. It reads no `schema.ts`, takes no history lock, and leaves the schema
and its owner as the fork copied them. Init never hands off schema `public`, because `public` belongs to the database,
not to an app.

The role delete returns HTTP 500 when Postgres refuses the drop with SQLSTATE 2BP01, for example when the role still
owns objects in another database of the branch
([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). Init lists that role's remaining
dependencies from `pg_shdepend` before the delete. When the delete fails, init prints the API error, the
dependencies with where they are, and the fix. What remains is the platform's: the 500 classifies a dependency
refusal as a server error, and the delete cannot complete until someone repairs those dependencies.

Single ownership by the service principal breaks when that principal changes. A recreated app has a new one, and
removing and re-adding the database resource hands the objects to the app manager (XTA-18463). Either way the app
can no longer use or alter its schema, and its next start fails. The startup error names the current owner of schema
`app` and the manual recovery, which the docs repeat. When the owner belonged to a deleted app, someone with CAN MANAGE
on the project runs `databricks postgres delete-role <old role> --reassign-owned-to <new role>`, which moves the
objects and deletes the old role. Otherwise the owner transfers the schema. A zero-touch recovery is Open Question 5.

### Branch policy is one resolver and one table

One function resolves the `.env` branch to a kind, in this order: project default, protected, deploy target, dev
(yours), session (this checkout), other. Every command reads that kind. The rules live in one table:

| Kind | `init` | `migrate` | `introspect` | `clean`, `seed` | `verify` |
|---|---|---|---|---|---|
| dev (yours), session (this checkout) | Use | Write and apply | Write and record | Run | Read |
| deploy target, project default, protected, other | Refuse | Write only | Refuse | Refuse | Read |

`init` resolves the kind of the branch it would create or reuse before creating it or writing `.env`. A deploy target
is a branch that any `databricks.yml` target binds, through any `postgres` resource of any app or through
`postgres_branch`. A database binding counts for the branch it is on. One reader serves the guard, `init` and `verify`.
It follows `include:` and resolves variables per target. It reads each target twice when
`.databricks/bundle/<target>/variable-overrides.json` exists, once with `databricks.yml`'s own values and once with
the values `databricks bundle` keeps in that file, because a deploy from this checkout uses them. A branch that
either reading names is a deploy target. A branch or database reference that either reading cannot resolve, such as
an unset `postgres_branch` or `${workspace.current_user.short_name}`, may name any branch. While one exists, every
branch counts as a deploy target, so no command writes to any branch, and the refusal names the reference. `verify`
also warns when `.env` points at a branch that is not yours.

The name allowlist is the safety boundary against a command aimed at the wrong branch. It is not an authorization
boundary, as Security Considerations says. Only `dev-<user>-<hash6>` and `session-<hash6>-<id>`, with your user and
this checkout's id, are writable, and the denylist checks come first. Before connecting, the CLI checks that `PGHOST`
is a host of `LAKEBASE_ENDPOINT`.

### drizzle-kit generates, the plugin applies

drizzle-kit 0.31.10 generates migrations through `drizzle-kit/api`. It is an exact optional peer dependency, loaded
lazily from the `@databricks/appkit/beta/database-tooling` entry point that the runtime never imports. The
loader checks the installed version and the `drizzle-orm` it resolves, and prints the install command on a mismatch.

The stack ships on drizzle-kit 0.31's journal, version 7, as decided in review. drizzle-kit v1's folder format
removes the journal and its merge conflicts, but moving to it changes the layout of every app's committed migrations.
That move is future work, in a format-migration proposal of its own.

`appkit db init` installs drizzle-kit as a dev dependency when it is missing, since only database apps run it. A
template dev dependency would add about 32 MB, 12 downloads and two deprecation warnings to every app, including apps
that never use it. The template ships one lockfile, so it cannot be dropped per app.

The shared CLI's view of the tooling API is an interface exported from `shared`, and an appkit test assigns the
tooling's exports to it. Drift then fails typecheck.

### Introspect renders the AppKit builder, not drizzle's DSL

`appkit db introspect` reads `pg_catalog` and renders `defineSchema()` code. `drizzle-kit pull` emits drizzle's
`pgTable` DSL, which the plugin does not accept, and most of the renderer is skip and approximation policy that pull
does not have. Every catalog string reaches the output escaped. Nineteen hostile names, including newline, CR,
U+2028, U+2029, `*/`, backtick and `${`, loaded without running code.

Introspect records its migration as applied only if the branch's last recorded migration is the one just before it,
checked under the schema's advisory lock. A branch ahead of the checkout would otherwise record DDL it never ran.

Introspect keeps what an existing `schema.ts` marks private for default operation outputs. A column the old file
declares keeps its `.private()`, or stays without one. Introspect writes a column the old file does not declare with
`.private()`, and a warning names it. When the catalog has a foreign key the old file does not declare, introspect
refuses before it changes any file, because each foreign key adds a relation that authored operations can include.
When `schema.ts` does not load, introspect refuses before it reads the branch, because it could not keep the private
columns. Without a `schema.ts`, introspect writes no column private.

### Flag Strategy

| Flag | Default | Introduced in | Turning it off |
|---|---|---|---|
| `APPKIT_DB_MIGRATE_ON_START` (app env) | Off. #675's `template/app.yaml.tmpl` renders `true` for apps that select the plugin, which `apps init` does not offer until the reveal. | #654 | The app never migrates. The startup schema check still runs. |
| `hidden` in the plugin manifest | `true` | Already on `main` | `apps init` does not offer the plugin. #675 keeps `hidden: true` and leaves the plugin out of `template/appkit.plugins.json`. `beta.ts` exports `database` by hand, because the generated barrel skips hidden plugins. The reveal removes the flag and moves the `database` export into the generated barrel. |
| `appkit db` hidden from `--help` | Hidden | #666 | Discoverability only. The commands are local tools and change only branches `init` created. #675 keeps it hidden. The reveal shows it. |

Not flagged:

- The `app` default (#655). The plugin is beta, which allows API changes in a minor release, and the startup hint
  plus the upgrade note cover existing apps.
- `appkit db check`, `verify` and `introspect` on your own branch. They are read-only or write only local files and
  your own branch.

## Main Design

### A new app, from scaffold to deploy

#675 adds what the template renders for apps that select the plugin. An app that selects it gets an empty
`config/database/schema.ts` in schema `app`, the flag in `app.yaml`, and a database section in the README. `apps init`
does not offer the plugin yet, because #675 keeps the manifest `hidden: true` and `appkit plugin sync` leaves hidden
plugins out of `template/appkit.plugins.json`. The reveal removes `hidden: true`, so the synced file lists the plugin.
It also moves the `database` export from `beta.ts` into the generated barrel `beta-exports.generated.ts`, and it shows
`appkit db` in `appkit --help`. After the reveal and integration with the operation stack, a new app goes from
scaffold to deploy in six steps:

1. `databricks apps init` scaffolds the app with the plugin. It asks for the Lakebase project and the deploy branch
   and database. The branch and database go into `databricks.yml`, and their resource names include the project. The
   project gets no `databricks.yml` variable of its own, because its manifest field sets `bundleIgnore`, which the
   plugin manifest docs define as excluded from `databricks.yml` variables.
2. `apps init` runs `appkit db init`, which asks nothing on its default path. It forks the project's default branch
   into `dev-<user>-<hash6>`, adds a read-write endpoint and the developer's role, writes `.env`, hands the fork's app
   objects to the developer, and rebuilds the app schema from the committed migrations, so the new branch holds no
   copied app rows. With `--schema none`, init stops after it writes `.env`.
3. The developer declares a table in `schema.ts` and runs `appkit db migrate`. It writes `0000_migration.sql`,
   regenerates `shared/appkit-types/database.d.ts`, and applies the migration to the dev branch.
4. The developer adds authorized operations in `server/database/routes/` and uses the query and mutation hooks in
   the UI. Development saves regenerate the registry and contracts and reload the backend. Changes to storage still
   require `appkit db migrate`; editing an operation never applies DDL.
5. The developer commits `config/database/`, operation declarations and policies, the generated registry and type
   contracts, and the UI changes. `appkit generate-types` regenerates operation artifacts for a build or CI check;
   `NODE_ENV=production` makes missing authorization a generation error. They run `databricks apps deploy`.
6. The app starts with `APPKIT_DB_MIGRATE_ON_START=true`. Operation metadata is checked before the pool opens; under
   the migration lock it reconciles, applies `0000`, creates and owns schema `app`, checks the declared tables, and
   listens. Applying a migration alone never publishes a browser operation.

Until the CLI release that runs `appkit db init` ships, the developer runs it once after scaffolding, as the README
says. Before that run, `.env` points at the branch picked in the prompts, usually the deploy branch, and
`appkit db verify` warns about it. A local app start in that window reads and writes the deploy branch. The `appkit db`
guards do not cover a local app start. Only migrations stay off there, because `.env` never sets the flag. This is a
known gap, to close before the reveal offers the plugin.

### A table change

Edit `schema.ts`, run `appkit db migrate`, commit, deploy. CI runs `appkit db check`. After the deploy,
`appkit db verify --deployed -t <target>` checks through the Databricks API what the target's app deployed. The app
must be running and bound to the branch and database, and its service principal must have a role on the branch. The
source snapshot of its active deployment must hold exactly the committed migrations, entry by entry, each with the same
journal entry and byte-identical SQL. A snapshot without a journal holds no migration. Verify fails on any difference,
when it cannot read the snapshot, when the app has no service principal ID, and when it cannot resolve the target's
workspace host.

That proves the deployed source, not the database. `verify --deployed` reads nothing on the deploy branch, so it does
not show that the app applied those migrations. The app's startup log and its schema check do.

### A second developer

Clone, install, `appkit db init`. Init forks the default branch, which already holds the deployed migrations. It drops
the fork's copy of the app schema and applies every committed migration, so the new branch has the deployed tables and
none of their rows. With `--schema migrate`, init keeps the copied rows and applies only the committed migrations the
fork has not recorded.

### Existing tables

On a fork that has tables but no `schema.ts`, `appkit db init` runs introspect. It writes `schema.ts` and
`0000_baseline`. On a branch init created in this run, it then rebuilds the app schema from that baseline, so the fork
has the tables and none of the copied rows. On a reused branch, it records the baseline as applied and keeps the rows.
The deployed app adopts the baseline on start when every baseline table and column already exists. A partial match
fails start and changes nothing.

A baseline is not proof that the deploy branch is secured the way the fork is. Introspect does not render row-level
security policies, triggers, or `CHECK` and `EXCLUDE` constraints, and it warns about each one it skips. Adoption on
deploy checks only that the baseline's tables and columns exist by name. Types, constraints, policies and grants on the
deploy branch are whatever they were.

### API Changes

- CLI: `appkit db init | migrate | introspect | clean | seed | verify | check`.
- Backend operations: `defineOperation`, `definePolicy` and `database()` discovery, with explicit `routes: false`
  or `routes: customRoutes` alternatives. These replace AutoCRUD and its `api` configuration.
- Generated contracts: `server/database/routes.gen.ts` and `shared/appkit-types/database-operations.d.ts`, alongside
  `database.d.ts`. Omitted inputs generate `void`; explicit schemas determine the wire types. Output defaults stay.
- UI: `databaseApi.execute`, `useDatabaseQuery`, `useDatabaseMutation`, and query-only `skipToken`. Entity CRUD hooks
  and `databaseApi.list/get/create/update/remove` are removed by the operation cutover.
- `defineSchema()` defaults `schemaName` to `"app"`.
- Package export `@databricks/appkit/beta/database-tooling`. It is beta and internal to the AppKit CLI. It has no semver
  guarantee, and only the CLI of the same AppKit release imports it.
- App env: `APPKIT_DB_MIGRATE_ON_START`. Local env written by init: `LAKEBASE_PROJECT`, `LAKEBASE_ENDPOINT`,
  `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPORT` when it is unset or not a number, `PGSSLMODE=require` when it is unset,
  `prefer` or `disable`, `APPKIT_DB_SESSION` for a session branch, and `DATABRICKS_CONFIG_PROFILE` or
  `DATABRICKS_HOST` when `.env` names neither.
- Flags: `appkit db init --dev | --session`, `--ttl <duration>` for session branches,
  `--schema <migrate|introspect|clean|none>` and `-y, --yes`. On a branch init created in the same run, `--schema`
  defaults to `clean`, and without `schema.ts` to introspect followed by the same rebuild. On a branch init reused, it
  defaults to `migrate`, and without `schema.ts` to `introspect`. `--schema migrate` on a new branch keeps the copied
  rows. `appkit db clean --delete-branch` and `-y, --yes`.
  `appkit db introspect --schema-name <name>`. `appkit db verify --deployed` and `-t, --target <name>`.
- Optional peer dependency: `drizzle-kit` `0.31.10`.

## Observability

Migrations run before `TelemetryManager.start()` registers the tracer provider, so a span opened during setup is
dropped. The plugin opens no span and records no metric for migrations. The migrator returns the applied, adopted and
edited tags, the number of recorded migrations the checkout does not commit, and `lockWaitMs`. It logs one line per
applied migration with its duration. The plugin then logs one line per run with the schema, the migrations folder,
the `applied`, `adopted`, `edited` and `unknown` (the `ahead` rows) counts, `lock_wait_ms` and `duration_ms`.

## Security Considerations

- **New forks start without copied app rows.** A Lakebase fork copies every row of the default branch, and the
  developer gets `DATABRICKS_SUPERUSER` on it. That role is required, because it is the only role API membership that
  grants `CREATE` on the database. On a branch init created in this run, init drops the fork's app schema and rebuilds
  it from the committed migrations, or from the baseline introspect writes, so no copied row stays in it. Limits that
  the docs repeat:
  - Until the rebuild runs, the copied rows are on the fork at the Lakebase level. An init interrupted before the
    rebuild leaves them there, and a rerun reuses the branch, which defaults to `migrate`. The developer reruns
    `appkit db init --schema clean`.
  - Rows in other schemas stay. `DROP SCHEMA ... CASCADE` also drops objects in other schemas that depend on the app
    schema, such as a view over an app table, a foreign key into one, or a column of an app type. Clean lists them
    before it drops. Only independent objects in other schemas stay.
  - On schema `public`, clean drops only the objects the developer owns. Init never hands `public` off, so tables the
    app's service principal owns stay on the fork with their copied rows, and init warns and lists them. The recovery
    on your own branch is `databricks postgres delete-role projects/<project>/branches/<your branch>/roles/<app role>
    --reassign-owned-to projects/<project>/branches/<your branch>/roles/<your role>`, then `appkit db clean`. Moving
    the app to schema `app` avoids it.
  - A reused dev branch keeps whatever it holds, and `--schema migrate` on a new fork keeps production rows on
    purpose.
  - Whether Lakebase offers schema-only branches, which would copy no rows at all, is Open Question 4.
- **Creating branches needs CAN MANAGE on the project.** That also allows deleting the deploy branch. The narrowest
  permission is Open Question 3.
- **Branch guards stop mistakes, not people.** The name allowlist, the denylist and the `PGHOST` check run before
  any connection. They stop an `appkit db` command aimed at the wrong branch. They are not an authorization boundary.
  The developer's CAN MANAGE on the project still lets them delete the deploy branch through the console, the API or
  `databricks postgres`.
- **The scaffold points `.env` at the deploy branch.** Until `appkit db init` runs, a local app start reads and writes
  the deploy branch, as the scaffold flow says. This gap closes before the reveal.
- **A baseline is not a security-equivalence proof.** Introspect omits row-level security policies, triggers, and
  `CHECK` and `EXCLUDE` constraints, with a warning for each. Adopting a baseline on deploy checks only table and
  column names.
- **`verify --deployed` proves the deployed source.** It checks the journal and the SQL bytes of the active
  deployment, the bindings, the running status and the service principal's role. It does not show that the migrations
  were applied on the database.
- **The migration journal must be AppKit's.** Startup refuses a `__drizzle_migrations` relation that is not an
  ordinary table owned by the app schema's owner, before it reads from it.
- **`appkit db init` installs drizzle-kit.** It runs the project's package manager to add `drizzle-kit@0.31.10` in the
  developer's environment, and the packages' lifecycle scripts run as in any install.
- **`appkit db check` runs the pull request's code.** It imports `schema.ts` and what it imports, so CI runs it in a
  job without secrets.
- **Generated code.** Introspect escapes every catalog string that reaches `schema.ts`. Tests cover each escape
  vector, including CR and U+2029.
- **No driver text leaves the server.** Startup errors carry the SQLSTATE and the migration tag. Clients see
  `Database setup failed`.
- **`.env`.** Init writes it with mode 0600 through a temporary file and a rename, and refuses a symlink. When `.env`
  is missing, init writes its own keys and the profile or host it authenticated with. It never copies `.env.example`,
  whose `DATABRICKS_HOST` is a placeholder. It replaces a `PGSSLMODE` of `prefer` or `disable` with `require` and says
  so, because `prefer` does not verify the server's certificate.
- **Session branches are bound to a user.** With the user hash in the name, a copied `.env` fails the guard for
  everyone but its creator.

## Validation of the operation integration

The operation stack is exercised through runtime, generation, hook and playground tests, including a real
`tsx watch` + Vite lifecycle test and a production build that loads operations after all TypeScript sources are
removed. Application scenarios cover reordered read responses, refresh after writes, field-validation feedback,
concurrent investigation creation, audit rollback and note/closure ordering in disposable PostgreSQL.

These checks validate the operation design and application experience. They do not establish that the two PR chains
have been integrated or repeat the migration stack's live Lakebase validation. Before release, combine both stacks
and verify registry validation, startup migrations and schema checks in one deployment, and keep the expand/contract
migration checks for mixed-version rollouts.

## Platform Dependencies

| Ask | Why |
|---|---|
| Databricks CLI: `apps init` runs `appkit db init` after install. | Removes the manual init step. Without it the README tells the developer to run init. |
| Databricks CLI: a minimum version recorded in the template. | An older CLI scaffolds without init, and `.env` points at the deploy branch until the developer runs it. `appkit db verify` warns meanwhile. |
| Lakebase: `client_connection_check_interval` allowed for app roles (Open Question 2). | Lets Postgres cancel, best effort, the statement of a killed instance that still holds the migration lock. Without it the migrator logs a warning. |
| Lakebase: role delete returns the 2BP01 dependency error as a 4xx, not a 500 ([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). | Init prints the API error, the dependencies and the fix, but the 500 classifies a dependency refusal as a server error. The hand-off cannot complete on any rerun until someone repairs the dependencies. |
| Lakebase: raise the quota of 25 unarchived branches per project ([LKB-12894](https://databricks.atlassian.net/browse/LKB-12894), backlog, proposes 100). | One branch per developer caps a project at about 20 developers. |
| Apps: keep object ownership with the app across a database resource remove and re-add ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463), to do). | The app cannot use its own schema after a re-add, and start fails. |
| Apps: the start timeout and whether a non-zero exit restarts the app (Open Question 1). | Sets the lock wait and the longest migration. The template exits 1 on a failed start. |

## Rollout Plan

1. **Design.** Land this doc. Done when the Apps, Lakebase and CLI reviewers have answered the open questions marked
   for them.
2. **Runtime, dark.** Land #654 and #655 with the flag, the per-migration transactions, the reconcile states and the
   bounded lock. Done when a real-Postgres test suite passes in CI, and the dev-playground deployed with the flag on
   applies `0000` and then `0001`.
3. **Commands, hidden.** Land #666 to #674. Done when a developer on the dev-playground runs `init`, `migrate` and
   `verify` on their own branch, and the deployed app applies the migration.
4. **Template and docs, hidden.** Land #675, then #678 (`appkit db check`). #675 keeps the plugin `hidden: true` and out
   of `template/appkit.plugins.json`, and keeps `appkit db` hidden from `appkit --help`. Done when two people on the
   dev-playground add migrations on parallel git branches, `appkit db check` fails a merge that keeps both, and the
   documented fix passes.
5. **Reveal.** A later, separate change offers the plugin in `apps init`, moves the `database` export from `beta.ts`
   into the generated barrel, and shows `appkit db` in `appkit --help`. Until a CLI release runs `appkit db init`, the
   README says to run it once. Done when `apps init` with the plugin, one table and a deploy need no step outside the
   README.
6. **GA of the plugin** is a separate plan.

## PR Stack

1. `00-design`: this doc.
2. [#654](https://github.com/databricks/appkit/pull/654) Migrations on deploy start: the flag, one transaction per
   migration, the reconcile states with fail-closed `stranded` and one-to-one matching within a `when`, the refusal of
   a journal relation that is not an ordinary table owned by the schema's owner, the bounded lock wait, a 5s lock
   timeout, a warning when `client_connection_check_interval` is rejected, the lock-free read on a current branch, the
   `-pooler` refusal and the developer-branch skip, the schema owner in the startup error, a log line per run and per
   applied migration, and a real-Postgres suite.
3. [#655](https://github.com/databricks/appkit/pull/655) The `app` default schema, with the `public` hint in the
   startup check, the refusal to create the tables in an implicit `app` when `public` has them, and an upgrade note.
4. [#666](https://github.com/databricks/appkit/pull/666) `appkit db migrate`: the branch resolver, the checkout's
   history lock, the drizzle-kit version check, the destructive-statement warning, and a checked tooling contract.
   When Postgres rejects the migration the run wrote, migrate removes it, so the next run writes it again.
5. [#670](https://github.com/databricks/appkit/pull/670) `appkit db introspect`: compare-and-set recording, only on
   your own branch, private columns and a refusal of foreign keys that the old `schema.ts` does not declare, and
   catalog tests that run SQL.
6. [#672](https://github.com/databricks/appkit/pull/672) `appkit db init`, `clean`, `seed`: dev and session branches
   with no prompts, a new fork rebuilt without copied app rows by default, the hand-off of the app schema and its
   refusal when the copied owner owns objects outside it, the 2BP01 dependency report, the refusal of a bound
   database the fork lacks, the 5-minute scale to zero, the branch-limit stop, `--ttl` and `--delete-branch`, atomic
   `.env` writes with `PGSSLMODE=require`, and the drizzle-kit install.
7. [#674](https://github.com/databricks/appkit/pull/674) `appkit db verify`: the local check, including `ahead` rows,
   and `--deployed` with `-t, --target`. The deployed check reads only the Databricks API. It reads the target with
   the same `databricks.yml` reader as the deploy guard, and uses the values in `variable-overrides.json` when that
   file exists. It refuses when the target's `workspace.host` is not the workspace the shell is authenticated against.
   It checks that the app is bound to the branch and database with `CAN_CONNECT_AND_CREATE`, that its service
   principal has a role on the branch, and that the app is running. An app with no service principal ID, or a target
   whose workspace host cannot be resolved, fails the check. It reads the journal in the source snapshot of the
   app's active deployment, which must list exactly the committed migrations, entry by entry, with the same journal
   entries and byte-identical SQL. A snapshot without a journal lists none, so verify names each committed migration
   as missing and says to deploy. A migration the snapshot lists that the checkout does not commit fails the check,
   and verify says to pull it. Any other failure to read the snapshot fails the check too. The check proves the
   deployed source, not that the database applied it. One `databricks.yml` reader serves the guard, `init` and
   `verify`.
8. [#675](https://github.com/databricks/appkit/pull/675) What the template renders for apps that select the plugin,
   which stays hidden: the flag in `app.yaml`, no drizzle-kit in the template, exit 1 on a failed start, a README that
   works before the CLI release, `verify`'s warning for a `.env` branch that is not yours, the recreated-app recovery
   in the owner error, and the docs. The manifest keeps `hidden: true`, `beta.ts` exports `database` by hand,
   `template/appkit.plugins.json` does not list the plugin, and `appkit db` stays hidden from `appkit --help`. The
   reveal is a later, separate change.
9. [#678](https://github.com/databricks/appkit/pull/678) `appkit db check`: the offline check of the committed
   migrations that CI runs, including each entry's `when`, the first snapshot's origin and each snapshot's
   structure, recovery advice that keeps hand-written SQL, the CI section of the plugin docs, and a CI note in the
   template README.

### Related operation PRs

The application contract above is implemented in a separate chain:

| PR | Responsibility |
|---|---|
| [#687](https://github.com/databricks/appkit/pull/687) | Remove the earlier database lifecycle hooks and read serializers. |
| [#688](https://github.com/databricks/appkit/pull/688) | Define operations and policies; inputs are explicit or absent. |
| [#689](https://github.com/databricks/appkit/pull/689) | Verify callers, authorize execution and return safe field validation details. |
| [#690](https://github.com/databricks/appkit/pull/690) | Generate registries/contracts and watch shared database modules. |
| [#691](https://github.com/databricks/appkit/pull/691) | Typed clients/hooks, operation/session state and dependent-query `skipToken`. |
| [#692](https://github.com/databricks/appkit/pull/692) | Serve operations, remove AutoCRUD, discover/build/reload conventional routes, and update the usage guidelines. |

## Open Questions

Three earlier questions were decided in review, and the sections above record them. The service principal owns the
deploy branch's objects (One owner per branch). A new fork starts without copied app rows (Every developer gets a
Lakebase branch). The stack ships on drizzle-kit 0.31's journal (drizzle-kit generates, the plugin applies).

1. What is the Apps start timeout, and does a process that exits non-zero get restarted? SUP-36075 suggests about 10
   minutes, unconfirmed. Reviewer: Apps runtime.
2. Is `client_connection_check_interval` allowed for Lakebase roles? Reviewer: Lakebase.
3. What is the narrowest Lakebase permission that lets a developer fork a branch and manage roles on their own fork?
   CAN MANAGE also allows deleting the deploy branch. Reviewer: Lakebase.
4. Does Lakebase offer, or plan, schema-only branches? A new fork now drops its copied app rows, but the fork copies
   them first, and rows in other schemas stay. Reviewer: Lakebase, security.
5. How does an app with a new service principal take ownership back, after a recreate or a resource re-add? The
   stack documents a manual recovery with `databricks postgres delete-role --reassign-owned-to`. Options for a
   zero-touch one are Apps transferring ownership on re-add, or an `appkit db adopt --deployed` built on the role API.
   Reviewer: Lakebase, Apps.
6. What scale to zero do child branch computes get by default? Production gets 24 hours. Reviewer: Lakebase.
7. How does Genie App Builder drive this flow? Its apps have no per-developer `.env` and no CI, and they start on
   every cold start. Reviewer: App Builder.
8. Which CLI release runs `appkit db init`, and does it run before or after the dependency install? Init asks nothing
   on its default path, so it needs no flags. Reviewer: Databricks CLI.
9. This design has `appkit db init` install drizzle-kit. Should the CLI support per-plugin dependencies instead, so
   apps that select the plugin get it at scaffold time? Reviewer: AppKit, Databricks CLI.
