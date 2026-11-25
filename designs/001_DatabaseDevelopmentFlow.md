# 001 - Database development flow

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Victor Ditadi |

The [Google Doc](https://docs.google.com/document/d/1bsMsYsTfoFBSYS3YbXn3FvOOUQl21X829Z4u1I-fBzg/edit) is the copy for comments and edits. Changes there are synced to this file.

## Background and Motivation

The DatabasePlugin (`@databricks/appkit/beta`) provides typed server access to Lakebase Postgres from
`config/database/schema.ts`. The earlier beta exposed generated CRUD routes. The operation design in
[#687–#692](https://github.com/databricks/appkit/pull/692) replaces those routes with explicitly authorized, named
operations. Table declarations alone expose no HTTP endpoint.

This design covers branch ownership, migrations and deployment. [Design 002](./002_DatabaseRouteOperations.md) defines
the operation contract. The migration implementation in #654–#678 and the operation implementation in #687–#692 are
separate PR chains; integrating them is required before both flows ship together. The operation stack alone checks
existing tables at startup and never creates or migrates them. This design adds the opt-in migration step before that
check.

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

- Classic compute stops an app's old process before it starts the new one. No-downtime compute, which horizontally
  scaled apps use, starts the new process beside the old one, which keeps serving until the new one is healthy.
- Removing a database resource from an app hands the service principal's objects to the person who removed it.
  Re-adding it restores database access but not object ownership, so the next deploy fails with
  `permission denied for schema` ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463)).
- Genie App Builder builds on AppKit. Its apps scale to zero after 15 idle minutes by default, so start runs on every
  cold start, and they deploy from the UI with no CI step.

The stack below this design was built and verified against a Lakebase project with a throwaway deploy branch and app.
Its PR descriptions record the live results.

## Goals

1. From `databricks apps init` to a deployed app with one table, a developer runs no SQL, grants nothing and opens no
   console. The stack builds this flow and keeps it hidden. The reveal, a later change that offers the plugin in
   `apps init`, meets this goal.
2. Each developer works on a Lakebase branch of their own. Only the deployed app runs migrations on the branch it
   deploys to.
3. Schema changes are committed as SQL migrations and reviewed with the code that needs them.
4. A deploy applies exactly the migrations its commit carries, or fails before serving with a message that names the
   migration and the fix.
5. Every command that writes refuses a branch it was not built for, before it connects.

## Out of Scope

- Down migrations and automatic schema rollback. Fixes go forward.
- Per-user Postgres connections (OBO). Operations verify the caller and authorize access in application code; the
  database connection and migrations still run as the app's service principal.
