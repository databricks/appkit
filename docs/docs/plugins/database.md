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
PostgreSQL. The plugin creates and migrates tables only in a deployed app that
sets `APPKIT_DB_MIGRATE_ON_START=true`. That app applies the committed migrations
in `config/database/migrations` at startup, as its service principal. After any
migrations, setup checks that every declared table and column exists and fails
if one is missing.

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

Tables live in the Postgres schema `app` unless the second argument of
`defineSchema()` names another one, for example `{ schemaName: "public" }`. The
default is not `public` because the deployed app's service principal creates and
owns `app`, but has no `CREATE` privilege on `public`.

Give each app its own `schemaName`. Two apps bound to one database with the same
schema are unsupported. They would share the schema, its migration journal and
the migration lock, and the second app's service principal cannot change the
tables the first one owns.

### Apps with tables in `public`

Earlier releases put tables in `public` by default. An app that created its
tables there fails setup after the upgrade, and the error says the tables are in
`public`. With `APPKIT_DB_MIGRATE_ON_START=true`, startup refuses before any
migration runs when `defineSchema()` was given no `schemaName`, none of the
declared tables exist in `app`, and some exist in `public`; `npx appkit db migrate`
refuses to apply on a dev branch in the same case. Otherwise the first
migration would create empty copies in `app`, the check would pass, and the app
would serve the empty tables. Keep the tables in `public` with:

```ts
export const schema = defineSchema(
  ({ table }) => ({
    notes: table("notes", { id: id(), body: text().notNull() }),
  }),
  { schemaName: "public" },
);
```

To use `app` instead, move the tables first
(`ALTER TABLE public.notes SET SCHEMA app`). When the tables in `public` belong
to another app, pass `{ schemaName: "app" }` explicitly and neither startup nor
`migrate` refuses.

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
   otherwise uses your dev branch, `dev-<you>-<hash>`. When the branch does not
   exist yet, it forks the branch that the default `databricks.yml` target
   binds, or the project's default branch when that target does not resolve,
   and prints which one it forked. `--session` uses a branch for this checkout
   that expires after 7 days (`--ttl` changes that), and `--dev` goes back to
   your dev branch.
2. It makes sure the branch has an endpoint and your Postgres role, and points
   `.env` at the branch.