- Several apps sharing one Postgres schema. Two apps on one database each set their own `schemaName`.
- drizzle-kit v1's migration folder format. This design ships on drizzle-kit 0.31 (journal v7).
- Seeding or copying data into the deploy branch.
- Migrations that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`).

## Product Decisions

### The schema lives in TypeScript, and migrations are committed SQL

`config/database/schema.ts` stays the source of truth. `appkit db migrate` writes drizzle-kit output under
`config/database/migrations/`: one `NNNN_<name>.sql` per change, a `meta/NNNN_snapshot.json` per migration and
`meta/_journal.json`. The SQL is what reviewers read and what the deployed app runs.

### Browser access is a set of authored operations

[Design 002](./002_DatabaseRouteOperations.md) defines the operation contract, and this design does not restate it.
This design relies on four of its rules:

- Operations are the only database HTTP surface. A table declaration exposes no endpoint.
- Each operation is a `defineOperation` export in `server/database/routes/`, which `database()` discovers.
- Each operation authorizes its callers explicitly. A missing policy never allows every caller.
- A migration changes storage and nothing else. Applying one never publishes an operation, and editing an operation
  never applies DDL.

### Every developer gets a Lakebase branch

`appkit db init` forks the branch that the default `databricks.yml` target binds, when that branch resolves in the
project. Otherwise it forks the project's default branch. It says which branch it forked. The fork is one of two kinds:

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

A Lakebase fork copies every row of its parent. A dev or session branch still starts with no copied app rows. Init
decides from the branch itself whether the copied rows are still there, so a rerun from any checkout decides the same
way. It reads the owner of the app schema and the journal in it. It also knows whether this run created the branch:

| App schema on the branch | Meaning | Start without `--schema` |
|---|---|---|
| Absent | Nothing was copied. | Migrate, or introspect without `schema.ts`. |
| Owned by another role | An untouched copy. The owner is the fork's copy of the service principal. | Rebuild. |
| Yours, and its journal holds the fork-copy tag | A copy whose rebuild did not finish. | Rebuild. |
| Yours, on a branch this run created | A copy of a source schema you already owned. | Rebuild. |
| Yours, without the tag, on a branch that already existed | Your working branch. | Migrate, or introspect without `schema.ts`. |

A rebuild tags the copied journal with one row, hands the schema to the developer when another role owns it, then drops
it and rebuilds it from the committed migrations, which is what `--schema clean` does. Dropping the schema removes the
tag in the same transaction. Without a `schema.ts`, init introspects the copy first and rebuilds from the baseline that
introspect writes. Init writes and deletes the tag only in a journal the migrator trusts, and reads it by the migrator's
read rule, as the section on a history the migrator would skip says. A copied journal on an untouched fork belongs to
the schema's owner, so it is trusted. When the journal is missing or not trusted, init does not tag. It then warns
before it hands off or drops the schema. If the run stops before the rebuild finishes, the next init sees a branch that
looks like yours, and `appkit db init --schema clean` removes the copy.

`appkit db migrate`, `introspect` and `seed` refuse an untouched copy and a tagged one, so no work lands on top of
copied rows. They say to run `appkit db init` to rebuild the branch, or `appkit db init --schema migrate` or
`--schema introspect` to keep the copied rows. They never refuse schema `public`, which init never hands off or tags.

`--schema none` touches nothing, so a later plain init still rebuilds an untouched copy. An explicit `--schema migrate`
or `--schema introspect` on a copy keeps the copied rows, removes the tag, and says the rows stayed. The schema is then
yours, so a later plain init keeps the rows too. Init says that `appkit db init --schema clean` removes them. That
clean drops the app schema with everything in it, and asks first or needs `--yes`.

Some windows remain, and in each a rerun treats the branch as your working branch with its copied rows:

- An init on a copy it could not tag stops before the drop, once the schema is yours. The warning above names the fix.
- An init stops after creating a branch whose schema you already owned, and before it writes the tag. When it stops
  after the tag, the next init finishes the rebuild.
- `--schema none` creates a branch whose schema you already owned. The next init did not create it, so it migrates.

See Security Considerations for what the rebuild does not remove.

Branches count against the project's limits, so init keeps them cheap. It creates the branch's endpoint with a 5-minute
scale to zero, because an idle compute counts against the 20 active ones. When the project is at its branch limit, init
stops before creating anything. It lists your branches with the command that deletes them, and when none of the
project's branches are yours, it says to ask a project owner. With the quota of 25, a project holds the deploy branch
and about 20 developers with one branch each, fewer when they also keep session branches. The 20 active computes cap how
many of them work at the same time.

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

Two apps bound to one database with the same schema would share the schema, its journal and its migration lock. That
is unsupported. Each app sets its own `schemaName`, and the startup error for a schema another role owns says so first.

### The upgrade path for apps without `schemaName`

An upgraded app without `schemaName` fails its startup check until it sets `{ schemaName: "public" }` or moves its
tables to `app`. The check runs whether or not the app migrates. When it finds every missing table in `public`, its
error says the default moved to `app` and offers `{ schemaName: "public" }`.

The upgrade does not start migrating, because the deploy flag below is off unless the app's `app.yaml` sets it. With
migrate on start and no `schemaName`, startup refuses before it applies anything when some declared tables exist in
`public` and none exist in `app`. Otherwise an upgraded app would create empty tables in `app` and serve them.
`appkit db migrate` refuses the same case. Both errors say to set `{ schemaName: "public" }` or move the tables. The
release notes carry an upgrade section.

The operation stack separately replaces the beta AutoCRUD HTTP surface and entity hooks. Applications move those calls
to named operations, as design 002 describes. No compatibility layer keeps the removed HTTP API.

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
explicit `--schema clean` on your working branch, and about an ambiguous rename in a migration it writes. The rebuild
of a copy needs no confirmation, because `appkit db migrate`, `introspect` and `seed` refuse to work on top of a copy,
so nothing on it is the developer's. It keeps this checkout's session branch when `.env` points at one and otherwise
uses your dev branch. `--session` and `--dev` switch between them.
`appkit db check` is the only command that needs no Databricks or Lakebase access, so CI runs it without credentials.

## Architecture Decisions

### Migrate on start, behind an explicit flag

The plugin applies migrations in `setup()`, after the pool opens and before the schema check and `server.start()`. It
runs only when `APPKIT_DB_MIGRATE_ON_START=true` and the process connects as the app's own service principal. Apps sets
`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` for the app, and sets `PGUSER` to that client ID for every app
with a bound database. So the plugin migrates only when `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` are set
and `PGUSER` is set and equals `DATABRICKS_CLIENT_ID`. An unset
`PGUSER` does not qualify, though the pool would then connect with the client ID. When the flag is set and the process
does not qualify, the plugin logs why and does not migrate. A process that qualifies also needs `LAKEBASE_ENDPOINT` set
to the endpoint's full resource name, `projects/<p>/branches/<b>/endpoints/<e>`, because the plugin reads the branch
from it. When it is unset or has another form, startup fails and names the variable. The template's `app.yaml.tmpl` writes the flag for apps that
select the plugin, which `apps init` offers only after the reveal. Until then, an app that adds the plugin by hand adds
the flag to `app.yaml` too. `.env` never carries it.

The rule is an identity check, not deployment detection. `appkit db init` writes the developer's user name into `PGUSER`
in `.env`. A local start with that `PGUSER` never migrates. So neither `npm start` nor `databricks apps run-local`,
which reads the flag from `app.yaml`, migrates after init, even when the shell exports M2M credentials. One gap remains
before init writes `PGUSER`. A local process that connects as the app's service principal, with its M2M credentials
exported and `PGUSER` set to its client ID, migrates whatever branch `.env` names, and the scaffold points `.env` at the
deploy branch. This gap closes before the reveal.

A deployed app bound to a branch with the exact shape of a dev or session branch, `dev-<user>-<hash6>` or
`session-<hash6>-<id>`, refuses to start and names the branch. Only a developer migrates those branches. A deploy
branch named `session-store` does not have that shape, so it migrates. The refusal runs inside migrate on start, so it
covers only a start that migrates. An app without the flag, or a process that does not qualify, starts on such a branch.

Rejected alternatives:

| Option | Why not |
|---|---|
| Infer deployment from the environment alone | No way to turn it off for a deployed app that must not migrate. The identity check above narrows the flag and does not replace it. |
| An admin migrates the deploy branch from the CLI | A human step on every schema change, by a person with DDL rights on the production branch. App Builder has nobody to run it. |
| A shared owner role, with CI migrating on merge ([tmm Lakebase Agentic CI](https://github.com/databricks/tmm/tree/main/Lakebase-Agentic-CI)) | Works. It needs a one-time bootstrap on the deploy branch by someone with `ADMIN OPTION`, database credentials in CI, and a grant to every new app service principal. Developers skip the fork hand-off only if they are members on the deploy branch, which gives them DDL rights there. App Builder apps have no CI. |
| A one-shot migration job per deploy | Adds a resource to every app, and still needs a shared owner role and its bootstrap so the app can use what the job created. |
| A bundle script hook | Runs as the person or CI identity that deploys, which then owns the objects. |

The decision costs three rules that the docs and `appkit db migrate` carry:

- **Each migration works with the previous release.** On no-downtime compute the old instance keeps serving while the
  new one migrates and starts. A dropped, renamed or retyped column breaks it. Drops go in a later deploy than the code
  that stops using the column (expand, then contract). `appkit db migrate` warns when it writes a drop, a rename, a
  type change, `SET NOT NULL`, or an `ADD COLUMN ... NOT NULL` without a default.
- **A migration can fail on rows a new branch does not have.** `appkit db migrate` warns separately about statements
  that may fail on existing rows. They are `SET NOT NULL`, an `ADD COLUMN` that is `NOT NULL` without a default or
  carries a constraint, a `UNIQUE`, `PRIMARY KEY`, `CHECK`, `FOREIGN KEY` or `EXCLUDE` constraint, a unique index, and
  a type change. A new dev branch starts empty, so such a migration passes there. Before deploying, test it on a
  session branch that keeps a copy of the deploy branch's rows, created with
  `appkit db init --session --schema migrate`.
- **A migration fits in 300 seconds.** That is the longest health check Apps allows, as the next section says. A long
  backfill runs as an expand migration, such as a nullable column, then a batched DML job whose role has the
  DATABRICKS_SUPERUSER membership on the deploy branch, then a contract migration, such as `SET NOT NULL`.

### What a deploy does while the app migrates

The Apps runtime decides what users see while the new process migrates:

- A deploy counts as succeeded once the app process has lived 2 seconds, unless an `app.yaml` `health_check` applies.
  Then the health check must pass within its timeout, which defaults to 300 seconds and cannot be longer.
- The template declares `health_check` on `/health`. AppKit binds `/health` only after the database plugin's setup,
  migrations included.
- Classic compute stops the old process before it starts the new one.
- No-downtime compute starts the new process beside the old one. When the new one fails its health check, the old one
  keeps serving.
- A process that crashes is not restarted. It stays down until the next deploy.
- An app on compute that scales to zero (`LIQUID`, which Genie App Builder apps use) stops after 15 idle minutes by
  default. It runs its start, migrations included, on every cold start.

So the old instance keeps serving after a failed migration only on no-downtime compute with the health check. A
single-instance app on classic compute, and an app that scales to zero, are down until a fixed deploy. Whether Apps
enables health checks in production is Open Question 1.

### One transaction per migration

Each pending migration commits in its own transaction, in journal order, with the journal row drizzle-orm would
write. A deploy then replays the same commits the developer's branch went through one `appkit db migrate` at a time.

drizzle-orm's migrator runs every pending migration in one transaction. That fails on deploy for changes that applied
cleanly on the dev branch. `ALTER TYPE ... ADD VALUE` in one migration and a use of the new value in the next fails
with SQLSTATE 55P04 when both run together. A failure after some migrations commit leaves them committed and the new
process not serving. Because every migration works with the previous release, an old instance that still serves keeps
working, and the next deploy resumes from there.

The alternative keeps one transaction and refuses, before `begin`, a batch where an enum value is added before the
last migration. It keeps all-or-nothing, but the deploy still differs from what the developer ran.

### When a migration fails on deploy

Some migrations fail on the deploy branch every time, though they passed on the dev branch. For example, a `SET NOT
NULL` fails when rows on the deploy branch hold a `NULL`, and a new dev branch has no rows. The state after the
failure:

- The failed migration rolled back and is not recorded.
- The migrations before it in that start stay committed and recorded.
- The new process exits 1 and does not serve. Whether the app is down depends on its compute, as the section on
  deploys says.

The fix goes forward, and it never edits a migration a deploy branch applied. A deploy start refuses an `edited`
migration. A file that differs only in CRLF or LF line endings counts as the same file. When the migration failed
because of the rows it met, someone repairs those rows on the deploy branch, then redeploys the same migration. The
repair runs as a role with the DATABRICKS_SUPERUSER membership on the deploy branch, which someone with CAN USE on the
project creates. A migration may be edited in place only while no deploy branch has recorded it. A dev branch that ran
the old version then reports it as `edited`, and the developer rebuilds that branch with `appkit db clean` and
`appkit db migrate`.

Measured on a Lakebase fork, a role with the DATABRICKS_SUPERUSER membership can SELECT, INSERT, UPDATE, DELETE and
TRUNCATE the service principal's tables and create tables in its schema, through the grants Lakebase gives
`databricks_superuser`. It cannot ALTER, DROP or index them, so schema changes stay in migrations. A contract
migration, one that drops or retypes what older code uses, closes the rollback window. After it lands, an older
revision of the app may no longer start.

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
  300-second health check rather than a statement deadline. Once DDL holds its lock, it keeps it until the statement
  and its transaction end.

A killed instance is not cancelled for certain either. The migrating session also sets
`client_connection_check_interval` to 10 seconds, so Postgres cancels a statement whose client went away. Lakebase
allows the setting and sets it to 60 seconds server-wide. That is best effort. Postgres sees a closed connection only
when the server's kernel reports it, and a host that vanished without closing the socket may not be seen until TCP
keepalive gives up. When the server rejects the setting, the migrator logs a warning and goes on. Until Postgres
notices, the killed instance's statement keeps running and holds its locks, the advisory lock included.

For a stuck start, the lock-wait log names the holder's pid. `select pg_cancel_backend(<pid>)` cancels its statement.
`select pg_terminate_backend(<pid>)` ends its session, which releases the advisory lock. A role with the
DATABRICKS_SUPERUSER membership on the deploy branch can run both, because `databricks_superuser` inherits
`pg_signal_backend` (measured on Lakebase) and the service principal is not a superuser. Without such a role, someone
with CAN MANAGE on the project restarts the branch's compute.

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

A command releases the lock when it finishes or exits, and on SIGINT or SIGTERM when nothing else in the process handles
the signal. When another handler keeps the process running, the command keeps the lock until it exits. A command that
ends any other way, such as SIGKILL, can leave the file behind. The next command fails the same way, reports the lock as
stale, and says whether the holder's pid still runs on this machine. AppKit never takes over or deletes a lock it does not hold. Once no
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
| `edited` | A recorded entry whose file hash changed, with either line ending. | Fail. The CLI only warns. |
| `ambiguous` | Entries and rows at one `when` that no exact hash pairs, other than one of each. | Fail. Nothing changes. |
| `ahead` | A recorded row with no committed entry, for example after a code rollback. | Warn, or fail when an entry is also `pending`. |
| `partial-baseline` | `0000_baseline` tables exist only in part. | Fail. Nothing changes. |

Committed entries and recorded rows that share a `when` match one to one, exact hashes first. A committed entry left
with no row is `pending` or `stranded`, never `edited`. So a migration that never ran cannot hide behind an edited one
with the same timestamp. One entry and one row left at a `when` are `edited`. Any other remainder is `ambiguous`,
because the migrator cannot tell which entries ran.

Before it reads the rows, startup checks the journal relation itself. It refuses a `__drizzle_migrations` in the app
schema that is not an ordinary table. It records only into a journal it trusts, one owned by its own role, by a role it
inherits, or by the schema's owner. It reads another role's journal only when the table has no row-level security. A
view, or a trigger on another role's table, would otherwise run that role's code with the migrator's rights.

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

That holds only when every deploy target deploys commits from `main`. A feature deployed early from its own branch
merges its migrations into `main` unchanged before `main` deploys again. A deploy start refuses a diverged history, one
with committed entries pending and recorded rows the checkout lacks at the same time, and names both. A code rollback
leaves only recorded rows the checkout lacks, so it only warns.

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
and its owner as the fork copied them, so a later plain init still rebuilds an untouched copy. Init never hands off
or tags schema `public`, because `public` belongs to the database, not to an app.

The role delete returns HTTP 500 when Postgres refuses the drop with SQLSTATE 2BP01, for example when the role still
owns objects in another database of the branch
([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). Init lists that role's remaining
dependencies from `pg_shdepend` before the delete. When the delete fails, init prints the API error, the
dependencies with where they are, and the fix. What remains is the platform's: the 500 classifies a dependency
refusal as a server error, and the delete cannot complete until someone repairs those dependencies.

Single ownership by the service principal breaks when that principal changes. A recreated app has a new one. Removing
and re-adding the database resource hands the objects to the role Apps created for the person who removed it
(`dbrx-apps-user-<email>`), or to that person's existing role (XTA-18463). Either way the app can no longer use or
alter its schema, and its next start fails.

No Postgres role can hand objects to a service principal's role. Measured on Lakebase, `ALTER ... OWNER TO` that role
fails with `must be able to SET ROLE`, and nobody holds that right on an Apps service principal role. The startup error
names the current owner of schema `app`. It says first that two apps on one database each need their own
`schemaName`. The recovery comes second, and the docs repeat it. Someone with CAN MANAGE on the project first takes
the inventory that init's hand-off takes. In each database of the branch, `pg_shdepend` joined with
`pg_identify_object` lists every object the owner role owns there. `pg_shdepend` also shows what the role owns or is
granted in other databases and in shared objects. They resolve anything unrelated to the app, then run
`databricks postgres delete-role <owner role> --reassign-owned-to <app role>`. That moves every object the owner role
holds on the branch to the app's role and deletes the owner role, which also drops its memberships and grants. A
zero-touch recovery is Open Question 2.

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

`appkit db init` installs drizzle-kit as a dev dependency when it is missing, for every start except `--schema none`,
since only database apps run it. `appkit db migrate` and `appkit db check` both need it, and a dev dependency reaches
CI too. A template dev dependency would add about 32 MB, 12 downloads and two deprecation warnings to every app,
including apps that never use it. The template ships one lockfile, so it cannot be dropped per app.

The shared CLI's view of the tooling API is an interface exported from `shared`, and an appkit test assigns the
tooling's exports to it. Drift then fails typecheck.

### Introspect renders the AppKit builder, not drizzle's DSL

`appkit db introspect` reads `pg_catalog` and renders `defineSchema()` code. `drizzle-kit pull` emits drizzle's
`pgTable` DSL, which the plugin does not accept, and most of the renderer is skip and approximation policy that pull
does not have. Every catalog string reaches the output escaped. Nineteen hostile names, including newline, CR,
U+2028, U+2029, `*/`, backtick and `${`, loaded without running code.

Introspect records its migration as applied only if the branch's last recorded migration is the one just before it,
checked under the schema's advisory lock. A branch ahead of the checkout would otherwise record DDL it never ran.

Introspect writes only the part of the catalog the builder can express, so `schema.ts` and the baseline are not a full
copy of the branch. A table needs a single-column primary key and a name AppKit does not reserve. A column needs a
supported type, and an identity column is written only as the primary key. Generated columns, columns of unsupported
types and identity columns other than the primary key are left out, and an unsupported default is dropped from its
column. A foreign key is written with `fk()` only when one column references the primary key or a single-column unique
key of another table in the same schema. Composite, cross-schema and self-referencing foreign keys, one that would close
a cycle, and a few other shapes the builder cannot type are left out, and their column stays when it is otherwise
supported. What introspect leaves out is reported in three ways. A table, column, default, multi-column unique
constraint or foreign key it cannot write gets an `// appkit: skipped …` comment in `schema.ts` and a `Skipped` line
from the command, plus a warning when inserts would then fail. CHECK and EXCLUDE constraints and indexes, which the
builder cannot declare, get a warning and no comment, and so do the views, triggers, policies, functions, standalone
sequences and types introspect does not read. None of these reach `schema.ts` or the baseline, so a branch
`appkit db init` rebuilds from the migrations lacks them. The deploy branch keeps them, because the app adopts
`0000_baseline` without running it. What the builder declares differently from the database, such as a timestamp's
precision, DEFERRABLE, MATCH FULL, an always-identity key, sequence options or partitioning, is listed as `Approximated`
information. Comments, collations, `NOT VALID` and storage options are neither read nor reported.

Introspect keeps the `.private()` an existing `schema.ts` declares, because the server entity client omits private
columns from its reads by default. Every other column it writes is public. When `schema.ts` does not load, introspect
refuses before it reads the branch, because it could not keep the columns the file marks private.

Before it replaces `schema.ts`, introspect copies the old file to `schema.ts.bak`. It writes the backup only when the
new file differs, so a second run with the same catalog keeps the first backup. With history, introspect refuses to
write a migration that drops an object the branch still has but `schema.ts` cannot express, such as a skipped column.
It would record that migration as applied, and the deployed app would run the drop on start. The refusal names each
object, says why introspect left it out, and says the deployed app would drop it.

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
2. `apps init` runs `appkit db init`, which asks nothing on its default path. It forks the deploy branch that
   `databricks.yml` now binds into `dev-<user>-<hash6>`, adds a read-write endpoint and the developer's role, writes
   `.env`, installs drizzle-kit, hands the fork's app objects to the developer, and rebuilds the app schema from the
   committed migrations, so the new branch holds no copied app rows. With `--schema none`, init stops after it writes
   `.env`, and a later plain init still rebuilds.
3. The developer declares a table in `schema.ts` and runs `appkit db migrate`. It writes `0000_migration.sql`,
   regenerates `shared/appkit-types/database.d.ts` and `database-operations.d.ts`, and applies the migration to the
   dev branch.
4. The developer adds authorized operations in `server/database/routes/` and uses them in the UI, as design 002
   describes. Changes to storage still require `appkit db migrate`, and editing an operation never applies DDL.
5. The developer commits `config/database/`, the operations with their generated contracts, and the UI changes. After
   the merge, they deploy `main` with `databricks apps deploy`.
6. The app starts with `APPKIT_DB_MIGRATE_ON_START=true`, as its service principal. Under the migration lock it
   reconciles, applies `0000`, creates and owns schema `app`, checks the declared tables, binds `/health`, and listens.
   Applying a migration never publishes a browser operation.

Until the CLI release that runs `appkit db init` ships, the developer runs it once after scaffolding, as the README
says. Before that run, `.env` points at the branch picked in the prompts, usually the deploy branch, and
`appkit db verify` warns about it. A local app start in that window reads and writes the deploy branch. The `appkit db`
guards do not cover a local app start. It migrates only when it connects as the app's service principal, with
`PGUSER` set to the app's client ID, as the section on migrate on start says. Both are known gaps, to close before the
reveal offers the plugin.

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

Clone, install, `appkit db init`. Init forks the branch the default `databricks.yml` target binds, which already holds
the deployed migrations, and says which branch it forked. When that branch does not resolve in the project, init forks
the project's default branch. The fork's app schema still belongs to the copy of the service principal, so init drops
it and applies every committed migration. The new branch has the deployed tables and none of their rows. With
`--schema migrate`, init keeps the copied rows, applies only the committed migrations the fork has not recorded, and
says the rows stayed. `appkit db init --schema clean` removes them later.

### Existing tables

On a fork that has tables but no `schema.ts`, `appkit db init` runs introspect. It writes `schema.ts` and
`0000_baseline`. On an untouched copy, it then rebuilds the app schema from that baseline, so the fork has the tables
and none of the copied rows. On your working branch, it records the baseline as applied and keeps the rows.
The deployed app adopts the baseline on start when every baseline table and column already exists. A partial match
fails start and changes nothing.

A baseline is not proof that the deploy branch is secured the way the fork is. Introspect does not render row-level
security policies, triggers, or `CHECK` and `EXCLUDE` constraints, and it warns about each one it skips. Adoption on
deploy checks only that the baseline's tables and columns exist by name. Types, constraints, policies and grants on the
deploy branch are whatever they were.

### API Changes

- CLI: `appkit db init | migrate | introspect | clean | seed | verify | check`.
- Operations, their generated contracts and the UI hooks, as design 002 defines them. They replace AutoCRUD, its
  `api` configuration and the entity CRUD hooks.
- `defineSchema()` defaults `schemaName` to `"app"`.
- Package export `@databricks/appkit/beta/database-tooling`. It is beta and internal to the AppKit CLI. It has no semver
  guarantee, and only the CLI of the same AppKit release imports it.
- App env: `APPKIT_DB_MIGRATE_ON_START`, which takes effect only when `PGUSER` is set and equals
  `DATABRICKS_CLIENT_ID`. Local env written by init: `LAKEBASE_PROJECT`, `LAKEBASE_ENDPOINT`,
  `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPORT` when it is unset or not a number, `PGSSLMODE=require` when it is unset,
  `prefer` or `disable`, `APPKIT_DB_SESSION` for a session branch, and `DATABRICKS_CONFIG_PROFILE` or
  `DATABRICKS_HOST` when `.env` names neither.
- Flags: `appkit db init --dev | --session`, `--ttl <duration>` for session branches,
  `--schema <migrate|introspect|clean|none>` and `-y, --yes`. On an untouched copy, a copy whose rebuild did not
  finish, or a branch this run created with the app schema in it, `--schema` defaults to `clean`, and without
  `schema.ts` to introspect followed by the same rebuild. Otherwise it defaults to `migrate`, and without `schema.ts`
  to `introspect`. `--schema migrate` or `introspect` on a copy keeps the copied rows, says so, and names
  `--schema clean` to remove them. `--schema none` touches nothing. `appkit db clean --delete-branch` and
  `-y, --yes`.
  `appkit db introspect --schema-name <name>`. `appkit db verify --deployed` and `-t, --target <name>`.
- Optional peer dependency: `drizzle-kit` `0.31.10`.

## Observability

Migrations run before `TelemetryManager.start()` registers the tracer provider, so a span opened during setup is
dropped. The plugin opens no span and records no metric for migrations. The migrator returns the applied, adopted and
edited tags, the number of recorded migrations the checkout does not commit, and `lockWaitMs`. It logs one line per
applied migration with its duration. The plugin then logs one line per run with the schema, the migrations folder,
the `applied`, `adopted`, `edited` and `unknown` (the `ahead` rows) counts, `lock_wait_ms` and `duration_ms`.

## Security Considerations

- **New forks start without copied app rows.** A Lakebase fork copies every row of the branch it forks, and the
  developer gets `DATABRICKS_SUPERUSER` on it. That role is required, because it is the only role API membership that
  grants `CREATE` on the database. On an untouched copy, init drops the fork's app schema and rebuilds it from the
  committed migrations, or from the baseline introspect writes, so no copied row stays in it. A branch the same init
  run created is rebuilt even when its app schema was already the developer's, so copied rows do not hide behind
  ownership. Limits that the docs repeat:
  - Until the rebuild runs, the copied rows are on the fork at the Lakebase level. An interrupted init leaves them
    there. A rerun from any checkout finds the schema still owned by the copy of the service principal, or tagged in
    its journal, and rebuilds. `appkit db migrate`, `introspect` and `seed` refuse an untouched or tagged copy
    meanwhile.
  - Init tags only a journal the migrator trusts. A copy with no journal, or with one it does not trust, gets no tag,
    and init warns before it hands off or drops the schema. An init stopped once the schema is the developer's and
    before the drop leaves copied rows that a rerun treats as the working branch. So does an init stopped after creating
    a branch whose schema the developer already owned and before the tag, and `--schema none` on such a branch. `appkit
    db init --schema clean` removes the rows.
  - Rows in other schemas stay. `DROP SCHEMA ... CASCADE` also drops objects in other schemas that depend on the app
    schema, such as a view over an app table, a foreign key into one, or a column of an app type. `appkit db clean`
    lists them before it asks to drop. Init's rebuild of a copy reports them after the drop, because a fresh copy
    needs no confirmation. Only independent objects in other schemas stay.
  - On schema `public`, clean drops only the objects the developer owns. Init never hands `public` off, so tables the
    app's service principal owns stay on the fork with their copied rows, and init warns and lists them. The recovery
    on your own branch is `databricks postgres delete-role projects/<project>/branches/<your branch>/roles/<app role>
    --reassign-owned-to projects/<project>/branches/<your branch>/roles/<your role>`, then `appkit db clean`. Moving
    the app to schema `app` avoids it.
  - Your working branch keeps whatever it holds. `--schema migrate` or `--schema introspect` on a copy keeps
    production rows on purpose. Init says so, and says that `appkit db init --schema clean` removes them.
  - Lakebase has no schema-only branch this flow can use, as the Open Questions record, so every fork copies the rows
    first.
- **Creating branches needs CAN MANAGE on the project.** That also allows deleting the deploy branch. No narrower
  permission exists. CAN USE manages roles and databases but cannot create a branch.
- **Branch guards stop mistakes, not people.** The name allowlist, the denylist and the `PGHOST` check run before
  any connection. They stop an `appkit db` command aimed at the wrong branch. They are not an authorization boundary.
  The developer's CAN MANAGE on the project still lets them delete the deploy branch through the console, the API or
  `databricks postgres`.
- **The scaffold points `.env` at the deploy branch.** Until `appkit db init` runs, a local app start reads and writes
  the deploy branch, as the scaffold flow says. It also migrates that branch when it connects as the app's service
  principal, with exported M2M credentials and `PGUSER` set to the app's client ID. Migrate on start checks the
  identity, not where the process runs. This gap closes before the reveal.
- **A baseline is not a security-equivalence proof.** Introspect omits row-level security policies, triggers, and
  `CHECK` and `EXCLUDE` constraints, with a warning for each. Adopting a baseline on deploy checks only table and
  column names.
- **`verify --deployed` proves the deployed source.** It checks the journal and the SQL bytes of the active
  deployment, the bindings, the running status and the service principal's role. It does not show that the migrations
  were applied on the database.
- **The migration journal guard stops mistakes, not people.** Startup refuses a `__drizzle_migrations` relation that
  is not an ordinary table. It records only into a journal owned by its own role, by a role it inherits, or by the app
  schema's owner, and reads another role's journal only without row-level security. Any role with the
  DATABRICKS_SUPERUSER membership on the deploy branch can still write journal rows, because `databricks_superuser`
  holds `pg_write_all_data`.
- **`appkit db init` installs drizzle-kit.** For every start except `--schema none`, it runs the project's package
  manager to add `drizzle-kit@0.31.10` in the developer's environment, and the packages' lifecycle scripts run as in
  any install.
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
- **`appkit db` connects only with TLS that verifies.** Of the modes the Lakebase pool takes, only `PGSSLMODE=require`
  verifies the server's certificate, and an unset `PGSSLMODE` means `require`. The CLI refuses `prefer`, `disable` and
  `allow`, says why, and does not connect.
- **Session branches are bound to a user.** With the user hash in the name, a copied `.env` fails the guard for
  everyone but its creator.

## Integration with the operation stack

Design 002 records how the operation stack is validated. Neither stack's checks show that the two PR chains work
together. Before release, combine both stacks and verify in one deployment that the operations load, migrations run on
start and the schema check passes. Keep the expand and contract migration checks for mixed-version rollouts.

## Platform Dependencies

| Ask | Why |
|---|---|
| Databricks CLI: `apps init` runs `appkit db init` after install. | Removes the manual init step. Without it the README tells the developer to run init. |
| Databricks CLI: a minimum version recorded in the template. | An older CLI scaffolds without init, and `.env` points at the deploy branch until the developer runs it. `appkit db verify` warns meanwhile. |
| Lakebase: role delete returns the 2BP01 dependency error as a 4xx, not a 500 ([ES-2265656](https://databricks.atlassian.net/browse/ES-2265656), open). | Init prints the API error, the dependencies and the fix, but the 500 classifies a dependency refusal as a server error. The hand-off cannot complete on any rerun until someone repairs the dependencies. |
| Lakebase: raise the quota of 25 unarchived branches per project ([LKB-12894](https://databricks.atlassian.net/browse/LKB-12894), backlog, proposes 100). | One branch per developer caps a project at about 20 developers. |
| Apps: keep object ownership with the app across a database resource remove and re-add ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463), to do). | The app cannot use its own schema after a re-add, and start fails. |
| Apps: deployment health checks enabled in production (Open Question 1). | Without them a deploy succeeds once the process lives 2 seconds, and no-downtime compute can send traffic to a process that is still migrating. |

## Rollout Plan

1. **Design.** Land this doc. Done when the Apps, Lakebase and CLI reviewers have answered the open questions marked
   for them.
2. **Runtime, dark.** Land #654 and #655 with the flag, the per-migration transactions, the reconcile states and the
   bounded lock. Done when a real-Postgres test suite passes in CI, and a throwaway app scaffolded from the template,
   with the plugin and the flag added by hand, deploys and applies `0000` and then `0001`.
3. **Commands, hidden.** Land #666 to #674. Done when a developer on a throwaway app scaffolded from the template runs
   `init`, `migrate` and `verify` on their own branch, and the deployed app applies the migration.
4. **Template and docs, hidden.** Land #675, then #678 (`appkit db check`). #675 keeps the plugin `hidden: true` and out
   of `template/appkit.plugins.json`, and keeps `appkit db` hidden from `appkit --help`. Its `process.exit(1)` on a
   failed start applies to every app the template scaffolds, with or without the plugin, so any app whose startup
   fails stops instead of serving without its routes. Done when two people on a throwaway app scaffolded from the
   template add migrations on parallel git branches, `appkit db check` fails a merge that keeps both, and the
   documented fix passes.
5. **Reveal.** A later, separate change offers the plugin in `apps init`, moves the `database` export from `beta.ts`
   into the generated barrel, and shows `appkit db` in `appkit --help`. Until a CLI release runs `appkit db init`, the
   README says to run it once. Done when `apps init` with the plugin, one table and a deploy need no step outside the
   README.
6. **GA of the plugin** is a separate plan.

## PR Stack

1. `00-design`: this doc.
2. [#654](https://github.com/databricks/appkit/pull/654) Migrations on deploy start: the flag, migrating only as the
   app's own service principal (`PGUSER` set and equal to `DATABRICKS_CLIENT_ID`) with the reason logged otherwise,
   the refusal of a deployed app bound to a branch shaped like a dev or session branch, one transaction per
   migration, the reconcile states with fail-closed `stranded` and one-to-one matching within a `when`, a deploy start
   that refuses an `edited` migration, ignoring line endings, and a diverged history, the journal trust rule, the
   bounded lock wait, a 5s lock timeout, a warning when `client_connection_check_interval` is rejected, the lock-free
   read on a current branch, the `-pooler` refusal, the schema owner in the startup error with the two-apps case first
   and no `ALTER ... OWNER` advice, a log line per run and per applied migration, and a real-Postgres suite.
3. [#655](https://github.com/databricks/appkit/pull/655) The `app` default schema, with the `public` hint in the
   startup check, the refusal to create the tables in an implicit `app` when `public` has them, an ownership hint for
   `public` that does not suggest `ALTER ... OWNER`, and an upgrade note.
4. [#666](https://github.com/databricks/appkit/pull/666) `appkit db migrate`: the branch resolver, the checkout's
   history lock, the drizzle-kit version check, the warning for statements that break the previous release, a second
   warning class for statements that may fail on existing rows, and a checked tooling contract.
   When Postgres rejects the migration the run wrote, migrate removes it, so the next run writes it again.
5. [#670](https://github.com/databricks/appkit/pull/670) `appkit db introspect`: compare-and-set recording, only on
   your own branch, the old `schema.ts`'s private columns kept, and catalog tests that run SQL.
6. [#672](https://github.com/databricks/appkit/pull/672) `appkit db init`, `clean`, `seed`: dev and session branches
   with no prompts, forked from the branch the default `databricks.yml` target binds or else the project default, an
   untouched copy rebuilt without its app rows by default, decided from the schema owner and a fork-copy tag in the
   copied journal, a branch created in the same run rebuilt even when its schema was already yours, the tag written only
   into a journal the migrator trusts with a warning when it cannot be, `appkit db migrate`, `introspect` and `seed`
   refusing an untouched or tagged copy, `--schema clean` named after a kept copy, the hand-off of the app schema and
   its refusal when the copied owner owns objects outside it, the 2BP01 dependency report, the refusal of a bound
   database the fork lacks, the 5-minute scale to zero, the branch-limit stop that names a project owner when no branch
   is yours, `--ttl` and `--delete-branch`, atomic `.env` writes with `PGSSLMODE=require`, and the drizzle-kit install
   for every start except `none`.
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
   works before the CLI release, `verify`'s warning for a `.env` branch that is not yours, the
   `delete-role --reassign-owned-to` recovery in the owner error, and the docs, with the deploy, failure, backfill and
   stuck-start runbooks. The manifest keeps `hidden: true`, `beta.ts` exports `database` by hand,
   `template/appkit.plugins.json` does not list the plugin, and `appkit db` stays hidden from `appkit --help`. The
   reveal is a later, separate change.
9. [#678](https://github.com/databricks/appkit/pull/678) `appkit db check`: the offline check of the committed
   migrations that CI runs, including each entry's `when`, the first snapshot's origin and each snapshot's
   structure, recovery advice that keeps hand-written SQL, the CI section of the plugin docs, and a CI note in the
   template README.

### Related operation PRs

Design 002's operation contract is implemented in a separate chain:

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

Four more have answers from the platform's code and from measurements:

- The Apps start timeout is 600 seconds in code, a crashed process is not restarted, and a health check waits at most
  300 seconds (What a deploy does while the app migrates).
- Lakebase allows `client_connection_check_interval` and sets it to 60 seconds server-wide (One lock per schema).
- No Lakebase permission narrower than CAN MANAGE lets a developer fork a branch. CAN USE manages roles and databases
  but cannot create a branch.
- Schema-only branches exist only in the console API, as root branches, and fail for some users
  ([LKB-21345](https://databricks.atlassian.net/browse/LKB-21345)). Resetting a branch is UI-only and copies the
  parent's data. Neither replaces the rebuild.

Open:

1. Does Apps enable deployment health checks in production? The flag defaults to off in code. Without it a deploy
   succeeds after 2 seconds. SUP-36075, which suggested a 10-minute start timeout, is still unread. Reviewer: Apps
   runtime.
2. How does an app with a new service principal take ownership back, after a recreate or a resource re-add? The
   stack documents a manual recovery with `databricks postgres delete-role --reassign-owned-to`. No API grants one
   role to another ([LKB-16323](https://databricks.atlassian.net/browse/LKB-16323),
   [LKB-5108](https://databricks.atlassian.net/browse/LKB-5108)), and Apps does not keep ownership across a re-add
   ([XTA-18463](https://databricks.atlassian.net/browse/XTA-18463)). Options for a zero-touch recovery are Apps
   transferring ownership on re-add, or an `appkit db adopt --deployed` built on the role API. Reviewer: Lakebase,
   Apps.
3. What scale to zero do child branch computes get by default? Production gets 24 hours. Reviewer: Lakebase.
4. How does Genie App Builder drive this flow? Today it drops the `database` plugin when `lakebase` is selected,
   writes no `.env`, runs its preview as the editor user (LA-2251), and deploys apps that scale to zero, with no CI.
   It would need to keep the plugin, run `appkit db init --session` for each editing session and pass the branch's
   env to the preview, give editors CAN MANAGE on the project, and offer a path for a deploy whose migration failed.
   Reviewer: App Builder.
5. Which CLI release runs `appkit db init`, and does it run before or after the dependency install? Init asks nothing
   on its default path, so it needs no flags. Reviewer: Databricks CLI.
6. This design has `appkit db init` install drizzle-kit. Should the CLI support per-plugin dependencies instead, so
   apps that select the plugin get it at scaffold time? Reviewer: AppKit, Databricks CLI.