3. It sets up the schema, and reads the branch to decide how. When the app
   schema still belongs to the fork's copy of the app's service principal, the
   branch is an untouched copy. `init` then tags the copied migration journal,
   hands you the schema (see [One owner per branch](#one-owner-per-branch)),
   drops it, and rebuilds it from the committed migrations, so the tables start
   without the copied rows. Without `schema.ts`, it first writes `schema.ts`
   and a `0000_baseline` migration from the fork's tables (`introspect`), then
   rebuilds from that baseline. A branch this run created is rebuilt the same
   way even when its app schema is already yours, because every row on it is
   the fork's copy. In schema `public`, which no app owns, a rebuild drops only
   the tables you own, and lists the tables that keep their copied rows. When
   the app schema was already yours on a branch that existed before this run,
   `init` keeps the rows. With `schema.ts` it runs `migrate`, which writes a
   migration when `schema.ts` changed since the last one, then applies the
   committed migrations. Without `schema.ts`, it runs `introspect`. To keep
   the copied rows on a new branch, pass `--schema migrate`, or
   `--schema introspect` without `schema.ts`, and `init` says that they stay.
   The rows are yours from then on, so a later plain `init` keeps them, and
   `--schema clean` removes them. `--schema clean` drops the app schema first,
   after a confirmation. Without a terminal, it needs `--yes`. `--schema none`
   only sets up the branch and `.env`. It reads no `schema.ts`, hands over no
   schema, and leaves the schema and its owner as the fork copied them. The
   next plain `init` still rebuilds a copy the app's service principal owns.
   If you already owned the schema on the source, that later run sees your
   working branch, so run `--schema clean` then.
4. Unless `--schema none`, it installs the drizzle-kit version AppKit pins as a
   dev dependency when the app does not have it. `migrate` and `introspect`
   generate migrations with it.

`db init` never changes the project's default branch, a protected branch or a
branch `databricks.yml` deploys to, and never edits `databricks.yml`.

:::caution[A new branch copies the branch the app deploys to]
A new branch forks the branch the default `databricks.yml` target binds, or the
project's default branch when `init` cannot resolve that target, so it starts
with a copy of its rows, production data included. By default, `db init` drops
the copy in the app schema. Until it does, and in other schemas, the rows stay
on the branch. Your role there is a member of `DATABRICKS_SUPERUSER`, which
reads and writes every table on the branch and bypasses row-level security.
Creating a branch needs CAN MANAGE on the Lakebase project, which also allows
deleting any branch, the deploy branch included. Use a project whose deploy
branch holds only data every developer may see.
:::

### Commands

| Command | What it does |
| --- | --- |
| `npx appkit db init` | Points `.env` at your dev branch, or with `--session` at a branch for this checkout that expires, then sets up the schema. |
| `npx appkit db migrate` | Writes `config/database/migrations/NNNN_migration.sql` when `schema.ts` changed, regenerates `shared/appkit-types/database.d.ts` and `database-operations.d.ts`, and applies pending migrations to your branch. |
| `npx appkit db introspect` | Writes `schema.ts` from tables that already exist, and a `0000_baseline` migration (or `NNNN_introspect` when migrations already exist), and regenerates both type files. |
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
files and the generated types in `shared/appkit-types/`.

A typical change:

```bash
# edit config/database/schema.ts
npx appkit db migrate            # writes and applies NNNN_migration.sql on your branch
git add config/database          # commit schema.ts with its migrations
databricks apps deploy           # the deployed app applies it on start
npx appkit db verify --deployed  # the app runs, and its source has every committed migration
```

### Warnings about a generated migration

`migrate` prints a warning for each of two classes of statement in the
migration it wrote, and names the statements. One statement can be in both
classes.

Statements that break instances still running the previous release. Drops,
renames, type changes, `SET NOT NULL` and a new `NOT NULL` column without a
default are in this class. Those instances can still serve while the new one
migrates on start, and a code rollback does not undo a migration. Deploy code
that works with both the old and the new schema first, then this change in a
later deploy.

Statements that may fail on existing rows. `SET NOT NULL`, a new `NOT NULL`
column without a default, a type change, a new constraint (`UNIQUE`,
`PRIMARY KEY`, `CHECK`, `FOREIGN KEY` or `EXCLUDE`) and a unique index are in
this class. Postgres checks them against the rows already in the table. A new
dev branch has no rows, so they pass there and can fail on the deploy branch.
Test the migration on a branch that has a copy of the deploy branch's data
before you deploy, for example a session branch created with
`npx appkit db init --session --schema migrate`.

### Your branch's data

`npx appkit db init` creates your dev branch, or this checkout's session branch
with `--session`, as a fork of the branch `databricks.yml` deploys to, else of
the project's default branch, and points `.env` at it. A fork copies every row
of its source, production data included. `init` reads from the branch what its
app schema is. While the app's service principal still owns the schema, it is
the fork's untouched copy. `init` hands it to you, drops it and recreates it
from the committed migrations, so the branch starts without the copied rows.
A branch `init` forked in this run holds only what the fork copied, whoever
owns its schema. So a schema you already owned on the source is rebuilt too,
with no hand-off to make. Without `config/database/schema.ts`, `init` first
writes it and `0000_baseline.sql` from the fork's schema, then rebuilds the
schema from that baseline.

Before the hand-off, `init` inserts one row with the hash `appkit:fork-copy`
into the copied `__drizzle_migrations` journal. It writes the row only where
the migrator would record. That is a journal owned by your role, by a role it
inherits, or by the schema's owner, which is what a fork's copy has. A journal
another role owns could run that role's code as you through a trigger, a rule,
a default or a policy, so `init` leaves it alone. It then warns that it could
not mark the copy and rebuilds anyway. A copy with no journal gets the same
warning. If such a run stops before the rebuild finishes, the next `init` sees
a schema that looks like your working branch and keeps the copied rows. Run
`npx appkit db init --schema clean` then. Dropping the schema removes the row. A
run that stops between the hand-off and the drop leaves a schema you own whose
journal still carries that row, and the next `init`, from any checkout,
finishes the rebuild.

`npx appkit db migrate`, `npx appkit db introspect` and `npx appkit db seed` refuse a
schema that is still a copy. That is one the service principal still owns, with
no row yet, or one handed to you whose journal still carries the row. The message
says to run `npx appkit db init` to rebuild it, or `npx appkit db init --schema
migrate` (`introspect` for introspect) to keep the copied rows. Schema `public`
is never refused.
`npx appkit db verify` reports both kinds of copy with the same advice.

To keep the copied rows, pass `--schema migrate`, or `--schema introspect`.
`init` then hands the schema to you, removes the row, keeps the data, and says
where it came from. From then on the schema is your working branch. A plain
`init` migrates it and keeps the rows. `npx appkit db init --schema clean` drops
the app schema with everything in it and rebuilds it from the committed
migrations, after a confirmation or with `--yes`. On a branch an earlier run
created, a schema you own with no such row is your working branch. `init`
migrates it, or introspects it without `schema.ts`. A copy's rebuild asks
nothing, because `migrate` refuses a copy and a fresh fork holds only what it
copied, so none of your work can be on it. `--schema none` touches nothing.
The next plain `init` still rebuilds a copy the service principal owns. A fresh
fork of a schema you already owned looks like your working branch to that
later run, so run `npx appkit db init --schema clean` then.

In schema `public`, `init` and `clean` remove only the objects your role owns,
and `init` never hands `public` off or tags it. On a fork of the deploy branch
the app's service principal owns the tables, so `init` migrates the schema, the
tables stay with their rows, and the report lists them as kept.

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
`postgres_branch` unset and `${workspace.current_user.short_name}`. The same
holds for a `${var.…}` reference in place of an app's `resources` list, one of
its entries, or a `postgres` block, because the files do not say what it binds.
While any such reference exists, `migrate` applies migrations to no branch, and
`init`, `introspect`, `clean` and `seed` refuse every branch. The message names
the target and where the reference is. To continue, give the reference a value
in `databricks.yml`, or in the `variable-overrides.json` the message names. A
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

A migration must work with the code that is still running or may run again. On
no-downtime compute, instances of the previous release keep serving while the
new release migrates on start. On classic compute the old process stops first,
but a [rollback](#rolling-back) redeploys the previous release against the
migrated schema. A change that drops or renames a table or column, changes a
column's type, or makes a column required breaks that code, and `db migrate`
warns when it writes one. Split such a change over two deploys. First deploy
code that works with both the old and the new schema, with a migration that
only adds. Then, in a later deploy, drop what the old code used.

`db migrate` warns separately when a migration has a statement that may fail
on rows the deploy branch already has. Your dev branch starts without the
copied rows, so a `SET NOT NULL` on a column with NULL rows, or a `UNIQUE`
constraint on a column with duplicates, passes there and fails on deploy. Test
such a migration on a session branch that keeps the copied rows,
`npx appkit db init --session --schema migrate`. If it still fails on deploy,
repair the rows, as
[When a migration fails on deploy](#when-a-migration-fails-on-deploy) describes.

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

The flag alone does not migrate. A start migrates only when `PGUSER` is set
and equals `DATABRICKS_CLIENT_ID`, so that the process connects as the deployed
app's own service principal. Databricks Apps sets both for an app with a bound
database. `npx appkit db init` writes your user name to `PGUSER` in `.env`, so
a local start (`npm run dev`, `npm start`, `databricks apps run-local`)
connects as you and never migrates, with or without exported M2M credentials.
Before `db init` writes `.env`, `PGUSER` is unset, and the start skips for that
reason. A start that skips logs why. Use `npx appkit db migrate` on your
branch instead. A deployed app bound to a branch with the exact shape of a dev
branch, `dev-<slug>-<6 hex>`, or of a session branch refuses to start, because
`appkit db` owns those branches.

Migrations run as the app's service principal, one instance at a time, each in
its own transaction. If one fails, it is rolled back, the ones before it stay
applied, and the app does not start. The server log names the migration and the
SQLSTATE, or the missing migration file. An instance waits up to 5 minutes for
another one to finish migrating. A migration that waits more than 5 seconds for a
table lock, for example behind a long transaction of the running app, is rolled
back and retried twice, then fails instead of blocking that table.

A deploy start also refuses two histories. One is an edited migration, a
committed migration the deploy branch recorded with different content. A
checkout that turned its line endings into CRLF does not count as edited. The
other is a diverged history, where the checkout has migrations the branch never
recorded while the branch recorded migrations the checkout lacks. On your dev
branch, `npx appkit db migrate` only warns about both. See
[When a migration fails on deploy](#when-a-migration-fails-on-deploy) for the
first and [Rolling back](#rolling-back) for the second.

A `0000_baseline` from `introspect` is recorded without running when its tables
already exist on the deploy branch and no migration was ever applied there. If
only some of them exist, the app does not start, and nothing is changed.

#### What a deploy waits for

Databricks Apps counts a deploy as succeeded once the app process has lived for
2 seconds, unless `app.yaml` declares a `health_check`. Then the health check
must pass within its timeout, 300 seconds by default and at most. The template
declares `health_check` on `/health`, and AppKit binds `/health` only after the
database plugin's setup, migrations included. So with the health check, a
deploy succeeds only after the migrations ran, and fails when they fail or do
not finish within 300 seconds. Keep it. Without it, a deploy succeeds while the
app is still migrating, and a failed migration shows up only as a crashed app.

What happens to the running app depends on its compute:

- On classic compute, Apps stops the old process before it starts the new one.
  A failed migration takes the app down.
- On no-downtime compute, which horizontally scaled apps use, the old instance
  keeps serving while the new one starts, and keeps serving when the health
  check fails.
- A crashed process is not restarted. The app stays down until the next deploy.
- An app that scales to zero runs its start again on every cold start,
  migrations included.

#### When a migration fails on deploy

`databricks apps logs` names the migration and the SQLSTATE. The migration was
rolled back and is not recorded. On classic compute the app is down. On
no-downtime compute the previous release still serves.

Never edit a migration a deploy branch has applied. A deploy start refuses an
edited migration. Edit a migration in place only while no deploy branch
recorded it. Otherwise, write the change as a new migration.

A migration that failed because of the data, for example `SET NOT NULL` on a
column with NULL rows, needs the rows repaired, not the migration. Repair them
on the deploy branch, then redeploy the same commit, and the app applies the
same migration. The app's service principal owns the tables, but a role with
the `DATABRICKS_SUPERUSER` membership on the deploy branch reads and writes its
rows. Someone with CAN USE on the Lakebase project creates that role with
`databricks postgres create-role`.

#### Long backfills

A migration runs inside the start, so it has to finish within the 300 second
health-check limit. A backfill that needs longer is not one migration. Split it
in three steps:

1. An expand migration, for example a new nullable column.
2. A batched DML job that fills the rows, run as a role with the
   `DATABRICKS_SUPERUSER` membership on the deploy branch. On a Lakebase branch
   such a role can `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` the
   service principal's tables and create new tables in its schema. It cannot
   `ALTER`, `DROP` or index them, so the schema stays the app's.
3. A contract migration, for example `SET NOT NULL`, once every row has a value.

#### A stuck start

While an instance migrates, its session has `application_name` set to
`appkit-migrate` and holds the migration lock, and other instances wait for it.
A role with the `DATABRICKS_SUPERUSER` membership on the deploy branch can end
that session, because `databricks_superuser` inherits `pg_signal_backend` and
the app's service principal is not a superuser. Find the session, then cancel
its statement or end it:

```sql
select pid, state, query_start from pg_stat_activity
 where application_name = 'appkit-migrate';
select pg_cancel_backend(<pid>);
select pg_terminate_backend(<pid>);
```

When that does not free the branch, restart its compute, which needs CAN
MANAGE on the Lakebase project.

### Existing apps

- **Tables created by hand or by earlier code.** Without `schema.ts`,
  `npx appkit db init` creates your dev branch from the branch the app deploys to
  and introspects it. It writes `schema.ts` from the tables in schema `app` and a
  `0000_baseline` migration. When schema `app` on the branch still belongs to the
  fork's copy of the app's service principal, init then rebuilds it from that
  baseline, so the tables start without the rows the fork copied. With a
  `schema.ts` already, run
  `npx appkit db init --schema introspect`. On a new branch, a plain `db init`
  drops the app schema and rebuilds it from the committed migrations, so it keeps
  only the tables those migrations create. Commit `schema.ts` and the baseline. The
  deployed app records the baseline without running it, because the tables already
  exist on the deploy branch. Once the baseline is committed,
  `db init --schema migrate` keeps the rows a new branch copied.
- **Tables in `public`.** Earlier releases used `public` by default. Keep them there
  with `schemaName: "public"`, as [Apps with tables in `public`](#apps-with-tables-in-public)
  shows. With a `schema.ts`, `npx appkit db introspect` reads the schema it sets in
  `schemaName`. Without one, `db init` and `db introspect` read schema `app`, so run
  `npx appkit db init --schema none`, then
  `npx appkit db introspect --schema-name public`. The `schema.ts` it writes
  sets `schemaName: "public"`, so later runs read `public` without the flag. The
  tables keep the rows the fork copied.
- **No migrate-on-start flag.** Add `APPKIT_DB_MIGRATE_ON_START=true` to `app.yaml`,
  as [Migrations on deploy](#migrations-on-deploy) shows. Without it, the app checks
  its tables on start but creates none.

### Rolling back

Migrations only go forward. There are no down migrations, and the app never undoes
one. Redeploying an older commit leaves the newer tables and their recorded
migrations in place. The app logs that the branch recorded migrations the older
code does not have, and applies nothing. It starts when every table and column the
older `schema.ts` declares still exists. It refuses to start only when the
checkout also has committed migrations the branch never recorded, because then
the two histories diverged, and a rollback alone does not produce that. Deploy
from one branch, usually `main`, and merge a feature's migrations unchanged into
it before it deploys again.

You can roll back only to a commit whose code works with the current schema. A
migration that only adds, as the first step of a
[two-step change](#changing-tables-in-use) does, keeps the previous release
working. A migration that drops or renames a table or column ends rollbacks to
every commit whose `schema.ts` declares it, because that code no longer starts.
The second step of a two-step change is such a migration, so deploy it only when
you no longer need to roll back past the first step. To undo a schema change,
commit a new migration that reverses it, and deploy it.

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

Do not apply migrations to the deploy branch yourself. You would own those
objects, and the app could no longer change them.

If the app schema on the deploy branch already belongs to another role, the app
cannot migrate it, and the server log names both roles. Two apps bound to the
same database each need their own `schemaName` in `defineSchema()`. Otherwise
the app was recreated with a new service principal, or its database resource
was removed and added again. Lakebase then leaves the objects with a role the
app no longer has, the old service principal's role or the role of the person
who removed the resource. No Postgres role can hand them back. `ALTER ... OWNER
TO` the new service principal fails with `must be able to SET ROLE`, because
nobody holds that role. Only Lakebase moves them, by deleting the owning role
and reassigning what it owns. The delete reassigns the objects the role owns
on the branch, drops the role's memberships and grants, and removes the role. If
the role still owns objects in another database of the branch, the delete can
fail. So first take the inventory `db init` takes before it hands a
schema over. In each database of the branch, list what the role owns there:

```sql
select o.type, o.identity
  from pg_shdepend s
  cross join lateral pg_identify_object(s.classid, s.objid, s.objsubid) o
 where s.refclassid = 'pg_authid'::regclass
   and s.refobjid = (select oid from pg_roles where rolname = '<role>')
   and s.deptype = 'o'
   and s.dbid = (select oid from pg_database where datname = current_database())
 order by 1, 2;
```

Then count what else depends on the role, grants included, in the other
databases and in shared objects such as a database it owns. Run the first query
in each database this one names:

```sql
select coalesce(d.datname, 'shared objects') as database, count(*)
  from pg_shdepend s
  left join pg_database d on d.oid = s.dbid
 where s.refclassid = 'pg_authid'::regclass
   and s.refobjid = (select oid from pg_roles where rolname = '<role>')
   and not (s.deptype = 'o'
            and s.dbid = (select oid from pg_database where datname = current_database()))
 group by 1
 order by 1;
```

Reassign or drop anything unrelated to the app before you delete the role.
Then someone with CAN MANAGE on the Lakebase project moves the objects:

```bash
# Both roles, by their client IDs or user names
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
checkout does not commit. It compares the deployment's journal entry by entry,
so a duplicated, malformed or reordered entry fails too. When verify cannot read
that source, or the API reports no service principal for the app, it fails and
says why.

It reads no database, so it does not check that the migrations ran on the
deploy branch. An app with `APPKIT_DB_MIGRATE_ON_START=true` applies them on
start, and a migration that fails stops the start; `databricks apps logs` shows
why.

`-t, --target` picks the target; without it, verify uses the bundle's default
target. When the target's `workspace.host` is not the workspace your shell is
authenticated against, verify refuses and names the profile to set. A
`workspace.host` the checkout's files cannot resolve, such as a `${var.…}` with
no value, is refused before any API call. It needs no
access to the deploy branch's database and changes nothing. A failed check names
`databricks apps logs`, `start` or `deploy`.

### CI

`appkit db init` sets up branches for developers, and CI does not need one. On
every pull request, run the offline check after installing the app's
dependencies:

```bash
npx appkit db check
```

It needs no Databricks or Lakebase credentials. It is not a sandbox, though. To
load `schema.ts` it imports that file and everything the file imports, so it
runs the pull request's code. Give the CI job that runs it no secrets. It
compares the snapshots with each other and with `schema.ts`, and does not read
the `.sql` files, so SQL edited by hand is not checked against its snapshot. It
exits 1 when:

- `schema.ts` changed and no committed migration has the change;
- a migration is listed after one generated later, which a branch that ran the
  later one never runs;
- two migrations were generated from the same snapshot on parallel git branches;
- the first migration was not generated from an empty database, so the ones
  before it are missing;
- an entry's `idx` is not its position in the journal, or its `when` is not an
  integer timestamp;
- a migration's `.sql` or snapshot is not committed, a snapshot is not a
  drizzle-kit snapshot, or a `.sql` is not in the journal.

Two pull requests that each add a migration conflict in
`config/database/migrations` once one of them is merged, and keeping both sides
fails the check. Resolve the conflict with `main`'s migrations instead. Save any
SQL you wrote by hand in your migration, such as a backfill. Merge `main`, reset
`config/database/migrations` to `main`'s, then run `npx appkit db clean` and
`npx appkit db migrate`. `migrate` writes your schema change again after
`main`'s migrations. Add the saved SQL back to the migration it writes and
review it before you commit.

After a deploy, check the deployed app with workspace credentials:

```bash
databricks apps deploy -t prod
npx appkit db verify --deployed -t prod
```

It exits 1 when the app is not running or is bound to another branch, when
verify cannot confirm that its deployment has every committed migration with the
same SQL, and when the deployment has a migration this checkout does not commit.

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

An explicit schema skips schema file discovery. Operations in
`server/database/routes/` still load unless `routes: false` disables them. They
still need `config/database/schema.ts`, because type generation and the
generated registry import it. With a different layout, re-export the schema
from that file:

```ts
// config/database/schema.ts
export { schema } from "../../server/db/schema";
```

With an explicit [`routes` registry](#serve-the-operations), a `schema` passed
beside it must be the same object the registry loads, or setup fails.

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
declares its HTTP method, its input and output schemas, an `authorize` rule,
and an `execute` function.

### Define an operation

Write operations in modules under `server/database/routes/`. Each exported
`defineOperation()` result is an operation, and other exports are ignored.

```ts
// server/database/routes/notes.ts
import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { noteAuthor, signedIn } from "../policies";

const note = z.object({ id: z.number(), author: z.string(), body: z.string() });

export const listNotes = defineOperation({
  name: "notes.list",
  method: "GET",
  input: z.object({ limit: z.number().int().max(100) }),
  output: z.array(note),
  authorize: signedIn,
  execute: ({ db, input }) =>
    db.notes.order({ created_at: "desc" }).limit(input.limit).toArray(),
});

export const createNote = defineOperation({
  name: "notes.create",
  method: "POST",
  input: z.object({ body: z.string().trim().min(1) }),
  output: note,
  authorize: signedIn,
  execute: ({ actor, db, input }) =>
    db.transaction(async (tx) => {
      const created = await tx.notes.create({ author: actor.id, body: input.body });
      await tx.note_events.create({ note_id: created.id, action: "created" });
      return created;
    }),
});

export const updateNote = defineOperation({
  name: "notes.update",
  method: "PATCH",
  input: z.object({ id: z.number().int(), body: z.string().trim().min(1) }),
  output: note,
  authorize: noteAuthor,
  execute: ({ db, input }) => db.notes.update(input.id, { body: input.body }),
});

export const deleteNote = defineOperation({
  name: "notes.delete",
  method: "DELETE",
  input: z.object({ id: z.number().int() }),
  authorize: noteAuthor,
  execute: async ({ db, input }) => {
    await db.notes.delete(input.id);
  },
});
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The name the browser calls, one URL segment. Parts of letters, digits, `_`, and `-`, each starting with a letter, joined by dots. At most 64 characters per part and 255 in total. `constructor` and `prototype` are reserved |
| `method` | Yes | `GET`, `POST`, `PATCH`, `PUT`, or `DELETE`. The operation answers only this method |
| `input` | No | A Zod schema for accepted parameters. Omit it for no parameters; callbacks receive `undefined` |
| `output` | No | A Zod schema for the answer. The plugin parses what `execute` returns and sends only that. Omit it for no body; `execute` returns nothing |
| `authorize` | Yes | A function or a [policy](#authorize-an-operation) that admits the caller |
| `execute` | Yes | Does the work and returns the answer |

Omitting `input` means the operation accepts no parameters. Declare a schema
whenever it needs an ID, filters, or write values. There is no input inferred
from the HTTP method or a table, and no need for `input: z.object({})` on lists.
Unexpected parameters are rejected before authorization; an empty object is
also accepted and normalized to `undefined`.

```ts
export const countNotes = defineOperation({
  name: "notes.count",
  method: "GET",
  output: z.number(),
  authorize: signedIn,
  execute: ({ db }) => db.notes.count(),
});
```

Omitting `output` means the operation answers no body, and the browser type of
its answer is `void`. Nothing infers a response from a table or the HTTP method:

| `execute` returns | Response |
| --- | --- |
| `undefined` | 204 with no body |
| `null` on `GET`, `PATCH`, or `PUT` | 404 |
| Anything else | 500. After a write the client reports `OUTCOME_UNKNOWN` |

Every operation that answers a body declares `output`, rows included. `z.object`
strips the keys it does not name, so the schema is the projection, and a column
stays out of the answer by not being named. Explicit input schemas control how
incoming values are validated and converted. Keep server-owned values, such as
the caller's identity, out of those schemas.

Every callback receives one context. `authorize`, a policy's `resource` lookup
and `allow`, and `execute` all see the same `actor`, `input`, `db`, and `appkit`:

| Field | Meaning |
| --- | --- |
| `actor` | The verified caller, `{ id, email? }`. See [Caller identity](#caller-identity) |
| `input` | The parsed input, or `undefined` when there is no input schema |
| `db` | The same client as `appkit.database` |
| `appkit` | Every plugin's exports, as `createApp` returns them |
| `resource` | In `allow` and `execute`, the value the policy's lookup loaded, otherwise `undefined` |

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

The lookup receives the same context as every other callback, `actor`
included, and runs once per request. `execute` receives its value as
`resource`, so `execute: ({ resource }) => resource` answers without a second
query. A lookup can scope its query to the caller, so that another author's
note is a 404 rather than a 403:

```ts
/** The caller's own note, or nothing. */
export const ownNote = definePolicy({
  resource: ({ actor, db, input }: PolicyContext<{ readonly id: number }>) =>
    db.notes.where({ id: input.id, author: actor.id }).first(),
  allow: () => true,
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
| Throws because the database is unavailable or failed unexpectedly | 503 when the failure is temporary, otherwise 500 |
| Throws anything else, a database permission error included | 403, or 404 for a resource policy |

A missing record answers 404 before `allow` runs. While the database is failing,
a policy whose queries run only for an existing record answers 503 or 500 for
that record, so it can reveal that the record exists.

A denial may carry a `reason` for your own tests. The plugin never sends it or
logs it. `execute` runs at most once, and only after `authorize` admitted.

### Serve the operations

The AppKit Vite plugin and `appkit generate-types` find the modules directly in
`server/database/routes/`, except `*.test.ts`, `*.d.ts`, and `*.gen.ts` files
and names that start with `.`. Both import every module to read its
declarations, so a module must not open a connection or start a timer when it
is imported: an open handle keeps `vite build` from exiting. The Vite plugin
runs when the dev server starts, and whenever a file in `config/database/` or
`server/database/routes/` changes. Both write two files:

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
its file and export. When `NODE_ENV` is `production`, the Vite plugin and
`appkit generate-types` fail generation on such an operation under
`server/database/routes/` instead. The template's build runs
`NODE_ENV=production appkit generate-types --wait`, and a custom build that
calls the command sets `NODE_ENV` the same way. A module listed only in an
explicit registry is checked by setup alone. With `routes: false`, the plugin
registers no HTTP endpoint.

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
- An answer is at most 5 MiB of JSON. A larger answer, or one that does not
  match `output`, answers 500 and logs a warning that names the operation and
  the reason, without the value.
- A success answers 200, or 201 for `POST`. An operation without `output`
  answers 204 with no body.
- An unknown name, or a method the operation does not declare, answers 404.
- A browser request from another origin answers 403, before the plugin asks the
  workspace who sent it. A write must carry `Origin` or `Sec-Fetch-Site`, as
  every browser sends, so a script that calls a write sends the app's origin.
- Without a verified caller, every request answers 401, before the plugin reads
  its input.
- Every response carries `Cache-Control: no-store`.

A failure answers `{ "error": "<stable message>" }`. An input that fails its
schema also carries `details`, a list of `{ path, message }` pairs that name the
input field without its value. Paths include declared property names and array
indices; dictionary keys and unknown fields are not echoed. Messages use stable
descriptions such as `Must not be empty` or `Invalid format`, rather than raw
Zod or custom refinement messages. A form can associate these details with its
fields without displaying submitted values from an error.

### Caller identity

The plugin identifies the caller of every request, and selects how once, from
the deployment:

- In Databricks Apps (`DATABRICKS_APP_NAME` is set and `NODE_ENV` is not
  `development`), the user token the Apps proxy forwards is checked with the
  workspace. A rejected token, an inactive user, or a service principal answers
  401. When the workspace refuses the check with 403, the plugin also logs a
  warning, because the app's user authorization usually lacks a scope. The
  forwarded user and email headers are not trusted. A verified token is
  reused for 30 seconds, and concurrent requests with one token share one check,
  so a user removed from the workspace can keep access for up to 30 seconds.
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

A column declared with `.private()` stays on the server. Default reads leave it
out of the rows the trusted client returns, and server code, including
`execute`, can still select, read, and write it. It does not sanitize an
operation's `output`. The output schema alone decides what is sent, so list the
public fields you mean to send, nested objects included. `.passthrough()`,
`z.record`, `z.any()`, `z.unknown()`, a transform, or naming a private field
sends whatever `execute` returns. For example, `execute` can store the caller's
email from `actor.email` in a private column that no input accepts and no
output names.

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
signed in, that someone signed in after a 401, or a 401 shows that the session
ended, every query drops its data and asks again, and every mutation returns to
idle. The page's first answer only records who is signed in. An answer that arrives
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
| `FORBIDDEN` | 403 | `authorize` refused, the request came from another origin, a write carried no origin, or the database refused |
| `NOT_FOUND` | 404 | No such operation for this method, a resource policy found nothing, or `execute` answered `null` on a `GET`, `PATCH`, or `PUT` with no `output` or an `output` that rejects `null`. An `output` that accepts `null` answers 200 |
| `CONFLICT` | 409 | A constraint rejected the change |
| `PAYLOAD_TOO_LARGE` | 413 | The request body exceeded its limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request body was not JSON |
| `VALIDATION_FAILED` | 422 | A value failed the schema's validation |
| `TRANSIENT` | 503 or `null` | Temporarily unavailable, or a read received no response |
| `SESSION_CHANGED` | `null` | The answer belongs to an earlier session. A write may have completed |
| `OUTCOME_UNKNOWN` | 5xx, `null`, or a successful status | A write may have committed without a usable answer, for example when it failed after `execute` ran or a proxy answered it with a server error. Check before retrying |
| `INTERNAL` | 500 or other | Any other failure |

## API reference

- [`database`](../api/appkit/Function.database.md)
- [`IDatabaseConfig`](../api/appkit/TypeAlias.IDatabaseConfig.md)
